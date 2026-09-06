/** Native Node integration tests: real TCP WebSockets, real threads, real engine. */
import { after, afterEach, before, test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseListenOptions } from "../scripts/listen-options.mjs";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startEvolutionServer, workspaceOrigins } from "./index.js";
import {
  evolve,
  fitness,
  simulate,
  PRESETS,
  type Simulation,
} from "../src/simulation";
import type {
  EvolutionCommand,
  EvolutionRequest,
  EvolutionResponse,
  SnapshotMessage,
  WireSimulation,
} from "../src/protocol";
import { MAX_COMMAND_BYTES } from "./validation";

let server: Awaited<ReturnType<typeof startEvolutionServer>>;
const clients = new Set<Client>();
const base = (): EvolutionRequest => ({
  type: "evaluate",
  id: 1,
  genome: [...PRESETS[0].genome],
  config: { size: 25, steps: 24, seed: "cross", randomSeed: 1729 },
  objective: "complexity",
  mutationRate: 0.18,
  randomSeed: 1234,
  epoch: 0,
});
const wire = (simulation: Simulation): WireSimulation => ({
  ...simulation,
  layers: simulation.layers.map((layer) =>
    Buffer.from(layer).toString("base64"),
  ),
});
async function until<T>(
  read: () => T | undefined | false,
  timeout = 5000,
): Promise<T> {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    await delay(5);
  }
  throw new Error("Timed out waiting for a real transport result.");
}
class Client {
  socket: WebSocket;
  messages: { message: EvolutionResponse; at: number }[] = [];
  closed: Promise<number>;
  constructor(
    port = server.port,
    options: { autoPong?: boolean; origin?: string } = {},
  ) {
    this.socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/evolution`,
      options,
    );
    this.socket.on("message", (data) =>
      this.messages.push({
        message: JSON.parse(data.toString()),
        at: Date.now(),
      }),
    );
    this.socket.on("error", () => {});
    this.closed = new Promise((resolve) => this.socket.once("close", resolve));
    clients.add(this);
  }
  async take<T extends EvolutionResponse["type"]>(type: T, id?: number) {
    return until(() => {
      const index = this.messages.findIndex(
        ({ message }) =>
          message.type === type &&
          (id === undefined || ("id" in message && message.id === id)),
      );
      if (index < 0) return undefined;
      return this.messages.splice(index, 1)[0] as {
        message: Extract<EvolutionResponse, { type: T }>;
        at: number;
      };
    });
  }
  send(command: EvolutionCommand) {
    this.socket.send(JSON.stringify(command));
  }
  async close() {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
    await this.closed;
    clients.delete(this);
  }
}
async function connect(
  port = server.port,
  options: { autoPong?: boolean; origin?: string } = {},
) {
  const client = new Client(port, options);
  const { message } = await client.take("ready");
  assert.equal(message.execution.kind, "node:worker_threads");
  assert.ok(
    message.execution.threadId > 0,
    "ready identifies an actual non-main thread",
  );
  return { client, execution: message.execution };
}
async function health(port = server.port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  return (await response.json()) as {
    workers: number;
    maxWorkers: number;
    execution: string;
  };
}
async function emptyWorkers(port = server.port) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await health(port)).workers === 0) return;
    await delay(10);
  }
  assert.fail("Disconnected worker threads did not terminate.");
}
function matchesEngine(snapshot: SnapshotMessage, request: EvolutionRequest) {
  const result =
    request.type === "evaluate"
      ? (() => {
          const simulation = simulate(request.genome, request.config);
          return {
            genome: request.genome,
            simulation,
            fitness: fitness(simulation, request.objective),
          };
        })()
      : evolve(
          request.genome,
          request.config,
          request.objective,
          request.mutationRate,
          request.randomSeed,
        );
  assert.deepEqual(snapshot.genome, result.genome);
  assert.deepEqual(snapshot.simulation, wire(result.simulation));
  assert.equal(snapshot.fitness, result.fitness);
  assert.deepEqual(snapshot.config, request.config);
  assert.equal(snapshot.id, request.id);
  assert.equal(
    snapshot.epoch,
    request.epoch + (request.type === "evaluate" ? 0 : 1),
  );
  assert.equal(
    snapshot.randomSeed,
    request.randomSeed + (request.type === "evaluate" ? 0 : 1),
  );
}

before(async () => {
  server = await startEvolutionServer({ port: 0, host: "127.0.0.1" });
});
afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  await emptyWorkers();
});
after(async () => {
  await server.close();
});

test("evaluation runs in a real VM thread, preserves the revision/epoch, and serializes every real layer", async () => {
  const { client, execution } = await connect();
  const request = { ...base(), epoch: 37, randomSeed: -42 };
  client.send(request);
  const { message } = await client.take("snapshot", request.id);
  matchesEngine(message, request);
  assert.deepEqual(message.execution, execution);
  assert.equal(message.running, false);
  assert.equal(message.simulation.layers.length, 24);
  assert.equal(Buffer.from(message.simulation.layers[0], "base64").length, 625);
  await delay(330);
  assert.equal(
    client.messages.filter(({ message }) => message.type === "snapshot").length,
    0,
  );
});

test("step is exactly one deterministic population-GA call, including changed genomes and improved fitness", async () => {
  const [{ client: first, execution: a }, { client: second, execution: b }] =
    await Promise.all([connect(), connect()]);
  assert.notEqual(a.threadId, b.threadId);
  const request: EvolutionRequest = {
    ...base(),
    type: "step",
    genome: Array(45).fill(0),
    mutationRate: 0.24,
    epoch: 8,
  };
  first.send(request);
  second.send({ ...request, id: 2 });
  const one = (await first.take("snapshot", 1)).message;
  const two = (await second.take("snapshot", 2)).message;
  matchesEngine(one, request);
  assert.deepEqual(one.genome, two.genome);
  assert.deepEqual(one.simulation, two.simulation);
  assert.equal(one.fitness, two.fitness);
  assert.notDeepEqual(one.genome, request.genome);
  assert.ok(
    one.fitness >
      fitness(simulate(request.genome, request.config), request.objective),
  );
  assert.equal(one.running, false);
  await delay(330);
  assert.equal(
    first.messages.filter(({ message }) => message.type === "snapshot").length,
    0,
  );
});

test("neutral drift survives the VM boundary: an equally fit genotype can replace the incumbent", async () => {
  const { client } = await connect();
  const request: EvolutionRequest = {
    ...base(),
    type: "step",
    genome: Array(45).fill(0),
    objective: "longevity",
    mutationRate: 0.02,
    randomSeed: 3,
    config: { ...base().config, seed: "point" },
  };
  client.send(request);
  const { message } = await client.take("snapshot", request.id);
  matchesEngine(message, request);
  assert.notDeepEqual(message.genome, request.genome);
  assert.equal(
    message.fitness,
    fitness(simulate(request.genome, request.config), "longevity"),
  );
});

test("start evolves the incumbent with incremented seeds, bounded cadence, and pause stops scheduling", async () => {
  const { client } = await connect();
  let request: EvolutionRequest = { ...base(), type: "start", epoch: 17 };
  client.send(request);
  const results: SnapshotMessage[] = [];
  let previousAt = 0;
  for (let count = 0; count < 3; count++) {
    const { message, at } = await client.take("snapshot", request.id);
    matchesEngine(message, request);
    assert.equal(message.running, true);
    if (previousAt)
      assert.ok(
        at - previousAt >= 140,
        `Snapshot cadence was ${at - previousAt}ms`,
      );
    previousAt = at;
    results.push(message);
    request = {
      ...request,
      genome: message.genome,
      epoch: message.epoch,
      randomSeed: message.randomSeed,
    };
  }
  assert.ok(
    results.some((result) => result.genome.join("") !== base().genome.join("")),
  );
  assert.ok(results[2].fitness >= results[0].fitness);
  client.send({ type: "pause", id: 90 });
  await client.take("paused", 90);
  const before = client.messages.length;
  await delay(350);
  assert.equal(client.messages.length, before);
});

test("pause and step are isolated per connection and replacement evaluate cancels an active run", async () => {
  const [{ client: first }, { client: second }] = await Promise.all([
    connect(),
    connect(),
  ]);
  first.send({ ...base(), type: "start" });
  second.send({ ...base(), type: "start", id: 20 });
  await first.take("snapshot", 1);
  await second.take("snapshot", 20);
  first.send({ type: "pause", id: 2 });
  await first.take("paused", 2);
  const count = first.messages.length;
  await second.take("snapshot", 20);
  assert.equal(first.messages.length, count);
  const step: EvolutionRequest = { ...base(), type: "step", id: 3, epoch: 123 };
  first.send(step);
  matchesEngine((await first.take("snapshot", 3)).message, step);
  const replacement: EvolutionRequest = {
    ...base(),
    id: 21,
    genome: [...PRESETS[2].genome],
    epoch: 56,
  };
  second.send(replacement);
  const evaluated = (await second.take("snapshot", 21)).message;
  matchesEngine(evaluated, replacement);
  assert.equal(evaluated.running, false);
  const queued = second.messages.length;
  await delay(350);
  assert.equal(second.messages.length, queued);
});

test("a burst of revisions coalesces to the newest command rather than queuing CPU work", async () => {
  const { client } = await connect();
  for (let id = 1; id <= 8; id++) client.send({ ...base(), type: "start", id });
  await client.take("snapshot", 8);
  client.send({ type: "pause", id: 9 });
  await client.take("paused", 9);
  assert.ok(
    client.messages.filter(({ message }) => message.type === "snapshot")
      .length < 8,
  );
});

test("all supported world sizes/depths and boundary mutation rates retain engine semantics", async () => {
  const { client } = await connect();
  for (const [index, size] of [25, 33, 41, 49].entries()) {
    const request: EvolutionRequest = {
      ...base(),
      id: index,
      config: {
        ...base().config,
        size,
        steps: [24, 32, 48, 64][index],
        randomSeed: -2024,
      },
    };
    client.send(request);
    matchesEngine((await client.take("snapshot", index)).message, request);
  }
  for (const mutationRate of [0, 1]) {
    const request: EvolutionRequest = {
      ...base(),
      type: "step",
      id: mutationRate + 10,
      mutationRate,
    };
    client.send(request);
    matchesEngine((await client.take("snapshot", request.id)).message, request);
  }
});

const invalidCases: [string, unknown][] = [
  ["null", null],
  ["array", []],
  ["missing fields", { type: "step", id: 5 }],
  ["unknown command", { ...base(), type: "mutate" }],
  ["negative revision", { ...base(), id: -1 }],
  ["fractional revision", { ...base(), id: 0.5 }],
  ["unknown fields", { ...base(), surprise: true }],
  ["pause payload", { type: "pause", id: 5, genome: [] }],
  ["short genome", { ...base(), genome: Array(44).fill(0) }],
  ["long genome", { ...base(), genome: Array(46).fill(0) }],
  ["nonquiescent void", { ...base(), genome: [1, ...Array(44).fill(0)] }],
  ["fractional gene", { ...base(), genome: [0, 1.5, ...Array(43).fill(0)] }],
  ["sixth state", { ...base(), genome: [0, 5, ...Array(43).fill(0)] }],
  ["negative state", { ...base(), genome: [0, -1, ...Array(43).fill(0)] }],
  ["string state", { ...base(), genome: [0, "1", ...Array(43).fill(0)] }],
  [
    "unbounded world",
    { ...base(), config: { ...base().config, size: 1_000_000 } },
  ],
  ["unsupported world", { ...base(), config: { ...base().config, size: 27 } }],
  [
    "unbounded depth",
    { ...base(), config: { ...base().config, steps: 1_000_000 } },
  ],
  ["unsupported depth", { ...base(), config: { ...base().config, steps: 25 } }],
  [
    "unknown seed form",
    { ...base(), config: { ...base().config, seed: "random" } },
  ],
  [
    "unsafe seed fixture",
    {
      ...base(),
      config: { ...base().config, randomSeed: Number.MAX_SAFE_INTEGER + 1 },
    },
  ],
  [
    "unknown config fields",
    { ...base(), config: { ...base().config, extra: 1 } },
  ],
  ["unknown objective", { ...base(), objective: "fame" }],
  ["negative mutation rate", { ...base(), mutationRate: -0.1 }],
  ["oversize mutation rate", { ...base(), mutationRate: 1.01 }],
  ["null mutation rate", { ...base(), mutationRate: null }],
  ["fractional evolution seed", { ...base(), randomSeed: 0.1 }],
  ["null evolution seed", { ...base(), randomSeed: null }],
  ["negative epoch", { ...base(), epoch: -1 }],
  ["exhausted epoch", { ...base(), epoch: Number.MAX_SAFE_INTEGER }],
];
for (const [name, value] of invalidCases)
  test(`rejects ${name} over WebSocket without poisoning the worker`, async () => {
    const { client } = await connect();
    client.socket.send(JSON.stringify(value));
    const { message } = await client.take("error");
    assert.ok(message.error.length > 0);
    if (value && typeof value === "object" && "id" in value && value.id === 1)
      assert.equal(message.id, 1);
    const valid = { ...base(), id: 77 };
    client.send(valid);
    matchesEngine((await client.take("snapshot", 77)).message, valid);
  });

test("malformed JSON and binary input are rejected without losing server health", async () => {
  const { client } = await connect();
  client.socket.send("{");
  await client.take("error");
  client.socket.send(Buffer.from("{}"));
  await client.take("error");
  client.send(base());
  await client.take("snapshot", 1);
  assert.equal((await health()).workers, 1);
});

test("oversize frames are closed before allocating worker input", async () => {
  const { client } = await connect();
  client.socket.send(" ".repeat(MAX_COMMAND_BYTES + 1));
  const code = await client.closed;
  assert.equal(code, 1009);
  await emptyWorkers();
  const { client: healthy } = await connect();
  healthy.send(base());
  await healthy.take("snapshot", 1);
});

test("command flooding is closed with a policy violation instead of an unbounded thread queue", async () => {
  const { client } = await connect();
  for (let id = 0; id < 40; id++) client.send({ type: "pause", id });
  assert.equal(await client.closed, 1008);
  assert.match((await client.take("error")).message.error, /rate exceeded/);
  await emptyWorkers();
});

async function rejectedUpgrade(
  port: number,
  path = "/api/evolution",
  origin?: string,
) {
  return await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode!);
    });
    socket.on("error", () => {});
    socket.on("open", () => {
      socket.terminate();
      reject(new Error("Unexpected accepted connection"));
    });
  });
}

test("exactly four actual workers are admitted; HTTP remains responsive while they evolve", async () => {
  const connected = await Promise.all([
    connect(),
    connect(),
    connect(),
    connect(),
  ]);
  assert.equal(
    new Set(connected.map(({ execution }) => execution.threadId)).size,
    4,
  );
  assert.equal((await health()).workers, 4);
  assert.equal(await rejectedUpgrade(server.port), 503);
  for (const { client } of connected)
    client.send({
      ...base(),
      type: "start",
      config: { ...base().config, size: 49, steps: 64 },
      mutationRate: 1,
    });
  await Promise.all(connected.map(({ client }) => client.take("snapshot", 1)));
  const started = Date.now();
  assert.equal((await health()).workers, 4);
  assert.ok(
    Date.now() - started < 1000,
    "HTTP is not blocked behind the simulation loop",
  );
});

test("disconnect terminates an evolving thread, frees capacity, and leaves subsequent science healthy", async () => {
  const { client } = await connect();
  client.send({
    ...base(),
    type: "start",
    config: { ...base().config, size: 49, steps: 64 },
  });
  await client.take("snapshot", 1);
  await client.close();
  await emptyWorkers();
  const { client: replacement } = await connect();
  replacement.send(base());
  matchesEngine((await replacement.take("snapshot", 1)).message, base());
});

test("same-origin upgrade is accepted; unrelated origins and unknown API paths are rejected", async () => {
  assert.equal(
    await rejectedUpgrade(
      server.port,
      "/api/evolution",
      "https://unrelated.example",
    ),
    403,
  );
  assert.equal(await rejectedUpgrade(server.port, "/api/unknown"), 404);
  await connect(server.port, { origin: `http://127.0.0.1:${server.port}` });
});

