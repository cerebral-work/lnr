import { afterEach, describe, expect, test } from "bun:test";
import { createServer, connect, type Socket } from "node:net";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeControlClient, startControlServer, MAX_CONTROL_BODY_BYTES } from "../src/lib/control-socket.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function path() {
  const dir = mkdtempSync(join(tmpdir(), "lnr-wire-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "s");
}
function rawRequest(socketPath: string, chunks: Buffer[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("test peer timed out")));
    socket.on("data", (data) => { response += data; });
    socket.on("error", reject);
    socket.on("end", () => resolve(response));
    socket.on("connect", async () => {
      for (const chunk of chunks) {
        socket.write(chunk);
        await new Promise((done) => setTimeout(done, 1));
      }
    });
  });
}
async function peer(socketPath: string, handler: (socket: Socket) => void) {
  const server = createServer(handler);
  await new Promise<void>((done) => server.listen(socketPath, done));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  return server;
}

describe("bounded control transport", () => {
  test("round-trips Unicode bodies by byte length", async () => {
    const socketPath = path();
    const server = await startControlServer((request) => ({ status: 200, body: request.body }), { socketPath });
    cleanups.push(server.close);
    const body = JSON.stringify({ title: "赤鬼 café 🚀", note: "first\nsecond" });
    expect((await makeControlClient(socketPath, { connectTimeoutMs: 2000 }).request("POST", "/delegate", body)).body).toBe(body);
  });

  test("accepts a request split inside a UTF-8 codepoint", async () => {
    const socketPath = path();
    const seen: string[] = [];
    const server = await startControlServer((request) => {
      seen.push(request.body); return { status: 200, body: request.body };
    }, { socketPath });
    cleanups.push(server.close);
    const body = Buffer.from("A🚀B");
    const response = await rawRequest(socketPath, [
      Buffer.from(`POST /delegate\r\nContent-Length: ${body.length}\r\n\r\n`), body.subarray(0, 3), body.subarray(3),
    ]);
    expect(response).toContain("A🚀B");
    expect(seen).toEqual(["A🚀B"]);
  });

  test("accepts a response split inside a UTF-8 codepoint", async () => {
    const socketPath = path();
    await peer(socketPath, (socket) => socket.once("data", () => {
      socket.write("200 OK\r\nContent-Length: 4\r\n\r\n");
      socket.write(Buffer.from("🚀").subarray(0, 2));
      setTimeout(() => socket.end(Buffer.from("🚀").subarray(2)), 5);
    }));
    expect((await makeControlClient(socketPath, { connectTimeoutMs: 2000 }).request("GET", "/")).body).toBe("🚀");
  });

  test.each(["-1", "1junk", "1.5", "9999999999999999999", String(MAX_CONTROL_BODY_BYTES + 1)])(
    "rejects invalid length %s before invoking handler", async (length) => {
      const socketPath = path(); let calls = 0;
      const server = await startControlServer(() => { calls++; return { status: 200 }; }, { socketPath });
      cleanups.push(server.close);
      const response = await rawRequest(socketPath, [Buffer.from(`POST /delegate\r\nContent-Length: ${length}\r\n\r\n`)]);
      expect(response).toStartWith("400"); expect(calls).toBe(0);
    },
  );

  test("never executes a second pipelined request", async () => {
    const socketPath = path(); let calls = 0;
    const server = await startControlServer(() => { calls++; return { status: 200 }; }, { socketPath });
    cleanups.push(server.close);
    await rawRequest(socketPath, [Buffer.from("GET /\r\n\r\nGET /\r\n\r\n")]);
    expect(calls).toBe(1);
  });

  test("rejects duplicate lengths", async () => {
    const socketPath = path(); let calls = 0;
    const server = await startControlServer(() => { calls++; return { status: 200 }; }, { socketPath });
    cleanups.push(server.close);
    expect(await rawRequest(socketPath, [Buffer.from("POST /\r\nContent-Length: 0\r\nContent-Length: 1\r\n\r\nx")])).toStartWith("400");
    expect(calls).toBe(0);
  });

  test("rejects incomplete peer response without waiting for the deadline", async () => {
    const socketPath = path();
    await peer(socketPath, (socket) => socket.once("data", () => socket.end("200 OK\r\nContent-Length: 20\r\n\r\nx")));
    await expect(makeControlClient(socketPath).request("GET", "/")).rejects.toThrow("complete frame");
  });

  test("expires partial request ingress and can shut down", async () => {
    const socketPath = path();
    const server = await startControlServer(() => ({ status: 200 }), { socketPath, requestTimeoutMs: 20 });
    cleanups.push(server.close);
    const socket = connect(socketPath);
    await new Promise<void>((done, reject) => {
      socket.on("connect", () => socket.write("POST /\r\nContent-Length: 100\r\n\r\nx"));
      socket.on("close", () => done()); socket.on("error", reject);
    });
  });
});

