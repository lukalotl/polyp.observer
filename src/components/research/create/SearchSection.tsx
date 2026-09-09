import { Dices, History } from "lucide-react";
import { founderPresets, genomeId } from "../../../research/genome";
import {
  mutationChangeDistribution,
  rateForExpectedChanges,
  unlockedLoci,
} from "../../../research/mutation";
import type { RunConfig } from "../../../research/types";
import type { DraftApi } from "./draft";
import { NumericField, SelectField } from "./fields";
import { freshSearchSeed } from "./seeds";
import { immigrantsPerGeneration } from "./summary";

const shown = (value: number) =>
  Number.isFinite(value) ? Number(value.toPrecision(6)) : value;
const pct = (value: number | undefined) =>
  `${((value ?? 0) * 100).toFixed(1)}%`;

export default function SearchSection({
  api,
  sourceSeed,
  trainingSeedCount,
  onEditGenome,
}: {
  api: DraftApi;
  sourceSeed?: number;
  trainingSeedCount: number;
  onEditGenome: () => void;
}) {
  const { draft, update, patch, errorFor } = api;
  const presets = founderPresets(draft.stateCount);
  const preset =
    presets.find((value) =>
      value.genome.every((gene, index) => gene === draft.seedGenome[index]),
    )?.id ?? "custom";
  const policy = draft.mutationPolicy ?? "independent";
  const unlocked = unlockedLoci(draft.stateCount);
  const distribution = mutationChangeDistribution(draft);
  const p = distribution.probabilities;
  const immigrants = immigrantsPerGeneration(draft);
  const lexicaseShort =
    draft.selection === "lexicase" && trainingSeedCount < 2
      ? `Lexicase needs at least two training seeds; this draft lists ${trainingSeedCount}.`
      : undefined;
  return (
    <>
      <fieldset>
        <legend>Initial population</legend>
        <SelectField
          label="Initialization"
          value={draft.initialization}
          error={errorFor("Initialization")}
          options={[
            { value: "random", label: "Random rules" },
            { value: "mutants", label: "Founder + mutations" },
          ]}
          onChange={(value) =>
            update("initialization", value as RunConfig["initialization"])
          }
        />
        <p className="config-note">
          {draft.initialization === "random"
            ? "Every contender starts with an independently randomized rule. No founder rule is used for initialization."
            : "One contender keeps the founder rule; the others start as mutations of it under the mutation policy below."}
        </p>
        {draft.initialization === "mutants" && (
          <div className="founder-editor">
            <SelectField
              label="Founder preset"
              value={preset}
              error={errorFor("Founder preset")}
              options={[
                { value: "custom", label: "Custom", disabled: true },
                ...presets.map((value) => ({
                  value: value.id,
                  label: value.name,
                })),
              ]}
              onChange={(value) => {
                const chosen = presets.find((item) => item.id === value);
                if (chosen)
                  patch((current) => ({
                    ...current,
                    seedGenome: [...chosen.genome],
                    seed: chosen.seed,
                  }));
              }}
            />
            <button
              type="button"
              className="founder-genome"
              aria-label="Edit founder genome"
              onClick={onEditGenome}
            >
              {draft.seedGenome.map((state, index) => (
                <i key={index} className={`gene-${state}`} />
              ))}
            </button>
            <div className="founder-caption">
              <code>{genomeId(draft.seedGenome)}</code>
              <button type="button" onClick={onEditGenome}>
                Edit {draft.seedGenome.length} outputs
              </button>
            </div>
            <p className="config-note">
              {draft.stateCount}-state, outer-totalistic Moore CA. State 0 is
              empty; its empty-neighborhood rule is locked. Boundaries are fixed
              zero. Choosing a preset also selects its starting pattern.
            </p>
          </div>
        )}
        <SelectField
          label="Random rule sampling"
          value={draft.randomRuleBias ?? "uniform"}
          options={[
            { value: "sparse", label: "Favor empty · rare edge births" },
            { value: "uniform", label: "Uniform outputs" },
          ]}
          onChange={(value) =>
            update("randomRuleBias", value as RunConfig["randomRuleBias"])
          }
        />
        <p className="config-note">
          {draft.randomRuleBias === "sparse"
            ? "Random rules and immigrants output empty (0) 80% of the time. For empty cells with 1 neighbor this rises to 98%, or 95% with 2–3 neighbors, making fast-spreading fronts rarer. Remaining probability is shared equally by live states."
            : "Random rules and immigrants give every output state equal probability. Existing runs retain this sampler unless changed in a new draft."}{" "}
          This controls random rule generation; mutation and crossover keep
          their usual behavior.
        </p>
        <NumericField
          label="Population"
          value={draft.populationSize}
          min={8}
          max={512}
          error={errorFor("Population")}
          onChange={(value) => update("populationSize", value)}
        />
      </fieldset>
      <fieldset>
        <legend>Survival and parents</legend>
        <SelectField
          label="Elitism"
          value={draft.elitism ?? "slots"}
          error={errorFor("Elitism")}
          options={[
            { value: "distinct", label: "Distinct genomes" },
            { value: "slots", label: "Slots" },
          ]}
          onChange={(value) =>
            update("elitism", value as NonNullable<RunConfig["elitism"]>)
          }
        />
        <NumericField
          label="Elites"
          value={draft.eliteCount}
          min={0}
          max={Math.max(0, draft.populationSize - 1)}
          error={errorFor("Elites")}
          note={
            (draft.elitism ?? "slots") === "distinct"
              ? "Keeps the fittest pairwise-distinct genomes; duplicates fill a slot only when fewer distinct genomes exist."
              : "Keeps the fittest individuals even when they share one genome, so copies of the champion can hold every slot."
          }
          onChange={(value) => update("eliteCount", value)}
        />
        <SelectField
          label="Selection"
          value={draft.selection}
          error={errorFor("Selection") ?? lexicaseShort}
          options={[
            { value: "tournament", label: "Tournament" },
            { value: "rank", label: "Rank weighted" },
            { value: "lexicase", label: "Lexicase" },
          ]}
          onChange={(value) =>
            update("selection", value as RunConfig["selection"])
          }
        />
        {draft.selection === "tournament" && (
          <NumericField
            label="Tournament size"
            value={draft.tournamentSize}
            min={2}
            max={Math.min(32, draft.populationSize)}
            error={errorFor("Tournament size")}
            note="Smaller tournaments give alternative lineages more chances to breed."
            onChange={(value) => update("tournamentSize", value)}
          />
        )}
        {draft.selection === "lexicase" && (
          <p className="config-note">
            Lexicase needs at least two training worlds: each parent is chosen
            by filtering on per-world training scores in a random world order.
            With point or cross patterns every seed is the same world, so use
            islands or soup.
          </p>
        )}
      </fieldset>
      <fieldset>
        <legend>Variation</legend>
        <SelectField
          label="Mutation policy"
          value={policy}
          error={errorFor("Mutation policy")}
          options={[
            { value: "heavyTailed", label: "Heavy-tailed" },
            { value: "independent", label: "Independent per output" },
          ]}
          onChange={(value) =>
            patch((current) => {
              if (value === "heavyTailed")
                return {
                  ...current,
                  mutationPolicy: "heavyTailed",
                  mutationBeta: current.mutationBeta ?? 1.5,
                };
              const { mutationBeta: _unused, ...rest } = current;
              void _unused;
              return { ...rest, mutationPolicy: "independent" };
            })
          }
        />
        {policy === "heavyTailed" ? (
          <NumericField
            label="Mutation beta"
            value={draft.mutationBeta}
            min={1}
            max={4}
            step={0.1}
            error={errorFor("Mutation beta")}
            note={`Each child changes k of the ${unlocked} unlocked outputs with P(k) ∝ k^−beta, k from 1 to ${Math.max(1, Math.floor(unlocked / 2))}. Lower beta makes large jumps more common; every child changes at least one output.`}
            onChange={(value) => update("mutationBeta", value)}
          />
        ) : (
          <>
            <NumericField
              label="Expected changes per child"
              value={shown(draft.mutationRate * unlocked)}
              min={0}
              max={unlocked}
              step={0.1}
              note={`Mean changed outputs among the ${unlocked} unlocked entries; sets the per-output probability below.`}
              onChange={(value) =>
                update(
                  "mutationRate",
                  Number.isFinite(value)
                    ? rateForExpectedChanges(draft.stateCount, value)
                    : value,
                )
              }
            />
            <NumericField
              label="Mutation probability"
              value={shown(draft.mutationRate)}
              min={0}
              max={1}
              step={0.005}
              error={errorFor("Mutation probability")}
              note="Independent probability per unlocked rule entry. Children with no change are clones."
              onChange={(value) => update("mutationRate", value)}
            />
          </>
        )}
        <dl className="mutation-readout" aria-label="Mutation changes per child">
          <div>
            <dt>P(0)</dt>
            <dd>{pct(p[0])}</dd>
          </div>
          <div>
            <dt>P(1)</dt>
            <dd>{pct(p[1])}</dd>
          </div>
          <div>
            <dt>P(2)</dt>
            <dd>{pct(p[2])}</dd>
          </div>
          <div>
            <dt>P(3+)</dt>
            <dd>
              {pct(Math.max(0, 1 - (p[0] ?? 0) - (p[1] ?? 0) - (p[2] ?? 0)))}
            </dd>
          </div>
          <div>
            <dt>Mean</dt>
            <dd>
              {Number.isFinite(distribution.mean)
                ? distribution.mean.toFixed(2)
                : "—"}
            </dd>
          </div>
        </dl>
        <SelectField
          label="Crossover"
          value={draft.crossover}
          error={errorFor("Crossover")}
          options={[
            { value: "uniform", label: "Uniform" },
            { value: "onePoint", label: "One point" },
            { value: "none", label: "None" },
          ]}
          onChange={(value) =>
            update("crossover", value as RunConfig["crossover"])
          }
        />
        <NumericField
          label="Crossover probability"
          value={draft.crossoverRate}
          min={0}
          max={1}
          step={0.05}
          error={errorFor("Crossover probability")}
          onChange={(value) => update("crossoverRate", value)}
        />
        <NumericField
          label="Immigrant fraction"
          value={draft.immigrantRate}
          min={0}
          max={0.5}
          step={0.01}
          error={errorFor("Immigrant fraction")}
          note={`${immigrants} random ${immigrants === 1 ? "immigrant" : "immigrants"} per generation: floor(${draft.populationSize} × ${draft.immigrantRate}). Immigrants use the random rule sampling above.`}
          onChange={(value) => update("immigrantRate", value)}
        />
      </fieldset>
      <fieldset>
        <legend>Reproducibility</legend>
        <NumericField
          label="Search RNG seed"
          value={draft.randomSeed}
          min={-Number.MAX_SAFE_INTEGER}
          max={Number.MAX_SAFE_INTEGER}
          error={errorFor("Search RNG seed")}
          note="A fresh seed was drawn when this creator opened. Identical seed and identical settings replay the identical search; a new seed starts an independent one."
          onChange={(value) => update("randomSeed", value)}
        >
          <button
            type="button"
            className="seed-action"
            aria-label="New search seed"
            title="Draw a fresh random seed"
            onClick={() => update("randomSeed", freshSearchSeed())}
          >
            <Dices size={13} />
            <span>New</span>
          </button>
          {sourceSeed !== undefined && (
            <button
              type="button"
              className="seed-action"
              aria-label="Use source seed"
              title={`Replay the source run's seed ${sourceSeed}`}
              disabled={draft.randomSeed === sourceSeed}
              onClick={() => update("randomSeed", sourceSeed)}
            >
              <History size={13} />
              <span>Source {sourceSeed}</span>
            </button>
          )}
        </NumericField>
      </fieldset>
    </>
  );
}
