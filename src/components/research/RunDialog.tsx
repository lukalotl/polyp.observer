import { useEffect, useRef, useState } from "react";
import { Code2, SlidersHorizontal, X } from "lucide-react";
import {
  founderPresets,
  genomeId,
  resizeGenome,
  MIN_STATE_COUNT,
  MAX_STATE_COUNT,
} from "../../research/genome";
import { validateRunConfig } from "../../research/config";
import {
  MAX_GRID_SIZE,
  SIMULATION_SCALES,
  maxHorizon,
} from "../../research/limits";
import type { RunConfig } from "../../research/types";
import { trapDialogTab } from "../../dialogFocus";
import RuleEditor from "../RuleEditor";

interface Props {
  initial: RunConfig;
  title?: string;
  maxWorkers: number;
  busy: boolean;
  onClose: () => void;
  onCreate: (config: RunConfig, start: boolean) => Promise<unknown>;
}
type NumericKey = {
  [K in keyof RunConfig]: RunConfig[K] extends number ? K : never;
}[keyof RunConfig];
const seeds = (text: string) =>
  text.trim()
    ? text.split(",").map((value) => {
        if (!value.trim())
          throw new Error("Fixture seeds must be comma-separated integers.");
        const n = Number(value);
        if (!Number.isSafeInteger(n))
          throw new Error("Fixture seeds must be safe integers.");
        return n;
      })
    : [];

