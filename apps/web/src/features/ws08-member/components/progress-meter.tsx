import { cn } from "cn";

// A single progress bar with progressbar semantics (label + value exposed to
// assistive tech; the visible text next to it is the same information). Color
// is never the only signal: callers always print "x dari y".
export function ProgressMeter({
  value,
  max,
  label,
  tone = "brand",
  className,
}: {
  value: number;
  max: number;
  label: string;
  tone?: "brand" | "success";
  className?: string;
}) {
  const safeMax = Math.max(max, 1);
  const clamped = Math.max(0, Math.min(value, safeMax));
  const percent = Math.round((clamped / safeMax) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={clamped}
      className={cn(
        "h-2 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-(--duration-base) ease-standard",
          tone === "success" ? "bg-success" : "bg-brand",
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
