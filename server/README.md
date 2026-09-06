# Persistent VM research service

The browser is an observer/controller, not the owner of a training session. HTTP controls one canonical `RunManager`; every active run has a real Node coordinator worker and a dedicated pool of real `node:worker_threads` fitness workers. Closing every browser/socket does **not** stop research.

## Run it

```sh
npm run build
POLYP_RUNS_DIR=.polyp/research npm start -- --host 0.0.0.0 --port 3000 --strictPort
```

`PORT`/`HOST` are also supported. The existing Vite-compatible `--port`, `-p`, `--host`, `--strictPort` and `--flag=value` parsing remains; an occupied port fails instead of moving silently. Default listening port is 4173. Use the workspace's forwarded HTTPS URL, not the loopback URL, in a remote browser.

One canonical manager must own the data directory. Additional preview ports run **proxy mode**:

```sh
API_UPSTREAM=http://127.0.0.1:3000 npm run preview -- --port 4173 --host 0.0.0.0 --strictPort
API_UPSTREAM=http://127.0.0.1:3000 npm run preview -- --port 8787 --host 0.0.0.0 --strictPort
```

A proxy serves the same `dist/`, forwards `/api` HTTP and `/api/research/ws`, and never constructs a manager, locks a datastore, or creates scientific workers. Upstream must be a loopback HTTP(S) origin and cannot point back to the proxy's listening port. The canonical API should not itself use `API_UPSTREAM`. Proxy mutations/upgrades validate the incoming origin before forwarding with the canonical origin. No wildcard origins or arbitrary `X-Forwarded-Host` trust are used.

`npm run dev` uses Vite plus the same server, but defaults to **`.polyp/research.dev`**, separate from production. Its watcher shuts the old manager down before rebuilding/restarting. Explicit `API_UPSTREAM=http://127.0.0.1:3000 npm run dev` instead makes the dev backend a proxy to production intentionally (Vite still goes through that backend for origin validation). Do not override `POLYP_RUNS_DIR` to a live production directory for a second dev manager. The lock will reject it, not launch duplicate jobs. `dev:server` also defaults to the separate development directory. `.polyp/` is gitignored.

## Scheduling and state

- `maxGenerations: 0` runs indefinitely. Initialization is generation **0** (uninitialized summaries use **-1**); advancing means one actual GA generation, not a UI epoch. A positive limit completes exactly at that generation. `step` initializes generation 0 or advances exactly once and pauses; a step past the configured limit returns a conflict.
- The coordinator breeds immutable complete generations, preserving the entire population, champion, ancestry, RNG, next individual ID, evaluation counters and ordered LRU fitness cache. It never resets around the champion. Every uncached genome is scored on evaluation workers using the compact evaluator, not preview rendering. A batch is returned in original input order regardless of worker completion order.
- Default global limits on an 8-CPU VM are **6 evaluation workers**, **3 active runs**, and **7 total training threads** (coordinators + evaluators). `os.availableParallelism()` supplies the CPU bound. `POLYP_MAX_EVALUATION_WORKERS` (1–6), `POLYP_MAX_ACTIVE_RUNS` (1–3), and `POLYP_CPU_BUDGET` may lower these limits. CPU budget also counts coordinators; for example three 2-evaluator runs cannot fit a 7-thread budget. One independently bounded preview worker uses the remaining reservation. Pools are created only after admission.
- Queued runs are strictly FIFO: a smaller request never jumps a resource-blocked head. Queue metadata is refreshed when capacity changes. `Capacity.allocatedWorkers` counts evaluators; run `workerCount` and health `workers` count actual coordinator/evaluator threads (health also includes preview). Paused runs have no pool.
- Pause/archive immediately invalidate queued/in-flight work, terminate the coordinator **and** all evaluators, roll back the partial generation, persist the last complete state, and release capacity only after termination. Completed-generation state cannot be mutated by a late worker message. Archive is the stop action; archived runs are read-only except export/checkpoint, and can be forked.
- Training is cooperative without an artificial epoch delay. A coordinator waits for the main process to dispatch the next generation; sockets do not ACK training. Publications run independently at ~2 Hz. Slow observers drop publications, not work, and disconnects never kill jobs.
- WebSockets negotiate **per-message DEFLATE** for frames of at least 1024 bytes, using zlib level 1, a shared concurrency limit of 4, and no client/server context takeover. This reduces repeated full-detail/history traffic without changing `ResearchEvent` or the ~2 Hz protocol. Peers that decline compression still work. Both browser↔proxy and proxy↔canonical legs negotiate it independently; decompressed input/output size limits and uncompressed queued-send budgets remain in force. Compression uses the bounded Node/libuv zlib pool, not research evaluation workers.
- Elapsed training time is committed generation wall time plus time spent in a cancelled partial generation (not idle/queued/startup time). Evaluation/cache counters count committed scientific state; cancelled partial work is discarded. Rates are completed fixture evaluations per elapsed training second, not browser frame rates. A generation checkpoint during active work captures the last complete transaction; partial progress is intentionally replayed on resume.

## Persistence, recovery and limits

`POLYP_RUNS_DIR` defaults to `.polyp/research` under the project. Every run has an atomically replaced `<UUID>.json` envelope and the preceding valid `<UUID>.json.bak`. The envelope includes portable checkpoint, status/timestamps, and retained generation archives. Writes use exclusive temporary files, file `fsync`, rename and directory `fsync`; backups are replaced atomically before the primary is replaced. Per-run and global write queues serialize checkpoints.

The data directory is protected by **Linux `flock`** (util-linux required). A pipe-owned holder process keeps a kernel-exclusive, crash-released lock. There is no stale PID-file reclamation race. A second canonical process fails clearly. SIGKILL closes the holder's pipe and releases its lock; losing the lock while alive stops all research. Do not delete/replace `.manager.lock` while any manager is running, or edit live checkpoints manually.