test("workspace origin aliases are exact, port-scoped, and include Vite only for the configured dev backend", () => {
  const env = {
    WORKSPACE_SHORT_ID: "owned-space",
    SOFT_MACHINE_PORT_FORWARDING_DOMAIN: "workspaces.example",
  };
  assert.deepEqual(
    [...workspaceOrigins(4173, env)],
    ["https://4173-owned-space.workspaces.example"],
  );
  assert.deepEqual(
    [...workspaceOrigins(8787, env)],
    [
      "https://8787-owned-space.workspaces.example",
      "https://5173-owned-space.workspaces.example",
    ],
  );
  assert.deepEqual(
    [
      ...workspaceOrigins(9876, {
        ...env,
        API_PORT: "9876",
        CLIENT_PORT: "5678",
      }),
    ],
    [
      "https://9876-owned-space.workspaces.example",
      "https://5678-owned-space.workspaces.example",
    ],
  );
  assert.equal(workspaceOrigins(4173, {}).size, 0);
  assert.equal(
    workspaceOrigins(4173, { ...env, WORKSPACE_SHORT_ID: "*.example" }).size,
    0,
  );
});

test("a trusted HTTPS gateway origin works even when BOTH Host headers are rewritten, without allowing other sites", async () => {
  const publicOrigin = "https://4173-owned-space.workspaces.example";
  const isolated = await startEvolutionServer({
    port: 0,
    host: "127.0.0.1",
    publicOrigin,
  });
  try {
    assert.equal(
      await rejectedUpgrade(
        isolated.port,
        "/api/evolution",
        "https://4173-other-space.workspaces.example",
      ),
      403,
    );
    assert.equal(
      await rejectedUpgrade(
        isolated.port,
        "/api/evolution",
        "https://5173-owned-space.workspaces.example",
      ),
      403,
    );
    assert.equal(
      await rejectedUpgrade(
        isolated.port,
        "/api/evolution",
        "https://4173-owned-space.workspaces.example.attacker.example",
      ),
      403,
    );
    assert.equal(
      await rejectedUpgrade(isolated.port, "/api/evolution", "null"),
      403,
    );
    const { client } = await connect(isolated.port, { origin: publicOrigin });
    client.send(base());
    matchesEngine((await client.take("snapshot", 1)).message, base());
    await client.close();
    await emptyWorkers(isolated.port);
  } finally {
    await isolated.close();
  }
});

