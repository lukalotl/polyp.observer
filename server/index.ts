import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { WebSocket, WebSocketServer } from "ws";
import type { EvolutionResponse } from "../src/protocol";
import type { FromWorker, ToWorker } from "./worker";
import {
  commandId,
  COMPUTE_TIMEOUT_MS,
  MAX_COMMAND_BYTES,
  MAX_OUTBOUND_BYTES,
  MAX_WORKERS,
  validateCommand,
} from "./validation";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const here = dirname(fileURLToPath(import.meta.url));

/** Exact aliases for the workspace HTTPS gateway, which may replace Host.
 * Never accept a wildcard domain or infer trust from an untrusted Origin itself.
 */
export function workspaceOrigins(
  port: number,
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const origins = new Set<string>();
  const id = env.WORKSPACE_SHORT_ID;
  const domain = env.SOFT_MACHINE_PORT_FORWARDING_DOMAIN ?? "soft-machine.io";
  if (!id || !/^[a-z0-9-]+$/i.test(id) || !/^[a-z0-9.-]+$/i.test(domain))
    return origins;
  origins.add(`https://${port}-${id}.${domain}`);
  // In development, the browser reaches Vite, which proxies to the VM backend.
  if (port === Number(env.API_PORT ?? 8787)) {
    const clientPort = Number(env.CLIENT_PORT ?? 5173);
    if (
      Number.isInteger(clientPort) &&
      clientPort >= 1024 &&
      clientPort <= 65535
    )
      origins.add(`https://${clientPort}-${id}.${domain}`);
  }
  return origins;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  distDir?: string;
  /** Exact trusted reverse-proxy origin; PUBLIC_ORIGIN is the CLI equivalent. */
  publicOrigin?: string;
  /** Shortened only by transport lifecycle tests. */
  heartbeatMs?: number;
}

