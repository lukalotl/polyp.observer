import { useMemo } from "react";
import type { Incentive } from "../../../research/incentives";
import type { RunConfig } from "../../../research/types";
import { scoreExampleRows, scoreExamples } from "./scoreExamples";

export default function ScoreExamples({
  draft,
  incentives,
}: {
  draft: RunConfig;
  incentives: Incentive[];
}) {
  const { size, steps, stateCount, seed, soupSize } = draft;
  const examples = useMemo(
    () => scoreExamples({ size, steps, stateCount, seed, soupSize }),
    [size, steps, stateCount, seed, soupSize],
  );
  const rows = scoreExampleRows(examples, incentives, draft.boundaryPolicy);
  if (!examples.length)
    return (
      <p className="config-note">
        Score examples appear once the grid size and horizon are valid.
      </p>
    );
  return (
    <div className="score-examples">
      <h3 className="incentive-section-label">Score examples</h3>
      <p className="config-note">
        Five synthetic worlds at {size} × {size} cells over{" "}
        {steps.toLocaleString("en-US")} CA timesteps, scored with the
        incentives above. Each column is clamped to 0–1 before weighting; the
        last column shows which world a hard constraint would zero.
      </p>
      <div className="score-examples-scroll">
        <table aria-label="Score examples">
          <thead>
            <tr>
              <th scope="col">Example</th>
              {incentives.map((item, index) => (
                <th scope="col" key={index} title={item.expression}>
                  {item.name}
                </th>
              ))}
              <th scope="col">Score</th>
              <th scope="col">Hard constraint</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.example.id}
                className={row.zeroedBy ? "zeroed" : undefined}
              >
                <th scope="row">
                  <strong>{row.example.name}</strong>
                  <small>{row.example.description}</small>
                </th>
                {row.values.map((value, index) => (
                  <td key={index}>{value.toFixed(3)}</td>
                ))}
                <td className="score-cell">
                  {row.zeroedBy ? (
                    <>
                      <s>{row.score.toFixed(3)}</s> 0
                    </>
                  ) : (
                    row.score.toFixed(3)
                  )}
                </td>
                <td className="constraint-cell">
                  {row.zeroedBy === "spatial"
                    ? "Disqualified · edge contact"
                    : row.zeroedBy === "horizon"
                      ? "Disqualified · alive at cutoff"
                      : row.example.measurements.spatialContact
                        ? "Edge contact allowed"
                        : row.example.measurements.cutoffContact
                          ? "Cutoff contact allowed"
                          : "Passes"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
