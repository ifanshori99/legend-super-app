// A registry metric value in a StatTile: money-display tier, scaled suffix.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Money, NumberDisplay } from "@/components/ui/money";
import type { MetricValue } from "@starter/shared/metrics";
import { formatDecimal, formatPercent } from "../board.ts";

function Suffix({ children }: { children: ReactNode }) {
  return (
    <span className="ms-0.5 align-[0.32em] text-[0.6em] font-medium tracking-normal text-muted-foreground">
      {children}
    </span>
  );
}

export function MetricValueView({
  value,
  size = "stat",
}: {
  value: MetricValue;
  size?: "stat" | "md";
}) {
  const t = useT();
  switch (value.unit) {
    case "idr":
      return <Money amount={value.valueIdr} size={size} />;
    case "count":
      return <NumberDisplay value={value.value} size={size} />;
    case "percent":
      return (
        <span className={size === "stat" ? "type-money-display" : "tabular"}>
          {formatPercent(value.value)}
          <Suffix>%</Suffix>
        </span>
      );
    case "decimal":
      return (
        <span className={size === "stat" ? "type-money-display" : "tabular"}>
          {formatDecimal(value.value)}
        </span>
      );
    case "seconds":
      return (
        <span className={size === "stat" ? "type-money-display" : "tabular"}>
          {Math.round(value.value / 60)}
          <Suffix>{t("shareholderHome.units.minutes")}</Suffix>
        </span>
      );
  }
}
