// Promo ROI report (/kelola/promo/roi; PRD v1.7 §3.21 "ROI Promo"): discount
// cost, revenue from promo transactions and net margin per promotion, with the
// totals in a stat strip. ROI is one request per promotion (contract
// getPromotionRoi), so a row can fail alone and retry alone.
import * as React from "react";
import { RotateCw } from "lucide-react";
import type { Promotion, PromotionRoi } from "@starter/shared/crm";
import { formatNumber } from "@starter/shared/i18n";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { Money } from "@/components/ui/money";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "cn";
import { usePromotionRois, usePromotions } from "../hooks";
import { formatPercentBp, totalRoi } from "../lib";
import { usePromoT, type PromoT } from "../t";
import { Notice, PromoStatusPill } from "./promo-shell";

function RoiValue({ roiBp, t }: { roiBp: number | null; t: PromoT }) {
  if (roiBp === null)
    return (
      <span className="text-muted-foreground">{t("promo.roi.roiNone")}</span>
    );
  return (
    <span className={cn("tabular font-semibold", roiBp < 0 && "text-danger")}>
      {roiBp < 0
        ? `−${formatPercentBp(Math.abs(roiBp))}`
        : formatPercentBp(roiBp)}
    </span>
  );
}

export function RoiPage() {
  const t = usePromoT();
  const [search, setSearch] = React.useState("");
  const promotionsQuery = usePromotions();
  const promotions: Promotion[] = promotionsQuery.data?.data ?? [];
  const roiQueries = usePromotionRois(promotions);

  const rows = promotions.map((promotion, index) => ({
    promotion,
    query: roiQueries[index],
  }));
  const loaded = rows.flatMap(({ query }) =>
    query?.data ? [query.data.data] : [],
  );
  const total = totalRoi(loaded as PromotionRoi[]);
  const roiLoading = roiQueries.some((query) => query.isPending);
  // Totals only sum rows that answered. While rows load the tiles wait, and a
  // failed row is called out, so a partial sum never reads as the whole.
  const roiFailed = roiQueries.filter((query) => query.isError).length;
  const pendingValue = <span aria-busy="true">…</span>;
  const money = (amount: number) =>
    roiLoading ? pendingValue : <Money amount={amount} size="stat" />;
  const filtered = rows.filter(({ promotion }) =>
    promotion.name
      .toLocaleLowerCase("id-ID")
      .includes(search.trim().toLocaleLowerCase("id-ID")),
  );

  const state = promotionsQuery.isPending
    ? "loading"
    : promotionsQuery.isError
      ? "error"
      : promotions.length === 0
        ? "empty"
        : "ready";

  return (
    <div className="grid min-w-0 gap-5">
      {state === "ready" && roiFailed > 0 && (
        <Notice tone="warning" role="status">
          {t("promo.roi.partial", { count: roiFailed })}
        </Notice>
      )}
      {state === "ready" && (
        <StatStrip label={t("promo.roi.summaryLabel")} columns={4}>
          <StatTile
            label={t("promo.roi.totalCost")}
            value={money(total.cost)}
            context={t("promo.roi.contextAll")}
          />
          <StatTile
            label={t("promo.roi.totalRevenue")}
            value={money(total.revenue)}
            context={t("promo.roi.contextAll")}
          />
          <StatTile
            label={t("promo.roi.netMargin")}
            value={money(total.net)}
            context={t("promo.roi.marginNote")}
          />
          <StatTile
            label={t("promo.roi.avgRoi")}
            value={
              roiLoading ? pendingValue : <RoiValue roiBp={total.roiBp} t={t} />
            }
            context={`${formatNumber(total.transactions)} ${t("promo.roi.columns.transactions").toLocaleLowerCase("id-ID")}`}
          />
        </StatStrip>
      )}

      <DataTableShell
        title={t("promo.roi.title")}
        description={t("promo.roi.description")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("promo.roi.searchLabel"),
        }}
        onRetry={() => void promotionsQuery.refetch()}
        empty={{
          title: t("promo.roi.emptyTitle"),
          description: t("promo.roi.emptyHint"),
        }}
        noResults={filtered.length === 0 && promotions.length > 0}
        rowCount={filtered.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("promo.roi.columns.promo")}</TableHead>
                <TableHead numeric>
                  {t("promo.roi.columns.transactions")}
                </TableHead>
                <TableHead numeric>{t("promo.roi.columns.cost")}</TableHead>
                <TableHead numeric>{t("promo.roi.columns.revenue")}</TableHead>
                <TableHead numeric>{t("promo.roi.columns.margin")}</TableHead>
                <TableHead numeric>{t("promo.roi.columns.roi")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(({ promotion, query }) => {
                const roi = query?.data?.data;
                return (
                  <TableRow key={promotion.id}>
                    <TableCell>
                      <div className="grid gap-1">
                        <span className="font-medium">{promotion.name}</span>
                        <PromoStatusPill status={promotion.status} />
                      </div>
                    </TableCell>
                    {roi ? (
                      <>
                        <TableCell numeric className="tabular">
                          {formatNumber(roi.transactions)}
                        </TableCell>
                        <TableCell numeric>
                          <Money amount={roi.discountCostIdr} />
                        </TableCell>
                        <TableCell numeric>
                          <Money amount={roi.revenueIdr} />
                        </TableCell>
                        <TableCell numeric>
                          <Money
                            amount={roi.netMarginIdr}
                            className={cn(
                              roi.netMarginIdr < 0 && "text-danger",
                            )}
                          />
                        </TableCell>
                        <TableCell numeric>
                          <RoiValue roiBp={roi.roiBp} t={t} />
                        </TableCell>
                      </>
                    ) : (
                      <TableCell colSpan={5} numeric>
                        {query?.isError ? (
                          <span className="inline-flex items-center gap-2 text-sm">
                            <span role="alert" className="text-danger">
                              {t("promo.roi.rowError")}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void query.refetch()}
                            >
                              <RotateCw aria-hidden="true" />
                              {t("promo.roi.retry")}
                            </Button>
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            {t("promo.common.loading")}
                          </span>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <ul className="md:hidden">
          {filtered.map(({ promotion, query }) => {
            const roi = query?.data?.data;
            return (
              <li
                key={promotion.id}
                className="grid gap-2 border-b px-card py-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-medium">{promotion.name}</span>
                  <PromoStatusPill status={promotion.status} />
                </div>
                {roi ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">
                      {t("promo.roi.columns.cost")}
                    </dt>
                    <dd className="text-right">
                      <Money amount={roi.discountCostIdr} size="sm" />
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("promo.roi.columns.revenue")}
                    </dt>
                    <dd className="text-right">
                      <Money amount={roi.revenueIdr} size="sm" />
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("promo.roi.columns.margin")}
                    </dt>
                    <dd className="text-right">
                      <Money
                        amount={roi.netMarginIdr}
                        size="sm"
                        className={cn(roi.netMarginIdr < 0 && "text-danger")}
                      />
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("promo.roi.columns.roi")}
                    </dt>
                    <dd className="text-right">
                      <RoiValue roiBp={roi.roiBp} t={t} />
                    </dd>
                  </dl>
                ) : query?.isError ? (
                  <div className="flex items-center gap-2 text-sm">
                    <span role="alert" className="text-danger">
                      {t("promo.roi.rowError")}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void query.refetch()}
                    >
                      <RotateCw aria-hidden="true" />
                      {t("promo.roi.retry")}
                    </Button>
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {t("promo.common.loading")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </DataTableShell>
    </div>
  );
}
