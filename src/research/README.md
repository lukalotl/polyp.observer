# Retained-population research engine

This is a reproducible experiment engine for the existing visual CA, **not a
reproduction of a published biological model**. Its objectives are bounded,
transparent heuristics. Higher fitness is evidence about these finite fixtures,
not biological validity or generalization. The legacy `src/simulation` remains an
small-volume golden reference. Training and preview share
`trajectory.ts`, a streaming simulator with optional consecutive-plane observation.

## Public contract

- `config.ts`: `DEFAULT_RUN_CONFIG`, `validateRunConfig(unknown): RunConfig`.
  Supply a **complete** config, normally a `structuredClone(DEFAULT_RUN_CONFIG)`
  with explicit changes. Validation rejects unknown fields, coercions and unsafe
  values, and returns detached arrays/weights. There are no hidden model switches.
  The optional keys `fixtureFailures`, `randomRuleBias`, `elitism`,
  `mutationPolicy`, `mutationBeta` and `stallGenerations` may be omitted by older
  saved configurations; an absent key means the legacy behavior described below
  and is returned absent, never defaulted, so old checkpoints replay byte-for-byte.
- `mutation.ts`: pure change-count distributions (`heavyTailedWeights`,
  `mutationChangeDistribution`, `rateForExpectedChanges`) shared by the engine's
  heavy-tailed sampler and the run creator's summary. No RNG.
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

`MODEL_VERSION = ca-moore-research-v3`: `stateCount` is 2–16 (including empty
state 0), with exactly `9 * stateCount` integer genes in `[0, stateCount - 1]`,
indexed by `currentState * 9 + occupiedMooreNeighbors`. Neighbors are occupied
counts, not sums of states. Gene 0 is always zero. Updates are synchronous, with a
permanently zero boundary/halo, not wrapping. The seed is recorded at t=0; `steps`
is the finite number of recorded time layers, not genetic generations.

Five-state evaluation reproduces legacy point/cross/islands placement and Mulberry32 RNG.
Islands draw uniformly from occupied states 1 through `stateCount - 1`; their
secondary neighbor uses state 2, or state 1 for binary rules. Point/cross use state 1.
Soup requires explicit `soupSize` N (integer 1…grid size). Its centered N×N square
starts at `floor((size - N) / 2)` on each axis; each cell is drawn independently
and uniformly from all states, including empty, using the fixture's Mulberry32
seed in row-major order. Outside is empty. No center cell is forced. Training,
preview and replay use the same stored seeds; no fresh random draws are made per
candidate. Existing non-soup configurations can omit `soupSize` and retain exact
checkpoint/cache semantics. Selecting soup in the UI expands the untouched default
fixture set to four training and two held-out seeds; explicit user lists survive.

The explicit `ca5-moore-research-v1` checkpoint format migrates by adding
`stateCount: 5`. Both v1 and `ca-moore-research-v2` migrate to v3 with
`boundaryPolicy: { spatial: false, horizon: false }` and false qualification flags. RNG, fitness, IDs, cache, ancestry,
archives and five-state normalization are preserved exactly. New configurations
must specify the count; missing fields and unknown model versions are rejected.
It stores **two haloed lattice buffers** and one `Float64Array(steps)` population
series, never a 3D history. It only steps the live bounding box expanded by one
cell. Clearing the reused output prevents stale cells from reappearing after
contraction. Early extinction leaves exact zero population padding; horizon,
activity, variance, survival and finite-longevity denominators do not shorten.
Variance uses the legacy ordered centered sum, not unstable `E[x²] - E[x]²`.

Each genome is evaluated on all fixed training seeds and then all held-out seeds.
Fitness is the training **mean** or **minimum**, including a zero score for each
failed fixture. Mean rewards partial success; minimum is zero if any fixture fails.
`fixtureFailures: "aggregate"` pins this behavior in new runs. Older saved configs
that omit it (or explicitly use `"all"`) retain their original any-failure-zero
semantics and evaluation cache. New-run variants opt into aggregate behavior.
Validation is aggregated separately using the same rule and is **never** used for parent selection, elites, tie breaks,
or all-time champion. Metrics always average **training fixtures**, even when
fitness uses minimum. Fixtures count separately even if their trajectories match.

