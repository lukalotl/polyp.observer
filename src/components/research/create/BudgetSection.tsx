import type { DraftApi } from "./draft";
import { NumericField } from "./fields";

export default function BudgetSection({
  api,
  maxWorkers,
  repeats,
  onRepeats,
  fixtureCount,
}: {
  api: DraftApi;
  maxWorkers: number;
  repeats: number;
  onRepeats: (value: number) => void;
  fixtureCount: number;
}) {
  const { draft, update, errorFor } = api;
  const stall = draft.stallGenerations ?? 0;
  const populationWork =
    draft.size * draft.size * draft.steps * draft.populationSize * fixtureCount;
  const scoringBytes =
    2 * (draft.size + 2) ** 2 +
    draft.steps * 8 +
    8 * Math.ceil(draft.size ** 2 / 32);
  return (
    <>
      <fieldset>
        <legend>Compute and stopping</legend>
        <NumericField
          label="CPU workers"
          value={draft.evaluationWorkers}
          min={1}
          max={Math.max(1, maxWorkers)}
          error={errorFor("CPU workers")}
          note="Parallel evaluators for this run. More workers finish generations sooner without changing the search itself."
          onChange={(value) => update("evaluationWorkers", value)}
        >
          <span className="field-suffix">
            of {maxWorkers || "?"} available
          </span>
        </NumericField>
        <NumericField
          label="Generation limit"
          value={draft.maxGenerations}
          min={0}
          max={1_000_000_000}
          error={errorFor("Generation limit")}
          note="0 = train until paused."
          onChange={(value) => update("maxGenerations", value)}
        />
        <NumericField
          label="Stall pause"
          value={stall}
          min={0}
          max={1_000_000_000}
          error={errorFor("Stall pause")}
          note="GA generations without a new record before the run pauses itself; 0 = never. A stalled run is paused, not completed: its population is preserved and Start resumes it for another full window. Single steps never trigger it."
          onChange={(value) => update("stallGenerations", value)}
        />
        <NumericField
          label="Independent repeats"
          value={repeats}
          min={1}
          max={8}
          note="Creates this many runs with distinct search seeds, named “… · seed k”. Repeat 1 uses the seed from Search; each further repeat draws a fresh seed. All are queued exactly like a single create."
          onChange={(value) => onRepeats(value)}
        />
      </fieldset>
      <details className="details-group">
        <summary>Details</summary>
        <fieldset>
          <legend>Checkpoints and retention</legend>
          <NumericField
            label="Checkpoint interval (s)"
            value={draft.checkpointSeconds}
            min={2}
            max={300}
            error={errorFor("Checkpoint interval (s)")}
            onChange={(value) => update("checkpointSeconds", value)}
          />
          <NumericField
            label="Archive every N generations"
            value={draft.snapshotEvery}
            min={1}
            max={10000}
            error={errorFor("Archive every N generations")}
            onChange={(value) => update("snapshotEvery", value)}
          />
          <NumericField
            label="Retained populations"
            value={draft.retainedSnapshots}
            min={2}
            max={128}
            error={errorFor("Retained populations")}
            onChange={(value) => update("retainedSnapshots", value)}
          />
          <NumericField
            label="Evaluation cache entries"
            value={draft.cacheSize}
            min={0}
            max={8192}
            error={errorFor("Evaluation cache entries")}
            onChange={(value) => update("cacheSize", value)}
          />
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
          Work is reduced by early extinction, sparsity and cache hits. Buffer
          size excludes process, population and cache memory.
        </p>
      </details>
    </>
  );
}
