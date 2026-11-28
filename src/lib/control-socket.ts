/**
 * One request/response per Unix stream, using the existing HTTP-ish framing.
 * Content-Length counts bytes. Decode UTF-8 only after a complete bounded frame.
 */
import { createServer, connect, type Socket, type Server } from "node:net";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

/**
 * The socket sits in `run/`, a directory the server creates, so the server owns
 * it and can restrict it to 0700. `~/.local/state/linearctl` itself may be a
 * mount point the process does not own: the linearctl-operator pod mounts a
 * root-owned emptyDir there and runs as uid 65532, so a chmod of that directory
 * fails with EPERM.
 */
export const DEFAULT_OPERATOR_SOCKET = `${homedir()}/.local/state/linearctl/run/operator.sock`;
export const DEFAULT_CONNECT_TIMEOUT_MS = 250;
/** How long the server keeps a replied connection open for the client to close it. */
export const REPLY_LINGER_MS = 1000;
export const MAX_CONTROL_HEADER_BYTES = 8192;
export const MAX_CONTROL_BODY_BYTES = 1_048_576;
const MAX_FRAME_BYTES = MAX_CONTROL_HEADER_BYTES + 4 + MAX_CONTROL_BODY_BYTES;

export interface ControlRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
export interface ControlResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}
export type ControlHandler = (req: ControlRequest) => Promise<ControlResponse> | ControlResponse;
export interface ControlServer {
  readonly socketPath: string;
  close: () => Promise<void>;
  /** Server-side connections not yet closed. Stays near 0 between requests. */
  connectionCount: () => number;
}

/** Grow geometrically rather than recopying the whole body for every fragment. */
class FrameBuffer {
  private storage = Buffer.alloc(4096);
  private length = 0;
  append(chunk: Buffer): Buffer {
    const needed = this.length + chunk.length;
    if (needed > MAX_FRAME_BYTES) throw new Error("control frame too large");
    if (needed > this.storage.length) {
      const grown = Buffer.allocUnsafe(Math.min(MAX_FRAME_BYTES, Math.max(needed, this.storage.length * 2)));
      this.storage.copy(grown, 0, 0, this.length);
      this.storage = grown;
    }
    chunk.copy(this.storage, this.length);
    this.length = needed;
    return this.storage.subarray(0, needed);
  }
}

function parseFrame(buf: Buffer) {
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    if (buf.length > MAX_CONTROL_HEADER_BYTES) throw new Error("control headers exceed 8 KiB");
    return null;
  }
  if (headerEnd > MAX_CONTROL_HEADER_BYTES) throw new Error("control headers exceed 8 KiB");
  const lines = buf.subarray(0, headerEnd).toString("utf8").split("\r\n");
  const start = lines.shift() ?? "";
  const headers: Record<string, string> = Object.create(null);
  for (const line of lines) {
    const index = line.indexOf(":");
    const name = line.slice(0, index).toLowerCase();
    const value = line.slice(index + 1).trim();
    if (index < 1 || !/^[a-z0-9-]+$/.test(name) || Object.hasOwn(headers, name)) {
      throw new Error("invalid or duplicate control header");
    }
    headers[name] = value;
  }
  const lengthText = headers["content-length"] ?? "0";
  if (!/^(0|[1-9][0-9]*)$/.test(lengthText)) throw new Error("invalid control Content-Length");
  const length = Number(lengthText);
  if (!Number.isSafeInteger(length) || length > MAX_CONTROL_BODY_BYTES) {
    throw new Error("control body exceeds 1 MiB");
  }
  const end = headerEnd + 4 + length;
  if (buf.length < end) return null;
  return { start, headers, body: buf.subarray(headerEnd + 4, end).toString("utf8") };
}

function serializeResponse(res: ControlResponse): string {
  const body = res.body ?? "";
  if (!Number.isInteger(res.status) || res.status < 100 || res.status > 599 ||
      Buffer.byteLength(body) > MAX_CONTROL_BODY_BYTES) throw new Error("invalid control response");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers ?? {})) {
    if (!/^[a-zA-Z0-9-]+$/.test(name) || /[\r\n]/.test(value)) throw new Error("invalid response header");
    if (name.toLowerCase() !== "content-length") headers[name.toLowerCase()] = value;
  }
  headers["content-length"] = String(Buffer.byteLength(body));
  const statusText = res.status === 200 ? "OK" : res.status === 404 ? "Not Found" : "Error";
  const head = `${res.status} ${statusText}\r\n` +
    Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("") + "\r\n";
  if (Buffer.byteLength(head) > MAX_CONTROL_HEADER_BYTES) throw new Error("control headers exceed 8 KiB");
  return head + body;
}

/**
 * Remove a socket file that no server answers on, so a start after a SIGKILL
 * succeeds. The operator's socket lives on an emptyDir, which survives a
 * container restart, and a killed process never runs close(). Fails closed:
 * a non-socket file, a server that accepts, a probe that times out, or any
 * error other than ECONNREFUSED is a refusal, never an unlink.
 */
