import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryPoint, SnapshotRef } from "../../research/types";
import {
  distinctEliteScale,
  historyReadout,
  historySegments,
  historyValue,
  nearestGeneration,
  UNIT_METRICS,
  type HistoryMetric,
  type HistoryScale,
} from "./visualizerData";
import SearchHealth from "./SearchHealth";
import "./visualizers.css";

export interface HistoryViewProps extends HistoryScale {
  history: HistoryPoint[];
  snapshots: SnapshotRef[];
  selectedGeneration: number | null;
  onSelectGeneration: (generation: number | null) => void;
}
const SERIES: {
  key: HistoryMetric;
  label: string;
  /** Short name for the shared right-hand axis title. */
  axis?: string;
  color: string;
  dash?: string;
}[] = [
  { key: "bestEver", label: "Best ever", color: "#e5c995" },
  { key: "best", label: "Generation best", color: "#90a98e" },
  { key: "mean", label: "Mean", color: "#82a9da" },
  { key: "worst", label: "Worst", color: "#757f83" },
  {
    key: "validationBest",
    label: "Held-out best",
    color: "#df6c7c",
    dash: "5 3",
  },
  {
    key: "diversity",
    label: "Allele entropy",
    axis: "Entropy",
    color: "#baa2cf",
    dash: "2 4",
  },
  {
    key: "repeatShare",
    label: "Repeat share",
    axis: "Repeat share",
    color: "#e8a04a",
    dash: "7 3",
  },
  {
    key: "distinctElites",
    label: "Distinct top ranks",
    axis: "Distinct top ranks",
    color: "#e8eef3",
    dash: "1 3",
  },
];
function useChartSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 320 });
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect?.width && rect?.height)
        setSize({
          width: Math.max(280, rect.width),
          height: Math.max(200, rect.height),
        });
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}
export default function HistoryView({
  history,
  snapshots,
  selectedGeneration,
  onSelectGeneration,
  eliteCount,
  populationSize,
}: HistoryViewProps) {
  const [visible, setVisible] = useState<Set<HistoryMetric>>(
    () => new Set(["bestEver", "best", "mean", "worst", "validationBest"]),
  );
  const [hoverGeneration, setHoverGeneration] = useState<number | null>(null);
  const { ref, width, height } = useChartSize();
  const points = useMemo(
    () => [...history].sort((a, b) => a.generation - b.generation),
    [history],
  );
  const scale = useMemo<HistoryScale>(
    () => ({ eliteCount, populationSize }),
    [eliteCount, populationSize],
  );
  const eliteScale = useMemo(
    () => distinctEliteScale(points, scale),
    [points, scale],
  );
  const available = useMemo(
    () =>
      [...new Set(snapshots.map((snapshot) => snapshot.generation))].sort(
        (a, b) => a - b,
      ),
    [snapshots],
  );
  const segments = useMemo(
    () =>
      new Map(
        SERIES.map((series) => [
          series.key,
          historySegments(points, series.key, eliteScale),
        ]),
      ),
    [points, eliteScale],
  );
  const valueOf = (point: HistoryPoint, metric: HistoryMetric) =>
    historyValue(point, metric, eliteScale);
  const first = points[0]?.generation ?? 0,
    last = points.at(-1)?.generation ?? 1;
  const xMin = points.length === 1 ? Math.max(0, first - 1) : first;
  const xMax = Math.max(xMin + 1, points.length === 1 ? last + 1 : last);
  const [yMin, yMax] = useMemo(() => {
    let minimum = 0,
      maximum = 0;
    const active = SERIES.filter(
      (series) => visible.has(series.key) && !UNIT_METRICS.has(series.key),
    );
    for (const point of points)
      for (const series of active) {
        const value = historyValue(point, series.key);
        if (value !== null) {
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
      }
    return [
      minimum,
      maximum === minimum ? minimum + 1 : maximum + (maximum - minimum) * 0.06,
    ];
  }, [points, visible]);
  const unitSeries = SERIES.filter(
    (series) => UNIT_METRICS.has(series.key) && visible.has(series.key),
  );
  const unitAxis = unitSeries.length > 0;
  const box = {
    left: 58,
    top: 20,
    right: width - (unitAxis ? 50 : 18),
    bottom: height - 36,
  };
  const x = (generation: number) =>
    box.left + ((generation - xMin) / (xMax - xMin)) * (box.right - box.left);
  const y = (value: number, metric: HistoryMetric) =>
    box.bottom -
    (UNIT_METRICS.has(metric) ? value : (value - yMin) / (yMax - yMin)) *
      (box.bottom - box.top);
  // Cache the full-resolution geometry; pointer inspection never rebuilds thousands of coordinates.
  const renderedSeries = useMemo(
    () =>
      SERIES.filter((series) => visible.has(series.key)).map((series) => (
        <g key={series.key} data-series={series.key}>
          {segments
            .get(series.key)
            ?.map((segment, index) =>
              segment.length === 1 ? (
                <circle
                  key={index}
                  cx={x(segment[0].generation)}
                  cy={y(valueOf(segment[0], series.key)!, series.key)}
                  r={2.5}
                  fill={series.color}
                />
              ) : (
                <polyline
                  key={index}
                  fill="none"
                  stroke={series.color}
                  strokeWidth={series.key === "bestEver" ? 1.8 : 1.2}
                  strokeDasharray={series.dash}
                  points={segment
                    .map(
                      (point) =>
                        `${x(point.generation).toFixed(2)},${y(valueOf(point, series.key)!, series.key).toFixed(2)}`,
                    )
                    .join(" ")}
                />
              ),
            )}
        </g>
      )),
    [segments, visible, xMin, xMax, yMin, yMax, width, height, eliteScale],
  );
  const hovered =
    points.find((point) => point.generation === hoverGeneration) ??
    (selectedGeneration === null
      ? points.at(-1)
      : points.find((point) => point.generation === selectedGeneration)) ??
    points.at(-1);
  const xTicks = [
    ...new Set(
      Array.from({ length: 6 }, (_, i) =>
        Math.round(xMin + ((xMax - xMin) * i) / 5),
      ),
    ),
  ];
  const choose = (generation: number) => {
    const nearest = nearestGeneration(available, generation);
    if (nearest !== null) onSelectGeneration(nearest);
  };
  const pointerGeneration = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const position =
      ((event.clientX - rect.left) * width) / Math.max(1, rect.width);
    return (
      xMin +
      Math.max(0, Math.min(1, (position - box.left) / (box.right - box.left))) *
        (xMax - xMin)
    );
  };
  return (
    <section className="rv-panel rv-history" aria-label="Fitness history">
      <SearchHealth
        latest={points.at(-1) ?? null}
        eliteCount={eliteCount}
        populationSize={populationSize}
      />
      <div className="rv-toolbar rv-history-toolbar">
        <div className="rv-series-toggles">
          {SERIES.map((series) => (
            <label
              className="rv-check"
              key={series.key}
              style={{ color: series.color }}
            >
              <input
                type="checkbox"
                checked={visible.has(series.key)}
                onChange={() =>
                  setVisible((previous) => {
                    const next = new Set(previous);
                    if (next.has(series.key)) next.delete(series.key);
                    else next.add(series.key);
                    return next;
                  })
                }
              />
              {series.label}
            </label>
          ))}
        </div>
        <div className="rv-snapshot-controls">
          <label>
            Snapshot{" "}
            <select
              aria-label="Retained generation"
              value={selectedGeneration ?? "latest"}
              onChange={(event) =>
                onSelectGeneration(
                  event.target.value === "latest"
                    ? null
                    : Number(event.target.value),
                )
              }
            >
              <option value="latest">Latest</option>
              {selectedGeneration !== null &&
                !available.includes(selectedGeneration) && (
                  <option value={selectedGeneration}>
                    Generation {selectedGeneration} (not retained)
                  </option>
                )}
              {available.map((generation) => (
                <option key={generation} value={generation}>
                  Generation {generation}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => onSelectGeneration(null)}
            disabled={selectedGeneration === null}
          >
            Latest
          </button>
        </div>
      </div>
      {!points.length ? (
        <div className="rv-empty">
          No fitness history. An evaluated generation will appear here.
        </div>
      ) : (
        <>
          <div className="rv-chart" ref={ref}>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label="Fitness by GA generation. Arrow keys inspect; Enter selects nearest retained snapshot."
              tabIndex={0}
              onMouseMove={(event) =>
                setHoverGeneration(
                  nearestGeneration(
                    points.map((point) => point.generation),
                    pointerGeneration(event),
                  ),
                )
              }
              onMouseLeave={() => setHoverGeneration(null)}
              onClick={(event) => choose(pointerGeneration(event))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && hovered) {
                  event.preventDefault();
                  choose(hovered.generation);
                }
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  const index = hovered
                    ? points.indexOf(hovered)
                    : points.length - 1;
                  setHoverGeneration(
                    points[
                      Math.max(
                        0,
                        Math.min(
                          points.length - 1,
                          index + (event.key === "ArrowLeft" ? -1 : 1),
                        ),
                      )
                    ].generation,
                  );
                }
              }}
            >
              <title>
                Recorded fitness across {points.length} GA generations
              </title>
              <text x={box.left} y={11} className="rv-axis-title">
                Fitness
              </text>
              {[0, 1, 2, 3, 4].map((i) => {
                const value = yMin + ((yMax - yMin) * i) / 4;
                const position = y(value, "best");
                return (
                  <g key={i}>
                    <line
                      className="rv-chart-grid"
                      x1={box.left}
                      x2={box.right}
                      y1={position}
                      y2={position}
                    />
                    <text
                      className="rv-axis-text"
                      x={box.left - 8}
                      y={position + 3}
                      textAnchor="end"
                    >
                      {value.toFixed(yMax < 0.1 ? 4 : 2)}
                    </text>
                    {unitAxis && (
                      <text
                        className="rv-axis-text"
                        x={box.right + 8}
                        y={position + 3}
                      >
                        {(i / 4).toFixed(2)}
                      </text>
                    )}
                  </g>
                );
              })}
              {xTicks.map((generation) => (
                <g key={generation}>
                  <line
                    className="rv-chart-grid"
                    x1={x(generation)}
                    x2={x(generation)}
                    y1={box.top}
                    y2={box.bottom}
                  />
                  <text
                    className="rv-axis-text"
                    x={x(generation)}
                    y={box.bottom + 16}
                    textAnchor="middle"
                  >
                    {generation}
                  </text>
                </g>
              ))}
              <text
                className="rv-axis-title"
                x={(box.left + box.right) / 2}
                y={height - 3}
                textAnchor="middle"
              >
                GA generation
              </text>
              {unitAxis && (
                <text
                  className="rv-axis-title"
                  x={box.right}
                  y={11}
                  textAnchor="end"
                >
                  {unitSeries.map((series) => series.axis).join(" · ")} (right,
                  0–1)
                </text>
              )}
              {renderedSeries}
              {selectedGeneration !== null &&
                selectedGeneration >= xMin &&
                selectedGeneration <= xMax && (
                  <line
                    className="rv-selection-line"
                    x1={x(selectedGeneration)}
                    x2={x(selectedGeneration)}
                    y1={box.top}
                    y2={box.bottom}
                  />
                )}
              {hovered && (
                <g>
                  <line
                    className="rv-hover-line"
                    x1={x(hovered.generation)}
                    x2={x(hovered.generation)}
                    y1={box.top}
                    y2={box.bottom}
                  />
                  {SERIES.filter(
                    (series) =>
                      visible.has(series.key) &&
                      valueOf(hovered, series.key) !== null,
                  ).map((series) => (
                    <circle
                      key={series.key}
                      cx={x(hovered.generation)}
                      cy={y(valueOf(hovered, series.key)!, series.key)}
                      r={2.5}
                      fill={series.color}
                    />
                  ))}
                </g>
              )}
            </svg>
          </div>
          <div className="rv-chart-readout" aria-live="polite">
            {hovered && (
              <>
                <strong>Generation {hovered.generation}</strong>
                {SERIES.filter((series) => visible.has(series.key)).map(
                  (series) => (
                    <span key={series.key}>
                      <i style={{ background: series.color }} />
                      {series.label}{" "}
                      <b>{historyReadout(hovered, series.key, scale)}</b>
                    </span>
                  ),
                )}
              </>
            )}
          </div>
          <div className="rv-note rv-chart-note">
            {available.length
              ? "Click the chart or press Enter to inspect the nearest retained snapshot."
              : "No retained snapshots yet."}{" "}
            Held-out gaps mean not evaluated; repeat-share gaps mean the
            generation's evaluation counts were not recorded. All{" "}
            {points.length} recorded history points shown.
          </div>
        </>
      )}
    </section>
  );
}
