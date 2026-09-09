import { availableParallelism } from "node:os";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { validateRunConfig } from "../src/research/config";
import { MAX_EVALUATION_WORKERS } from "../src/research/limits";
import { generationSnapshot } from "../src/research/engine";
import {
  MODEL_VERSION,
  type EngineState,
  type RunConfig,
  type RunDetail,
  type RunSummary,
  type RunStatus,
  type RunCheckpoint,
  type RunList,
  type GenerationSnapshot,
  type HistoryPoint,
  type ChampionPoint,
  type RunAction,
} from "../src/research/types";
import { EvaluatorPool } from "./evaluator-pool";
import { RunStore, type StoredRun } from "./store";
import {
  MAX_RESEARCH_MEMORY_BYTES,
  MAX_RUN_MEMORY_BYTES,
  maximumRunMemory,
  retainedRunMemory,
} from "./memory";
import {
  HISTORY_LIMIT,
  IMPROVEMENT_LIMIT,
  MAX_RUNS,
  HttpError,
  validateCheckpoint,
  runName,
} from "./validation";

interface Job {
  coordinator: Worker;
  pool: EvaluatorPool;
  mode: "run" | "step";
  accepting: boolean;
  generationStarted: number | null;
}
interface Run {
  summary: RunSummary;
  config: RunConfig;
  state: EngineState | null;
  snapshot: GenerationSnapshot | null;
  history: HistoryPoint[];
  improvements: ChampionPoint[];
  archives: StoredRun["archives"];
  elapsedMs: number;
  job?: Job;
  mode?: "run" | "step";
  saving?: Promise<void>;
  operation?: Promise<unknown>;
  halting?: Promise<void>;
}
export interface ManagerOptions {
  dataDir: string;
  maxEvaluationWorkers?: number;
  maxRuns?: number;
  cpuBudget?: number;
  maxMemoryBytes?: number;
}
const now = () => new Date().toISOString();
function boundedOption(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max)
    throw new Error(`Resource limit must be an integer from 1 to ${max}.`);
  return result;
}
export class RunManager extends EventEmitter {
  readonly store: RunStore;
  readonly maxEvaluationWorkers: number;
  readonly maxRuns: number;
  readonly cpuBudget: number;
  readonly maxMemoryBytes: number;
  private runs = new Map<string, Run>();
  private queue: string[] = [];
  private closing = false;
  private timer?: ReturnType<typeof setInterval>;
  private closingPromise?: Promise<void>;
  constructor(options: ManagerOptions) {
    super();
    this.cpuBudget = boundedOption(
      options.cpuBudget,
      Math.max(2, availableParallelism() - 1),
      Math.max(2, availableParallelism() - 1),
    );
    this.maxEvaluationWorkers = boundedOption(
      options.maxEvaluationWorkers,
      Math.min(MAX_EVALUATION_WORKERS, this.cpuBudget - 1),
      Math.min(MAX_EVALUATION_WORKERS, this.cpuBudget - 1),
    );
    this.maxRuns = boundedOption(options.maxRuns, 3, 3);
    this.maxMemoryBytes = boundedOption(
      options.maxMemoryBytes,
      MAX_RESEARCH_MEMORY_BYTES,
      MAX_RESEARCH_MEMORY_BYTES,
    );
    this.store = new RunStore(options.dataDir);
    this.store.onLockLost = () => {
      console.error(
        "[polyp:storage] Exclusive lock lost; stopping all research.",
      );
      void this.close();
    };
  }
  async open(): Promise<void> {
    let persisted: StoredRun[];
    try {
      persisted = await this.store.open();
    } catch (error) {
      await this.store.close();
      throw error;
    }
    let reserved = 0;
    for (const stored of persisted) {
      const cp = stored.checkpoint;
      const status = stored.summary.status;
      const resume =
        stored.intent === "run" &&
        ["queued", "starting", "running"].includes(status) &&
        cp.config.resumeOnRestart &&
        cp.config.evaluationWorkers <= this.maxEvaluationWorkers;
      const run = this.fromCheckpoint(
        stored.summary.id,
        cp,
        stored.summary.parentRunId,
      );
      run.summary = {
        ...run.summary,
        status: ["completed", "failed", "archived"].includes(status)
          ? status
          : "paused",
        createdAt: stored.summary.createdAt,
        updatedAt: stored.summary.updatedAt,
        checkpointAt: stored.summary.checkpointAt,
        error: stored.summary.error,
        stopReason: resume ? null : stored.summary.stopReason,
      };
      run.archives = stored.archives;
      const bytes = retainedRunMemory(run);
      if (
        maximumRunMemory(run.config) > MAX_RUN_MEMORY_BYTES ||
        reserved + bytes > this.maxMemoryBytes
      ) {
        this.store.recoveryErrors.push(
          `${stored.summary.id}: retained memory reservation exceeds limits; skipped.`,
        );
        continue;
      }
      reserved += bytes;
      this.runs.set(run.summary.id, run);
      if (resume) {
        run.mode = "run";
        run.summary.status = "queued";
        this.queue.push(run.summary.id);
      }
    }
    // Persisted FIFO is restored by creation order, not arbitrary directory order.
    this.queue.sort((a, b) =>
      this.runs
        .get(a)!
        .summary.updatedAt.localeCompare(this.runs.get(b)!.summary.updatedAt),
    );
    this.pump();
    this.timer = setInterval(() => {
      for (const run of this.runs.values())
        if (
          run.job &&
          !run.saving &&
          Date.now() - Date.parse(run.summary.checkpointAt ?? "1970-01-01") >=
            run.config.checkpointSeconds * 1000
        )
          void this.persist(run).catch((error) => this.fail(run, error));
    }, 1000);
    this.timer.unref();
    for (const error of this.store.recoveryErrors)
      console.warn("[polyp:recovery]", error);
  }
  private fromCheckpoint(
    id: string,
    cp: RunCheckpoint,
    parentRunId: string | null = null,
  ): Run {
    const run: Run = {
      config: cp.config,
      state: cp.state,
      snapshot: cp.state ? generationSnapshot(cp.state) : null,
      elapsedMs: cp.elapsedMs,
      history: cp.history,
      improvements: cp.improvements,
      archives: [],
      summary: {
        id,
        name: cp.config.name,
        status: "paused",
        createdAt: now(),
        updatedAt: now(),
        checkpointAt: null,
        generation: -1,
        evaluations: 0,
        cacheHits: 0,
        bestFitness: null,
        meanFitness: null,
        validationFitness: null,
        diversity: 0,
        uniqueGenomes: 0,
        elapsedMs: cp.elapsedMs,
        evalsPerSecond: 0,
        generationMs: 0,
        workerCount: 0,
        queuePosition: null,
        error: null,
        stopReason: null,
        parentRunId,
      },
    };
    this.refresh(run);
    return run;
  }
  private get(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new HttpError(404, "Run not found.");
    return run;
  }
  private refresh(run: Run): void {
    const metrics = run.snapshot?.metrics;
    Object.assign(run.summary, {
      generation: run.state?.generation ?? -1,
      evaluations: run.state?.evaluations ?? 0,
      cacheHits: run.state?.cacheHits ?? 0,
      bestFitness: metrics?.bestEver ?? null,
      meanFitness: metrics?.mean ?? null,
      validationFitness: run.state?.champion.validationFitness ?? null,
      diversity: metrics?.diversity ?? 0,
      uniqueGenomes: metrics?.uniqueGenomes ?? 0,
      elapsedMs: run.elapsedMs,
      evalsPerSecond:
        run.elapsedMs > 0
          ? ((run.state?.evaluations ?? 0) * 1000) / run.elapsedMs
          : 0,
      generationMs: run.history.at(-1)?.generationMs ?? 0,
      workerCount: run.job ? run.config.evaluationWorkers + 1 : 0,
      queuePosition:
        run.summary.status === "queued"
          ? this.queue.indexOf(run.summary.id) + 1
          : null,
    });
  }
  private changed(run?: Run): void {
    if (run) {
      run.summary.updatedAt = now();
      this.refresh(run);
    }
    for (const id of this.queue) this.refresh(this.get(id));
    this.emit("change");
  }
  get allocatedWorkers(): number {
    return [...this.runs.values()].reduce(
      (sum, run) => sum + (run.job ? run.config.evaluationWorkers : 0),
      0,
    );
  }
  get activeRuns(): number {
    return [...this.runs.values()].filter((run) => run.job).length;
  }
  get totalWorkers(): number {
    return this.allocatedWorkers + this.activeRuns;
  }
  get reservedMemoryBytes(): number {
    return [...this.runs.values()].reduce(
      (total, run) =>
        total +
        (run.job ? maximumRunMemory(run.config) : retainedRunMemory(run)),
      0,
    );
  }
  list(): RunList {
    return {
      runs: [...this.runs.values()].map((run) => ({ ...run.summary })),
      capacity: {
        maxRuns: this.maxRuns,
        maxEvaluationWorkers: this.maxEvaluationWorkers,
        allocatedWorkers: this.allocatedWorkers,
      },
      modelVersion: MODEL_VERSION,
    };
  }
  detail(id: string): RunDetail {
    const run = this.get(id);
    return {
      summary: { ...run.summary },
      config: run.config,
      snapshot: run.snapshot,
      history: run.history,
      improvements: run.improvements,
      snapshots: run.archives.map(({ savedAt, snapshot }) => ({
        generation: snapshot.generation,
        savedAt,
        bestFitness: snapshot.metrics.best,
      })),
    };
  }
  checkpoint(id: string): RunCheckpoint {
    const run = this.get(id);
    return {
      format: "polyp-research-checkpoint",
      version: 1,
      modelVersion: MODEL_VERSION,
      config: run.config,
      state: run.state,
      history: run.history,
      improvements: run.improvements,
      elapsedMs: run.elapsedMs,
      createdAt: run.summary.createdAt,
      sourceRunId: run.summary.id,
    };
  }
  generation(id: string, generation: number): GenerationSnapshot {
    const run = this.get(id);
    const snapshot =
      run.snapshot?.generation === generation
        ? run.snapshot
        : run.archives.find((item) => item.snapshot.generation === generation)
            ?.snapshot;
    if (!snapshot)
      throw new HttpError(
        404,
        "Generation is outside the retained snapshot window.",
      );
    return snapshot;
  }
  private writable(): void {
    if (this.closing)
      throw new HttpError(503, "Research manager is shutting down.");
  }
  async create(configInput: unknown, start = false): Promise<RunDetail> {
    this.writable();
    const config = validateRunConfig(configInput);
    runName(config.name);
    if (
      config.evaluationWorkers > this.maxEvaluationWorkers ||
      config.evaluationWorkers + 1 > this.cpuBudget
    )
      throw new HttpError(
        400,
        `This server permits at most ${this.maxEvaluationWorkers} evaluation workers per run.`,
      );
    return this.add(
      {
        format: "polyp-research-checkpoint",
        version: 1,
        modelVersion: MODEL_VERSION,
        config,
        state: null,
        history: [],
        improvements: [],
        elapsedMs: 0,
        createdAt: now(),
      },
      null,
      start,
    );
  }
  private async add(
    cp: RunCheckpoint,
    parent: string | null,
    start: boolean,
  ): Promise<RunDetail> {
    if (maximumRunMemory(cp.config) > MAX_RUN_MEMORY_BYTES)
      throw new HttpError(
        400,
        "Population, cache and retained snapshots exceed the 64 MiB run storage reservation; reduce retention or population.",
      );
    if (this.runs.size >= MAX_RUNS)
      throw new HttpError(
        409,
        `At most ${MAX_RUNS} stored runs are allowed (including archives).`,
      );
    if (cp.config.evaluationWorkers > this.maxEvaluationWorkers)
      throw new HttpError(
        400,
        "Checkpoint requires more evaluation workers than this server permits.",
      );
    const id = randomUUID();
    const run = this.fromCheckpoint(id, cp, parent);
    if (run.snapshot)
      run.archives = [{ savedAt: now(), snapshot: run.snapshot }];
    if (this.reservedMemoryBytes + retainedRunMemory(run) > this.maxMemoryBytes)
      throw new HttpError(
        409,
        "Retained run data exhausts the research memory reservation.",
      );
    this.runs.set(id, run);
    try {
      await this.persist(run);
    } catch (error) {
      this.runs.delete(id);
      throw error;
    }
    this.changed(run);
    if (start) return this.action(id, "start");
    return this.detail(id);
  }
  async import(
    checkpoint: unknown,
    name?: string,
    start = false,
  ): Promise<RunDetail> {
    this.writable();
    const cp = structuredClone(validateCheckpoint(checkpoint));
    if (name !== undefined) {
      cp.config.name = runName(name);
      if (cp.state) cp.state.config.name = cp.config.name;
    }
    return this.add(cp, cp.sourceRunId ?? null, start);
  }
  async fork(id: string, name?: string, start = false): Promise<RunDetail> {
    this.writable();
    const cp = structuredClone(this.checkpoint(id));
    cp.config.name =
      name === undefined
        ? `${cp.config.name.slice(0, 73)} (fork)`
        : runName(name);
    if (cp.state) cp.state.config.name = cp.config.name;
    return this.add(cp, id, start);
  }
  async action(id: string, action: RunAction): Promise<RunDetail> {
    this.writable();
    const run = this.get(id);
    // Concurrent HTTP actions on a run are linearized; checkpoint writes are too.
    const operation = (run.operation ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        this.writable();
        await run.halting;
        if (action === "checkpoint") {
          await this.persist(run);
          return;
        }
        if (run.summary.status === "archived" && action !== "archive")
          throw new HttpError(
            409,
            "Archived runs are read-only; fork to continue.",
          );
        if (action === "pause" || action === "archive") {
          await this.halt(
            run,
            action === "archive" ? "archived" : "paused",
            action === "archive" ? "Archived by user." : "Paused by user.",
          );
          return;
        }
        if (run.summary.status === "archived")
          throw new HttpError(
            409,
            "Archived runs are read-only; fork to continue.",
          );
        if (run.job || run.summary.status === "queued") {
          if (action === "step")
            throw new HttpError(409, "Pause the run before stepping.");
          return;
        }
        if (
          run.config.evaluationWorkers > this.maxEvaluationWorkers ||
          run.config.evaluationWorkers + 1 > this.cpuBudget
        )
          throw new HttpError(
            409,
            "This run requires more workers than the server currently permits; import a checkpoint with a lower evaluationWorkers setting.",
          );
        if (
          action === "step" &&
          run.config.maxGenerations > 0 &&
          (run.state?.generation ?? -1) >= run.config.maxGenerations
        )
          throw new HttpError(
            409,
            "Generation limit reached; import with a higher limit to continue.",
          );
        if (
          action === "start" &&
          run.config.maxGenerations > 0 &&
          (run.state?.generation ?? -1) >= run.config.maxGenerations
        ) {
          run.summary.status = "completed";
          run.summary.stopReason = "Generation limit reached.";
          await this.persist(run);
          this.changed(run);
          return;
        }
        run.mode = action === "step" ? "step" : "run";
        run.summary.status = "queued";
        run.summary.error = null;
        run.summary.stopReason = null;
        this.queue.push(id);
        this.changed(run);
        await this.persist(run);
        this.pump();
      });
    run.operation = operation;
    await operation;
    return this.detail(id);
  }
  private pump(): void {
    if (this.closing) return;
    while (this.queue.length && this.activeRuns < this.maxRuns) {
      const run = this.get(this.queue[0]);
      // Strict FIFO: smaller jobs never jump a larger head-of-line reservation.
      if (
        this.allocatedWorkers + run.config.evaluationWorkers >
          this.maxEvaluationWorkers ||
        this.totalWorkers + run.config.evaluationWorkers + 1 > this.cpuBudget
      )
        break;
      // Queued runs hold only retained data. Reserve all future growth atomically
      // at admission; keep that reservation until the workers have terminated.
      if (
        this.reservedMemoryBytes -
          retainedRunMemory(run) +
          maximumRunMemory(run.config) >
        this.maxMemoryBytes
      )
        break;
      this.queue.shift();
      run.summary.status = "starting";
      let job: Job;
      let pool: EvaluatorPool | undefined;
      try {
        pool = new EvaluatorPool(
          run.config.evaluationWorkers,
          run.config,
          (error) => {
            if (run.job === job) void this.fail(run, error);
          },
        );
        const coordinator = new Worker(
          new URL("./coordinator-worker.js", import.meta.url),
          {
            workerData: { config: run.config, state: run.state },
            resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
          },
        );
        job = {
          coordinator,
          pool,
          mode: run.mode ?? "run",
          accepting: true,
          generationStarted: null,
        };
        run.job = job;
        coordinator.on("message", (message) => {
          if (run.job !== job || !job.accepting || this.closing) return;
          if (message.type === "ready") {
            run.summary.status = "running";
            job.generationStarted = performance.now();
            coordinator.postMessage({ type: "advance" });
            this.changed(run);
          } else if (message.type === "evaluate") {
            void job.pool
              .evaluate(message.genomes)
              .then((results) => {
                if (run.job === job && job.accepting)
                  coordinator.postMessage({ type: "evaluated", results });
              })
              .catch((error) => {
                if (run.job === job && job.accepting)
                  void this.fail(run, error);
              });
          } else if (message.type === "generation") {
            this.commit(
              run,
              message.state,
              message.snapshot,
              message.generationMs,
            );
            job.generationStarted = null;
            if (job.mode === "step")
              void this.halt(
                run,
                "paused",
                "Single generation complete.",
              ).catch((error) => this.fail(run, error));
            else if (
              run.config.maxGenerations > 0 &&
              run.state!.generation >= run.config.maxGenerations
            )
              void this.halt(
                run,
                "completed",
                "Generation limit reached.",
              ).catch((error) => this.fail(run, error));
          } else if (message.type === "failed")
            void this.fail(run, new Error(message.error));
        });
        coordinator.on("error", (error) => {
          if (run.job === job && job.accepting) void this.fail(run, error);
        });
        coordinator.on("exit", (code) => {
          if (run.job === job && job.accepting)
            void this.fail(run, new Error(`Coordinator exited (${code}).`));
        });
      } catch (error) {
        void pool?.close();
        void this.fail(run, error);
      }
      this.changed(run);
    }
  }
  private commit(
    run: Run,
    state: EngineState,
    snapshot: GenerationSnapshot,
    generationMs: number,
  ): void {
    const priorBest = run.state?.champion.fitness ?? -Infinity;
    run.elapsedMs += generationMs;
    run.state = state;
    run.snapshot = snapshot;
    const point: HistoryPoint = {
      ...snapshot.metrics,
      elapsedMs: run.elapsedMs,
      generationMs,
      evalsPerSecond: (state.evaluations * 1000) / Math.max(1, run.elapsedMs),
    };
    run.history = [...run.history, point].slice(-HISTORY_LIMIT);
    if (state.champion.fitness > priorBest)
      run.improvements = [
        ...run.improvements,
        {
          generation: state.generation,
          individual: state.champion,
          elapsedMs: run.elapsedMs,
        },
      ].slice(-IMPROVEMENT_LIMIT);
    if (state.generation % run.config.snapshotEvery === 0)
      run.archives = [...run.archives, { savedAt: now(), snapshot }].slice(
        -run.config.retainedSnapshots,
      );
    this.changed(run);
  }
  private halt(
    run: Run,
    status: RunStatus,
    reason: string | null,
    preserve = false,
  ): Promise<void> {
    const operation = (run.halting ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.haltNow(run, status, reason, preserve));
    run.halting = operation;
    void operation
      .finally(() => {
        if (run.halting === operation) run.halting = undefined;
      })
      .catch(() => {});
    return operation;
  }
  private async haltNow(
    run: Run,
    status: RunStatus,
    reason: string | null,
    preserve: boolean,
  ): Promise<void> {
    const job = run.job;
    this.queue = this.queue.filter((id) => id !== run.summary.id);
    if (job) {
      job.accepting = false;
      if (job.generationStarted !== null)
        run.elapsedMs += Math.max(0, performance.now() - job.generationStarted);
      run.summary.status = "pausing";
      this.changed(run);
      await Promise.all([job.coordinator.terminate(), job.pool.close()]);
      if (run.job === job) run.job = undefined;
    }
    run.summary.status = status;
    run.summary.stopReason = reason;
    if (!preserve) run.mode = undefined;
    this.changed(run);
    await this.persist(run);
    this.pump();
  }
  private async fail(run: Run, error: unknown): Promise<void> {
    run.summary.error = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 500);
    console.error("[polyp:run]", run.summary.id, run.summary.error);
    try {
      await this.halt(run, "failed", "Research worker or checkpoint failed.");
    } catch (failure) {
      console.error("[polyp:checkpoint]", String(failure));
    }
  }
  private persist(run: Run): Promise<void> {
    const operation = (run.saving ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const checkpointAt = now();
        this.refresh(run);
        const stored: StoredRun = {
          storageVersion: 1,
          intent: run.mode ?? null,
          summary: { ...run.summary, checkpointAt },
          checkpoint: this.checkpoint(run.summary.id),
          archives: run.archives,
        };
        await this.store.save(stored);
        run.summary.checkpointAt = checkpointAt;
      });
    run.saving = operation;
    void operation
      .finally(() => {
        if (run.saving === operation) run.saving = undefined;
      })
      .catch(() => {});
    return operation;
  }
  close(): Promise<void> {
    return (this.closingPromise ??= (async () => {
      this.closing = true;
      clearInterval(this.timer);
      // Running/queued intent survives clean shutdown; explicit pause does not.
      await Promise.all(
        [...this.runs.values()].map(async (run) => {
          await run.operation?.catch(() => {});
          const continuing =
            run.job?.mode === "run" ||
            (run.summary.status === "queued" && run.mode === "run");
          try {
            await this.halt(
              run,
              continuing
                ? "running"
                : run.summary.status === "completed" ||
                    run.summary.status === "archived" ||
                    run.summary.status === "failed"
                  ? run.summary.status
                  : "paused",
              continuing
                ? "Server shutdown; awaiting restart."
                : run.summary.stopReason,
              true,
            );
          } catch (error) {
            console.error("[polyp:shutdown]", String(error));
          }
        }),
      );
      await this.store.close();
    })());
  }
}