async function clearStaleSocket(socketPath: string): Promise<void> {
  let isSocket: boolean;
  try {
    isSocket = lstatSync(socketPath).isSocket();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!isSocket) throw new Error(`${socketPath} exists and is not a socket; refusing to replace it`);
  const stale = await new Promise<boolean>((resolve) => {
    const probe = connect(socketPath);
    const guard = setTimeout(() => { probe.destroy(); resolve(false); }, 1000);
    probe.once("connect", () => { clearTimeout(guard); probe.destroy(); resolve(false); });
    probe.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(guard);
      resolve(err.code === "ECONNREFUSED" || err.code === "ENOENT");
    });
  });
  if (!stale) throw new Error(`a control server is already listening on ${socketPath}`);
  try { unlinkSync(socketPath); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Bound ingress time and memory; pause reads before invoking the single handler. */
export function startControlServer(
  handler: ControlHandler,
  opts: { socketPath?: string; requestTimeoutMs?: number } = {},
): Promise<ControlServer> {
  const socketPath = opts.socketPath ?? DEFAULT_OPERATOR_SOCKET;
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(socketPath), 0o700);
  const sockets = new Set<Socket>();
  const { promise, resolve, reject } = Promise.withResolvers<ControlServer>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const buffer = new FrameBuffer();
    let processing = false;
    let timer = setTimeout(() => socket.destroy(), opts.requestTimeoutMs ?? 30_000);
    socket.on("close", () => { clearTimeout(timer); sockets.delete(socket); });
    socket.on("error", () => {});
    // Reply, then make sure the connection closes. The socket is paused while
    // the handler runs, so resume it to read the client's FIN ("data" is
    // ignored once processing), and destroy it after a short linger if the
    // client keeps it open. Without this "close" never fired, and every
    // request left its socket and frame buffer in `sockets` (CER-4207).
    const reply = (res: ControlResponse) => {
      if (socket.destroyed) return;
      socket.end(serializeResponse(res));
      socket.resume();
      clearTimeout(timer);
      timer = setTimeout(() => socket.destroy(), REPLY_LINGER_MS);
    };
    socket.on("data", (chunk: Buffer) => {
      if (processing) return;
      try {
        const parsed = parseFrame(buffer.append(chunk));
        if (!parsed) return;
        const match = /^(GET|POST) (\/\S*)$/.exec(parsed.start);
        if (!match) throw new Error("invalid control request line");
        processing = true;
        clearTimeout(timer);
        socket.pause();
        const req: ControlRequest = { method: match[1], path: match[2], headers: parsed.headers, body: parsed.body };
        Promise.resolve().then(() => handler(req))
          .then(reply)
          .catch(() => reply({ status: 500, body: "control handler failed" }));
      } catch {
        processing = true;
        reply({ status: 400, body: "invalid control frame" });
      }
    });
  });
  clearStaleSocket(socketPath).then(() => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      try { chmodSync(socketPath, 0o600); } catch { /* 0700 parent still gates access. */ }
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => closing ??= new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          try { unlinkSync(socketPath); } catch { /* already gone */ }
          done();
        });
      });
      resolve({ socketPath, close, connectionCount: () => sockets.size });
    });
  }, reject);
  return promise;
}

export interface ControlClient {
  request: (method: string, path: string, body?: string) => Promise<ControlResponse>;
}

/** A total deadline covers connect, headers, and the complete response body. */
export function makeControlClient(
  socketPath: string,
  opts: { connectTimeoutMs?: number } = {},
): ControlClient {
  const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const request = (method: string, path: string, body = ""): Promise<ControlResponse> => {
    if (!/^(GET|POST)$/.test(method) || !/^\/\S*$/.test(path) ||
        Buffer.byteLength(body) > MAX_CONTROL_BODY_BYTES) return Promise.reject(new Error("invalid control request"));
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const buffer = new FrameBuffer();
      let settled = false;
      const finish = (error?: Error, response?: ControlResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else if (response) resolve(response);
      };
      const timer = setTimeout(() => finish(new Error(
        `control socket ${method} ${path} timed out after ${timeoutMs}ms`,
      )), timeoutMs);
      socket.once("error", (error) => finish(error));
      socket.once("end", () => finish(new Error("control response ended before a complete frame")));
      socket.once("close", () => finish(new Error("control socket closed before a complete frame")));
      socket.once("connect", () => {
        socket.write(`${method} ${path}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      });
      socket.on("data", (chunk: Buffer) => {
        try {
          const parsed = parseFrame(buffer.append(chunk));
          if (!parsed) return;
          const match = /^([1-5][0-9]{2}) .+$/.exec(parsed.start);
          if (!match) throw new Error("invalid control response status");
          finish(undefined, { status: Number(match[1]), headers: parsed.headers, body: parsed.body });
        } catch (error) { finish(error instanceof Error ? error : new Error("invalid control response")); }
      });
    });
  };
  return { request };
}
