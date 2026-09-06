# Retained-population research engine

This is a reproducible experiment engine for the existing visual CA, **not a
reproduction of a published biological model**. Its three objectives are bounded,
transparent heuristics. Higher fitness is evidence about these finite fixtures,
not biological validity or generalization. The legacy `src/simulation` remains an
unchanged, small-volume golden reference. Training and preview share
`trajectory.ts`, a streaming simulator with optional sampled-plane observation.

## Public contract

- `config.ts`: `DEFAULT_RUN_CONFIG`, `validateRunConfig(unknown): RunConfig`.
  Supply a **complete** config, normally a `structuredClone(DEFAULT_RUN_CONFIG)`
  with explicit changes. Validation rejects unknown fields, coercions and unsafe
  values, and returns detached arrays/weights. There are no hidden model switches.
- `evaluate.ts`: synchronous `evaluateGenome(genome, config): Evaluation` and
  asynchronous inline oracle `evaluateBatch(genomes, config): Promise<Evaluation[]>`.
- `engine.ts`: async `initializePopulation(config, evaluate?)`, async
  `advanceGeneration(state, evaluate?)`, `generationSnapshot(state)`, and
  `validateEngineState(unknown): EngineState`. The validator throws `RangeError`
  or returns a detached, checked state; keep the returned value.
- `BatchEvaluator` is `(genomes, config) => Promise<Evaluation[]>`. Executors may
  finish tasks in any order, but **must return results in input order** (e.g.
  indexed tasks plus `Promise.all`). Arrays of bare evaluations contain no genome
  identity, so the engine cannot detect a executor that returns completion order.
  The Node service owns worker pooling, cancellation and durable checkpoint I/O.

## Pinned science and evaluation

`MODEL_VERSION = ca5-moore-research-v1`: exactly five states and 45 integer genes,
indexed by `currentState * 9 + occupiedMooreNeighbors`. Neighbors are occupied
counts, not sums of states. Gene 0 is always zero. Updates are synchronous, with a
permanently zero boundary/halo, not wrapping. The seed is recorded at t=0; `steps`
is the finite number of recorded time layers, not genetic generations.

The evaluator reproduces legacy point/cross/islands placement and Mulberry32 RNG.
It stores **two haloed lattice buffers** and one `Float64Array(steps)` population
series, never a 3D history. It only steps the live bounding box expanded by one
cell. Clearing the reused output prevents stale cells from reappearing after
contraction. Early extinction leaves exact zero population padding; horizon,
activity, variance, survival and finite-longevity denominators do not shorten.
Variance uses the legacy ordered centered sum, not unstable `E[x²] - E[x]²`.

Each genome is evaluated on all fixed training seeds and then all held-out seeds.
Fitness is the training **mean** or **minimum**. Validation is aggregated separately
using the same rule and is **never** used for parent selection, elites, tie breaks,
or all-time champion. Metrics always average **training fixtures**, even when
fitness uses minimum. Fixtures count separately even if their trajectories match.

- Point and Cross ignore fixture RNG seeds, so multiple seeds do **not** establish
  independent validation for those seed forms. Use Islands for varied placements.
- Lists reject duplicates, overlap and equivalent uint32 RNG aliases. Accepted
  safe-integer seeds are normalized by `>>> 0`, just like the golden simulator.
  Distinct Islands seeds still can produce similar/equal placements; this is not
  a guarantee of independent biological evidence.
- `complexity = persistence × weightedMean(diversity, motion, density, variation)`.
  Weights are normalized by their positive sum, before multiplication to avoid
  subnormal underflow. Defaults 0.34/0.30/0.24/0.12 match legacy exactly.
- `growth = clamp(.65 × gain + .25 × occupancy + .10 × persistence)`.
- `longevity = lifetime / (steps - 1)` **only when extinction was observed**;
  surviving at the horizon is censored and scores zero. This is finite longevity,
  not a claim that all survivors are immortal.
- Changing complexity weights does not affect growth or longevity.