export default function RunDialog({
  initial,
  title = "New run",
  maxWorkers,
  busy,
  onClose,
  onCreate,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<RunConfig>(() => structuredClone(initial));
  const [trainText, setTrainText] = useState(initial.trainingSeeds.join(", "));
  const [validationText, setValidationText] = useState(
    initial.validationSeeds.join(", "),
  );
  const [raw, setRaw] = useState(false);
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [editGenome, setEditGenome] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  const update = <K extends keyof RunConfig>(key: K, value: RunConfig[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const composed = () =>
    validateRunConfig(
      raw
        ? JSON.parse(json)
        : {
            ...draft,
            trainingSeeds: seeds(trainText),
            validationSeeds: seeds(validationText),
          },
    );
  const numeric = (
    key: NumericKey,
    label: string,
    min: number,
    max: number,
    step = 1,
    note?: string,
  ) => (
    <label className="config-field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(draft[key]) ? draft[key] : ""}
        onChange={(event) => update(key, event.target.valueAsNumber)}
      />
      {note && <small>{note}</small>}
    </label>
  );
  async function submit(start: boolean) {
    try {
      const config = composed();
      setError("");
      await onCreate(config, start);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create run.",
      );
    }
  }
  function switchEditor() {
    try {
      const config = composed();
      setDraft(config);
      setTrainText(config.trainingSeeds.join(", "));
      setValidationText(config.validationSeeds.join(", "));
      setJson(JSON.stringify(config, null, 2));
      setRaw((value) => !value);
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Invalid configuration.",
      );
    }
  }
  const presets = founderPresets(draft.stateCount);
  const preset =
    presets.find((value) =>
      value.genome.every((gene, index) => gene === draft.seedGenome[index]),
    )?.id ?? "custom";
  const fixtureCount =
    trainText.split(",").filter((value) => value.trim()).length +
    validationText.split(",").filter((value) => value.trim()).length;
  const populationWork =
    draft.size * draft.size * draft.steps * draft.populationSize * fixtureCount;
  const scoringBytes = 2 * (draft.size + 2) ** 2 + draft.steps * 8;
  return (
    <dialog
      ref={dialog}
      className="run-dialog"
      aria-labelledby="run-dialog-title"
      onKeyDown={trapDialogTab}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <header className="dialog-header">
        <h2 id="run-dialog-title">{title}</h2>
        <div className="button-row">
          <button
            onClick={switchEditor}
            disabled={busy}
            aria-label={
              raw ? "Use parameter fields" : "Edit configuration JSON"
            }
          >
            {raw ? <SlidersHorizontal size={14} /> : <Code2 size={14} />}
            <span>{raw ? "Fields" : "JSON"}</span>
          </button>
          <button
            aria-label="Close run configuration"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="run-dialog-content">
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        {raw ? (
          <textarea
            aria-label="Configuration JSON"
            className="config-json-editor"
            spellCheck={false}
            value={json}
            onChange={(event) => setJson(event.target.value)}
          />
        ) : (
          <>
            <label className="config-name">
              <span>Name</span>
              <input
                autoFocus
                aria-label="Run name"
                value={draft.name}
                maxLength={80}
                onChange={(event) => update("name", event.target.value)}
              />
            </label>
            <div className="config-grid">
              <fieldset>
                <legend>Evaluation</legend>
                <label className="config-field">
                  <span>State count</span>
                  <select
                    aria-label="State count"
                    value={draft.stateCount}
                    onChange={(event) => {
                      const stateCount = Number(event.target.value);
                      setDraft((current) => ({
                        ...current,
                        stateCount,
                        seedGenome: resizeGenome(
                          current.seedGenome,
                          stateCount,
                        ),
                      }));
                    }}
                  >
                    {Array.from(
                      { length: MAX_STATE_COUNT - MIN_STATE_COUNT + 1 },
                      (_, i) => i + MIN_STATE_COUNT,
                    ).map((count) => (
                      <option key={count} value={count}>
                        {count}
                        {count === 2 ? " · binary" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="config-note">
                  Includes empty state 0. Changing the count keeps existing rule
                  rows, maps removed outputs to 1, and copies state 1's rule
                  into new rows.
                  {draft.stateCount === 2 &&
                    " Life and HighLife are available under Founder preset."}
                </p>
                <label className="config-field">
                  <span>Simulation scale</span>
                  <select
                    aria-label="Simulation scale"
                    value={
                      SIMULATION_SCALES.find(
                        (scale) =>
                          scale.size === draft.size &&
                          scale.steps === draft.steps,
                      )?.id ?? "custom"
                    }
                    onChange={(event) => {
                      const scale = SIMULATION_SCALES.find(
                        (value) => value.id === event.target.value,
                      );
                      if (scale)
                        setDraft((current) => ({
                          ...current,
                          size: scale.size,
                          steps: scale.steps,
                        }));
                    }}
                  >
                    <option value="custom" disabled>
                      Custom
                    </option>
                    {SIMULATION_SCALES.map((scale) => (
                      <option key={scale.id} value={scale.id}>
                        {scale.label}
                      </option>
                    ))}
                  </select>
                </label>
                {numeric("size", "Grid size", 9, MAX_GRID_SIZE, 2)}
                {numeric(
                  "steps",
                  "CA horizon",
                  8,
                  maxHorizon(draft.size),
                  1,
                  "CA timesteps per evaluation, not GA generations.",
                )}
                <p className="config-note">
                  Up to {maxHorizon(draft.size).toLocaleString("en-US")}{" "}
                  timesteps at this grid size. Larger grids and longer horizons
                  increase evaluation time. The preview samples time; fitness
                  evaluates the full horizon.
                </p>
                <label className="config-field">
                  <span>Seed pattern</span>
                  <select
                    aria-label="Seed pattern"
                    value={draft.seed}
                    onChange={(event) =>
                      update("seed", event.target.value as RunConfig["seed"])
                    }
                  >
                    <option value="point">Point</option>
                    <option value="cross">Cross</option>
                    <option value="islands">Islands</option>
                  </select>
                </label>
                <label className="config-field">
                  <span>Training seeds</span>
                  <input
                    aria-label="Training seeds"
                    value={trainText}
                    onChange={(event) => setTrainText(event.target.value)}
                  />
                </label>
                <label className="config-field">
                  <span>Held-out seeds</span>
                  <input
                    aria-label="Held-out seeds"
                    placeholder="Optional"
                    value={validationText}
                    onChange={(event) => setValidationText(event.target.value)}
                  />
                </label>
                {draft.seed !== "islands" && (
                  <p className="config-note">
                    Point and cross ignore fixture seeds. Use islands for
                    distinct training and held-out fixtures.
                  </p>
                )}
                <label className="config-field">
                  <span>Objective</span>
                  <select
                    aria-label="Objective"
                    value={draft.objective}
                    onChange={(event) =>
                      update(
                        "objective",
                        event.target.value as RunConfig["objective"],
                      )
                    }
                  >
                    <option value="longevity">Finite longevity</option>
                    <option value="complexity">Complexity heuristic</option>
                    <option value="growth">Growth</option>
                  </select>
                </label>
                {draft.objective === "longevity" && (
                  <p className="config-note">
                    Rewards the longest lifetime that ends within the horizon.
                    Still alive at the cutoff scores zero; increase the horizon
                    to observe longer finite lifetimes.
                  </p>
                )}
                <label className="config-field">
                  <span>Aggregation</span>
                  <select
                    aria-label="Aggregation"
                    value={draft.aggregation}
                    onChange={(event) =>
                      update(
                        "aggregation",
                        event.target.value as RunConfig["aggregation"],
                      )
                    }
                  >
                    <option value="mean">Mean of fixtures</option>
                    <option value="minimum">Worst fixture</option>
                  </select>
                </label>
                {draft.objective === "complexity" && (
                  <div className="weight-fields">
                    {(
                      [
                        ["diversity", "State entropy"],
                        ["activity", "Motion"],
                        ["density", "Density"],
                        ["variation", "Variation"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key}>
                        <span>{label}</span>
                        <input
                          aria-label={`${label} weight`}
                          type="number"
                          min="0"
                          max="10"
                          step="0.01"
                          value={
                            Number.isFinite(draft.weights[key])
                              ? draft.weights[key]
                              : ""
                          }
                          onChange={(event) =>
                            update("weights", {
                              ...draft.weights,
                              [key]: event.target.valueAsNumber,
                            })
                          }
                        />
                      </label>
                    ))}
                    <small>
                      Weights are normalized; persistence scales the result.
                      {draft.stateCount === 2 &&
                        " Binary rules have one occupied state, so state entropy is zero. Set its weight to 0 to use only the other components."}
                    </small>
                  </div>
                )}
              </fieldset>
              <fieldset>
                <legend>Genetics</legend>
                {numeric("populationSize", "Population", 8, 512)}
                {numeric("eliteCount", "Elites", 0, draft.populationSize - 1)}
                <label className="config-field">
                  <span>Selection</span>
                  <select
                    aria-label="Selection"
                    value={draft.selection}
                    onChange={(event) =>
                      update(
                        "selection",
                        event.target.value as RunConfig["selection"],
                      )
                    }
                  >
                    <option value="tournament">Tournament</option>
                    <option value="rank">Rank weighted</option>
                  </select>
                </label>
                {numeric(
                  "tournamentSize",
                  "Tournament size",
                  2,
                  Math.min(32, draft.populationSize),
                )}
                <label className="config-field">
                  <span>Crossover</span>
                  <select
                    aria-label="Crossover"
                    value={draft.crossover}
                    onChange={(event) =>
                      update(
                        "crossover",
                        event.target.value as RunConfig["crossover"],
                      )
                    }
                  >
                    <option value="uniform">Uniform</option>
                    <option value="onePoint">One point</option>
                    <option value="none">None</option>
                  </select>
                </label>
                {numeric("crossoverRate", "Crossover probability", 0, 1, 0.05)}
                {numeric(
                  "mutationRate",
                  "Mutation probability",
                  0,
                  1,
                  0.005,
                  "Independent probability per unlocked rule entry.",
                )}
                {numeric("immigrantRate", "Immigrant fraction", 0, 0.5, 0.01)}
                {numeric(
                  "randomSeed",
                  "Search RNG seed",
                  -Number.MAX_SAFE_INTEGER,
                  Number.MAX_SAFE_INTEGER,
                )}
                <label className="config-field">
                  <span>Initialization</span>
                  <select
                    aria-label="Initialization"
                    value={draft.initialization}
                    onChange={(event) =>
                      update(
                        "initialization",
                        event.target.value as RunConfig["initialization"],
                      )
                    }
                  >
                    <option value="mutants">Founder + mutations</option>
                    <option value="random">Random rules</option>
                  </select>
                </label>
              </fieldset>
              <fieldset>
                <legend>Execution & retention</legend>
                {numeric(
                  "evaluationWorkers",
                  "CPU workers",
                  1,
                  Math.max(1, maxWorkers),
                )}
                {numeric(
                  "maxGenerations",
                  "Generation limit",
                  0,
                  1_000_000_000,
                  1,
                  "0 = train until paused.",
                )}
                {numeric(
                  "checkpointSeconds",
                  "Checkpoint interval (s)",
                  2,
                  300,
                )}
                {numeric(
                  "snapshotEvery",
                  "Archive every N generations",
                  1,
                  10000,
                )}
                {numeric("retainedSnapshots", "Retained populations", 2, 128)}
                {numeric("cacheSize", "Evaluation cache entries", 0, 8192)}
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={draft.resumeOnRestart}
                    onChange={(event) =>
                      update("resumeOnRestart", event.target.checked)
                    }
                  />
                  Resume running jobs after server restart
                </label>
              </fieldset>
              <fieldset>
                <legend>Founder rule</legend>
                <label className="config-field">
                  <span>Preset</span>
                  <select
                    aria-label="Founder preset"
                    value={preset}
                    onChange={(event) => {
                      const value = presets.find(
                        (p) => p.id === event.target.value,
                      );
                      if (value)
                        setDraft((current) => ({
                          ...current,
                          seedGenome: [...value.genome],
                          seed: value.seed,
                        }));
                    }}
                  >
                    <option value="custom" disabled>
                      Custom
                    </option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="founder-genome"
                  aria-label="Edit founder genome"
                  onClick={() => setEditGenome(true)}
                >
                  {draft.seedGenome.map((state, index) => (
                    <i key={index} className={`gene-${state}`} />
                  ))}
                </button>
                <div className="founder-caption">
                  <code>{genomeId(draft.seedGenome)}</code>
                  <button onClick={() => setEditGenome(true)}>
                    Edit {draft.seedGenome.length} outputs
                  </button>
                </div>
                <p className="config-note">
                  {draft.stateCount}-state, outer-totalistic Moore CA. State 0
                  is empty; its empty-neighborhood rule is locked. Boundaries
                  are fixed zero.
                </p>
                <dl className="cost-estimate">
                  <div>
                    <dt>Full population work ceiling</dt>
                    <dd>
                      {Number.isFinite(populationWork)
                        ? populationWork.toLocaleString("en-US")
                        : "—"}{" "}
                      cell-steps
                    </dd>
                  </div>
                  <div>
                    <dt>Scoring typed buffers / evaluator</dt>
                    <dd>
                      {Number.isFinite(scoringBytes)
                        ? (scoringBytes / 1024).toFixed(1)
                        : "—"}{" "}
                      KiB
                    </dd>
                  </div>
                </dl>
                <p className="config-note">
                  Work is reduced by early extinction, sparsity and cache hits.
                  Buffer size excludes process, population and cache memory.
                </p>
              </fieldset>
            </div>
          </>
        )}
      </div>
      <footer className="dialog-footer">
        <span>
          Configurations are immutable. Branch to change the experiment.
        </span>
        <div className="button-row">
          <button disabled={busy} onClick={() => void submit(false)}>
            Create paused
          </button>
          <button
            className="primary-action"
            disabled={busy}
            onClick={() => void submit(true)}
          >
            {busy ? "Creating…" : "Create & start"}
          </button>
        </div>
      </footer>
      <RuleEditor
        open={editGenome}
        genome={draft.seedGenome}
        onClose={() => setEditGenome(false)}
        onApply={(value) => update("seedGenome", value)}
      />
    </dialog>
  );
}
