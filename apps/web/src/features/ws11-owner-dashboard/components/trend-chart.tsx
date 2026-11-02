// One quiet line chart (DESIGN.md §10): a single accent series, horizontal
// gridlines only, a neutral baseline, value labels on the points, and a hollow
// last point for a running (estimate) period. The same numbers also sit in a
// table next to it, so the chart is never the only way to read them.
import { cn } from "cn";

export type TrendPoint = {
  label: string;
  value: number | null;
  /** The running period: drawn hollow. */
  estimate?: boolean;
  /** Formatted value printed above the point. */
  text: string;
};

const WIDTH = 480;
const HEIGHT = 168;
const PAD = { left: 16, right: 16, top: 26, bottom: 28 };

export function TrendChart({
  points,
  ariaLabel,
  className,
}: {
  points: readonly TrendPoint[];
  ariaLabel: string;
  className?: string;
}) {
  const values = points
    .map((point) => point.value)
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.abs(max) || 1;
  const low = min - span * 0.25;
  const high = max + span * 0.25;
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (index: number) =>
    PAD.left +
    (points.length === 1 ? innerW / 2 : (innerW * index) / (points.length - 1));
  const y = (value: number) =>
    PAD.top + innerH - ((value - low) / (high - low)) * innerH;
  const known = points.flatMap((point, index) =>
    point.value === null ? [] : [{ point, index, value: point.value }],
  );
  const path = known
    .map(
      (entry, order) =>
        `${order === 0 ? "M" : "L"}${x(entry.index).toFixed(1)} ${y(entry.value).toFixed(1)}`,
    )
    .join(" ");
  const gridRows = [0, 1, 2].map((row) => PAD.top + (innerH * row) / 2);

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={cn("h-auto w-full", className)}
    >
      {gridRows.slice(0, 2).map((gridY) => (
        <line
          key={gridY}
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={gridY}
          y2={gridY}
          className="stroke-chart-grid"
          strokeDasharray="3 6"
        />
      ))}
      <line
        x1={PAD.left}
        x2={WIDTH - PAD.right}
        y1={HEIGHT - PAD.bottom}
        y2={HEIGHT - PAD.bottom}
        className="stroke-chart-neutral"
      />
      <path
        d={path}
        fill="none"
        className="stroke-chart-accent"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {known.map(({ point, index, value }) => (
        <g key={point.label}>
          <circle
            cx={x(index)}
            cy={y(value)}
            r={4}
            strokeWidth={2}
            className={cn(
              "stroke-chart-accent",
              point.estimate ? "fill-card" : "fill-chart-accent",
            )}
          />
          <text
            x={x(index)}
            y={y(value) - 10}
            textAnchor="middle"
            className="fill-foreground text-xs tabular"
          >
            {point.text}
          </text>
        </g>
      ))}
      {points.map((point, index) => (
        <text
          key={point.label}
          x={x(index)}
          y={HEIGHT - 8}
          textAnchor="middle"
          className="fill-muted-foreground text-xs"
        >
          {point.label}
        </text>
      ))}
    </svg>
  );
}
