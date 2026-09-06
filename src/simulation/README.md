# Simulation model and experiment notes

This module is standalone TypeScript. It does not import React, Three.js, browser
APIs, or runtime dependencies. Its public API is exported from `index.ts`.

## Model

- A synchronous, two-dimensional, **five-state outer-totalistic Moore** cellular
  automaton. State 0 is void; states 1–4 are occupied.
- Each cell counts occupied neighbors among its eight surrounding sites. State
  values are **not summed**. The next state is
  `genome[currentState * 9 + occupiedNeighborCount]`.
- A genome contains 45 integer outputs in `[0, 4]`; gene 0 is permanently zero.
  Empty space with no neighbors cannot spontaneously activate. Input genomes
  violating that condition are rejected, not silently rewritten.
- Outside the finite square, cells are permanently zero. There is **no wrapping**.
  The zero boundary can affect growth and extinction; it is not an infinite field.
- `steps` includes the initial seed at layer 0. A simulation always returns exactly
  that many independent `Uint8Array` layers, in row-major order
  `layers[time][z * size + x]`. A displayed volume stacks time, not a third spatial
  automaton axis.
- Point = one central state-1 cell. Cross = a central cell and two cells in each
  cardinal direction. Islands = seven seeded small nuclei around the center, with
  mixed occupied states. Point and cross are fixed and ignore `randomSeed`;
  islands use a local Mulberry32 pseudorandom generator. Numeric RNG seeds are
  coerced to unsigned 32-bit integers. No global `Math.random` is used.
- Inputs must have positive integer size/steps, finite random seeds, and at most
  16 million recorded sites. Mutation probabilities must be in `[0, 1]`.

## Metrics

Let `N = layers.length`, `A = size²`, and `p[t]` be occupied population at time t.

- **Occupancy O:** `sum(p) / (N * A)`.
- **Activity a:** the number of state changes between adjacent recorded layers,
  divided by `(N - 1) * A`; zero for a one-layer simulation. Births, deaths, and
  transitions between occupied states all count.
- **Diversity D:** Shannon entropy of states 1–4 across all recorded occupied
  sites, divided by `log(4)`. Void does not count as a color category.
- **Lifetime L:** number of nonempty recorded layers, including the seed. Since
  empty space is absorbing, these layers are consecutive.
- **Extinct:** the final recorded population is zero. A false value means
  **censored at the horizon**, not proven immortality.

## Fitness functions

All fitness values are in `[0, 1]`. All candidates within one search are evaluated
against the same seed fixture, field size, and recorded horizon.

Define `clamp(x) = max(0, min(1, x))`, survival `S = L/N`, relative motion
`M = clamp(a / max(O, 0.01))`, population variability
`V = clamp(stddev(p) / max(1, A*O))`, and a density preference
`B = clamp(O/0.1) * clamp(1 - max(0, O-0.25)/0.55)`.

- **Complexity:** `S * (0.34*D + 0.30*M + 0.24*B + 0.12*V)`. This rewards occupied
  state diversity, ongoing activity, sparse/mid-density form, population
  variation, and persistence. It is a visual heuristic, **not** a measurement of
  algorithmic complexity or a proof of open-ended evolution.
- **Finite longevity:** zero if extinction was not observed; otherwise
  `L / max(1, N-1)`. The maximum is a finite life that ends on the last recorded
  layer. An indefinitely active pattern and one that would die just beyond the
  horizon both receive zero, because neither has demonstrated finite extinction
  in this experiment. Increasing the horizon may change both eligibility and
  normalization.
- **Growth:** `0.65*G + 0.25*O + 0.10*S`, where
  `G = clamp((p[last]-p[0]) / max(1, A-p[0]))`. This explicitly favors net final
  expansion and occupation, including dense growth; it is not an anti-density or
  aesthetic objective.

These scores are not directly comparable across objectives or changed
size/horizon/seed configurations. Finite longevity can select an organism that
looks smaller or ends earlier than the default surviving sculpture; that is
intentional, not a rendering failure.

