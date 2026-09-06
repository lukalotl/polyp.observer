import { Worker } from "node:worker_threads";
import type { Genome } from "../src/simulation";
import type { PreviewFrame, RunConfig } from "../src/research/types";
import { HttpError } from "./validation";

export const PREVIEW_TIMEOUT_MS = 120_000;

/** Independent worker; at most one simulation and eight waiting previews. */
export class PreviewService {
  private worker?: Worker;
  private closed = false;
  private queue: {
    key: string;
    genome: Genome;
    config: RunConfig;
    seed: number;
    resolve: (frame: PreviewFrame) => void;
    reject: (error: Error) => void;
  }[] = [];
  private current?: (typeof this.queue)[number];
  private timer?: ReturnType<typeof setTimeout>;
  private cache = new Map<string, { frame: PreviewFrame; bytes: number }>();
  private cacheBytes = 0;
  get workerCount(): number {
    return this.worker ? 1 : 0;
  }
  preview(
    genome: Genome,
    config: RunConfig,
    seed: number,
  ): Promise<PreviewFrame> {
    if (this.closed)
      return Promise.reject(new HttpError(503, "Server is shutting down."));
    const key = JSON.stringify([
      genome,
      config.stateCount,
      config.size,
      config.steps,
      config.seed,
      seed,
    ]);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached.frame);
    }
    if (this.queue.length >= 8)
      return Promise.reject(
        new HttpError(429, "Preview queue is full; retry shortly."),
      );
    return new Promise((resolve, reject) => {
      this.queue.push({ key, genome, config, seed, resolve, reject });
      this.next();
    });
  }
  private next(): void {
    if (this.closed || this.current || !this.queue.length) return;
    if (!this.worker) {
      const worker = new Worker(
        new URL("./preview-worker.js", import.meta.url),
        { resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } },
      );
      this.worker = worker;
      worker.on(
        "message",
        ({ frame, error }: { frame?: PreviewFrame; error?: string }) => {
          if (worker !== this.worker || !this.current) return;
          clearTimeout(this.timer);
          const job = this.current;
          this.current = undefined;
          if (error || !frame)
            job.reject(new HttpError(422, error ?? "Preview failed."));
          else {
            const bytes = JSON.stringify(frame).length;
            this.cache.set(job.key, { frame, bytes });
            this.cacheBytes += bytes;
            while (this.cache.size > 16 || this.cacheBytes > 16 * 1024 * 1024) {
              const first = this.cache.keys().next().value!;
              this.cacheBytes -= this.cache.get(first)!.bytes;
              this.cache.delete(first);
            }
            job.resolve(frame);
          }
          this.next();
        },
      );
      worker.on("error", (error) => {
        if (worker === this.worker)
          void this.fail(
            error instanceof Error ? error : new Error(String(error)),
          );
      });
      worker.on("exit", (code) => {
        if (worker === this.worker)
          void this.fail(new Error(`Preview worker exited (${code}).`));
      });
    }
    this.current = this.queue.shift()!;
    this.worker.postMessage({
      genome: this.current.genome,
      config: this.current.config,
      seed: this.current.seed,
    });
    this.timer = setTimeout(() => {
      void this.fail(
        new HttpError(422, "Preview exceeded its 120-second compute limit."),
      );
    }, PREVIEW_TIMEOUT_MS);
    this.timer.unref();
  }
  private async fail(error: Error): Promise<void> {
    clearTimeout(this.timer);
    const worker = this.worker;
    this.worker = undefined;
    this.current?.reject(error);
    this.current = undefined;
    await worker?.terminate();
    this.next();
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0))
      job.reject(new HttpError(503, "Server is shutting down."));
    await this.fail(new HttpError(503, "Server is shutting down."));
    this.cache.clear();
    this.cacheBytes = 0;
  }
}
