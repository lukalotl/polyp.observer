import { act } from "@testing-library/react";
import { vi } from "vitest";
import { DEFAULT_RUN_CONFIG } from "../research/config";
import {
  advanceGeneration,
  generationSnapshot,
  initializePopulation,
} from "../research/engine";
import {
  MODEL_VERSION,
  type Capacity,
  type ResearchEvent,
  type RunCheckpoint,
  type RunConfig,
  type RunDetail,
  type RunList,
  type RunSummary,
  type PreviewFrame,
} from "../research/types";
import { simulate } from "../simulation";

export const CAPACITY: Capacity = {
  maxRuns: 3,
  maxEvaluationWorkers: 6,
  allocatedWorkers: 0,
};
export const SELECTED_KEY = "polyp.research.selected";
export const smallConfig = (overrides: Partial<RunConfig> = {}): RunConfig => ({
  ...structuredClone(DEFAULT_RUN_CONFIG),
  initialization: "mutants",
  randomRuleBias: "uniform",
  name: "Fixture research",
  size: 9,
  steps: 8,
  populationSize: 8,
  eliteCount: 2,
  evaluationWorkers: 1,
  snapshotEvery: 1,
  retainedSnapshots: 8,
  ...overrides,
});

/** Real genetic populations and CA layers, generated only in tests. The browser
 * production path obtains these via HTTP; it never runs an evolution loop. */
export async function researchFixture(
  id = "run-a",
  generation = 1,
  overrides: Partial<RunConfig> = {},
) {
  const config = smallConfig(overrides);
  let state = await initializePopulation(config);
  const snapshots = [generationSnapshot(state)];
  for (let i = 0; i < generation; i++) {
    state = await advanceGeneration(state);
    snapshots.push(generationSnapshot(state));
  }
  const snapshot = snapshots.at(-1)!;
  const createdAt = "2026-01-01T00:00:00.000Z";
  const updatedAt = `2026-01-01T00:00:${String(generation + 1).padStart(2, "0")}.000Z`;
  const summary: RunSummary = {
    id,
    name: config.name,
    status: "paused",
    createdAt,
    updatedAt,
    checkpointAt: updatedAt,
    generation,
    evaluations: state.evaluations,
    cacheHits: state.cacheHits,
    bestFitness: snapshot.metrics.bestEver,
    meanFitness: snapshot.metrics.mean,
    validationFitness: snapshot.metrics.validationBest,
    diversity: snapshot.metrics.diversity,
    uniqueGenomes: snapshot.metrics.uniqueGenomes,
    elapsedMs: (generation + 1) * 100,
    evalsPerSecond: 80,
    generationMs: 100,
    workerCount: 0,
    queuePosition: null,
    error: null,
    stopReason: null,
    parentRunId: null,
  };
  const history = snapshots.map((value) => ({
    ...value.metrics,
    elapsedMs: (value.generation + 1) * 100,
    generationMs: 100,
    evalsPerSecond: 80,
  }));
  const improvements = [
    { generation: 0, individual: snapshots[0].champion, elapsedMs: 100 },
  ];
  const detail: RunDetail = {
    summary,
    config,
    snapshot,
    history,
    improvements,
    snapshots: snapshots.map((value) => ({
      generation: value.generation,
      savedAt: updatedAt,
      bestFitness: value.metrics.bestEver,
    })),
  };
  const checkpoint: RunCheckpoint = {
    format: "polyp-research-checkpoint",
    version: 1,
    modelVersion: MODEL_VERSION,
    sourceRunId: id,
    config,
    state,
    history,
    improvements,
    elapsedMs: summary.elapsedMs,
    createdAt,
  };
  return { detail, state, checkpoint, snapshots, preview: previewFor(detail) };
}
export function previewFor(
  detail: RunDetail,
  genome = detail.snapshot!.champion.genome,
  seed = detail.config.trainingSeeds[0],
): PreviewFrame {
  const simulation = simulate(genome, {
    size: detail.config.size,
    steps: detail.config.steps,
    seed: detail.config.seed,
    soupSize: detail.config.soupSize,
    randomSeed: seed,
  });
  return {
    genome,
    seed,
    simulation: {
      ...simulation,
      layers: simulation.layers.map((layer) =>
        btoa(String.fromCharCode(...layer)),
      ),
    },
    layerTimes: simulation.layers.map((_, index) => index),
    totalSteps: detail.config.steps,
    stride: 1,
  };
}
export function runList(
  details: RunDetail[] = [],
  capacity = CAPACITY,
): RunList {
  return {
    runs: details.map((value) => value.summary),
    capacity,
    modelVersion: MODEL_VERSION,
  };
}
export function changed(
  detail: RunDetail,
  summary: Partial<RunSummary>,
): RunDetail {
  return {
    ...structuredClone(detail),
    summary: { ...detail.summary, ...summary },
  };
}
export function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
export interface PendingRequest {
  path: string;
  options: RequestInit;
  settled: boolean;
  resolve: (value: unknown, status?: number) => void;
  raw: (body: string, contentType?: string, status?: number) => void;
  reject: (error: Error) => void;
}
/** Deliberately does not auto-reject aborted requests: late delivery exercises
 * the consumer's own stale-response guards as well as AbortSignal use. */
