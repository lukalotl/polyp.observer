import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  open,
  rm,
  stat,
  copyFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateEngineState,
  generationSnapshot,
} from "../src/research/engine";
import type {
  GenerationSnapshot,
  RunCheckpoint,
  RunSummary,
} from "../src/research/types";
import {
  MAX_FILE_BYTES,
  MAX_STORAGE_BYTES,
  MAX_RUNS,
  date,
  fields,
  record,
  validateCheckpoint,
} from "./validation";

export interface StoredRun {
  storageVersion: 1;
  intent: "run" | "step" | null;
  summary: RunSummary;
  checkpoint: RunCheckpoint;
  archives: { savedAt: string; snapshot: GenerationSnapshot }[];
}
const validId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    id,
  );
export class RunStore {
  readonly dir: string;
  readonly recoveryErrors: string[] = [];
  private lock?: ChildProcessWithoutNullStreams;
  private shuttingDown = false;
  private sizes = new Map<string, number>();
  private writes: Promise<void> = Promise.resolve();
  onLockLost?: () => void;
  constructor(dir: string) {
    this.dir = resolve(dir);
  }
  async open(): Promise<StoredRun[]> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Linux flock is kernel-exclusive, crash-released, and has no PID/stale-lock race.
    // The holder's stdin pipe closes even if the owning server is SIGKILLed.
    const lock = spawn(
      "flock",
      [
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        "73",
        join(this.dir, ".manager.lock"),
        process.execPath,
        "-e",
        "console.log('LOCKED');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.lock = lock;
    await new Promise<void>((done, reject) => {
      let message = "",
        acquired = false;
      lock.stderr.on("data", (data) => {
        message += data.toString().slice(0, 4096);
      });
      lock.once("error", reject);
      lock.stdout.once("data", (data) => {
        if (data.toString().startsWith("LOCKED")) {
          acquired = true;
          done();
        } else reject(new Error("Research lock failed."));
      });
      lock.once("exit", (code) => {
        if (!this.shuttingDown) {
          if (acquired) this.onLockLost?.();
          reject(
            new Error(
              code === 73
                ? `Research data directory is already locked: ${this.dir}. Use API_UPSTREAM for additional ports.`
                : `Research lock exited (${code}): ${message}`,
            ),
          );
        }
      });
    });
    const entries = await readdir(this.dir);
    const ids = new Set<string>();
    for (const name of entries) {
      if (name.endsWith(".tmp")) {
        await rm(join(this.dir, name), { force: true });
        continue;
      }
      const id = name.replace(/\.json(?:\.bak)?$/, "");
      if (validId(id)) ids.add(id);
      if (/\.json(?:\.bak)?$/.test(name))
        this.sizes.set(name, (await stat(join(this.dir, name))).size);
    }
    if (ids.size > MAX_RUNS)
      throw new Error(`Data directory exceeds ${MAX_RUNS} run storage limit.`);
    const runs: StoredRun[] = [];
    for (const id of ids) {
      let found: StoredRun | undefined;
      for (const suffix of [".json", ".json.bak"]) {
        try {
          const path = join(this.dir, id + suffix);
          if ((await stat(path)).size > MAX_FILE_BYTES)
            throw new Error("Stored run exceeds file size limit.");
          found = this.validate(JSON.parse(await readFile(path, "utf8")), id);
          if (suffix.endsWith("bak")) {
            this.recoveryErrors.push(`${id}: recovered valid backup.`);
            // Never let the bad primary overwrite the valid backup on next save.
            await rm(join(this.dir, id + ".json"), { force: true });
            this.sizes.delete(id + ".json");
          }
          break;
        } catch (error) {
          if (suffix.endsWith("bak"))
            this.recoveryErrors.push(
              `${id}: skipped invalid checkpoint and backup (${error instanceof Error ? error.message : String(error)}).`,
            );
        }
      }
      if (found) runs.push(found);
    }
    return runs;
  }
  private validate(value: unknown, id: string): StoredRun {
    fields(
      value,
      ["storageVersion", "summary", "checkpoint", "archives", "intent"],
      ["storageVersion", "summary", "checkpoint", "archives", "intent"],
    );
    if (
      value.intent !== null &&
      value.intent !== "run" &&
      value.intent !== "step"
    )
      throw new Error("Invalid persisted run intent.");
    if (value.storageVersion !== 1 || !record(value.summary))
      throw new Error("Unsupported run storage format.");
    const summary = value.summary;
    if (
      summary.id !== id ||
      ![
        "paused",
        "queued",
        "starting",
        "running",
        "pausing",
        "completed",
        "failed",
        "archived",
      ].includes(summary.status as string) ||
      !date(summary.createdAt) ||
      !date(summary.updatedAt)
    )
      throw new Error("Invalid persisted run metadata.");
    if (summary.checkpointAt !== null && !date(summary.checkpointAt))
      throw new Error("Invalid checkpoint timestamp.");
    for (const key of ["error", "stopReason"])
      if (
        summary[key] !== null &&
        (typeof summary[key] !== "string" ||
          (summary[key] as string).length > 500)
      )
        throw new Error("Invalid persisted status message.");
    if (
      summary.parentRunId !== null &&
      (typeof summary.parentRunId !== "string" || !validId(summary.parentRunId))
    )
      throw new Error("Invalid parent run id.");
    const checkpoint = validateCheckpoint(value.checkpoint);
    if (
      !Array.isArray(value.archives) ||
      value.archives.length > checkpoint.config.retainedSnapshots
    )
      throw new Error("Invalid generation archive retention.");
    let previous = -1;
    for (const archive of value.archives) {
      if (
        !record(archive) ||
        !date(archive.savedAt) ||
        !record(archive.snapshot) ||
        !Number.isSafeInteger(archive.snapshot.generation) ||
        (archive.snapshot.generation as number) <= previous ||
        (archive.snapshot.generation as number) >
          (checkpoint.state?.generation ?? -1)
      )
        throw new Error("Invalid archived generation.");
      const snapshot = archive.snapshot;
      if (
        !Array.isArray(snapshot.population) ||
        snapshot.population.length !== checkpoint.config.populationSize ||
        !record(snapshot.champion) ||
        !record(snapshot.metrics) ||
        snapshot.metrics.generation !== snapshot.generation
      )
        throw new Error("Invalid archived population.");
      const generation = snapshot.generation as number;
      const archiveState = validateEngineState({
        ...checkpoint.state,
        generation,
        population: snapshot.population,
        champion: snapshot.champion,
        nextId:
          1 +
          checkpoint.config.populationSize +
          generation *
            (checkpoint.config.populationSize - checkpoint.config.eliteCount),
        cache: [],
        evaluations: snapshot.metrics.evaluations,
        cacheHits: snapshot.metrics.cacheHits,
      });
      const checked = generationSnapshot(archiveState);
      for (const [key, entry] of Object.entries(checked.metrics))
        if (snapshot.metrics[key] !== entry)
          throw new Error("Archived metrics conflict with population.");
      archive.snapshot = checked;
      previous = generation;
    }
    return {
      storageVersion: 1,
      intent: value.intent,
      summary: summary as unknown as RunSummary,
      checkpoint,
      archives: value.archives,
    };
  }
  save(value: StoredRun): Promise<void> {
    const write = this.writes.then(() => this.write(value));
    this.writes = write.catch(() => {});
    return write;
  }
  private async write(value: StoredRun): Promise<void> {
    if (!this.lock || this.lock.exitCode !== null || this.shuttingDown)
      throw new Error("Research storage lock is unavailable.");
    const id = value.summary.id;
    if (!validId(id)) throw new Error("Invalid run id.");
    const json = JSON.stringify(value);
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_FILE_BYTES)
      throw new Error(
        "Run checkpoint exceeds the 64 MiB per-file storage limit.",
      );
    const main = id + ".json",
      backup = main + ".bak";
    const total = [...this.sizes.values()].reduce((sum, size) => sum + size, 0);
    const old = this.sizes.get(main) ?? 0;
    // Reserve peak atomic-write space too: the new primary and backup temporary
    // coexist with both prior files before rename.
    if (total + bytes + old > MAX_STORAGE_BYTES)
      throw new Error(
        "Research storage exceeds the 1 GiB budget including atomic-write headroom. Export and remove old run files while the server is stopped.",
      );
    const temp = join(this.dir, id + "." + randomUUID() + ".tmp");
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(json);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (old) {
        const backupTemp = temp + ".bak.tmp";
        await copyFile(join(this.dir, main), backupTemp);
        const copy = await open(backupTemp, "r");
        try {
          await copy.sync();
        } finally {
          await copy.close();
        }
        await rename(backupTemp, join(this.dir, backup));
        this.sizes.set(backup, old);
      }
      await rename(temp, join(this.dir, main));
      this.sizes.set(main, bytes);
      const dir = await open(this.dir, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
  async close(): Promise<void> {
    await this.writes;
    this.shuttingDown = true;
    const lock = this.lock;
    this.lock = undefined;
    if (!lock || !lock.pid || lock.exitCode !== null) return;
    await new Promise<void>((done) => {
      lock.once("exit", () => done());
      lock.stdin.end();
    });
  }
}
