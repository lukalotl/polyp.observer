import { Worker } from "node:worker_threads";
import type { Evaluation, RunConfig } from "../src/research/types";
import type { Genome } from "../src/simulation";

/** One bounded queue per run. Worker completion order never changes result order. */
export class EvaluatorPool {
  readonly workers: Worker[] = [];
  private stopped = false;
  private pending?: {
    genomes: Genome[];
    results: Evaluation[];
    next: number;
    finished: number;
    resolve: (value: Evaluation[]) => void;
    reject: (error: Error) => void;
  };
  constructor(
    count: number,
    config: RunConfig,
    onFailure: (error: Error) => void,
  ) {
    for (let i = 0; i < count; i++) {
      const worker = new Worker(
        new URL("./evaluation-worker.js", import.meta.url),
        {
          workerData: config,
          resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
        },
      );
      this.workers.push(worker);
      worker.on("message", (message) => {
        const batch = this.pending;
        if (this.stopped || !batch) return;
        if (message.error) {
          this.pending = undefined;
          batch.reject(new Error(message.error));
          return;
        }
        batch.results[message.index] = message.result;
        batch.finished++;
        if (batch.finished === batch.genomes.length) {
          this.pending = undefined;
          batch.resolve(batch.results);
        } else this.dispatch(worker);
      });
      worker.on("error", (error) => {
        if (!this.stopped)
          onFailure(error instanceof Error ? error : new Error(String(error)));
      });
      worker.on("exit", (code) => {
        if (!this.stopped)
          onFailure(new Error(`Evaluation worker exited (${code}).`));
      });
    }
  }
  private dispatch(worker: Worker): void {
    const batch = this.pending;
    if (!batch || batch.next >= batch.genomes.length || this.stopped) return;
    const index = batch.next++;
    worker.postMessage({ index, genome: batch.genomes[index] });
  }
  evaluate(genomes: Genome[]): Promise<Evaluation[]> {
    if (this.stopped) return Promise.reject(new Error("Evaluation cancelled."));
    if (this.pending)
      return Promise.reject(
        new Error("Only one generation may be evaluated at a time."),
      );
    if (!genomes.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      this.pending = {
        genomes,
        results: new Array(genomes.length),
        next: 0,
        finished: 0,
        resolve,
        reject,
      };
      for (const worker of this.workers) this.dispatch(worker);
    });
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.pending?.reject(new Error("Evaluation cancelled."));
    this.pending = undefined;
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}
