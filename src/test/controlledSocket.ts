import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { Experiment } from "../experiment";
import type {
  EvolutionCommand,
  EvolutionRequest,
  EvolutionResponse,
  SnapshotMessage,
} from "../protocol";
import { evolve, fitness, PRESETS, simulate } from "../simulation";

export const savedStudy = (): Experiment => ({
  version: 1,
  name: "My saved study",
  genome: [...PRESETS[1].genome],
  config: { size: 25, steps: 24, seed: "point", randomSeed: 2024 },
});

/** A controlled wire boundary, not a mocked hook or a browser-side Worker.
 * Engine imports are test-only fixtures. Production never evaluates here. */
export class ControlledSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: ControlledSocket[] = [];
  static creationError: Error | undefined;
  static reset() {
    this.instances = [];
    this.creationError = undefined;
  }
  readyState = ControlledSocket.CONNECTING;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sendError: Error | undefined;
  send = vi.fn((_payload: string) => {
    if (this.sendError) throw this.sendError;
  });
  close = vi.fn(() => {
    this.readyState = ControlledSocket.CLOSED;
  });
  constructor(public url: URL | string) {
    if (ControlledSocket.creationError) throw ControlledSocket.creationError;
    ControlledSocket.instances.push(this);
  }
  get commands(): EvolutionCommand[] {
    return this.send.mock.calls.map(([payload]) => JSON.parse(payload));
  }
  get latest(): EvolutionCommand {
    return this.commands.at(-1)!;
  }
  get request(): EvolutionRequest {
    const command = this.latest;
    if (!command || command.type === "pause")
      throw new Error("Expected an evaluation request.");
    return command;
  }
  ready() {
    this.readyState = ControlledSocket.OPEN;
    this.reply({
      type: "ready",
      execution: { kind: "node:worker_threads", threadId: 7 },
    });
  }
  reply(message: EvolutionResponse) {
    this.raw(JSON.stringify(message));
  }
  raw(data: string) {
    act(() => this.onmessage?.({ data } as MessageEvent<string>));
  }
  disconnect() {
    this.readyState = ControlledSocket.CLOSED;
    act(() => this.onclose?.(new CloseEvent("close")));
  }
  fail() {
    act(() => this.onerror?.(new Event("error")));
  }
  respond(overrides: Partial<SnapshotMessage> = {}) {
    const result = snapshotFor(this.request, overrides);
    this.reply(result);
    return result;
  }
}

export function snapshotFor(
  command: EvolutionRequest,
  overrides: Partial<SnapshotMessage> = {},
): SnapshotMessage {
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
  return {
    type: "snapshot",
    id: command.id,
    genome: [...result.genome],
    config: { ...command.config },
    simulation: {
      ...result.simulation,
      layers: result.simulation.layers.map((layer) =>
        btoa(String.fromCharCode(...layer)),
      ),
    },
    epoch: command.epoch + Number(evolving),
    fitness: result.fitness,
    randomSeed: evolving
      ? command.randomSeed === Number.MAX_SAFE_INTEGER
        ? 0
        : command.randomSeed + 1
      : command.randomSeed,
    running: command.type === "start",
    execution: { kind: "node:worker_threads", threadId: 7 },
    ...overrides,
  };
}
