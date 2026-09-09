import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { parseListenOptions } from "../scripts/listen-options.mjs";
import {
  MODEL_VERSION,
  type ResearchEvent,
  type RunAction,
} from "../src/research/types";
import { RunManager, type ManagerOptions } from "./manager";
import { PreviewService, PREVIEW_TIMEOUT_MS } from "./preview";
import { validatePreviewRange } from "../src/research/sample";
import {
  MAX_BODY_BYTES,
  MAX_COMMAND_BYTES,
  MAX_OUTBOUND_BYTES,
  HttpError,
  fields,
  genome,
  optionalBoolean,
  runName,
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
// Negotiated transport compression only; decoded messages and payload bounds stay
// unchanged. No retained dictionaries across frames/clients, at most four zlib jobs.
const WS_COMPRESSION = {
  zlibDeflateOptions: { level: 1 },
  threshold: 1024,
  concurrencyLimit: 4,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
};
export function workspaceOrigins(
  port: number,
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const origins = new Set<string>();
  const id = env.WORKSPACE_SHORT_ID,
    domain = env.SOFT_MACHINE_PORT_FORWARDING_DOMAIN ?? "soft-machine.io";
  if (!id || !/^[a-z0-9-]+$/i.test(id) || !/^[a-z0-9.-]+$/i.test(domain))
    return origins;
  origins.add(`https://${port}-${id}.${domain}`);
  if (port === Number(env.API_PORT ?? 8787)) {
    const client = Number(env.CLIENT_PORT ?? 5173);
    if (Number.isInteger(client) && client >= 1024 && client <= 65535)
      origins.add(`https://${client}-${id}.${domain}`);
  }
  return origins;
}
export interface ServerOptions extends Partial<ManagerOptions> {
  port?: number;
  host?: string;
  distDir?: string;
  publicOrigin?: string;
  publicOrigins?: readonly string[];
  heartbeatMs?: number;
  apiUpstream?: string;
}
function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": MIME[".json"],
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? ""))
    throw new HttpError(415, "Use Content-Type: application/json.");
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, "JSON body exceeds the 16 MiB limit.");
  }
  return new Promise((done, reject) => {
    let bytes = 0,
      failed = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, "JSON body exceeds the 16 MiB limit."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      try {
        done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Malformed JSON body."));
      }
    });
    req.on("error", () =>
      reject(new HttpError(400, "Request body interrupted.")),
    );
    req.on("aborted", () =>
      reject(new HttpError(400, "Request body interrupted.")),
    );
  });
}
function upstreamUrl(input: string): URL {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "API_UPSTREAM must be a loopback HTTP(S) origin, e.g. http://127.0.0.1:3000.",
    );
  return url;
}
export async function startResearchServer(options: ServerOptions = {}) {
  const distDir = resolve(options.distDir ?? resolve(here, "../dist"));
  const upstream = options.apiUpstream ?? process.env.API_UPSTREAM;
  const target = upstream ? upstreamUrl(upstream) : null;
  const numberEnv = (name: string): number | undefined =>
    process.env[name] === undefined ? undefined : Number(process.env[name]);
  // Proxy mode does not even construct a manager, open a datastore, or own jobs.
  const manager = target
    ? null
    : new RunManager({
        dataDir:
          options.dataDir ??
          process.env.POLYP_RUNS_DIR ??
          resolve(here, "../.polyp/research"),
        maxEvaluationWorkers:
          options.maxEvaluationWorkers ??
          numberEnv("POLYP_MAX_EVALUATION_WORKERS"),
        maxRuns: options.maxRuns ?? numberEnv("POLYP_MAX_ACTIVE_RUNS"),
        cpuBudget: options.cpuBudget ?? numberEnv("POLYP_CPU_BUDGET"),
        maxMemoryBytes: options.maxMemoryBytes,
      });
  const previews = manager ? new PreviewService() : null;
  if (manager) await manager.open();
  let closing = false;
  const subscriptions = new Map<
    WebSocket,
    { runId: string | null; alive: boolean; tokens: number; refilled: number }
  >();
  const proxyPeers = new Set<WebSocket>();
  const http = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    void serve(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof RangeError || error instanceof SyntaxError
            ? 400
            : 500;
      if (status === 500) console.error("[polyp:http]", error);
      json(
        res,
        { error: error instanceof Error ? error.message : "Request failed." },
        status,
      );
    });
  });
  http.requestTimeout = 20_000;
  http.headersTimeout = 10_000;
  http.keepAliveTimeout = 5_000;
  http.maxRequestsPerSocket = 100;
  const ws = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_COMMAND_BYTES,
    perMessageDeflate: WS_COMPRESSION,
  });
  const actualPort = () => {
    const address = http.address();
    return address && typeof address !== "string"
      ? address.port
      : (options.port ?? 4173);
  };
  function trustedOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return req.headers["sec-fetch-site"] !== "cross-site";
    try {
      const parsed = new URL(origin);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.origin !== origin
      )
        return false;
      const aliases = workspaceOrigins(actualPort());
      const explicit = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
      if (explicit) aliases.add(explicit);
      for (const allowed of options.publicOrigins ?? (process.env.PUBLIC_ORIGINS ?? "").split(","))
        if (allowed.trim()) aliases.add(allowed.trim());
      // Do not trust arbitrary X-Forwarded-Host. Known gateway aliases are exact.
      return parsed.host === req.headers.host || aliases.has(origin);
    } catch {
      return false;
    }
  }
  const ipRates = new Map<string, { tokens: number; at: number }>();
  function rate(req: IncomingMessage): void {
    const key = req.socket.remoteAddress ?? "local",
      at = Date.now();
    const item = ipRates.get(key) ?? { tokens: 60, at };
    item.tokens = Math.min(60, item.tokens + ((at - item.at) / 1000) * 20);
    item.at = at;
    if (ipRates.size > 512 && !ipRates.has(key))
      ipRates.delete(ipRates.keys().next().value!);
    ipRates.set(key, item);
    if (item.tokens < 1)
      throw new HttpError(429, "Request rate exceeded; retry shortly.");
    item.tokens--;
  }
  async function proxyHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!target) return;
    await new Promise<void>((done) => {
      let tooLarge = false;
      const headers: IncomingMessage["headers"] = {
        ...req.headers,
        host: target.host,
      };
      delete headers["x-forwarded-host"];
      delete headers["x-forwarded-proto"];
      if (headers.origin) headers.origin = target.origin;
      const request = (
        target.protocol === "https:" ? httpsRequest : httpRequest
      )(
        new URL(req.url!, target),
        { method: req.method, headers },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
          response.on("end", done);
        },
      );
      request.setTimeout(PREVIEW_TIMEOUT_MS + 5000, () =>
        request.destroy(new Error("Canonical API timed out.")),
      );
      request.on("error", () => {
        if (!res.headersSent)
          json(
            res,
            {
              error: tooLarge
                ? "JSON body exceeds the 16 MiB limit."
                : "Canonical research API is unavailable.",
            },
            tooLarge ? 413 : 502,
          );
        else res.destroy();
        done();
      });
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          tooLarge = true;
          request.destroy(new Error("Body too large."));
        }
      });
      req.on("aborted", () => request.destroy());
      res.on("close", () => request.destroy());
      req.pipe(request);
    });
  }
  async function serve(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (closing) throw new HttpError(503, "Server is shutting down.");
    let pathname: string;
    try {
      pathname = decodeURIComponent(
        new URL(req.url ?? "/", "http://local").pathname,
      );
    } catch {
      throw new HttpError(400, "Invalid URL.");
    }
    if (pathname.startsWith("/api/")) {
      if (!["GET", "POST", "HEAD"].includes(req.method ?? ""))
        throw new HttpError(405, "Use GET or POST.");
      if (req.method === "POST") {
        if (!trustedOrigin(req))
          throw new HttpError(403, "Origin is not allowed.");
        rate(req);
      }
      if (target) return proxyHttp(req, res);
      if (pathname === "/api/health" && req.method === "GET")
        return json(res, {
          status: "ok",
          execution: "node:worker_threads",
          workers: manager!.totalWorkers + previews!.workerCount,
          evaluationWorkers: manager!.allocatedWorkers,
          activeRuns: manager!.activeRuns,
          queuedRuns: manager!
            .list()
            .runs.filter((run) => run.status === "queued").length,
          storedRuns: manager!.list().runs.length,
          maxWorkers: manager!.maxEvaluationWorkers,
          cpuBudget: manager!.cpuBudget,
          memory: {
            reservedBytes: manager!.reservedMemoryBytes,
            limitBytes: manager!.maxMemoryBytes,
          },
          modelVersion: MODEL_VERSION,
          capacity: manager!.list().capacity,
          recoveryErrors: manager!.store.recoveryErrors,
        });
      if (pathname === "/api/runs") {
        if (req.method === "GET") return json(res, manager!.list());
        if (req.method === "POST") {
          const input = await body(req);
          fields(input, ["config", "start"], ["config"]);
          return json(
            res,
            await manager!.create(input.config, optionalBoolean(input.start)),
            201,
          );
        }
      }
      if (pathname === "/api/runs/import" && req.method === "POST") {
        const input = await body(req);
        fields(input, ["checkpoint", "name", "start"], ["checkpoint"]);
        try {
          return json(
            res,
            await manager!.import(
              input.checkpoint,
              input.name === undefined ? undefined : runName(input.name),
              optionalBoolean(input.start),
            ),
            201,
          );
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(
            400,
            error instanceof Error ? error.message : "Invalid checkpoint.",
          );
        }
      }
      const match =
        /^\/api\/runs\/([a-f0-9-]{36})(?:\/(actions|checkpoint|fork|metrics\.csv|preview|generations\/(\d+)))?$/.exec(
          pathname,
        );
      if (!match) throw new HttpError(404, "API route not found.");
      const [, id, path, generation] = match;
      if (!path && req.method === "GET") return json(res, manager!.detail(id));
      if (path === "actions" && req.method === "POST") {
        const input = await body(req);
        fields(input, ["action"], ["action"]);
        if (
          !["start", "pause", "step", "checkpoint", "archive"].includes(
            input.action as string,
          )
        )
          throw new HttpError(400, "Unknown run action.");
        return json(res, await manager!.action(id, input.action as RunAction));
      }
      if (path === "checkpoint" && req.method === "GET") {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="polyp-${id}.json"`,
        );
        return json(res, manager!.checkpoint(id));
      }
      if (path === "fork" && req.method === "POST") {
        const input = await body(req);
        fields(input, ["name", "start"]);
        return json(
          res,
          await manager!.fork(
            id,
            input.name === undefined ? undefined : runName(input.name),
            optionalBoolean(input.start),
          ),
          201,
        );
      }
      if (generation !== undefined && req.method === "GET") {
        const n = Number(generation);
        if (!Number.isSafeInteger(n))
          throw new HttpError(400, "Invalid generation.");
        return json(res, manager!.generation(id, n));
      }
      if (path === "metrics.csv" && req.method === "GET") {
        const detail = manager!.detail(id);
        const keys = [
          "generation",
          "best",
          "mean",
          "worst",
          "median",
          "bestEver",
          "validationBest",
          "diversity",
          "uniqueGenomes",
          "evaluations",
          "cacheHits",
          "elapsedMs",
          "generationMs",
          "evalsPerSecond",
        ] as const;
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="polyp-${id}-retained-metrics.csv"`,
          "Cache-Control": "no-store",
          "X-History-Limit": "4096",
          "X-History-First-Generation": String(
            detail.history[0]?.generation ?? "",
          ),
          "X-History-Last-Generation": String(
            detail.history.at(-1)?.generation ?? "",
          ),
        });
        res.end(
          keys.join(",") +
            "\n" +
            detail.history
              .map((point) => keys.map((key) => point[key] ?? "").join(","))
              .join("\n") +
            "\n",
        );
        return;
      }
      if (path === "preview" && req.method === "POST") {
        const input = await body(req);
        fields(input, ["genome", "seed", "range"], ["genome", "seed"]);
        genome(input.genome, manager!.detail(id).config.stateCount);
        if (!Number.isSafeInteger(input.seed))
          throw new HttpError(400, "Preview seed must be a safe integer.");
        return json(
          res,
          await previews!.preview(
            input.genome,
            manager!.detail(id).config,
            input.seed as number,
            validatePreviewRange(input.range, manager!.detail(id).config.steps),
          ),
        );
      }
      throw new HttpError(405, "Method is not allowed for this route.");
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new HttpError(405, "Static files use GET or HEAD.");
    let path = resolve(distDir, "." + pathname);
    if (
      (path !== distDir && !path.startsWith(distDir + sep)) ||
      pathname.includes("\0")
    )
      throw new HttpError(403, "Forbidden path.");
    if (pathname === "/") path = resolve(distDir, "index.html");
    let info = await stat(path).catch(() => null);
    if (!info?.isFile() && !extname(pathname)) {
      path = resolve(distDir, "index.html");
      info = await stat(path).catch(() => null);
    }
    if (!info?.isFile())
      throw new HttpError(
        404,
        "Not found. Build the client with npm run build.",
      );
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
  const send = (socket: WebSocket, event: ResearchEvent | string): void => {
    if (
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > MAX_OUTBOUND_BYTES
    )
      return;
    const payload = typeof event === "string" ? event : JSON.stringify(event);
    // Observers drop stale publications. They never ACK or control training.
    if (
      socket.bufferedAmount + Buffer.byteLength(payload) <=
      MAX_OUTBOUND_BYTES
    )
      socket.send(payload, () => {});
  };
  http.on("upgrade", (req, socket, head) => {
    const reject = (code: number) =>
      socket.end(
        `HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    if (closing) {
      reject(503);
      return;
    }
    if (req.url !== "/api/research/ws") {
      reject(404);
      return;
    }
    if (!trustedOrigin(req)) {
      reject(403);
      return;
    }
    if (ws.clients.size >= 64) {
      reject(503);
      return;
    }
    ws.handleUpgrade(req, socket, head, (client) =>
      ws.emit("connection", client, req),
    );
  });
  ws.on("connection", (socket: WebSocket) => {
    if (target) {
      const upstreamSocket = new WebSocket(
        new URL("/api/research/ws", target).href.replace(/^http/, "ws"),
        {
          origin: target.origin,
          maxPayload: MAX_OUTBOUND_BYTES,
          perMessageDeflate: WS_COMPRESSION,
        },
      );
      proxyPeers.add(upstreamSocket);
      const pending: (Buffer | string)[] = [];
      upstreamSocket.on("open", () => {
        for (const data of pending.splice(0)) upstreamSocket.send(data);
      });
      socket.on("message", (data, binary) => {
        if (binary) {
          socket.close(1003, "JSON text required.");
          return;
        }
        if (upstreamSocket.readyState === WebSocket.OPEN)
          upstreamSocket.send(data.toString());
        else if (pending.length < 4) pending.push(data.toString());
        else socket.close(1008, "Too many pending subscriptions.");
      });
      upstreamSocket.on("message", (data) => {
        if (
          socket.readyState === WebSocket.OPEN &&
          socket.bufferedAmount + data.toString().length <= MAX_OUTBOUND_BYTES
        )
          socket.send(data.toString());
      });
      upstreamSocket.on("error", () =>
        socket.close(1011, "Canonical API unavailable."),
      );
      upstreamSocket.on("close", () => {
        proxyPeers.delete(upstreamSocket);
        socket.close();
      });
      socket.on("error", () => upstreamSocket.terminate());
      socket.on("close", () => upstreamSocket.terminate());
      return;
    }
    const sub = {
      runId: null as string | null,
      alive: true,
      tokens: 12,
      refilled: Date.now(),
    };
    subscriptions.set(socket, sub);
    send(socket, {
      type: "hello",
      modelVersion: MODEL_VERSION,
      capacity: manager!.list().capacity,
    });
    send(socket, { type: "runs", ...manager!.list() });
    socket.on("pong", () => {
      sub.alive = true;
    });
    socket.on("close", () => subscriptions.delete(socket));
    socket.on("error", () => {
      subscriptions.delete(socket);
      socket.terminate();
    });
    socket.on("message", (raw, binary) => {
      const at = Date.now();
      sub.tokens = Math.min(12, sub.tokens + ((at - sub.refilled) / 1000) * 8);
      sub.refilled = at;
      if (sub.tokens < 1) {
        socket.close(1008, "Subscription rate exceeded.");
        return;
      }
      sub.tokens--;
      try {
        if (binary) throw new Error("Use JSON text subscriptions.");
        const input: unknown = JSON.parse(raw.toString());
        fields(input, ["type", "runId"], ["type", "runId"]);
        if (
          input.type !== "subscribe" ||
          (input.runId !== null && typeof input.runId !== "string")
        )
          throw new Error(
            "WebSocket is observer-only; send {type:subscribe, runId:string|null}.",
          );
        if (input.runId !== null) {
          const detail = manager!.detail(input.runId);
          sub.runId = input.runId;
          send(socket, { type: "run", runId: input.runId, detail });
        } else sub.runId = null;
      } catch (error) {
        send(socket, {
          type: "error",
          error:
            error instanceof Error ? error.message : "Invalid subscription.",
        });
      }
    });
  });
  // Publication cadence is independent of GA speed and of every socket's delivery.
  const publish = setInterval(() => {
    if (!manager || !subscriptions.size) return;
    const list = JSON.stringify({ type: "runs", ...manager.list() });
    const details = new Map<string, string>();
    for (const [socket, sub] of subscriptions) {
      send(socket, list);
      if (sub.runId && socket.bufferedAmount < MAX_OUTBOUND_BYTES) {
        if (!details.has(sub.runId))
          details.set(
            sub.runId,
            JSON.stringify({
              type: "run",
              runId: sub.runId,
              detail: manager.detail(sub.runId),
            }),
          );
        send(socket, details.get(sub.runId)!);
      }
    }
  }, 500);
  publish.unref();
  const heartbeat = setInterval(() => {
    for (const [socket, sub] of subscriptions) {
      if (!sub.alive) socket.terminate();
      else {
        sub.alive = false;
        socket.ping();
      }
    }
  }, options.heartbeatMs ?? 30_000);
  heartbeat.unref();
  try {
    await new Promise<void>((done, reject) => {
      http.once("error", reject);
      http.listen(options.port ?? 4173, options.host ?? "0.0.0.0", () => {
        http.off("error", reject);
        done();
      });
    });
  } catch (error) {
    clearInterval(publish);
    clearInterval(heartbeat);
    ws.close();
    await previews?.close();
    await manager?.close();
    throw error;
  }
  if (target && Number(target.port) === actualPort()) {
    http.close();
    await previews?.close();
    await manager?.close();
    clearInterval(publish);
    clearInterval(heartbeat);
    ws.close();
    throw new Error("API_UPSTREAM cannot point to this listening port.");
  }
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= (async () => {
      closing = true;
      clearInterval(publish);
      clearInterval(heartbeat);
      for (const socket of ws.clients) socket.terminate();
      for (const socket of proxyPeers) socket.terminate();
      ws.close();
      const ended = new Promise<void>((done) => http.close(() => done()));
      http.closeAllConnections();
      await Promise.all([manager?.close(), previews?.close()]);
      await ended;
    })());
  return { http, port: actualPort(), manager, close };
}
// Preserve the previous programmatic entry name for scripts, not the ephemeral API.
export const startEvolutionServer = startResearchServer;
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const options = parseListenOptions(process.argv.slice(2), {
    port: process.env.PORT ?? 4173,
    host: process.env.HOST ?? "0.0.0.0",
  });
  const server = await startResearchServer(options);
  console.log(
    `[polyp:vm] HTTP + /api/research/ws on port ${server.port}; ${server.manager ? "persistent node:worker_threads research manager" : "proxy to canonical " + process.env.API_UPSTREAM}`,
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