- Point and Cross ignore fixture RNG seeds, so multiple seeds do **not** establish
  independent validation for those seed forms. Use Islands or Soup for varied placements.
- Lists reject duplicates, overlap and equivalent uint32 RNG aliases. Accepted
  safe-integer seeds are normalized by `>>> 0`, just like the golden simulator.
  Distinct Islands seeds still can produce similar/equal placements; this is not
  a guarantee of independent biological evidence.
### Composable incentives

The new-run UI uses an editable incentive list instead of an Objective selector.
Each entry persists `{ name, expression, weight }` in optional `config.incentives`.
A present list replaces legacy `objective` / `weights` scoring. Old checkpoints
without the list retain exactly their existing scientific semantics; opening a
new variant converts its old objective into equivalent incentive formulas. The
legacy fields remain in JSON for compatibility and do not affect scoring when
`incentives` is present.

For each fixture, the final score is
`sum(weight * clamp(expression, 0, 1)) / sum(weight)`, clamped to [0,1] for rounding.
Weights are finite, nonnegative, at most 10,000; at least one must be positive.
Zero-weight incentives are skipped. There may be 1–16 incentives. Each formula
should normalize raw counts explicitly; e.g. `totalCells / (area * steps)`.
Negative results clamp to zero and results above one clamp to one *before* the
weighted average. A non-finite intermediate/result (division by zero, overflow,
invalid logarithm/square root) gives **only that incentive** zero on that fixture.

The variable catalog is shared by the evaluator and modal in `expressions.ts`:
normalized diversity, activity, density, variation, persistence and occupancy;
raw exposedCells, reusedCells, reuseEvents, reuseAlive, cellDeaths, lifetime,
initial/final/peak/mean population, population variance and total
occupied cell-timesteps; extinction and spatial/cutoff-contact indicators; and
size, area, steps and state count. All population measurements include the seed
and empty timesteps through the cutoff. Indicators are numeric 0 or 1.

`exposedCells` counts distinct X/Z positions occupied at least once through the
full scientific cutoff, including the starting configuration. Viewed down the
time axis, each column's last live cell claims the single point of exposure.
Stacked cells, state changes and reoccupation never add extra points. Empty
trailing timesteps do not erase claims. It is the population of a Life-style
history-trail projection, not the final population, maximum population, bounding
rectangle or total cell-timesteps. The Light exposure preset divides it by area.
A one-bit-per-position bitmap computes the exact union in the streaming loop;
no history volume or raycast is needed. It adds `4 * ceil(area / 32)` bytes to the
exposure tracking. A second equal-sized bitmap tracks distinct reused positions;
total history-tracking storage is `8 * ceil(area / 32)` bytes, independent of
the timestep count. Preview cropping does not
change scoring, and legacy saved metrics/configurations are unchanged.

`reusedCells` counts distinct X/Z positions that become occupied again after
having been occupied and then empty. `reuseEvents` counts every such return, so
repeated death/rebirth cycles at the same position add more events, but only one
reused position. An empty gap must span at least one recorded timestep; changing
between two live states adds neither a death nor a `reuseEvents` event. A
position's first occupation (including the seed) is never reuse. `cellDeaths` counts every observed
live-to-empty transition, including the first death, even without a later return.
No death after the simulation cutoff is inferred. Each fixture owns independent
history; empty trailing timesteps don't repeat death events.

`reuseAlive` counts every occupied timestep at an X/Z position after its first
occupation, regardless of cell type or whether it ever died. Continuous survival,
changes between live types and returns after an empty gap all count. First
occupation is free, including the seed; empty timesteps never count. A cell alive
at the same position for 8 timesteps has `reuseAlive = 7` and `reuseEvents = 0`.
The exact count is `totalCells - exposedCells`, requiring no extra history storage.
As with the other counts, each fixture is independent and only timesteps through
the scientific cutoff count, regardless of preview cropping.

