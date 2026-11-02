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
import { PromoStatusPill } from "./promo-shell";

function RoiValue({ roiBp, t }: { roiBp: number | null; t: PromoT }) {
  if (roiBp === null)
    return <span className="text-muted-foreground">{t("roi.roiNone")}</span>;
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
      {state === "ready" && (
        <StatStrip label={t("roi.summaryLabel")} columns={4}>
          <StatTile
            label={t("roi.totalCost")}
            value={<Money amount={total.cost} size="stat" />}
            context={t("roi.contextAll")}
          />
          <StatTile
            label={t("roi.totalRevenue")}
            value={<Money amount={total.revenue} size="stat" />}
            context={t("roi.contextAll")}
          />
          <StatTile
            label={t("roi.netMargin")}
            value={<Money amount={total.net} size="stat" />}
            context={t("roi.marginNote")}
          />
          <StatTile
            label={t("roi.avgRoi")}
            value={
              roiLoading ? (
                <span aria-busy="true">…</span>
              ) : (
                <RoiValue roiBp={total.roiBp} t={t} />
              )
            }
            context={`${formatNumber(total.transactions)} ${t("roi.columns.transactions").toLocaleLowerCase("id-ID")}`}
          />
        </StatStrip>
      )}

      <DataTableShell
        title={t("roi.title")}
        description={t("roi.description")}
        state={state}
        search={{
          value: search,
          onChange: setSearch,
          label: t("roi.searchLabel"),
        }}
        onRetry={() => void promotionsQuery.refetch()}
        empty={{ title: t("roi.emptyTitle"), description: t("roi.emptyHint") }}
        noResults={filtered.length === 0 && promotions.length > 0}
        rowCount={filtered.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("roi.columns.promo")}</TableHead>
                <TableHead numeric>{t("roi.columns.transactions")}</TableHead>
                <TableHead numeric>{t("roi.columns.cost")}</TableHead>
                <TableHead numeric>{t("roi.columns.revenue")}</TableHead>
                <TableHead numeric>{t("roi.columns.margin")}</TableHead>
                <TableHead numeric>{t("roi.columns.roi")}</TableHead>
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
                              {t("roi.rowError")}
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void query.refetch()}
                            >
                              <RotateCw aria-hidden="true" />
                              {t("roi.retry")}
                            </Button>
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            {t("common.loading")}
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
                      {t("roi.columns.cost")}
                    </dt>
                    <dd className="text-right">
                      <Money amount={roi.discountCostIdr} size="sm" />
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("roi.columns.revenue")}
                    </dt>
                    <dd className="text-right">
                      <Money amount={roi.revenueIdr} size="sm" />
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("roi.columns.margin")}
                    </dt>
                    <dd className="text-right">
                      <Money
                        amount={roi.netMarginIdr}
                        size="sm"
                        className={cn(roi.netMarginIdr < 0 && "text-danger")}
                      />
                    </dd>
                    <dt className="text-muted-foreground">
                      {t("roi.columns.roi")}
                    </dt>
                    <dd className="text-right">
                      <RoiValue roiBp={roi.roiBp} t={t} />
                    </dd>
                  </dl>
                ) : query?.isError ? (
                  <div className="flex items-center gap-2 text-sm">
                    <span role="alert" className="text-danger">
                      {t("roi.rowError")}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void query.refetch()}
                    >
                      <RotateCw aria-hidden="true" />
                      {t("roi.retry")}
                    </Button>
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {t("common.loading")}
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