test("missed heartbeat terminates the abandoned socket AND its actual worker", async () => {
  const isolated = await startEvolutionServer({
    port: 0,
    host: "127.0.0.1",
    heartbeatMs: 100,
  });
  try {
    const { client } = await connect(isolated.port, { autoPong: false });
    await client.closed;
    await emptyWorkers(isolated.port);
  } finally {
    await isolated.close();
  }
});

test("production serves static dist safely and shutdown closes live workers and sockets", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "polyp-server-"));
  await writeFile(
    join(fixture, "index.html"),
    "<!doctype html><h1>Polyp test fixture</h1>",
  );
  await writeFile(join(fixture, "app.js"), "export const fixture = true;");
  const isolated = await startEvolutionServer({
    port: 0,
    host: "127.0.0.1",
    distDir: fixture,
  });
  const url = `http://127.0.0.1:${isolated.port}`;
  try {
    const index = await fetch(url);
    assert.match(await index.text(), /Polyp test fixture/);
    assert.match(index.headers.get("content-type")!, /text\/html/);
    const asset = await fetch(`${url}/app.js`, { method: "HEAD" });
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "");
    assert.match(asset.headers.get("content-type")!, /javascript/);
    assert.equal((await fetch(`${url}/missing.js`)).status, 404);
    assert.equal((await fetch(`${url}/%2e%2e%2fsecret.txt`)).status, 403);
    assert.equal((await fetch(`${url}/api/nope`)).status, 404);
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
    const { client } = await connect(isolated.port);
    client.send({ ...base(), type: "start" });
    await client.take("snapshot", 1);
    await isolated.close();
    await client.closed;
    await isolated.close(); // Idempotent signal cleanup.
    await assert.rejects(fetch(`${url}/api/health`));
  } finally {
    await isolated.close();
    await rm(fixture, { recursive: true, force: true });
  }
});