Checkpoints are persisted at the configured interval (2–300 seconds), explicit checkpoint, pause/archive, generation limit, and SIGINT/SIGTERM shutdown. Clean shutdown preserves running/queued intent. On restart, only persisted running/queued/starting runs with `resumeOnRestart: true` are requeued; paused/completed/failed/archived runs stay stopped. Single-step intent is persisted separately and interrupted steps are not automatically replayed after shutdown or a crash. A corrupt primary falls back to its validated backup. Corrupt primary **and** backup isolate that run instead of crashing other runs; health `recoveryErrors` reports what was recovered/skipped. Schema, model version, state/fitness/lineage/counter invariants and archived populations are validated before use. Validation establishes structural consistency, not proof that an externally supplied score was honestly computed.

Retention is deliberately finite, **not** an infinite historical database:

- Last **4096** generation metric points and **256** champion improvements.
- Full generations at `snapshotEvery`, up to `retainedSnapshots` (2–128), plus the current complete generation always inspectable.
- Fitness cache bounded by `cacheSize` (0–8192), population 8–512, 1–8 training and 0–8 disjoint validation fixtures.
- At most **64 stored runs**, including archived runs; 64 MiB per checkpoint file and 1 GiB total checkpoint/backup disk budget. Conservative configuration reservations also cap a run at 64 MiB and the manager at 512 MiB; oversized population × archive combinations are rejected up front. To reclaim storage, export, stop the server, and remove an old run's primary and backup together. There is no destructive delete endpoint.
- JSON request limit 16 MiB, WebSocket input 4 KiB, outbound buffered publication limit 8 MiB, at most 64 observers. Mutations are rate bounded. Only same-origin/explicit `PUBLIC_ORIGIN`/exact workspace forwarded aliases are accepted; CLI clients without Origin are supported. No CORS wildcard. These are same-origin protections, **not authentication**: restrict network/workspace access to trusted users.

## HTTP / WebSocket

`GET /api/health` identifies `node:worker_threads`, worker/run counts and capacity. `GET /api/runs` lists metadata. `POST /api/runs` accepts `{config: <complete RunConfig>, start?: boolean}`. Configuration is strict: no coercion, partial defaults or unknown keys.

For `/api/runs/:id`:

- `GET` — detail with current population, metrics/history, champion improvements and snapshot refs.
- `POST /actions` — `{action: "start" | "pause" | "step" | "checkpoint" | "archive"}`.
- `GET /checkpoint` — portable JSON attachment of the last complete full genetic state. `sourceRunId` records provenance.
- `POST /fork` — optional `{name, start}`; new UUID, exact independent copy of current complete population/RNG/cache/counters, source untouched.
- `GET /generations/:generation` — current or retained full generation; 404 explicitly means outside the retention window.
- `GET /metrics.csv` — **retained** metrics only; `X-History-*` headers and generation column identify the honest bounded window.
- `POST /preview` — `{genome, seed}` from any selected historical individual, not a fragile latest individual ID.

`POST /api/runs/import` accepts `{checkpoint, name?, start?}` and always allocates a **new** run ID; never overwrites an existing run. A safe optional source ID becomes `parentRunId`. Fork/import naming is cosmetic and updates both config copies without re-scoring or resetting RNG. Exported checkpoints omit full archives; imported/forked runs retain current full generation plus copied bounded metrics/improvements.

`/api/research/ws` accepts **only** `{type: "subscribe", runId: string | null}`. Events are `hello`/capacity, `runs`, subscribed `run` detail, and `error`. All mutations use validated HTTP. Old per-socket `/api/evolution` commands are intentionally removed.

## Preview is not scoring

One separate VM worker runs the shared streaming trajectory over the full configured horizon. By default it returns **every consecutive timestep**, with `stride: 1`. An optional preview `range: { start, end }` selects an inclusive interval; it changes only which consecutive planes are rendered, while population and all metrics still cover the full horizon. Layers use `encoding: "adaptive-v1"`: a leading `s` selects sparse little-endian uint32 entries `(cellIndex << 4) | state`, sorted by spatial index; a leading `d` selects dense state bytes. The remaining string is base64. Each plane uses whichever exact encoding is smaller. Only empty spatial cells are implicit; no timesteps or occupied cells are dropped. Empty time planes are retained, including after extinction. Sparse volumes render directly as instances. Dense volumes use exact GPU grid traversal over a byte texture, stopping at the first occupied voxel; there is no interpolation or time sampling. Each cell is one unit on X/Z and one timestep on Y, with touching faces. Optional uniform time compression is off by default.

The browser switches to GPU grid traversal above 180,000 occupied cells when the dense texture fits. Very sparse worlds can retain up to two million instances when their dense lattice would be too large. Encoded planes and dense GPU textures are bounded to 64 MiB each, plus bounded timestamps and metrics. Larger volumes return an explicit 422 asking the observer to choose a shorter time range; there is no automatic sampling or cropping. Runs support odd grids up to 1025 and horizons up to 65,536, under a 1,073,741,824 cell-timestep work budget. Preview uses a bounded 8-request queue, 16-entry/16-MiB cache and 120-second timeout (proxy requests allow an additional five seconds). It cannot alter scoring, run state, RNG or workers. An observer's navigation does not change the scientific experiment.

## Validation

`npm run test:server` builds standalone native server/worker bundles, then uses Node's test runner against real TCP HTTP/WebSockets and actual worker/process lifecycles. Engine unit tests remain separate under `src/research`. `tsc -p tsconfig.server.json` checks server/core interfaces without requiring browser DOM types.
