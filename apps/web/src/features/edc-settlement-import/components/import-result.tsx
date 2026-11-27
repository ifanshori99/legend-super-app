// What the server recorded for one uploaded file (X2-UI). Counts only; the
// screen adds up nothing and shows no money.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Info, TriangleAlert } from "lucide-react";
import type { EdcSettlementCsvImportView } from "@starter/shared/payment/admin";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";

export function ImportResult({
  result,
}: {
  result: EdcSettlementCsvImportView;
}) {
  const t = useT();
  // The result replaces the form: move focus to it so a screen reader reads it
  // (audit P2 2).
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    titleRef.current?.focus();
  }, []);
  return (
    <section
      aria-labelledby="edc-csv-result-title"
      className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
    >
      <div className="grid gap-1">
        <h3
          id="edc-csv-result-title"
          ref={titleRef}
          tabIndex={-1}
          className="type-title outline-none"
        >
          {t("edcSettlementCsv.result.title")}
        </h3>
        <p className="text-sm leading-5 break-words text-muted-foreground">
          {t("edcSettlementCsv.result.file", {
            name: result.fileName,
            bank: t(`edcSettlementCsv.bank.${result.bank}`),
            count: result.rowCount,
          })}
        </p>
      </div>
      {result.replayed && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-container border-(length:--border-w) bg-info-subtle px-4 py-3 text-sm leading-5 text-info"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("edcSettlementCsv.result.replayed")}
        </p>
      )}
      <StatStrip label={t("edcSettlementCsv.result.summaryLabel")} columns={4}>
        <StatTile
          label={t("edcSettlementCsv.result.matched")}
          value={result.matched}
          context={t("edcSettlementCsv.result.clearedOf", {
            count: result.cleared,
          })}
        />
        <StatTile
          label={t("edcSettlementCsv.result.mismatch")}
          value={result.mismatch}
        />
        <StatTile
          label={t("edcSettlementCsv.result.unmatched")}
          value={result.unmatched}
        />
        <StatTile
          label={t("edcSettlementCsv.result.duplicate")}
          value={result.duplicate}
        />
      </StatStrip>
      {result.mismatch > 0 && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-container border-(length:--border-w) bg-warning-subtle px-4 py-3 text-sm leading-5 text-warning"
        >
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {t("edcSettlementCsv.result.mismatchHint")}
        </p>
      )}
      {result.unmatched > 0 && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("edcSettlementCsv.result.unmatchedHint")}
        </p>
      )}
      <div>
        <Button asChild variant="outline">
          <Link to="/kelola/pembayaran/edc-rekonsiliasi">
            {t("edcSettlementCsv.result.toQueue")}
          </Link>
        </Button>
      </div>
    </section>
  );
}