The Avoid reused positions after death preset uses
`1 - reusedCells / max(1, exposedCells)` to penalize each reused position once.
Avoid reuse after death uses `1 / (1 + reuseEvents)`, penalizing every return
after an empty timestep. Avoid any cell reuse uses `1 / (1 + reuseAlive)`,
penalizing every occupation after the first, even without death. Both reciprocal
incentives score 1 for 0 events, 0.5 for 1, and 0.333 for 2. Avoid cell deaths uses
`1 / (1 + cellDeaths)`, penalizing deaths even without a subsequent return.
These are editable positive rewards for fewer events (incentives maximize their
result). Alone they can favor trivial or empty trajectories; combine them with
light exposure or growth, or incorporate the penalty directly, e.g.
`(exposedCells / area) / (1 + reuseEvents)`.

Expressions use a bounded parser/interpreter, never JavaScript eval/Function.
Only catalog variables, numeric literals, pi/e, parentheses, arithmetic
`+ - * / % ^ **`, numeric comparisons `< <= > >= == !=`, and allowlisted math
functions are accepted. Powers associate right and bind tighter than unary minus.
Functions: abs, sqrt, log, exp, floor, ceil, round, min/max (2–8 arguments),
pow(x,y), clamp(x) / clamp(x,low,high), and lazy if(condition,yes,no).
No accessors, property lookup, assignment, strings, globals or JavaScript calls.
Names are 1–80 characters; formulas 1–512 characters, at most 128 AST nodes and
24 parser nesting levels. A bounded 256-entry compiled-expression cache avoids
parsing each fixture. Server, inline evaluator and native workers share validation.

The dropdown starts with **New incentive**, which opens a nested modal with
click-to-insert variables at the top, syntax validation, naming and formula editing.
Presets expose editable formulas; the list shows each weight's percentage share.
Finite presets require extinction only for their own contribution. Adding a
standalone `1 - spatialContact` incentive is a soft reward. Multiplying an
incentive by it zeros that incentive on contact.

**Hard constraints** remain in the scoring section: boundary switches override
all incentive contributions and zero a contacting fixture. Mean or worst fixture
then aggregates the resulting scores; held-out fixtures use the same process
separately. This preserves a convenient distinction between soft incentives and
hard eligibility without imposing all-fixture failure under mean aggregation.

### Legacy objectives (and corresponding presets)

- `complexity = persistence × weightedMean(diversity, motion, density, variation)`.
  Occupied-state entropy is normalized by `log(stateCount - 1)`. Binary rules
  have only one occupied state, so this component is defined as zero. Its weight
  remains explicit; set it to zero to normalize over the other components.
  Weights are normalized by their positive sum, before multiplication to avoid
  subnormal underflow. Defaults 0.34/0.30/0.24/0.12 match legacy exactly.
- `growth = clamp(.65 × gain + .25 × occupancy + .10 × persistence)`.
- `longevity = lifetime / (steps - 1)` **only when extinction was observed**;
  surviving at the horizon is censored and scores zero. This is finite longevity,
  not a claim that all survivors are immortal.
- `finiteSparse = 1 - occupancy`; `finiteDense = occupancy`. Occupancy is total
  occupied cell-timesteps (including the seed) / `(size² × steps)`. Both require
  a nonempty seed and extinction by the final recorded timestep. A failing
  fixture scores zero even with horizon policy off; mean still credits other
  successful fixtures. Held-out fixtures are assessed independently. Fewer cells favors immediate
  extinction; more cells rewards larger finite spacetime volumes.
- Changing legacy complexity weights does not affect the other legacy objectives.
  With composable incentives present, legacy weights are ignored.
