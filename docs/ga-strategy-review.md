**GA strategy review and run creator proposal — 9 September 2026**

Polyp's plateaus are real. The most useful next step is to improve experiment definition, preserve useful breeding diversity, and benchmark a small number of conventional search changes. The evidence does not justify replacing the engine with a complicated optimizer or claiming that a particular new parameter set will solve stagnation.

This review combines recent surveys, established theory, a source audit at `0c504dc`, and read-only measurements of saved runs. Proposed settings below are experimental starting points. No GA behavior or saved experiment was changed for this review.

**What the literature supports.** Recent work develops several complementary approaches: preserving population diversity, adjusting variation during a run, restarting searches, learning which operators to use, and optimizing a repertoire of behaviors. These solve different problems. None supplies universally optimal population, mutation, or crossover settings for our CA representation.

| Reading | Relevance and limits |
| --- | --- |
| Bäck et al., [*Evolutionary Algorithms for Parameter Optimization—Thirty Years Later*](https://doi.org/10.1162/evco_a_00325), 2023 | The strongest broad strategic review here. It argues for understanding components and problem characteristics, reproducible benchmarking, and consolidation of algorithms. Its main domain is continuous parameter optimization; its recommendations about scientific practice transfer more directly than its particular optimizers. Publisher text read through the Leiden repository. |
| Londe et al., [*Biased Random-Key Genetic Algorithms: A Review*](https://doi.org/10.1016/j.ejor.2024.03.030), 2024; [author manuscript](https://arxiv.org/abs/2312.00961) | Surveys over 150 papers. Sections 5–6 discuss islands, resets, partial resets, parameter control, and premature convergence from excessive elite concentration. It also describes problems where uniform crossover is unsuitable. Polyp is not a random-key GA: borrow the questions and simple mechanisms, not BRKGA's numerical defaults. Author manuscript read. |
| Song et al., [*Reinforcement learning-assisted evolutionary algorithm: A survey and research opportunities*](https://doi.org/10.1016/j.swevo.2024.101517), 2024; [author manuscript](https://arxiv.org/abs/2308.13420) | Maps learned solution generation, operator selection, and parameter adaptation. It explicitly discusses training cost and generalization. Relevant as a research direction; adding an RL controller is not warranted for our first redesign. Author manuscript read. |
| Naaman et al., [*Optimization by Nature: A Review of Genetic Algorithm Techniques*](https://doi.org/10.33022/ijcs.v14i1.4596), 2025 | Recent broad applications overview. Useful orientation, but its heterogeneous application summaries do not establish CA-specific settings or comparative evidence strong enough to choose our defaults. Full text read. |
| Qin et al., [*A survey on Quality-Diversity optimization: Approaches, applications, and challenges*](https://doi.org/10.1016/j.swevo.2025.102240), online November 2025 / January 2026 issue | A recent comprehensive QD survey identified in the search. Publication metadata verified; full text was unavailable, so no detailed recommendation here depends on an unverified claim from it. |

The recent surveys need grounding in more focused sources:

- Sudholt, [*The Benefits of Population Diversity in Evolutionary Algorithms: A Survey of Rigorous Runtime Analyses*](https://arxiv.org/abs/1801.10087), 2018 manuscript: diversity can help exploration and crossover; genotype and phenotype diversity differ. Results concern specified algorithms and landscapes, not a guarantee for any diversity mechanism.
- Doerr and Doerr, [*Theory of Parameter Control for Discrete Black-Box Optimization*](https://arxiv.org/abs/1804.05650), 2020 chapter: dynamic parameter choices can provide provable gains on particular problems. This supports testing parameter control, not assuming a generic adaptive schedule will help.
- Doerr and Rajabi, [*Stagnation Detection Meets Fast Mutation*](https://arxiv.org/abs/2201.12158), 2022: occasional larger mutations and stagnation-based changes have complementary strengths for crossing fitness valleys. The theory is for specific discrete search models; its speedups cannot be quoted as expected Polyp speedups.
- Pugh, Soros and Stanley, [*Quality Diversity: A New Frontier for Evolutionary Computation*](https://doi.org/10.3389/frobt.2016.00040), 2016: seeking many different good behaviors is a different task from maximizing one scalar score. Genetic differences can conceal similar behaviors. The QD discussion here is grounded in this accessible full text.
- Bartz-Beielstein et al., [*Benchmarking in Optimization: Best Practice and Open Issues*](https://arxiv.org/abs/2007.03488), 2020: define the problem, budget, baselines, repetitions, performance measures, and reproducibility before drawing algorithm comparisons.

Alhijawi and Awajan's [2023 general GA review](https://doi.org/10.1007/s12065-023-00822-6) was also identified; only its abstract and references were accessible. This is a targeted review, not an exhaustive systematic literature search or a claim that every relevant 2026 paper was available.

**What our implementation and saved experiments show.**

The engine already has useful foundations: reproducible randomness, immutable configurations, checkpoint continuation, evaluation caching, random immigrants, and selection from the retained population. It does not recreate every generation from the champion. Held-out scores do not influence parent selection.

However, several mechanisms can explain fast initial progress followed by long waits:

| Observation | Evidence | Implication |
| --- | --- | --- |
| Genuine local peaks | Exhaustive single-output neighborhood checks described below | Escaping requires a multi-output change, recombination, or a path through equal/worse intermediates. |
| Diversity is concentrated among weaker candidates | All three audited populations preserved four elite copies of one genome | Counting distinct genomes across the whole population overstates diversity among the candidates most likely to breed. |
| Fixed mutation percentage changes meaning with state count | Mutable outputs = `9 × states − 1`; at 3%, expected changes are 1.32 for 5 states, 2.67 for 10, and 4.29 for 16 | A state-count change silently changes both the search space and the typical mutation size. |
| Initialization and mutation use different distributions | Sparse initialization/immigration favors zero; a mutation always chooses a different state uniformly | Mutating zero always creates a live output; at 5 states, mutating a live output returns zero only 25% of the time. Without selection, repeated mutation tends toward a uniform output distribution. This is an explicit implementation choice, not evidence that sparse mutation would perform better. |
| Some nominal fixture sets contain only one pattern | Cross and point ignore fixture RNG seeds | Four training seeds and two held-out seeds can evaluate the same world six times. Equal scores then say nothing about generalization. |
| Real fixture generalization gaps | One soup champion scores 0.334881 on training and 0.106771 on held-out fixtures; another scores 0.639376 versus 0.315385 | Optimizing the training score can improve fixture-specific behavior. More generations alone do not fix the evaluation design. |
| Scores can contain cliffs and saturation | Hard boundary failure zeros a fixture; each incentive formula is clipped to `[0,1]` before weighted averaging | Many different failures become indistinguishable, and an unnormalized count formula can stop providing useful distinctions. |
| Search is unlimited and static by default | No stagnation policy; fixed tournament size, mutation and crossover | There is no budget-aware decision to try a different starting population. |

The CA representation also matters: outputs depend on the cell's current state and the **number** of occupied neighbors, not neighboring cell types. Adding colors does not add type-specific neighbor sensing. Independently evolved state labels can play different functional roles, making locus-wise crossover potentially disruptive. That last point is a hypothesis to test, not a measured causal explanation.

**The local-peak check used the actual fitness function.** For three saved five-state champions, the existing evaluator reproduced each stored training score within `1e-12`. I then evaluated every possible change to one mutable rule output: 44 outputs × 4 alternative states = 176 neighbors per champion, 528 neighbors total. Configurations, fixtures, weights and boundary policies stayed fixed. Comparisons use tolerance `1e-12`.

| Saved experiment | Generation / last improvement | Training / held-out score | Better / equal / worse one-output neighbors | Elite diversity |
| --- | --- | --- | --- | --- |
| A, cross, population 64 | 479,693 / 212,436 | 0.687083 / same repeated cross | 0 / 0 / 176 | 1 distinct genome in 4 slots |
| B, soup, population 64 | 35,725 / 20,447 | 0.334881 / 0.106771 | 0 / 0 / 176 | 1 distinct genome in 4 slots |
| C, soup, population 128 | 1,353 / 517 | 0.639376 / 0.315385 | 0 / 1 / 175 | 1 distinct genome in 4 slots |

A and B are strict local maxima under a one-output neighborhood. C is a non-strict local maximum. None is proven globally optimal, and the check does not tell us how far away an improvement lies. C had both hard boundary constraints disabled, so hard disqualification cannot explain every plateau.

A had gone 267,257 generations without improvement while retaining 51 distinct genomes out of 64. Its top quarter contained only three distinct genomes. B retained 53 distinct genomes, and C retained 116. These findings support measuring breeding diversity as well as whole-population diversity; they do not establish that diversity is sufficient to escape.

Improvement timings came from retained improvement records, not the rolling 4,096-generation history. A did have a major late breakthrough at generation 212,436. Consequently, a short fixed restart threshold could discard productive long searches. Saved runs have different objectives and budgets, and these three champions were selected for diagnosis: this is not an unbiased success-rate estimate or a controlled comparison of GA variants.

**A simpler creation page should expose the experiment before its mechanics.** Use a full-width creation workspace with four directly navigable sections and a persistent summary. Keep the draft when switching sections, show errors beside affected controls, and support keyboard navigation and narrow screens. Avoid a forced sequence that makes experienced users repeatedly click through unchanged settings.

| Section | Main decisions | Details revealed when relevant |
| --- | --- | --- |
| Goal | What behavior earns fitness; a small set of understandable incentive presets; actual weighted contribution; hard requirements | Formula editor, normalization and saturation, mean versus worst-case aggregation |
| Starting worlds | State count, grid, CA duration, initial cell pattern; thumbnails of the actual training and validation worlds | Pattern RNG seeds, soup size, duplicate-world detection |
| Search | Random population or founder; population size; expected rule-output changes per child; search preset | Selection, distinct elites, crossover, immigrant count, exact RNG seed and sampling distribution |
| Budget | Evaluation/time budget, workers available, independent repeats, what to do when progress stalls | Retention, checkpoint frequency, cache size, recovery policy |

The persistent review should explain the selected experiment in plain language: for example, “128 rules; 4 distinct training worlds and 2 validation worlds; mean score; about 1.5 output changes per child; 2 distinct rules preserved.” Show CA timesteps and GA generations separately. Display the founder editor only for founder mode, and show random rule examples as examples, never as an inserted founder.

The goal section should show concrete score examples: immediate extinction, continued survival, repeated occupation, spatial contact, and an incentive exceeding its declared range. For finite longevity, explicitly show that surviving to the cutoff scores zero. For reuse avoidance, explicitly show how empty/short-lived behavior can earn a high component score. A soft edge-contact indicator is still binary; call it a graded penalty only if the formula actually measures degree of violation.

For cross/point, show one deterministic world and no claim of independent validation. For randomized patterns, generate and freeze the actual worlds, verify distinct hashes, and expose the effective fixture count. The UI currently contains explanatory notes, but permits configurations that conflict with their apparent meaning.

**Candidate defaults should be tested, and some defaults depend on the question.**

| Setting | Current new-run default | Recommended next step |
| --- | --- | --- |
| Population | 64 | Trial 128 under the same evaluation budget; retain 64 as baseline |
| Elites | 4 slots, duplicates allowed | Trial 2 distinct genomes; preserve the all-time record separately |
| Parent selection | Tournament of 4 | Trial tournament of 2 to give alternative lineages more opportunity |
| Mutation | 3% per output | Present expected changes; trial a mean of 1.5, converted to `p = 1.5 / (9 × states − 1)` for the current always-change operator |
| Crossover | Uniform, 70% | Compare 0%, 35%, and 70%; keep the current setting until evidence supports replacement |
| Immigration | 5%, rounded down | Keep initially; show the actual count (3 at population 64, 6 at 128) |
| Rule sampling | Sparse random initial rules and immigrants | Keep the requested prior explicit; separately benchmark prior-preserving mutation |
| Fixtures | One cross; no held-out worlds | Keep a clear single-world mode; offer a robustness mode with 4 distinct training soups and 2 validation soups as a starting design, not a statistical guarantee |
| Search RNG | 1729 | Generate and record a fresh seed for a new independent search; make exact replay deliberate |
| Budget | Unlimited generations | Require an explicit finite evaluation/time budget in the main flow, with an explicit continuous option |
| Workers | 2 per run; server cap 13 | Show the available cap and measured throughput; additional workers do not change the search strategy |

Do not silently shorten the 2,048-step default horizon or relax hard constraints to make curves look better: both change the scientific question. Offer clearly named smaller exploratory worlds and separate validation at the intended final grid/horizon. A higher score on a different world is not a continuation improvement.

A sparse mutation alternative needs precise semantics. One simple option is to resample selected outputs from the sparse prior, allowing no change. That preserves the prior under neutral repeated resampling, but the expected number of actual changes depends on the current genome. Merely rejecting resamples equal to the current output changes the stationary distribution. Keep “attempted edits” and “actual changes” distinct, and version the policy for exact checkpoint replay. Test this alternative separately from changing mutation strength.

**Start with independent searches before elaborate adaptation.** A run group can execute several ordinary GAs with different recorded RNG seeds and retain every result. That requires scheduling and result comparison, but no new genetic operators or fitness function. The current public server permits one active run, so sequential repeats are the simplest initial implementation; 13 workers do not imply 13 independent populations.

Compare one long run with several independent runs using the same total evaluation budget. This is not guaranteed to win: experiment A's late improvement makes that tradeoff concrete. If restarts help, add a small, explicit stagnation policy using evaluations since the last training improvement, a warm-up period, a total budget, and an archived best result. A truly independent restart should not seed its new breeding population with the old champion. Keep its global record separate.

If local-peak trapping remains dominant, compare one bounded variation change: mostly ordinary mutation with occasional larger edits. Do not simultaneously add mutation schedules, new selection, crossover changes, and restarts and then attribute the gain to any one component. Raising mutation continually can destroy the useful structures we are trying to extend.

Quality-diversity methods such as MAP-Elites become relevant if the product goal is “discover many different interesting organisms.” They require explicit behavior descriptors, an archive, and changed parent/replacement rules. NSGA-II is relevant if users want to explore tradeoffs instead of committing to weights. Both are legitimate separate directions, but neither is required for the first creator redesign. A hidden novelty bonus would change the objective and make the current scalar score harder to interpret.

**Validation should make the next decision defensible.**

1. Freeze a small CA benchmark suite covering single-world and multiple-soup tasks, short and long horizons, and at least two state counts. Include ordinary tasks as well as the diagnosed difficult landscapes; keep objective changes separate from optimizer comparisons.
2. Keep the current GA as a baseline and include independent random search. Compare one change at a time, then test interactions among the promising changes. Include distinct elitism and reduced tournament size, mutation scaled by genome size, crossover ablations, and independent repeats.
3. Use 20 independent search seeds as an initial pilot per configuration where affordable, expanding if uncertainty remains large. This is a proposed starting budget, not a universal adequate sample size. Fix fixture sets within each comparison and reserve new worlds for final assessment after tuning.
4. Compare quality after equal uncached genome-evaluation budgets and report actual fixture evaluations and wall time too. The existing `state.evaluations` counter already counts fixture evaluations, so normalize by the fixed fixture count when deriving a genome-evaluation budget. Population size, cache hits, fixture count, early extinction and parallelism make generation counts alone misleading. Report medians/spread and probabilities of reaching a predeclared useful score, not just the best seed.
5. Record training/validation gaps, generations and evaluations since the last record, score distribution, feasible fraction, distinct elites, allele diversity, and offspring improvement/failure rates. Add a cheap behavior summary before proposing behavior-aware selection. State entropy inside a simulation is not population diversity.
6. Test saved-config migration, deterministic replay, worker-count invariance, exact budgets, and restart recovery. Browser tests should verify visible effective fixture counts, expected mutation changes, draft preservation, and create/fork/replay semantics.

Domain knowledge is legitimate when visible and reproducible. A declared sparse proposal distribution, distinct elitism, and independent restarts remain ordinary evolutionary search. Injecting a handcrafted rule into a run labeled random, choosing winners on a supposedly untouched test set, or changing weights mid-run while drawing one continuous fitness curve would undermine the experiment. Repeated human tuning against validation also makes it a development set; a final assessment needs fresh worlds.

The recommended implementation order is creator structure and truthful experiment summaries, then diagnostics and distinct breeding diversity, then controlled evaluation of a revised search preset and independent repeats. Keep the genotype representation, exact evaluator, and checkpoint guarantees throughout.

Relevant implementation: [defaults](../src/research/config.ts), [population and variation](../src/research/engine.ts), [evaluation](../src/research/evaluate.ts), [incentives](../src/research/incentives.ts), [creation dialog](../src/components/research/RunDialog.tsx). Private diagnostic inputs and outputs remain in the ignored `.polyp/ga-research/` directory; no saved run was edited.
