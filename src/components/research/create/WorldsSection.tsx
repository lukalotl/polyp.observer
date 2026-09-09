import {
  MAX_STATE_COUNT,
  MIN_STATE_COUNT,
  resizeGenome,
} from "../../../research/genome";
import {
  MAX_GRID_SIZE,
  SIMULATION_SCALES,
  maxHorizon,
} from "../../../research/limits";
import type { RunConfig } from "../../../research/types";
import type { DraftApi } from "./draft";
import { NumericField, SelectField, TextField } from "./fields";
import { listedSeeds } from "./seeds";
import { effectiveWorlds } from "./summary";

export default function WorldsSection({
  api,
  trainText,
  validationText,
  onTrainText,
  onValidationText,
}: {
  api: DraftApi;
  trainText: string;
  validationText: string;
  onTrainText: (value: string) => void;
  onValidationText: (value: string) => void;
}) {
  const { draft, update, patch, errorFor } = api;
  const worlds = effectiveWorlds(
    draft.seed,
    listedSeeds(trainText),
    listedSeeds(validationText),
  );
  const scale =
    SIMULATION_SCALES.find(
      (value) => value.size === draft.size && value.steps === draft.steps,
    )?.id ?? "custom";
  return (
    <>
      <fieldset>
        <legend>World</legend>
        <SelectField
          label="State count"
          value={String(draft.stateCount)}
          error={errorFor("State count")}
          options={Array.from(
            { length: MAX_STATE_COUNT - MIN_STATE_COUNT + 1 },
            (_, i) => i + MIN_STATE_COUNT,
          ).map((count) => ({
            value: String(count),
            label: `${count}${count === 2 ? " · binary" : ""}`,
          }))}
          onChange={(value) => {
            const stateCount = Number(value);
            patch((current) => ({
              ...current,
              stateCount,
              seedGenome: resizeGenome(current.seedGenome, stateCount),
            }));
          }}
        />
        <p className="config-note">
          Includes empty state 0. Changing the count keeps existing rule rows,
          maps removed outputs to 1, and copies state 1's rule into new rows.
          {draft.stateCount === 2 &&
            " Life and HighLife are available under Founder preset in Search."}
        </p>
        <SelectField
          label="Simulation scale"
          value={scale}
          options={[
            { value: "custom", label: "Custom", disabled: true },
            ...SIMULATION_SCALES.map((value) => ({
              value: value.id,
              label: value.label,
            })),
          ]}
          onChange={(value) => {
            const preset = SIMULATION_SCALES.find((item) => item.id === value);
            if (preset)
              patch((current) => ({
                ...current,
                size: preset.size,
                steps: preset.steps,
              }));
          }}
        />
        <NumericField
          label="Grid size"
          value={draft.size}
          min={9}
          max={MAX_GRID_SIZE}
          step={2}
          error={errorFor("Grid size")}
          onChange={(value) => update("size", value)}
        />
        <NumericField
          label="CA horizon"
          value={draft.steps}
          min={8}
          max={maxHorizon(draft.size)}
          error={errorFor("CA horizon")}
          note="CA timesteps per evaluation, not GA generations."
          onChange={(value) => update("steps", value)}
        />
        <p className="config-note">
          Up to {maxHorizon(draft.size).toLocaleString("en-US")} timesteps at
          this grid size. Larger grids and longer horizons increase evaluation
          time. The preview and fitness both use every timestep.
        </p>
      </fieldset>
      <fieldset>
        <legend>Starting pattern</legend>
        <SelectField
          label="Seed pattern"
          value={draft.seed}
          options={[
            { value: "point", label: "Point" },
            { value: "cross", label: "Cross" },
            { value: "islands", label: "Islands" },
            { value: "soup", label: "Random soup" },
          ]}
          onChange={(value) => {
            const seed = value as RunConfig["seed"];
            patch((current) => ({
              ...current,
              seed,
              ...(seed === "soup"
                ? { soupSize: current.soupSize ?? Math.min(9, current.size) }
                : {}),
            }));
            if (
              seed === "soup" &&
              trainText.trim() === "1729" &&
              !validationText.trim()
            ) {
              onTrainText("1729, 1730, 1731, 1732");
              onValidationText("2718, 2719");
            }
          }}
        />
        {draft.seed === "soup" && (
          <>
            <NumericField
              label="Soup size N"
              value={draft.soupSize}
              min={1}
              max={draft.size}
              error={errorFor("Soup size N")}
              note="Centered N × N square. Each cell is equally likely to be empty or any active state."
              onChange={(value) => update("soupSize", value)}
            />
            <p className="config-note">
              Each seed produces a different reproducible soup. All candidates
              train on the same set; held-out soups measure generalization.
              Choose Worst fixture to reward rules that work across every
              training soup.
            </p>
          </>
        )}
        <TextField
          label="Training seeds"
          value={trainText}
          error={errorFor("Training seeds")}
          onChange={onTrainText}
        />
        <TextField
          label="Held-out seeds"
          value={validationText}
          placeholder="Optional"
          error={errorFor("Held-out seeds")}
          onChange={onValidationText}
        />
        <p
          className={`creator-readout ${worlds.deterministic ? "muted" : ""}`}
          aria-label="Effective worlds"
        >
          <strong>Effective worlds:</strong> {worlds.text}
        </p>
        {worlds.deterministic ? (
          <p className="config-note">
            Point and cross ignore fixture seeds, so every listed seed evaluates
            the same deterministic world and held-out seeds cannot measure
            generalization. Use islands or soup for distinct training and
            held-out worlds.
          </p>
        ) : (
          <p className="config-note">
            Seeds that alias to the same 32-bit value produce the same world and
            are rejected. Held-out worlds never influence parent selection.
          </p>
        )}
      </fieldset>
    </>
  );
}