- `boundaryPolicy` defaults to `{ spatial: true, horizon: true }` in new runs.
  Spatial contact means any occupied cell at x=0, x=size−1, z=0 or z=size−1,
  including corners. Contact at any timestep disqualifies that fixture even if
  it subsequently becomes extinct. Horizon contact means occupancy at t=steps−1.
  The intentional t=0 seed is not itself a disqualifying time boundary.
  Each switch independently sets contacting fixtures' scores to zero. Any such
  training fixture sets `disqualified` (meaning at least one fixture failed).
  With aggregate handling this flag does not override the mean. The optional
  `fixturePasses` arrays record each pass/fail independently of its numeric score;
  `validationDisqualified` reports failure in the held-out set only.
  Non-rejected per-fixture scores and all observed metrics are retained.
  Turning the horizon policy off does not remove finite longevity's intrinsic
  requirement for observed extinction. Preview contacts always describe the
  complete fixture, including when the rendered time range is cropped.

Individual metrics: `diversity` is occupied-state Shannon entropy / log(stateCount − 1), or 0 for binary rules;
`activity` is normalized **motion** (`clamp(changedFraction / max(occupancy,.01))`),
not raw changed fraction; `density` is the legacy sparse/mid-density reward;
`variation` is clamped population coefficient of variation; `persistence` is
lifetime/steps; `occupancy` is mean occupied fraction; `lifetime` is mean nonempty
recorded layers; `extinctFraction` is the fraction of training fixtures extinct at
the horizon. All but lifetime lie in [0,1].

## Population, operators, lineage and replay

Generation 0 initializes a real population. New runs default to `random`;
existing configs retain their explicit initialization mode. `mutants` inserts
the supplied genome as founder `i1`, then per-locus mutants (or honest clones at
zero mutations) of that founder. Initialization mode `random` fills **all** slots
with independent random genomes, ignoring the seed genome as a founder.

New drafts use `randomRuleBias: "sparse"`: each unlocked output has an 80% chance
of zero. Empty-state births with one neighbor are 98% zero; births with two or
three neighbors are 95% zero. These low-neighbor births allow outward fronts to
advance into empty space at the Moore neighborhood's maximum speed, so making
them rare reduces explosive growth without forbidding it. Remaining probability
is uniform among nonzero states, independent of alphabet size. Gene 0 stays
locked; each unlocked gene consumes exactly one RNG draw. The same sampler
generates immigrants. Mutation and crossover retain their existing semantics.
An omitted bias or explicit `"uniform"` uses the original uniform sampler,
preserving the exact RNG, population and checkpoint continuation of older runs.

Every advance breeds from the **entire retained prior population**. The best
`eliteCount` survive byte-for-byte with original ID, ancestry and birth generation.
`floor(populationSize * immigrantRate)` fresh, unparented random genomes fill the
last slots. All other slots receive new, monotonically increasing `iN` IDs.

`elitism` (optional) chooses _which_ `eliteCount` survive. Absent or `"slots"`
keeps the top `eliteCount` of a stable fitness-descending sort, duplicates
included. `"distinct"` walks that same sort keeping the first individual for each
full genome key until `eliteCount` are kept; if the population holds fewer distinct
genomes than slots, the next-best duplicates (in sort order) fill the remainder, so
exactly `eliteCount` survive and `nextId === 1 + populationSize + generation ×
(populationSize − eliteCount)` still holds. Retained elites are listed in fitness
order and consume no RNG. Whenever the `eliteCount` fittest are already distinct,
the two policies produce identical states.

