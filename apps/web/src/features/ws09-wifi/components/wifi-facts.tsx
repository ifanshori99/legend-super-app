// The zone's Wi-Fi allowances, said in one scannable list (PRD §3 "Wi-Fi
// Berbasis Belanja" and "Jam Ramai"). Every number comes from the zone's
// policy row, so an admin change is visible on the next request (FAC-14).
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { formatRupiah } from "@starter/shared/i18n";
import type { WifiPolicy } from "@starter/shared/facility";
import {
  formatMinutes,
  formatPeakWindows,
  formatTierBonuses,
} from "../state.ts";

export function WifiFacts({
  policy,
  className,
}: {
  policy: WifiPolicy;
  className?: string;
}) {
  const t = useT();
  const facts = [
    t("wifi.ruleFree", {
      minutes: formatMinutes(policy.freeMinutes, t),
    }),
    ...(policy.peakSchedule.length > 0
      ? [
          t("wifi.rulePeak", {
            minutes: formatMinutes(policy.peakFreeMinutes, t),
            windows: formatPeakWindows(policy.peakSchedule, t),
          }),
        ]
      : []),
    t("wifi.ruleSpend", {
      amount: formatRupiah(policy.spendPerExtraHourIdr),
      minutes: formatMinutes(policy.extraMinutes, t),
    }),
    ...(Object.keys(policy.tierBonusMinutes).length > 0
      ? [
          t("wifi.ruleTier", {
            tiers: formatTierBonuses(policy.tierBonusMinutes, t),
          }),
        ]
      : []),
    t("wifi.ruleDevices", { devices: policy.maxDevices }),
  ];
  return (
    <ul
      className={cn(
        "list-disc space-y-1 pl-5 text-sm leading-5 text-muted-foreground",
        className,
      )}
    >
      {facts.map((fact) => (
        <li key={fact}>{fact}</li>
      ))}
    </ul>
  );
}
