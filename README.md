# Polyp research

A compact, VM-backed research workbench for evolving five-state 2D cellular
automata. The 3D inspector shows a rule's 2D history stacked through time.

## Start

Node 20.19+ (22 recommended), npm, and Linux `flock` (util-linux).

```sh
npm ci
npm run build
npm start -- --port 3000 --strictPort
```

This is the **canonical research service**. It owns the run directory, scheduler,
worker pools, and checkpoints. Do not use a bare static `vite preview`.

Other preview ports can safely share it without starting duplicate training jobs:

```sh
API_UPSTREAM=http://127.0.0.1:3000 npm run preview -- --port 4173
```

`npm run dev` starts Vite and a watched VM backend with a **separate development
run directory**. `--port`, `--host`, `API_PORT`, and `CLIENT_PORT` are supported.
See [server operations](server/README.md) for proxy mode, CPU budgets, storage,
startup/recovery, and deployment boundaries.

## Workbench

- **New run**: parameter fields or complete JSON configuration. Population,
  elitism, tournament/rank selection, crossover type/probability, per-locus
  mutation, immigrants, initialization, search RNG, fixture seeds, scoring
  weights, lattice/horizon, worker allocation, stopping and retention settings.
- **Start / Pause / Step**: generation 0 evaluates the initial population;
  each following generation breeds from the retained population. A generation
  limit of `0` is unlimited. Closing every browser does not stop a run.
- **Run queue**: FIFO admission under real coordinator/evaluator CPU budgets.
  Multiple runs share capacity without exceeding configured training limits.
- **Population**: ranked, paginated individuals with all 45 genes, training and
  held-out fitness, birth generation and origin. Click a row to inspect it.
- **Genetics**: actual immediate parents, crossover source, changed loci, rule
  matrix and allele frequencies. It does not invent ancestry outside recorded
  parent references.
- **History**: generation best, best ever, mean, worst, held-out and allelic
  entropy. Select a retained generation or pin the live population without
  pausing training.
- **Champion inspector**: specimen-bounds camera fit, best-ever/generation-best/
  selected candidate, isometric/top/front, volume/2D slice, fixture selection,
  time scrubbing and a full-size focus view. Preview sampling is labeled and
  never changes fitness evaluation.
- **Compare**: retained history on a generation or evaluation-count axis.
  Different evaluation configurations are flagged as not directly comparable.
- **Checkpoint / Fork / Export / Import**: preserve the complete population,
  RNG state, IDs, ancestry, bounded fitness cache and counters. A fork has a new
  identity and does not alter the source. New variants start from the champion
  with a new immutable configuration. Old single-rule JSON files can be imported
  as founders, not misrepresented as resumable population checkpoints.

Run registry, metrics and analysis panels are hideable. No marketing panels or
separate demonstration mode. Space starts/pauses the selected run; Escape exits
focus/options. Training and CA timesteps are explicitly separate.

## Long-running experiments

Runs are owned by the VM service, **not WebSocket connections**. Fitness is
computed by actual Node worker-thread pools; the browser never evaluates a GA or
falls back to browser workers. Viewer disconnections and slow observers do not
throttle or terminate training.

Checkpoints use atomic writes, backups and filesystem synchronization. Pause rolls
back an incomplete generation and persists the last complete one. Restarting the
service restores state; only previously running/queued jobs with automatic
restart enabled are resumed. Paused and archived jobs stay stopped. A model/schema
mismatch or malformed checkpoint is rejected. Reproducibility requires the same
engine version/runtime and configuration; structural validation is not proof
that an externally supplied score was honestly measured.

"Unlimited" means no configured generation ceiling while the VM service is
running—not guaranteed infrastructure uptime or an infinite historical database.
Retention is bounded: 4096 metric points, 256 improvements, configurable retained
population snapshots, and a bounded LRU evaluation cache. The current complete
population and all-time champion remain in the checkpoint. CSV exports contain
the retained window, not silently claimed full history.

Default production storage is `.polyp/research`, excluded from git. Exactly one
canonical process owns it, enforced by a kernel `flock`. Proxy processes never
open it. This is a trusted-workspace application, not an authenticated public
multi-tenant service; restrict network/workspace access appropriately.

## Performance and model

Scoring keeps **two haloed lattice buffers plus per-time counts**, rather than
retaining every candidate's full spacetime volume. Sparse stepping, early
extinction, duplicate elimination and a bounded fitness cache reduce work;
independent worker pools evaluate candidates in parallel with deterministic
result ordering. Preview calculation is separately scheduled and cached.

A single-thread, uncached mixed-rule benchmark on this VM measured roughly
**279 vs 242 fixture evaluations/s** at 49×49×96, and **50 vs 35/s** at
97×97×192, relative to the legacy full-history evaluator. Those are measurements
for those fixtures, not universal speed claims. Live typed-array payloads were
5,970 vs 235,698 bytes for the default case (excluding JavaScript objects, process
RSS, population/cache memory). Run it yourself:

```sh
node --expose-gc scripts/benchmark-research.mjs
```

The scientific model remains a five-state, outer-totalistic Moore CA with fixed
zero boundaries: `next = rule[currentState * 9 + occupiedNeighbors]`. Selection
uses training fitness only; held-out results are separately recorded. Point/cross
fixtures are deterministic, so changing their fixture seeds does not provide
independent validation. Islands supports distinct seeded fixtures.

The complexity objective is a configurable visual heuristic, not algorithmic
complexity or biological realism. Finite longevity rewards only extinction
observed within the finite horizon; censored survivors score zero. This is a 2D
adaptation inspired by Wolfram's work, not reproduction of his experimental
protocol. Exact operators, metrics, validation and benchmark methods:
[research engine](src/research/README.md),
[legacy model reference](src/simulation/README.md).

## Tests

```sh
npm test                    # scientific goldens, checkpoint replay, UI/transport
npm run test:server         # real TCP, worker pools, filesystem and process recovery
npx playwright install chromium
npm run test:e2e            # real browser + isolated research service
```

The native suite exercises worker-count-independent replay, partial-generation
rollback, browser-independent progress, crash/graceful restart, corrupt backups,
CPU queue limits, bounded retention, proxy/lock isolation and sampled preview
fidelity. E2E tests use isolated run directories and archive only their fixtures.

## Main modules

- `src/research/`: strict configuration, compact evaluator, retained-population GA,
  serializable state and browser/VM types.
- `server/manager.ts`, `store.ts`: scheduler, intent, checkpoint and retention.
- `server/coordinator-worker.ts`, `evaluation-worker.ts`: actual genetic workers.
- `server/preview*.ts`: independent bounded CA preview calculation.
- `src/useResearch.ts`: observer reconnection and HTTP operations; no run ownership.
- `src/components/research/`: configuration, population/genetics/history/compare.
- `src/rendering/`: bounded instance packing, specimen camera and dither materials.

GPL-3.0. See [LICENSE](LICENSE).
