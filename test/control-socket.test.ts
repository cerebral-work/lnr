import { afterEach, describe, expect, test } from "bun:test";
import { createServer, connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
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