Tournament selection draws with replacement and retains the first contestant on
fitness ties; tournament size controls pressure. Rank selection has linear rank
weights 1..N, averaging equal-fitness ranks so neutral genotypes are not biased by
stable ID/order. `selection: "lexicase"` is epsilon-lexicase over per-fixture
`trainingScores` and needs at least two training seeds (validation rejects one:
a single fixture cannot distinguish specialists from the aggregate). Once per
generation, from the _prior_ population, `eps[f]` is the median absolute deviation
of the population's scores on training fixture `f`. Each selection then draws
`fixtures − 1` `random.index` calls for a Fisher–Yates shuffle of fixture indices
(`i` from last down to 1, `j = index(i + 1)`, swap), starts with every individual,
and for each fixture in that order keeps those with
`score >= max(remaining scores) − eps[f]`, stopping when one remains or fixtures
are exhausted; one final `random.index(remaining.length)` picks uniformly among
the survivors (always drawn, even for a single survivor). Held-out scores and
`validationFitness` are never read. A fixture specialist that loses on the mean
can therefore still breed. Uniform crossover chooses each unlocked locus independently.
One-point crossover cuts between unlocked genes, using loci 1..cut from parent 0
and cut+1..last from parent 1 (cut is 1..geneCount−2). `none` or a failed crossover probability
keeps one parent. Crossover may select the same parent twice; its recorded mask
still truthfully records the operation, not invented genetic novelty.

Each unlocked locus mutates independently, always to a _different_ output among
the other `stateCount - 1` states. `crossoverMask[9 * stateCount]` records pre-mutation source parent;
`mutatedLoci` is sorted, unique, excludes 0 and lists actual changes. Two-parent
children have origin `crossover` even if also mutated; one-parent children are
`mutant` or `clone`; founders/random/immigrants are unparented except that initial
mutants reference the real founder. Full parent ID/genome/fitness/birth generation
is retained, not display fingerprints.

`mutationPolicy` (optional) selects the operator. Absent or `"independent"` is the
operator above: one `random.next()` per unlocked locus in ascending order and, for
each change, one `random.index(stateCount − 1)`. `"heavyTailed"` (the fast GA of
Doerr et al. 2017) requires `mutationBeta` in `[1, 4]` and ignores `mutationRate`:
`unlocked = 9 × stateCount − 1`, `kMax = max(1, floor(unlocked / 2))` and
`P(k) ∝ k^−beta` for `k = 1..kMax`, taken from `heavyTailedWeights` in
`mutation.ts` (index 0 is `k = 1`). Draw order per child: one `random.next()`
against the cumulative table picks `k`; `k` `random.index(unlocked − i)` draws
perform a partial Fisher–Yates over the unlocked loci `1..geneCount − 1` (swap
position `i` with `i + draw`, `i = 0..k−1`); the chosen loci are sorted ascending
and each then changes with one `random.index(stateCount − 1)` through the same
`(g + 1 + draw) % stateCount` formula. `k ≥ 1`, so a one-parent child under this
policy is always `mutant`, never `clone`; a two-parent child stays `crossover`.
Initialization `"mutants"` uses the configured policy too. `mutationBeta` is
rejected with any other policy or when the policy is absent.

New drafts (`DEFAULT_RUN_CONFIG`) use `elitism: "distinct"`, `eliteCount: 2`,
`tournamentSize: 2`, `mutationPolicy: "heavyTailed"`, `mutationBeta: 1.5` (about
3.7 changes per child for five states, 46% single changes) and
`mutationRate: 0.034` (≈ 1.5 changes across 44 loci if a draft switches back to
`"independent"`), with `stallGenerations: 0`. These are the trial settings from
[docs/ga-strategy-review.md](../../docs/ga-strategy-review.md): all three audited
plateaued runs kept four copies of one genome in their four elite slots, their
champions' complete one-output neighborhoods held no improvement, and a fixed
per-locus rate silently rescales mutation size with the state count. They are
experimental starting points, not measured winners; the review asks for
controlled comparisons against the legacy operators, which remain available.

Generation snapshots additionally report `distinctElites` (distinct genomes among
the `eliteCount` fittest by rank, regardless of elitism policy, so under
`"distinct"` it shows how often deduplication had to act), `bestCopies`
(population members sharing the fittest genome) and `generationsSinceImprovement`
(`generation − champion.birthGeneration`). `stallGenerations` (integer 0..1e9;
absent or 0 means never) is validated here but acted on only by the server, which
pauses a run once `generationsSinceImprovement` reaches it.

