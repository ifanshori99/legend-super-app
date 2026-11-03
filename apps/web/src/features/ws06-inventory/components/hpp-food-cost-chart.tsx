// One quiet horizontal bar chart for the food-cost comparison (DESIGN.md §10):
// one highlighted series (actual, chart-accent), one comparison series
// (theoretical, chart-neutral), a zero baseline on the left, and the value
// printed next to every bar. The same numbers sit in the table below, so the
// chart is never the only way to read them.
import { cn } from "cn";
import { Money } from "@/components/ui/money";
import type { Idr } from "@starter/shared/core";

export type FoodCostBar = {
  key: string;
  label: string;
  value: Idr;
  tone: "accent" | "neutral";
};

export function FoodCostChart({
  bars,
  ariaLabel,
  className,
}: {
  bars: readonly FoodCostBar[];
  ariaLabel: string;
  className?: string;
}) {
  const max = Math.max(...bars.map((bar) => Number(bar.value)), 0);

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn("grid gap-2", className)}
    >
      {bars.map((bar) => {
        const width =
          max === 0 || bar.value <= 0 ? 0 : (Number(bar.value) / max) * 100;
        return (
          <div
            key={bar.key}
            className="grid grid-cols-[minmax(4.5rem,6rem)_minmax(0,1fr)] items-center gap-2"
          >
            <span className="text-sm text-muted-foreground">{bar.label}</span>
            <div className="flex min-w-0 items-center gap-2">
              <div className="h-3 min-w-0 flex-1 rounded-r-[3px] border-s border-chart-neutral bg-surface-2">
                <div
                  className={cn(
                    "h-full rounded-r-[3px]",
                    bar.tone === "accent"
                      ? "bg-chart-accent"
                      : "bg-chart-neutral",
                  )}
                  style={{ width: `${width}%` }}
                />
              </div>
              <Money amount={bar.value} size="sm" className="shrink-0" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
