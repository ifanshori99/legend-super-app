// The outlet's latest imported settlement reports (C4b, legend-osqou.8), shown
// on the Duitku import screen and in the reconciliation panel. Every amount
// and count is the server's; nothing is added up here.
import { useRouteContext } from "@tanstack/react-router";
import type { MyOutlet } from "@starter/shared/access";
import type { SettlementListItem } from "@starter/shared/payment/admin";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
import type { AreaAccess } from "@/lib/areas/access";
import { formatMoment } from "../format";
import { useSettlements } from "../hooks";
import { periodLabel } from "../settlement-lib";

/**
 * Outlets the account works in (GET /api/me/access). The web does not know
 * per outlet which of them grant payment.reconcile; the first is the default
 * and the API decides again on every request (403 is worded on screen).
 */
export function useAccountOutlets(): readonly MyOutlet[] {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return context.access?.outlets ?? [];
}

function providerLabel(
  entry: SettlementListItem,
  t: ReturnType<typeof useT>,
): string {
  if (entry.provider === "duitku")
    return t("gatewaySettlement.list.provider.duitku");
  if (entry.provider === "doit")
    return t("gatewaySettlement.list.provider.doit");
  return t("gatewaySettlement.list.provider.edc", {
    bank: entry.provider.replace(/^edc_/, "").toUpperCase(),
  });
}

export function SettlementList({
  outletId,
  titleId,
}: {
  outletId: string | null;
  titleId?: string;
}) {
  const t = useT();
  const settlements = useSettlements(outletId);
  const rows = settlements.data?.data ?? [];
  const state =
    outletId === null || settlements.isPending
      ? "loading"
      : settlements.isError
        ? "error"
        : rows.length === 0
          ? "empty"
          : "ready";
  return (
    <div id={titleId} className="min-w-0">
      <DataTableShell
        title={t("gatewaySettlement.list.title")}
        state={state}
        rowCount={rows.length}
        onRetry={() => void settlements.refetch()}
        empty={{
          title: t("gatewaySettlement.list.emptyTitle"),
          description: t("gatewaySettlement.list.emptyHint"),
        }}
      >
        <ul className="divide-y divide-border">
          {rows.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-3 p-card lg:flex-row lg:items-center lg:justify-between"
            >
              <div className="grid min-w-0 gap-0.5">
                <p className="font-semibold break-words">{entry.reference}</p>
                <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge tone={entry.source === "edc" ? "info" : "neutral"}>
                    {providerLabel(entry, t)}
                  </Badge>
                  <span>
                    {periodLabel(entry.periodStart, entry.periodEnd)} ·{" "}
                    {formatMoment(entry.createdAt)}
                  </span>
                </p>
                <p className="text-sm text-muted-foreground tabular-nums">
                  {t("gatewaySettlement.list.lines", {
                    count: entry.lineCount,
                  })}{" "}
                  ·{" "}
                  {t("gatewaySettlement.list.counts", {
                    matched: entry.matchedLines,
                    mismatch: entry.mismatchLines,
                    unmatched: entry.unmatchedLines,
                  })}
                </p>
              </div>
              {/* Phone: one amount per line, label left and amount right, so a
                  tens-of-millions figure never runs past the screen. */}
              <dl className="grid gap-1 text-sm sm:grid-cols-3 sm:gap-3 lg:text-right">
                <div className="flex items-baseline justify-between gap-3 sm:block">
                  <dt className="text-muted-foreground">
                    {t("gatewaySettlement.list.gross")}
                  </dt>
                  <dd>
                    <Money amount={entry.grossIdr} size="sm" />
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 sm:block">
                  <dt className="text-muted-foreground">
                    {t("gatewaySettlement.list.fee")}
                  </dt>
                  <dd>
                    <Money amount={entry.feeIdr} size="sm" />
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 sm:block">
                  <dt className="text-muted-foreground">
                    {t("gatewaySettlement.list.net")}
                  </dt>
                  <dd className="font-semibold">
                    <Money amount={entry.netIdr} size="sm" />
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </DataTableShell>
    </div>
  );
}
