import { incentivesForConfig } from "../../../research/incentives";
import type { RunConfig } from "../../../research/types";
import IncentiveList from "../IncentiveList";
import type { DraftApi } from "./draft";
import { FieldError, SelectField } from "./fields";
import ScoreExamples from "./ScoreExamples";

export default function GoalSection({ api }: { api: DraftApi }) {
  const { draft, update, errorFor } = api;
  const incentives = incentivesForConfig(draft);
  const incentiveError = errorFor("Scoring incentives");
  return (
    <>
      <fieldset
        className={`scoring-config ${incentiveError ? "has-error" : ""}`}
      >
        <legend>Scoring incentives</legend>
        <IncentiveList
          value={incentives}
          onChange={(value) => update("incentives", value)}
        />
        <FieldError label="Scoring incentives" error={incentiveError} />
        <h3 className="incentive-section-label">Hard constraints</h3>
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.boundaryPolicy?.spatial ?? false}
            onChange={(event) =>
              update("boundaryPolicy", {
                ...draft.boundaryPolicy,
                spatial: event.target.checked,
              })
            }
          />
          Disqualify spatial edge contact
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={draft.boundaryPolicy?.horizon ?? false}
            onChange={(event) =>
              update("boundaryPolicy", {
                ...draft.boundaryPolicy,
                horizon: event.target.checked,
              })
            }
          />
          Disqualify time cutoff contact
        </label>
        <p className="config-note">
          Any occupied cell touching the left, right, front or back edge, or
          remaining at the final timestep, counts as contact. These constraints
          override all incentives. A disqualified world contributes zero to the
          chosen aggregation. Held-out worlds are assessed separately. Disable a
          boundary policy to reward avoiding contact with a soft incentive
          instead of disqualifying the world.
        </p>
        <SelectField
          label="Aggregation"
          value={draft.aggregation}
          error={errorFor("Aggregation")}
          options={[
            { value: "mean", label: "Mean of fixtures" },
            { value: "minimum", label: "Worst fixture" },
          ]}
          onChange={(value) =>
            update("aggregation", value as RunConfig["aggregation"])
          }
        />
        <p className="config-note">
          Mean averages all world scores, including zero for each failure, so it
          rewards rules that fail less often. Worst fixture uses the lowest
          score, so any failure gives zero. One successful world scoring 0.8 and
          one failure give mean 0.4 or worst 0. Held-out scores use the same
          aggregation separately.
        </p>
      </fieldset>
      <ScoreExamples draft={draft} incentives={incentives} />
    </>
  );
}
