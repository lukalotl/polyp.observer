# GA primitives and creation-flow contract (working document, 9 Sep 2026)

This is the shared contract for the parallel implementation of the changes proposed in
[ga-strategy-review.md](./ga-strategy-review.md) plus the redundancy findings from the
follow-up review. The type-level contract is already committed in
`src/research/types.ts`; this file fixes the semantics so that engine, server and UI work
can proceed in parallel without inventing divergent names.

Non-negotiables

- Old configurations, checkpoints and history must keep loading and must replay exactly.
  Every new config field is optional and absent means "legacy behavior". Follow the
  existing `randomRuleBias` / `fixtureFailures` pattern in `validateRunConfig`,
  `exactKeys` and `migrateLegacyRunConfig`.
- The `nextId === 1 + populationSize + generation * (populationSize - eliteCount)`
  invariant must still hold: exactly `eliteCount` elites are retained every generation.
- Genetic randomness is consumed before evaluation and never depends on completion
  order. Document the RNG draw order for every new operator in `src/research/README.md`.
- Every change ships with tests in the existing style (vitest for `src/`, node:test for
  `server/`, Playwright for the dialog). Deterministic replay and legacy-checkpoint
  loading are the two regressions to fear most.

## Config fields (RunConfig)

| Field | Values | Absent means | New-draft default |
| --- | --- | --- | --- |
| `elitism` | `"slots"` \| `"distinct"` | `"slots"` | `"distinct"` |
| `eliteCount` | existing | — | `2` (was 4) |
| `selection` | `"tournament"` \| `"rank"` \| `"lexicase"` | — | `"tournament"` |
| `tournamentSize` | existing | — | `2` (was 4) |
| `mutationPolicy` | `"independent"` \| `"heavyTailed"` | `"independent"` | `"heavyTailed"` |
| `mutationBeta` | number in `[1, 4]`; required iff heavyTailed, rejected otherwise | — | `1.5` |
| `mutationRate` | existing; only used by `"independent"` | — | `0.034` (≈ 1.5 changes / 44 loci) |
| `stallGenerations` | integer `0..1e9` | `0` (never) | `0` |

Semantics

- **distinct elitism**: sort by fitness descending (stable), walk the list keeping the
  first individual for each genome key until `eliteCount` are kept. If the population has
  fewer distinct genomes than `eliteCount`, fill the remaining slots with the next-best
  duplicates so the count is exact. Elites keep ID, ancestry and birth generation.
- **heavy-tailed mutation**: `unlocked = 9 * stateCount - 1`; `kMax = max(1, floor(unlocked / 2))`;
  draw `k` with `P(k) ∝ k^-beta` for `k in 1..kMax` (one `random.next()` against the
  cumulative table); then choose `k` distinct unlocked loci (partial Fisher–Yates using
  `random.index`), and change each to a different state via
  `(g + 1 + random.index(stateCount - 1)) % stateCount`, exactly like the existing
  operator. Resulting `mutatedLoci` must be sorted ascending. `k ≥ 1` always, so a
  one-parent child under this policy is never a `clone`. Initialization `"mutants"` uses the
  configured policy too.
- **epsilon-lexicase selection**: computed per generation from the *prior* population.
  For each training fixture `f`, `eps[f]` = median absolute deviation of the population's
  `trainingScores[f]`. To select one parent: shuffle fixture indices (Fisher–Yates using
  `random.index`), start with all individuals, and for each fixture in that order keep
  those with `score >= max(remaining scores) - eps[f]`; stop when one remains or fixtures
  are exhausted; return a uniform random remaining individual (`random.index`). Requires
  `trainingSeeds.length >= 2`; `validateRunConfig` rejects lexicase with one fixture.
  Held-out scores are never consulted.
- **stallGenerations**: server-side only. After a generation commits, if
  `stallGenerations > 0` and `metrics.generationsSinceImprovement >= stallGenerations`, the
  run is paused (status `"paused"`, `stopReason` `"Stalled: N generations without improvement."`).
  Start resumes it and clears the reason. It is not `"completed"`.