export async function startEvolutionServer(options: ServerOptions = {}) {
  const distDir = resolve(options.distDir ?? resolve(here, "../dist"));
  const workers = new Set<Worker>();
  const stopping = new Set<Promise<number>>();
  const sessions = new Map<WebSocket, { stop: () => void; alive: boolean }>();
  let closing = false;
  const http = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    void serve(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end("Request could not be served.");
    });
  });
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;
  http.keepAliveTimeout = 5_000;
  http.maxRequestsPerSocket = 100;
  const ws = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_COMMAND_BYTES,
    perMessageDeflate: false,
  });

  async function serve(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(
        new URL(req.url ?? "/", "http://local").pathname,
      );
    } catch {
      res.writeHead(400);
      res.end("Invalid URL.");
      return;
    }
    if (pathname === "/api/health") {
      res.writeHead(200, {
        "Content-Type": MIME[".json"],
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          status: "ok",
          execution: "node:worker_threads",
          workers: workers.size,
          maxWorkers: MAX_WORKERS,
        }),
      );
      return;
    }
    if (pathname.startsWith("/api/")) {
      res.writeHead(404);
      res.end("Not found.");
      return;
    }
    let path = resolve(distDir, "." + pathname);
    if (
      (path !== distDir && !path.startsWith(distDir + sep)) ||
      pathname.includes("\0")
    ) {
      res.writeHead(403);
      res.end("Forbidden.");
      return;
    }
    if (pathname === "/") path = resolve(distDir, "index.html");
    let info = await stat(path).catch(() => null);
    if (!info?.isFile() && !extname(pathname)) {
      path = resolve(distDir, "index.html");
      info = await stat(path).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(
        "Not found. Build the client with npm run build, or use npm run dev.",
      );
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control":
        extname(path) === ".html" ? "no-cache" : "public, max-age=3600",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(path);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  http.on("upgrade", (req, socket, head) => {
    const reject = (code: number, reason: string) => {
      socket.end(
        `HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    };
    if (closing) {
      reject(503, "Service Unavailable");
      return;
    }
    if (req.url !== "/api/evolution") {
      reject(404, "Not Found");
      return;
    }
    // Prevent another website from silently reserving this workspace's CPU.
    // Forwarded Host is needed when the workspace HTTPS gateway fronts Node.
    const origin = req.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.origin !== origin
        ) {
          reject(403, "Forbidden");
          return;
        }
        const forwarded = String(req.headers["x-forwarded-host"] ?? "")
          .split(",")[0]
          .trim();
        const address = http.address();
        const aliases = workspaceOrigins(
          address && typeof address !== "string" ? address.port : 0,
        );
        const explicit = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
        if (explicit) aliases.add(explicit);
        if (
          ![req.headers.host, forwarded].includes(parsed.host) &&
          !aliases.has(origin)
        ) {
          reject(403, "Forbidden");
          return;
        }
      } catch {
        reject(403, "Forbidden");
        return;
      }
    }
    if (workers.size >= MAX_WORKERS) {
      reject(503, "Worker Capacity Reached");
      return;
    }
    ws.handleUpgrade(req, socket, head, (client) =>
      ws.emit("connection", client, req),
    );
  });

  ws.on("connection", (socket) => {
    // Creation is synchronous, so a burst cannot pass the four-worker cap.
    const worker = new Worker(new URL("./worker.js", import.meta.url), {
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    workers.add(worker);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let tokens = 12;
    let refilled = Date.now();
    const session = { stop, alive: true };
    sessions.set(socket, session);

    function stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      clearTimeout(deliveryTimer);
      clearTimeout(closeTimer);
      sessions.delete(socket);
      const ended = worker.terminate();
      stopping.add(ended);
      void ended.finally(() => {
        stopping.delete(ended);
        workers.delete(worker);
      });
    }
    function fail(error: string, id?: number, code = 1011): void {
      if (stopped) return;
      if (
        socket.readyState === WebSocket.OPEN &&
        socket.bufferedAmount < MAX_OUTBOUND_BYTES
      ) {
        socket.send(
          JSON.stringify({
            type: "error",
            id,
            error,
          } satisfies EvolutionResponse),
        );
        socket.close(code, error.slice(0, 100));
      } else socket.terminate();
      stop();
      // A peer that ignores the close handshake must not retain a socket.
      closeTimer = setTimeout(() => socket.terminate(), 1000);
      closeTimer.unref();
    }
    function post(message: ToWorker): void {
      if (!stopped) worker.postMessage(message);
    }
    timer = setTimeout(() => fail("VM worker did not become ready."), 5000);
    timer.unref();

    worker.on("message", (message: FromWorker) => {
      if (stopped) return;
      clearTimeout(timer);
      if (message.type === "busy") {
        timer = setTimeout(
          () => fail("Evolution exceeded its compute budget.", message.id),
          COMPUTE_TIMEOUT_MS,
        );
        timer.unref();
        return;
      }
      const bytes = Buffer.byteLength(message.payload);
      if (
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount + bytes > MAX_OUTBOUND_BYTES
      ) {
        fail(
          "Client is too slow to receive simulation snapshots.",
          undefined,
          1013,
        );
        return;
      }
      clearTimeout(deliveryTimer);
      deliveryTimer = setTimeout(
        () => fail("Snapshot delivery timed out.", undefined, 1013),
        5000,
      );
      deliveryTimer.unref();
      socket.send(message.payload, (error) => {
        clearTimeout(deliveryTimer);
        if (error) {
          fail("Snapshot delivery failed.");
          return;
        }
        if (message.token !== undefined)
          post({ type: "delivered", token: message.token });
      });
    });
    worker.on("error", (error) => {
      console.error(
        "[polyp:worker]",
        error instanceof Error ? error.message : error,
      );
      fail("VM worker failed.");
    });
    worker.on("exit", (code) => {
      workers.delete(worker);
      if (!stopped) fail(`VM worker exited unexpectedly (${code}).`);
    });
    socket.on("pong", () => {
      session.alive = true;
    });
    socket.on("error", () => {
      stop();
      // ws has already sent its protocol close (e.g. 1009 for maxPayload).
      // Give it time to reach the peer, but do not retain a half-closed socket.
      closeTimer = setTimeout(() => socket.terminate(), 1000);
      closeTimer.unref();
    });
    socket.on("close", () => {
      clearTimeout(closeTimer);
      stop();
    });
    socket.on("message", (raw, binary) => {
      if (stopped) return;
      const now = Date.now();
      tokens = Math.min(12, tokens + ((now - refilled) * 8) / 1000);
      refilled = now;
      if (tokens < 1) {
        fail("Command rate exceeded (8/sec, burst 12).", undefined, 1008);
        return;
      }
      tokens--;
      let value: unknown;
      try {
        if (binary) throw new Error("Commands must be JSON text, not binary.");
        value = JSON.parse(raw.toString());
        post({ type: "command", command: validateCommand(value) });
      } catch (error) {
        const response: EvolutionResponse = {
          type: "error",
          id: commandId(value),
          error: error instanceof Error ? error.message : "Invalid command.",
        };
        if (socket.bufferedAmount > MAX_OUTBOUND_BYTES) {
          fail("Client is too slow.", undefined, 1013);
          return;
        }
        socket.send(JSON.stringify(response));
      }
    });
  });
  const heartbeat = setInterval(() => {
    for (const [socket, session] of sessions) {
      if (!session.alive) {
        session.stop();
        socket.terminate();
      } else {
        session.alive = false;
        socket.ping();
      }
    }
  }, options.heartbeatMs ?? 30_000);
  heartbeat.unref();

  try {
    await new Promise<void>((resolveListen, reject) => {
      http.once("error", reject);
      http.listen(options.port ?? 4173, options.host ?? "0.0.0.0", () => {
        http.off("error", reject);
        resolveListen();
      });
    });
  } catch (error) {
    clearInterval(heartbeat);
    ws.close();
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a TCP listening address.");
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    return (closePromise ??= (async () => {
      closing = true;
      clearInterval(heartbeat);
      for (const [socket, session] of sessions) {
        session.stop();
        socket.terminate();
      }
      ws.close();
      const closed = new Promise<void>((done) => http.close(() => done()));
      http.closeAllConnections();
      await Promise.all([...stopping]);
      await closed;
    })());
  }
  return { http, port: address.port, close };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const port = Number(process.env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be from 1 through 65535.");
  const server = await startEvolutionServer({
    port,
    host: process.env.HOST ?? "0.0.0.0",
  });
  console.log(
    `[polyp:vm] HTTP + /api/evolution on port ${server.port}; up to ${MAX_WORKERS} Node worker threads`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void server
        .close()
        .then(() => {
          process.exitCode = 0;
        })
        .catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
    });
}
