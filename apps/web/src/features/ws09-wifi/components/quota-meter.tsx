// Wi-Fi quota meter (a platform-specific component the PRD names, built from
// design-system primitives and tokens per DESIGN.md §4). It shows the minutes
// left for today and how much of the allowance is used; a spent allowance tints
// the bar with the warning role but never claims the guest is offline (FAC-13).
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { formatNumber } from "@starter/shared/i18n";
import type { WifiSpeedTier } from "@starter/shared/facility";
import { formatMinutes, isThrottled } from "../state.ts";

export function QuotaMeter({
  usedMinutes,
  quotaMinutes,
  remainingMinutes,
  speedTier,
}: {
  usedMinutes: number;
  quotaMinutes: number;
  remainingMinutes: number;
  speedTier: WifiSpeedTier;
}) {
  const t = useT();
  const throttled = isThrottled(speedTier);
  const used = Math.min(Math.max(usedMinutes, 0), quotaMinutes);
  const percent = quotaMinutes > 0 ? (used / quotaMinutes) * 100 : 100;
  return (
    <div className="grid gap-2">
      <p className="text-2xl leading-8 font-semibold tracking-tight">
        <data value={remainingMinutes} className="tabular">
          {formatMinutes(remainingMinutes, t)}
        </data>
      </p>
      <div
        role="progressbar"
        aria-label={t("wifi.quotaLabel")}
        aria-valuemin={0}
        aria-valuemax={quotaMinutes}
        aria-valuenow={used}
        className="h-3 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-(--duration-base) ease-standard",
            throttled ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("wifi.quotaUsed", {
          used: formatNumber(used),
          quota: formatNumber(quotaMinutes),
        })}
      </p>
    </div>
  );
}