## Metrics and summary

`GenerationMetrics` (engine, already implemented in `generationSnapshot`):
`distinctElites`, `bestCopies`, `generationsSinceImprovement`.

`HistoryPoint` (manager): `generationEvaluations` and `generationRepeats` are the deltas
of `state.evaluations / fixtureCount` and `state.cacheHits` versus the previous state.
Both are optional because older history lacks them. `validateCheckpoint` must accept
history points that lack the new keys and must only compare `generationSnapshot(state)`
metrics against keys present in the stored last point for the three new metric keys.

`RunSummary`: `generationsSinceImprovement` and `distinctElites` mirror the latest metrics
(optional in the type, always populated by the new server when a state exists).

## Creation flow (client)

- A `<dialog>` with accessible name equal to its title (`New run`, `Fork run`, …), full
  width, four directly navigable sections and a persistent plain-language summary:
  **Goal** (incentives, hard constraints, aggregation, worked score examples),
  **Starting worlds** (state count, scale, seed pattern, soup size, fixture seeds with the
  *effective* distinct-world count; cross/point say "1 deterministic world, seeds ignored"),
  **Search** (initialization, founder editor only for founder mode, population, elitism +
  elite count, selection + tournament size, mutation policy + beta or expected changes per
  child with the resulting change-count distribution, crossover, immigrants with the actual
  per-generation count, search RNG seed), **Budget** (workers with the server cap,
  generation limit, stall pause, independent repeats, then checkpoint/retention/cache
  details).
- Preserve every existing accessible label used by `src/App.test.tsx`, `e2e/*.spec.ts`
  (Run name, Grid size, CA horizon, Population, Elites, Selection, Tournament size,
  Mutation probability, Training seeds, Held-out seeds, Initialization, Random rule
  sampling, Founder preset, Edit founder genome, Generation limit, Disqualify spatial edge
  contact, Disqualify time cutoff contact, Edit configuration JSON, Use parameter fields,
  Configuration JSON, Create paused, Create & start). Add new labels: `Elitism`,
  `Mutation policy`, `Mutation beta`, `Expected changes per child`, `Stall pause`,
  `Independent repeats`, `New search seed`.
- A fresh `randomSeed` is generated whenever the dialog opens (new run and fork alike).
  Fork shows the source seed and offers a one-click exact replay of it.
- `Independent repeats` (1–8) creates that many runs with distinct fresh seeds, names
  suffixed ` · seed k`, all queued the same way as a single create.
- Summary example: "64 rules · 1 training world · mean score · heavy-tailed mutation,
  about 3.7 changes per child (46% single) · 2 distinct elites · tournament of 2 · 3
  immigrants per generation · no stall pause · unlimited generations".

## Run views (client)

- History/metrics: a search-health strip showing generations since improvement, distinct
  elites, best copies, unique evaluations per generation and repeat share (from
  `generationEvaluations` / `generationRepeats` when present).
- Population table: per-fixture training scores and the training-minus-held-out gap.

## File ownership for the parallel pass

| Workstream | Owns |
| --- | --- |
| engine | `src/research/{config,engine}.ts`, `src/research/README.md`, `src/research/*.test.ts`, `src/test/researchFixtures.ts` |
| server | `server/**` |
| creation flow | `src/components/research/RunDialog.tsx`, new files under `src/components/research/create/`, `src/index.css`, `src/App.tsx`, `src/useResearch.ts`, `src/App.test.tsx`, `src/useResearch.test.tsx`, `e2e/**`, `README.md` |
| run views | `src/components/research/{HistoryView,PopulationView}.tsx`, `visualizerData.ts`, `visualizers.css`, new `SearchHealth.tsx`, their tests |

`src/research/types.ts` is frozen for this pass; ask the coordinator before changing it.