export class ControlledHttp {
  requests: PendingRequest[] = [];
  fetch = vi.fn(
    (input: RequestInfo | URL, options: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        const entry: PendingRequest = {
          path: String(input),
          options,
          settled: false,
          resolve: (value, status = 200) => {
            entry.settled = true;
            resolve(jsonResponse(value, status));
          },
          raw: (body, contentType = "text/html", status = 200) => {
            entry.settled = true;
            resolve(
              new Response(body, {
                status,
                headers: { "content-type": contentType },
              }),
            );
          },
          reject: (error) => {
            entry.settled = true;
            reject(error);
          },
        };
        this.requests.push(entry);
      }),
  );
  pending(path: string, method = "GET") {
    const entry = this.requests.find(
      (request) =>
        !request.settled &&
        request.path === path &&
        (request.options.method ?? "GET") === method,
    );
    if (!entry)
      throw new Error(
        `No pending ${method} ${path}; pending: ${this.requests
          .filter((r) => !r.settled)
          .map((r) => `${r.options.method ?? "GET"} ${r.path}`)
          .join(", ")}`,
      );
    return entry;
  }
  get mutations() {
    return this.requests.filter((request) => request.options.method === "POST");
  }
  async reply(path: string, value: unknown, method = "GET", status = 200) {
    await act(async () => {
      this.pending(path, method).resolve(value, status);
    });
  }
}
export class ResearchSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: ResearchSocket[] = [];
  static creationError: Error | undefined;
  static reset() {
    this.instances = [];
    this.creationError = undefined;
  }
  readyState = ResearchSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn((_payload: string) => {});
  close = vi.fn(() => {
    this.readyState = ResearchSocket.CLOSED;
  });
  constructor(public url: URL | string) {
    if (ResearchSocket.creationError) throw ResearchSocket.creationError;
    ResearchSocket.instances.push(this);
  }
  get messages(): { type: string; runId?: string | null }[] {
    return this.send.mock.calls.map(([value]) => JSON.parse(value));
  }
  open() {
    act(() => {
      this.readyState = ResearchSocket.OPEN;
      this.onopen?.(new Event("open"));
    });
  }
  hello(capacity = CAPACITY) {
    this.open();
    this.reply({ type: "hello", modelVersion: MODEL_VERSION, capacity });
  }
  reply(message: ResearchEvent) {
    this.raw(JSON.stringify(message));
  }
  raw(data: string) {
    act(() => this.onmessage?.({ data } as MessageEvent<string>));
  }
  disconnect() {
    act(() => {
      this.readyState = ResearchSocket.CLOSED;
      this.onclose?.(new CloseEvent("close"));
    });
  }
  fail() {
    act(() => this.onerror?.(new Event("error")));
  }
}
export function installResearchNetwork() {
  const http = new ControlledHttp();
  ResearchSocket.reset();
  vi.stubGlobal("fetch", http.fetch);
  vi.stubGlobal("WebSocket", ResearchSocket);
  return http;
}
export function installDialog() {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.open = true;
      }),
    },
    close: {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.open = false;
      }),
    },
  });
}
