import { parentPort, threadId } from "node:worker_threads";
import { evolve, fitness, simulate } from "../src/simulation";
import type {
  EvolutionCommand,
  EvolutionRequest,
  EvolutionResponse,
  Execution,
  SnapshotMessage,
} from "../src/protocol";
import { EPOCH_INTERVAL_MS, validateCommand } from "./validation";

/** Private parent/thread transport. JSON serialization and all science stay here. */
export type ToWorker =
  | { type: "command"; command: EvolutionCommand }
  | { type: "delivered"; token: number };
export type FromWorker =
  | { type: "busy"; id: number }
  | { type: "result"; payload: string; token?: number };

if (!parentPort || threadId <= 0)
  throw new Error("Evolution must execute in a Node worker thread.");
const port = parentPort;
const execution: Execution = { kind: "node:worker_threads", threadId };
let active: EvolutionRequest | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;
let lastFinished = -Infinity;

function emit(message: EvolutionResponse, token?: number): void {
  port.postMessage({
    type: "result",
    payload: JSON.stringify(message),
    token,
  } satisfies FromWorker);
}
function cancel(): void {
  clearTimeout(timer);
  timer = undefined;
  active = null;
  revision++;
}
function schedule(token: number): void {
  clearTimeout(timer);
  timer = setTimeout(
    () => compute(token),
    Math.max(0, lastFinished + EPOCH_INTERVAL_MS - Date.now()),
  );
}
function compute(token: number): void {
  timer = undefined;
  if (!active || token !== revision) return;
  const command = active;
  try {
    port.postMessage({ type: "busy", id: command.id } satisfies FromWorker);
    const result =
      command.type === "evaluate"
        ? (() => {
            const simulation = simulate(command.genome, command.config);
            return {
              genome: command.genome,
              simulation,
              fitness: fitness(simulation, command.objective),
            };
          })()
        : evolve(
            command.genome,
            command.config,
            command.objective,
            command.mutationRate,
            command.randomSeed,
          );
    const evolving = command.type !== "evaluate";
    const epoch = command.epoch + (evolving ? 1 : 0);
    const randomSeed = evolving
      ? command.randomSeed === Number.MAX_SAFE_INTEGER
        ? 0
        : command.randomSeed + 1
      : command.randomSeed;
    const running = command.type === "start" && epoch < Number.MAX_SAFE_INTEGER;
    const snapshot: SnapshotMessage = {
      type: "snapshot",
      id: command.id,
      genome: result.genome,
      config: command.config,
      simulation: {
        ...result.simulation,
        layers: result.simulation.layers.map((layer) =>
          Buffer.from(layer).toString("base64"),
        ),
      },
      epoch,
      fitness: result.fitness,
      randomSeed,
      running,
      execution,
    };
    active = running
      ? { ...command, genome: result.genome, epoch, randomSeed }
      : null;
    // Next iteration waits for actual transport delivery, not an unbounded queue.
    emit(snapshot, token);
  } catch (error) {
    active = null;
    emit(
      {
        type: "error",
        id: command.id,
        error: error instanceof Error ? error.message : "Evolution failed.",
      },
      token,
    );
  } finally {
    lastFinished = Date.now();
  }
}

port.on("message", (message: ToWorker) => {
  if (message.type === "delivered") {
    if (message.token === revision && active) schedule(revision);
    return;
  }
  cancel();
  try {
    const command = validateCommand(message.command);
    if (command.type === "pause") emit({ type: "paused", id: command.id });
    else {
      active = command;
      schedule(revision);
    }
  } catch (error) {
    emit({
      type: "error",
      error: error instanceof Error ? error.message : "Invalid command.",
    });
  }
});
port.on("close", () => {
  cancel();
});
emit({ type: "ready", execution });