The all-time strict-best champion is independent of the current population. Exact
fitness ties preserve its identity; **zero elites may let generation best regress**.
Generation snapshots report best/mean/worst/median, bestEver, maximum held-out
fitness among the current population, distinct full genotypes, and mean per-locus
Shannon allele entropy / log(stateCount) across the **9 \* stateCount − 1 unlocked genes**. This allelic
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

Keys are complete genomes encoded as one hexadecimal digit per locus, **never short display hashes** (tests include
two different genomes that collide at the legacy display fingerprint). A state's
scientific config, including state count, is pinned: changing the objective/fixtures/horizon/model requires
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
new-run defaults are size 129, 2048 timesteps and the Finite longevity incentive. The work bound is separate from
the streaming memory bound: both per-axis maxima cannot be used together.

Elites 0..population−1; tournament 2..min(32,population); mutation/crossover rates
0..1; immigrant rate 0..0.5 with the floored count fitting non-elite slots; 1..8
training and 0..8 validation seeds; workers 1..13 (also bounded by server capacity); cache 0..8192; maxGenerations
0..1e9; checkpoint seconds 2..300; snapshotEvery 1..10000; retainedSnapshots 2..128;
nonblank name 1..80 characters; finite legacy weights 0..10 with positive sum.
Optional `elitism` slots|distinct; `mutationPolicy` independent|heavyTailed with
finite `mutationBeta` 1..4 required by, and only by, heavyTailed; `selection`
lexicase needs at least 2 training seeds; `stallGenerations` integer 0..1e9.
Composable incentive weights use 0..10,000 with at least one positive weight.

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

Research suite: 327 tests, including 432 randomized golden objective/fixture
comparisons, all default presets/objectives, 40 expansion/contraction trajectories,
early extinction, all metrics, selection pressure, neutral diversity, held-out
isolation, actual crossover/mutation traces, elite retention/regression, collision-
proof cache keys, dedup accounting, abort rollback, out-of-order completion,
JSON replay, malformed checkpoints and reproducible real-CA improvement. The
operator additions are covered by distinct-elite deduplication and fallback fill,
the nextId invariant under every new option, heavy-tailed no-clone/sorted traces
and an empirical change-count distribution against `heavyTailedWeights`, lexicase
held-out isolation (identical genetics whether held-out agrees, disagrees or is
absent) and a fixture specialist that tournament/rank on the mean never select,
per-policy JSON replay, and a legacy sha256 golden that pins the pre-existing
engine's exact continuation when the new keys are absent.

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

## Carousel playback

Playback and looping start enabled, with a 4× speed (25ms per recorded layer).
The speed selector offers 0.5×–16× and applies during playback. The scrub bar ends
at the last occupied layer of the longest visible model, excluding empty cutoff
padding. Scientific data, scoring and boundary contacts retain the full horizon.
All visible previews load before playback starts, so they animate together. Once
the last model finishes, a fixed 200ms hold precedes the next lap. Fixture changes
load the next reproducible preview before advancing its animation; network/compute
latency can add loading time. The complete configured training set is followed by
the held-out set, then wraps to the first seed. Offscreen models remain culled.

The selected rule stays fixed during playback. Pause, manual fixture selection and
scrubbing cancel automatic playback; loading cannot override a manual pause. With
looping off, playback stops at the last occupied layer. Fixture status is absolutely
positioned in the canvas's top-right corner; captions overlay full-height models.
Neighbor models are cached flat projections in one onscreen composition; the
selected model is an interactive 3D foreground pass without per-slot clipping,
allowing zoom and rotation to overlap neighboring projections.

Spatial bounding boxes always span the true lattice `[-size/2, size/2]` on X and Z;
only Y follows occupied voxel extents. A translucent red plane marks the actual
cutoff timestep at `(cutoff - firstPreviewTime) × timeScale`, including cropped and
compressed previews. The camera fits the spatial box and occupied Y extent, so a
very distant cutoff may lie outside the current view until zoomed out.