test("preview and dev launchers honor explicit listening flags instead of silently using a different port", () => {
  assert.deepEqual(
    parseListenOptions(["--port", "3000", "--strictPort"], { port: "4173" }),
    { port: 3000, host: "0.0.0.0" },
  );
  assert.deepEqual(
    parseListenOptions(["--port=3001", "--host=127.0.0.1"], { port: "5173" }),
    { port: 3001, host: "127.0.0.1" },
  );
  assert.deepEqual(
    parseListenOptions(["-p", "3002", "--host"], {
      port: 4173,
      host: "localhost",
    }),
    { port: 3002, host: "0.0.0.0" },
  );
  assert.deepEqual(parseListenOptions([], { port: "8787", host: "::1" }), {
    port: 8787,
    host: "::1",
  });
  for (const args of [
    ["--port"],
    ["--port=0"],
    ["--port=65536"],
    ["--port=3.5"],
    ["--port=oops"],
    ["--host="],
    ["--typo"],
  ]) {
    assert.throws(
      () => parseListenOptions(args, { port: 4173 }),
      args.join(" "),
    );
  }
});

test("the actual preview CLI serves the VM health and evolutionary WebSocket on its requested port", async () => {
  const reservation = await startEvolutionServer({
    port: 0,
    host: "127.0.0.1",
  });
  const port = reservation.port;
  await reservation.close();
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [entry, "--port", String(port), "--host", "127.0.0.1", "--strictPort"],
    {
      env: { ...process.env, PORT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const ended = new Promise<number | null>((resolveExit, reject) => {
    child.once("exit", resolveExit);
    child.once("error", reject);
  });
  let client: Client | undefined;
  try {
    await until(() => {
      assert.equal(child.exitCode, null, output);
      return output.includes(`on port ${port};`);
    });
    const status = await health(port);
    assert.equal(status.execution, "node:worker_threads");
    ({ client } = await connect(port));
    const command = { ...base(), type: "step" as const };
    client.send(command);
    const { message } = await client.take("snapshot", command.id);
    const expected = evolve(
      command.genome,
      command.config,
      command.objective,
      command.mutationRate,
      command.randomSeed,
    );
    assert.equal(message.epoch, 1);
    assert.ok(message.execution.threadId > 0);
    assert.equal(message.fitness, expected.fitness);
    assert.deepEqual(message.genome, expected.genome);
    assert.deepEqual(message.simulation, wire(expected.simulation));
  } finally {
    await client?.close();
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    const code = await ended;
    clearTimeout(force);
    assert.equal(code, 0, output);
  }
});
