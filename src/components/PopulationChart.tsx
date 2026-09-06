export function PopulationChart({
  values,
  progress,
  evolution = false,
}: {
  values: number[];
  progress: number;
  evolution?: boolean;
}) {
  const max = Math.max(1, ...values);
  const points = values
    .map(
      (v, i) =>
        `${(i / Math.max(values.length - 1, 1)) * 800},${36 - (v / max) * 32}`,
    )
    .join(" ");
  return (
    <svg
      className="population-chart"
      viewBox="0 0 800 40"
      preserveAspectRatio="none"
      role="img"
      aria-label={
        evolution
          ? "Best fitness across evolutionary epochs"
          : "Occupied cell population across time"
      }
    >
      <defs>
        <linearGradient
          id={evolution ? "evoFill" : "populationFill"}
          x1="0"
          x2="0"
          y1="0"
          y2="1"
        >
          <stop offset="0%" stopColor="currentColor" stopOpacity=".16" />
          <stop offset="100%" stopColor="currentColor" stopOpacity=".01" />
        </linearGradient>
      </defs>
      <polygon
        points={`0,40 ${points} 800,40`}
        fill={`url(#${evolution ? "evoFill" : "populationFill"})`}
      />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
      {!evolution && (
        <line
          x1={progress * 800}
          x2={progress * 800}
          y1="0"
          y2="40"
          stroke="#bf5636"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