Individual metrics: `diversity` is occupied-state Shannon entropy / log(4);
`activity` is normalized **motion** (`clamp(changedFraction / max(occupancy,.01))`),
not raw changed fraction; `density` is the legacy sparse/mid-density reward;
`variation` is clamped population coefficient of variation; `persistence` is
lifetime/steps; `occupancy` is mean occupied fraction; `lifetime` is mean nonempty
recorded layers; `extinctFraction` is the fraction of training fixtures extinct at
the horizon. All but lifetime lie in [0,1].

## Population, operators, lineage and replay

Generation 0 initializes a real population. `mutants` inserts the supplied genome
as founder `i1`, then per-locus mutants (or honest clones at zero mutations) of
that founder. Initialization mode `random` fills **all** slots with independent
uniform random genomes, ignoring the seed genome as a founder.

Every advance breeds from the **entire retained prior population**. The best
`eliteCount` survive byte-for-byte with original ID, ancestry and birth generation.
`floor(populationSize * immigrantRate)` fresh, unparented random genomes fill the
last slots. All other slots receive new, monotonically increasing `iN` IDs.

Tournament selection draws with replacement and retains the first contestant on
fitness ties; tournament size controls pressure. Rank selection has linear rank
weights 1..N, averaging equal-fitness ranks so neutral genotypes are not biased by
stable ID/order. Uniform crossover chooses each unlocked locus independently.
One-point crossover cuts between unlocked genes, using loci 1..cut from parent 0
and cut+1..44 from parent 1 (cut is 1..43). `none` or a failed crossover probability
keeps one parent. Crossover may select the same parent twice; its recorded mask
still truthfully records the operation, not invented genetic novelty.

Each unlocked locus mutates independently, always to a _different_ output among
the other four states. `crossoverMask[45]` records pre-mutation source parent;
`mutatedLoci` is sorted, unique, excludes 0 and lists actual changes. Two-parent
children have origin `crossover` even if also mutated; one-parent children are
`mutant` or `clone`; founders/random/immigrants are unparented except that initial
mutants reference the real founder. Full parent ID/genome/fitness/birth generation
is retained, not display fingerprints.

The all-time strict-best champion is independent of the current population. Exact
fitness ties preserve its identity; **zero elites may let generation best regress**.
Generation snapshots report best/mean/worst/median, bestEver, maximum held-out
fitness among the current population, distinct full genotypes, and mean per-locus
Shannon allele entropy / log(5) across the **44 unlocked genes**. This allelic
entropy differs from the individual's occupied-state entropy.

State includes every individual, champion, uint32 Mulberry32 state, next ID,
ordered LRU and counters. Genetic randomness is consumed before evaluation, never
by result-completion order. JSON round-trip plus next-generation evaluation gives
the exact same state, including IDs, masks, cache order and counters. The backend
may abort an evaluator and keep the prior state: advance works on a detached
transaction, and passes detached genomes/config to the evaluator. Snapshots also
do not alias live state. `maxGenerations: 0` means unbounded _genetic training_;
CA horizons remain finite. Explicit positive limits stop further advances.

## Cache and accounting

Keys are complete 45-digit genomes, **never short display hashes** (tests include
two different genomes that collide at the legacy display fingerprint). A state's
scientific config is pinned: changing the objective/fixtures/horizon/model requires
a **new initialized run**, not transplanting its population/cache.

The checkpoint stores LRU entries least-to-most recently touched. A batch first
resolves hits against its starting cache, deduplicates all candidates, evaluates
unique misses in first-appearance order, then applies LRU touches in candidate
order. Completion order never affects eviction. Even at cacheSize 0, duplicates
within that batch evaluate once. Elites need no new candidate evaluation or hit.

`evaluations` counts **actually computed CA fixtures** = unique misses ×
(training seeds + held-out seeds). `cacheHits` counts candidate cache/dedup hits,
not fixtures. Transaction commit preserves the useful invariant:

```
evaluations / fixtureCount + cacheHits === nextId - 1
```

Aborted work is not committed to durable counters; a worker might physically have
finished part of a canceled transaction, which the retained state intentionally
cannot claim as committed search work.

## Validation and bounds

Odd size 9..1025; steps 8..65536; size²×steps ≤1,073,741,824; population 8..512;
new-run defaults are size 129 and 2048 timesteps. The work bound is separate from
the streaming memory bound: both per-axis maxima cannot be used together.

