import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { request } from "../../research/api";
import { fitnessNumber, number } from "../../research/format";
import type { RunConfig, RunDetail, RunSummary } from "../../research/types";

const colors = ["#90a98e", "#e5c995", "#82a9da", "#df6c7c"];
function evaluationKey(config: RunConfig) {
  return JSON.stringify([
    config.stateCount,
    config.size,
    config.steps,
    config.seed,
    config.seed === "soup" ? config.soupSize : null,
    config.trainingSeeds,
    config.validationSeeds,
    config.objective,
    config.boundaryPolicy?.spatial ?? false,
    config.boundaryPolicy?.horizon ?? false,
    config.aggregation,
    config.fixtureFailures ?? "all",
    config.objective === "complexity" ? config.weights : null,
  ]);
}
export default function ComparisonView({
  runs,
  selectedRunId,
}: {
  runs: RunSummary[];
  selectedRunId: string;
}) {
  const [ids, setIds] = useState<string[]>([selectedRunId]);
  const [details, setDetails] = useState<RunDetail[]>([]);
  const [axis, setAxis] = useState<"generation" | "evaluations">("evaluations");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const key = ids.join(",");
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void Promise.all(
      ids.map((id) =>
        request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`, {
          signal: abort.signal,
        }),
      ),
    )
      .then((values) => {
        if (!abort.signal.aborted) setDetails(values);
      })
      .catch((caught) => {
        if (!abort.signal.aborted)
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not compare runs.",
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
    // Explicit refresh freezes comparison data rather than silently mixing capture times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision]);
  const comparable = useMemo(
    () =>
      new Set(details.map((detail) => evaluationKey(detail.config))).size <= 1,
    [details],
  );
  const maxX = Math.max(
    1,
    ...details.flatMap((detail) =>
      detail.history.map((point) =>
        axis === "generation" ? point.generation : point.evaluations,
      ),
    ),
  );
  const lines = details.map((detail) =>
    detail.history
      .map(
        (point) =>
          `${45 + ((axis === "generation" ? point.generation : point.evaluations) / maxX) * 800},${160 - point.bestEver * 140}`,
      )
      .join(" "),
  );
  return (
    <div className="comparison-view">
      <div className="comparison-picker">
        <label>
          Run set
          <select
            aria-label="Add comparison run"
            value=""
            onChange={(event) => {
              if (event.target.value && ids.length < 4)
                setIds((values) => [...values, event.target.value]);
            }}
          >
            <option value="">Add run…</option>
            {runs
              .filter(
                (run) => !ids.includes(run.id) && run.status !== "archived",
              )
              .map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          X axis
          <select
            aria-label="Comparison axis"
            value={axis}
            onChange={(event) => setAxis(event.target.value as typeof axis)}
          >
            <option value="evaluations">Fixture evaluations</option>
            <option value="generation">Generation</option>
          </select>
        </label>
        <button
          onClick={() => setRevision((value) => value + 1)}
          aria-label="Refresh comparison"
        >
          <RefreshCw size={13} />
          Refresh snapshot
        </button>
        {loading && <span role="status">Loading…</span>}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {!comparable && (
        <div className="comparison-warning">
          Different evaluation settings: these fitness scores are not directly
          comparable.
        </div>
      )}
      <div className="comparison-chart">
        <svg
          viewBox="0 0 880 190"
          preserveAspectRatio="none"
          role="img"
          aria-label="Best fitness comparison by selected run"
        >
          <path
            d="M45 20V160H845"
            fill="none"
            stroke="#40543d"
            strokeWidth="1"
          />
          {[0, 0.5, 1].map((value) => (
            <g key={value}>
              <line
                x1="45"
                x2="845"
                y1={160 - value * 140}
                y2={160 - value * 140}
                stroke="#33422f"
                strokeDasharray="3 5"
              />
              <text
                x="34"
                y={164 - value * 140}
                textAnchor="end"
                fill="#899d7e"
                fontSize="10"
              >
                {value}
              </text>
            </g>
          ))}
          {details.map((detail, index) => (
            <polyline
              key={detail.summary.id}
              points={lines[index]}
              fill="none"
              stroke={colors[index]}
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <text x="45" y="180" fill="#899d7e" fontSize="10">
            0
          </text>
          <text x="845" y="180" textAnchor="end" fill="#899d7e" fontSize="10">
            {number(maxX)}
          </text>
        </svg>
      </div>
      <table className="comparison-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Generation</th>
            <th>Evaluations</th>
            <th>Best</th>
            <th>Held-out</th>
            <th>Mutation</th>
            <th>Population</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {details.map((detail, index) => (
            <tr key={detail.summary.id}>
              <td>
                <i style={{ background: colors[index] }} />
                {detail.summary.name}
              </td>
              <td>{number(detail.summary.generation)}</td>
              <td>{number(detail.summary.evaluations)}</td>
              <td>{fitnessNumber(detail.summary.bestFitness)}</td>
              <td>{fitnessNumber(detail.summary.validationFitness)}</td>
              <td>{detail.config.mutationRate}</td>
              <td>{detail.config.populationSize}</td>
              <td>
                <button
                  aria-label={`Remove ${detail.summary.name} from comparison`}
                  onClick={() =>
                    setIds((values) =>
                      values.filter((id) => id !== detail.summary.id),
                    )
                  }
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
