// A 0–100 bar. The bar is decoration only: the number and the accessible label
// carry the value, so colour is never the only signal. `showValue={false}` is
// for a secondary comparison bar whose own number would compete with the cell's
// main figure (an indicator's achievement next to its actual value).
import { cn } from "cn";

export function ScoreBar({
  value,
  label,
  fallback,
  showValue = true,
  className,
}: {
  value: number | null;
  /** Accessible description of the number, e.g. "Skor 95 dari 100". */
  label: string;
  /** Shown instead of a number when the value is unknown. */
  fallback: string;
  showValue?: boolean;
  className?: string;
}) {
  const percent = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <div
        aria-hidden="true"
        className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${percent}%` }}
        />
      </div>
      {showValue && (
        <span className="tabular text-sm font-semibold">
          {value === null ? fallback : value}
        </span>
      )}
      <span className="sr-only">{label}</span>
    </div>
  );
}