Elites 0..population−1; tournament 2..min(32,population); mutation/crossover rates
0..1; immigrant rate 0..0.5 with the floored count fitting non-elite slots; 1..8
training and 0..8 validation seeds; workers 1..6; cache 0..8192; maxGenerations
0..1e9; checkpoint seconds 2..300; snapshotEvery 1..10000; retainedSnapshots 2..128;
nonblank name 1..80 characters; finite weights 0..10 with positive sum.

Checkpoint validation checks model/schema, bounded array lengths before copying,
RNG/IDs/generations, unique individual IDs, ancestry chronology, mutation/crossover
reconstruction, origin consistency, score aggregation, normalized metric bounds,
lifetime/persistence consistency, all-time champion dominance, cache keys and
bounds, and exact counters. Repeated individual references and repeated genotype
evaluations must agree. This is **structural validation, not authentication**:
it cannot prove imported scores arose from real historical computation without
re-evaluating history. Filesystem/service access controls remain necessary.

## Tests and measured benchmark

Run through the project environment:

```sh
npm test -- src/research
node --expose-gc scripts/benchmark-research.mjs
```

Research suite: 103 tests, including 432 randomized golden objective/fixture
comparisons, all default presets/objectives, 40 expansion/contraction trajectories,
early extinction, all metrics, selection pressure, neutral diversity, held-out
isolation, actual crossover/mutation traces, elite retention/regression, collision-
proof cache keys, dedup accounting, abort rollback, out-of-order completion,
JSON replay, malformed checkpoints and reproducible real-CA improvement.

Observed on this workspace, Node v22.23.2 / AMD EPYC (2026-09-06), five alternating
measured rounds after warm-up, 64 deterministic mixed-density mutant candidates
per round, **one fixture per candidate, inline single-thread, uncached**:

| Fixture                    | Legacy volume eval/s | Streaming sparse scalar eval/s | Speed ratio |
| -------------------------- | -------------------: | -----------------------------: | ----------: |
| 49×49, 96 layers, Cross    |               242.31 |                         279.43 |      1.153× |
| 97×97, 192 layers, Islands |                34.74 |                          50.22 |      1.445× |

These are measured medians, not universal speedup claims. Workload density,
extinction, CPU contention, thread-pool size and horizons affect throughput.
A separate full retained 64-member original 49×49×96 run completed 10 generations and 511
new fixture evaluations in 1.616 s (316.23 fixture eval/s, including genetic/cache
work), ended with best 0.9990260651951529 and 59 unique genotypes, and serialized
to a 268,624-byte checkpoint. Later validation-hardening edits may slightly alter
wall time, but not the deterministic final state. The script emits all raw times,
engine counters and JSON size and can be rerun to measure the current machine.

**Analytical live typed-array payload**, not measured process RSS: streaming uses
`2*(size+2)² + 8*steps` bytes (5,970 bytes at 49×49×96; 21,138 at the larger fixture),
versus legacy `2*(size+2)² + size²*steps` bytes (235,698 and 1,826,130 respectively).
The new default uses 50,706 typed-buffer bytes. The independent upper bound
is 2*(1025+2)² + 8*65,536 = 2,633,746 bytes (the work budget makes the actual
maximum smaller). Preview additionally retains at most 8 MiB of full spatial
planes and a full-horizon population series. These
bounds exclude JS metadata, state/population/cache, worker heaps and garbage
awaiting collection. There is no claim that process RSS equals lattice payload.


## Deep preview sampling

`sample.ts` observes the same streaming trajectory used by scoring, without
retaining its full space-time volume. It starts with a stride that fits 128
layers and an 8 MiB retained-plane budget, then doubles that stride as needed
to keep at most 180,000 occupied voxels. Doubling only removes samples; every
plane required by the final stride was already captured. The first and last
planes are always retained, with their actual CA time indices. No spatial cells
are dropped. If those two planes alone exceed the voxel limit, preview returns
an explicit error; scientific evaluation still supports that configuration.

The full population series and summary metrics include every timestep, even
when previews are heavily sampled or extinction occurs early. Scoring keeps
its original arithmetic, so existing checkpoints retain their model identity.
Changing size or horizon still requires a fresh population evaluation.
