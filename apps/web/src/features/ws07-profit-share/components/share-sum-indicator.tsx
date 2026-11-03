// SH-03's live sum indicator: one persistent figure and bar of the total basis
// points against the 10,000 bp rule, with a status pill that spells the gap
// out. It reads the contract's integers only — it never re-derives a
// percentage from money.
import { CircleCheck, TriangleAlert, XCircle } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { NumberDisplay } from "@/components/ui/money";
import { StatusPill } from "@/components/ui/badge";
import {
  formatShareBp,
  formatShareBpInteger,
  shareAllocationSumDeltaBp,
  shareAllocationSumKey,
  shareAllocationSumState,
} from "../lib";

const STATE_PILL = {
  exact: { status: "success", icon: CircleCheck },
  short: { status: "warning", icon: TriangleAlert },
  over: { status: "danger", icon: XCircle },
} as const;

export function ShareSumIndicator({
  totalBp,
  className,
}: {
  totalBp: number;
  className?: string;
}) {
  const t = useT();
  const state = shareAllocationSumState(totalBp);
  const pill = STATE_PILL[state];
  const delta = shareAllocationSumDeltaBp(totalBp);
  const width = Math.min(100, Math.max(0, totalBp / 100));
  return (
    <div
      data-slot="share-sum-indicator"
      data-state={state}
      className={cn("grid gap-2", className)}
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="type-eyebrow text-muted-foreground">
            {t("accounting.share.versions.sumLabel")}
          </p>
          <p className="flex items-baseline gap-1.5">
            <NumberDisplay value={totalBp} size="lg" />
            <span className="text-sm text-muted-foreground">
              {t("accounting.share.versions.sumValue")}
            </span>
          </p>
          <p className="text-sm text-muted-foreground tabular">
            {formatShareBp(totalBp)}
          </p>
        </div>
        <StatusPill status={pill.status} icon={pill.icon} className="text-sm">
          {t(shareAllocationSumKey(totalBp), {
            bp: formatShareBpInteger(delta),
          })}
        </StatusPill>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
        role="presentation"
      >
        <div
          className={cn(
            "h-full rounded-full",
            state === "exact" && "bg-primary",
            state === "short" && "bg-warning",
            state === "over" && "bg-danger",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
