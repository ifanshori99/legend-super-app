// What the server recorded for one Duitku settlement report (C4b). Every
// amount and count is the server's answer; the screen adds up nothing.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Info, TriangleAlert } from "lucide-react";
import type { SettlementImportView } from "@starter/shared/payment/admin";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { periodLabel } from "../settlement-lib";

export function SettlementImportResult({
  result,
}: {
  result: SettlementImportView;
}) {
  const t = useT();
  // The result replaces the form: move focus to it so a screen reader reads it.
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    titleRef.current?.focus();
  }, []);
  return (
    <section
      aria-labelledby="gateway-settlement-result-title"
      className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
    >
      <div className="grid gap-1">
        <h3
          id="gateway-settlement-result-title"
          ref={titleRef}
          tabIndex={-1}
          className="type-title outline-none"
        >
          {t("gatewaySettlement.result.title")}
        </h3>
        <p className="text-sm leading-5 break-words text-muted-foreground">
          {t("gatewaySettlement.result.report", {
            reference: result.reference,
            period: periodLabel(result.periodStart, result.periodEnd),
            count: result.lineCount,
          })}
        </p>
      </div>
      {result.replayed && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-container border-(length:--border-w) bg-info-subtle px-4 py-3 text-sm leading-5 text-info"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("gatewaySettlement.result.replayed")}
        </p>
      )}
      <StatStrip label={t("gatewaySettlement.result.summaryLabel")} columns={4}>
        <StatTile
          label={t("gatewaySettlement.result.matched")}
          value={result.matchedLines}
        />
        <StatTile
          label={t("gatewaySettlement.result.mismatch")}
          value={result.mismatchLines}
        />
        <StatTile
          label={t("gatewaySettlement.result.unmatched")}
          value={result.unmatchedLines}
        />
        <StatTile
          label={t("gatewaySettlement.result.cases")}
          value={result.casesCreated}
        />
      </StatStrip>
      <StatStrip label={t("gatewaySettlement.result.totalsLabel")} columns={3}>
        <StatTile
          label={t("gatewaySettlement.result.gross")}
          value={<Money amount={result.grossIdr} />}
        />
        <StatTile
          label={t("gatewaySettlement.result.fee")}
          value={<Money amount={result.feeIdr} />}
        />
        <StatTile
          label={t("gatewaySettlement.result.net")}
          value={<Money amount={result.netIdr} />}
        />
      </StatStrip>
      {result.casesCreated > 0 && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-container border-(length:--border-w) bg-warning-subtle px-4 py-3 text-sm leading-5 text-warning"
        >
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {t("gatewaySettlement.result.casesHint")}
        </p>
      )}
      <div>
        <Button asChild variant="outline">
          <Link to="/kelola/pembayaran" search={{ tab: "reconciliation" }}>
            {t("gatewaySettlement.result.toReconciliation")}
          </Link>
        </Button>
      </div>
    </section>
  );
}