/**
 * The operator's socket lives on an emptyDir, which survives a container
 * restart. A SIGKILL (OOM kill, liveness kill) skips close(), so the socket
 * file stays behind and every later start failed with "Failed to listen"
 * (linearctl-operator, 2026-11-26).
 */
describe("stale socket on startup", () => {
  const ok = () => ({ status: 200, body: "up" });

  async function killedServerLeavesSocket(socketPath: string): Promise<void> {
    const mod = join(import.meta.dir, "..", "src", "lib", "control-socket.ts");
    const code = `const { startControlServer } = await import(${JSON.stringify(mod)});
      await startControlServer(() => ({ status: 200, body: "old" }), { socketPath: ${JSON.stringify(socketPath)} });
      console.log("ready"); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("child server never became ready")), 10_000);
      child.stdout!.on("data", (d) => { if (String(d).includes("ready")) { clearTimeout(guard); resolve(); } });
    });
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
  }

  test("starts over a socket left by a SIGKILLed server", async () => {
    const socketPath = path();
    await killedServerLeavesSocket(socketPath);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    const server = await startControlServer(ok, { socketPath });
    cleanups.push(() => server.close());
    const res = await makeControlClient(socketPath).request("GET", "/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toBe("up");
  });

  test("refuses a socket that a live server answers on, and leaves that server serving", async () => {
    const socketPath = path();
    const first = await startControlServer(() => ({ status: 200, body: "first" }), { socketPath });
    cleanups.push(() => first.close());
    await expect(startControlServer(ok, { socketPath })).rejects.toThrow(/already listening/);
    const res = await makeControlClient(socketPath).request("GET", "/readyz");
    expect(res.body).toBe("first");
  });

  test("refuses to replace a file that is not a socket", async () => {
    const socketPath = path();
    writeFileSync(socketPath, "keep me");
    await expect(startControlServer(ok, { socketPath })).rejects.toThrow(/not a socket/);
    expect(existsSync(socketPath)).toBe(true);
    expect(readFileSync(socketPath, "utf8")).toBe("keep me");
  });
});

describe("connections are released after the reply", () => {
  // CER-4207: the server paused each socket before replying, so it never read
  // the client's FIN, "close" never fired, and every connection stayed in the
  // server's socket set (about 6 KB each). The operator grew by one socket per
  // kubelet probe until the memory limit.
  async function waitForConnections(server: { connectionCount: () => number }, want: number, ms = 3000) {
    const deadline = Date.now() + ms;
    while (server.connectionCount() !== want && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    return server.connectionCount();
  }

  test("sequential requests leave no open server connections", async () => {
    const socketPath = path();
    const server = await startControlServer(async () => ({ status: 200, body: "{\"ok\":true}" }), { socketPath });
    cleanups.push(() => server.close());
    const client = makeControlClient(socketPath);
    for (let i = 0; i < 200; i++) expect((await client.request("GET", "/healthz")).status).toBe(200);
    expect(await waitForConnections(server, 0)).toBe(0);
  });

  test("a client that never closes its side is still released", async () => {
    const socketPath = path();
    const server = await startControlServer(async () => ({ status: 200, body: "{\"ok\":true}" }), { socketPath });
    cleanups.push(() => server.close());
    // allowHalfOpen: this peer does not answer the server's FIN with its own.
    const held = connect({ path: socketPath, allowHalfOpen: true });
    let response = "";
    held.on("data", (d) => { response += d; });
    held.on("error", () => {});
    held.on("connect", () => held.write("GET /healthz\r\nContent-Length: 0\r\n\r\n"));
    cleanups.push(() => { held.destroy(); });
    // Bun closes the server side once it reads again after end(); the linger
    // timer covers a runtime that would keep a half-open peer. Either way the
    // connection must be released and the full reply delivered.
    const deadline = Date.now() + 2000;
    while (!response.includes("{\"ok\":true}") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(response).toContain("{\"ok\":true}");
    expect(await waitForConnections(server, 0, 3000)).toBe(0);
  });

  test("a rejected frame is released too", async () => {
    const socketPath = path();
    const server = await startControlServer(async () => ({ status: 200, body: "{}" }), { socketPath });
    cleanups.push(() => server.close());
    for (let i = 0; i < 20; i++) expect(await rawRequest(socketPath, [Buffer.from("BOGUS\r\n\r\n")])).toContain("400");
    expect(await waitForConnections(server, 0)).toBe(0);
  });
});