## Real small-population genetic search

One `evolve` call starts an eight-member population: the incumbent plus seven
independently point-mutated copies. It performs three breeding rounds. Each round:

1. Ranks the population by evaluated fitness and retains two elites unchanged.
2. Selects each parent via a three-draw tournament, with replacement.
3. Uniformly crosses the two genomes at every unlocked locus.
4. Independently mutates each of the 44 unlocked loci with the requested
   probability. A selected mutation always changes its output to one of the four
   other possible states.
5. Evaluates six offspring and repeats.

There are at most 26 unique simulation evaluations per call. An exact genome-key
cache avoids duplicate evaluations within that call. The selected result cannot
have lower fitness than the incumbent under the same objective and configuration.
The returned genome is chosen with the seeded RNG uniformly among **distinct
exact-equal-best genotypes evaluated during the call**, including the incumbent
when it ties. Repeated copies do not receive extra weight. This allows neutral
mutations to persist and the genotype to wander between separate searches instead
of freezing on the incumbent due to stable-sort tie order. Such neutral drift can
change unexpressed rule outputs without changing the observed organism or score.
This borrows a useful mechanism from minimal-evolution models; it is still not a
reproduction of a particular scientific experiment.

`improved` uses a `1e-12` tolerance and means **strict score improvement**, not
"a different genome was selected." Callers should adopt the returned genome even
when this flag is false to preserve neutral drift. With zero mutation, identical
founders remain identical and progress is correctly reported as false.
`genomeId` is an 8-digit
FNV-style display fingerprint, not a cryptographic or collision-free identity;
the evaluation cache uses the full genotype, not that fingerprint.

Measured on the development VM, default 41×41×48 searches took approximately
30–65 ms; this is a local measurement, not a browser performance guarantee.

## Curated presets

At size 41, 48 layers, random seed 42:

| Preset      | Seed    | Occupied voxels over time | Peak layer | Mean occupation |
| ----------- | ------- | ------------------------: | ---------: | --------------: |
| Dendrite    | Cross   |                     5,427 |        352 |           6.73% |
| Pagoda      | Point   |                    17,442 |        664 |          21.62% |
| Archipelago | Islands |                     8,569 |        453 |          10.62% |

Dendrite is the default: a narrow root grows into a branching, fourfold crown.
Its occupied X/Z bounds remain 4–36, clear of the boundary through layer 47.
Pagoda spreads quickly into broad lace-like terraces and reaches the field edge.
Archipelago grows an irregular canopy from scattered nuclei; its result changes
with the RNG seed. The curated rules progress through all four occupied states
before clearing, subject to neighbor-count survival restrictions. Mutated rules
need not preserve those age-like semantics. Every curated preset contains all
five states in every recorded layer from layer 16 onward at these settings.

## Scientific scope

The design is **inspired by** Stephen Wolfram's May 2024 discussion of minimal
models of biological evolution. It is an adaptation for interactive temporal
sculptures, **not a literal reproduction** of the paper's rule encoding,
experimental protocol, organism model, or reported findings. In particular, the
45-locus outer-totalistic Moore encoding, curated seeds, visual complexity/growth
objectives, and small genetic algorithm are this application's design choices.
Finite-horizon finite-longevity selection is an experimental proxy; it cannot
determine whether a censored organism lives forever on an unbounded lattice.
No claims of biological realism, literal natural selection, open-ended evolution,
or scientific validation follow from visually complex output.

## Verification

Run `npm test -- src/simulation/index.test.ts` from the project root. The 34 tests
cover exact seeds, all-state lookup and occupied-count semantics, nonwrapping
boundaries (including 1×1 and 2×2 worlds), a separate reference simulator,
extinction padding, determinism and non-aliasing, full preset regressions,
multistate dynamic structure, crossover, tournament selection, mutation,
elitism, deterministic real improvement, neutral genotype wandering, bounded scores, finite-longevity
censoring, and input validation.
