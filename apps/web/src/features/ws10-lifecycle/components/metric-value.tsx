// A number in a StatStrip that never lies: while the screen loads it is a
// skeleton, when the read failed it is an em dash. Showing "0" for unknown data
// would be a fake metric (DESIGN.md §4, PRD "tanpa metrik palsu").
import { useT } from "@/components/i18n";
import { NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";

export type MetricsState = "loading" | "error" | "ready" | "empty";

export function MetricValue({
  state,
  value,
}: {
  state: MetricsState;
  value: number;
}) {
  const t = useT();
  if (state === "loading") return <Skeleton className="h-7 w-14" />;
  if (state === "error")
    return (
      <span className="type-money-display text-muted-foreground">
        {t("lifecycle.common.noValue")}
      </span>
    );
  return <NumberDisplay value={value} size="stat" />;
}
