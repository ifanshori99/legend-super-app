// PRD §3 F34 "Operasional": serving time per station, best sellers and sold
// out items, the current kitchen queue, open waiter calls, and the latest
// reviews. Reports supply the numbers; the review list reads the CRM feedback
// queue because the dashboard contract has no queue payload yet.
// DESIGN.md v3: the two service-quality KPIs share one StatStrip, every list is
// a DataTableShell, and the review list is a CardShell.
import { Star } from "lucide-react";
import { useT } from "@/components/i18n";
import { formatNumber } from "@starter/shared/i18n";
import { Badge } from "@/components/ui/badge";
import {
  CardShell,
  CardShellBody,
  CardShellFooter,
} from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { StatStrip } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DashboardTile } from "@starter/shared/dashboard";
import {
  countOf,
  formatReviewDate,
  metricCell,
  ownerBoardTile,
  OWNER_TILE,
  reportRows,
  tileReportCode,
} from "../board";
import { useOwnerBoardContext } from "../board-context";
import { BoardEmpty, RowsSkeleton } from "./board-widget";
import { BoardTable } from "./board-table";
import { KpiTile } from "./kpi-tile";
import { MetricCellView } from "./metric-display";
import { TileSource } from "./tile-source";

function ServingTimeTable({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const state = useOwnerBoardContext().report(tileReportCode(tile));
  const rows = state.result
    ? reportRows(state.result, ["avg_serving_time"])
    : [];
  return (
    <BoardTable
      title={t("ownerDashboard.operations.servingTitle")}
      description={t("ownerDashboard.operations.servingHint")}
      status={state.status}
      onRetry={state.retry}
      source={<TileSource tile={tile} />}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("ownerDashboard.operations.station")}</TableHead>
            <TableHead numeric>
              {t("ownerDashboard.operations.servingTime")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label ?? "total"}>
              <TableCell className="font-medium">{row.label}</TableCell>
              <TableCell numeric>
                <MetricCellView
                  value={row.values.get("avg_serving_time") ?? null}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </BoardTable>
  );
}

function KitchenQueueTable({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const state = useOwnerBoardContext().report(tileReportCode(tile));
  const rows = state.result
    ? reportRows(state.result, ["order_queue_count", "avg_serving_time"])
    : [];
  return (
    <BoardTable
      title={t("ownerDashboard.operations.queueTitle")}
      description={t("ownerDashboard.operations.queueHint")}
      status={state.status}
      onRetry={state.retry}
      source={<TileSource tile={tile} />}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("ownerDashboard.operations.station")}</TableHead>
            <TableHead numeric>
              {t("ownerDashboard.operations.queueCount")}
            </TableHead>
            <TableHead numeric>
              {t("ownerDashboard.operations.servingTime")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label ?? "total"}>
              <TableCell className="font-medium">{row.label}</TableCell>
              <TableCell numeric>
                <MetricCellView
                  value={row.values.get("order_queue_count") ?? null}
                />
              </TableCell>
              <TableCell numeric>
                <MetricCellView
                  value={row.values.get("avg_serving_time") ?? null}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </BoardTable>
  );
}

function BestSellersTable({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const state = useOwnerBoardContext().report(tileReportCode(tile));
  const rows = state.result
    ? reportRows(state.result, ["menu_sold_qty", "net_sales"])
    : [];
  return (
    <BoardTable
      title={t("ownerDashboard.operations.bestTitle")}
      description={t("ownerDashboard.operations.bestHint")}
      status={state.status}
      onRetry={state.retry}
      source={<TileSource tile={tile} />}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("ownerDashboard.operations.menu")}</TableHead>
            <TableHead numeric>
              {t("ownerDashboard.operations.portions")}
            </TableHead>
            <TableHead numeric>
              {t("ownerDashboard.operations.revenue")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label ?? "total"}>
              <TableCell className="font-medium">{row.label}</TableCell>
              <TableCell numeric>
                <MetricCellView
                  value={row.values.get("menu_sold_qty") ?? null}
                />
              </TableCell>
              <TableCell numeric>
                <MetricCellView value={row.values.get("net_sales") ?? null} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </BoardTable>
  );
}

function WaiterCallsTable({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const state = useOwnerBoardContext().report(tileReportCode(tile));
  const rows = state.result
    ? reportRows(state.result, ["waiter_call_count"])
    : [];
  return (
    <BoardTable
      title={t("ownerDashboard.operations.waiterTitle")}
      description={t("ownerDashboard.operations.waiterHint")}
      status={state.status}
      onRetry={state.retry}
      source={<TileSource tile={tile} />}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("ownerDashboard.operations.zone")}</TableHead>
            <TableHead numeric>
              {t("ownerDashboard.operations.calls")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label ?? "total"}>
              <TableCell className="font-medium">{row.label}</TableCell>
              <TableCell numeric>
                <MetricCellView
                  value={row.values.get("waiter_call_count") ?? null}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </BoardTable>
  );
}

function ReviewsCard({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const { reviews } = useOwnerBoardContext();
  return (
    <CardShell>
      <CardShellBody className="gap-3 p-card">
        <div className="grid gap-1">
          <h3 className="type-title">
            {t("ownerDashboard.operations.reviewsTitle")}
          </h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("ownerDashboard.operations.reviewsHint")}
          </p>
        </div>
        {reviews.status === "loading" && <RowsSkeleton rows={2} />}
        {reviews.status === "error" && <ErrorState onRetry={reviews.retry} />}
        {reviews.status === "empty" && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("ownerDashboard.operations.noReviews")}
          </p>
        )}
        {reviews.status === "ready" && (
          <ul className="grid gap-3">
            {reviews.items.map((item) => (
              <li
                key={item.id}
                className="grid gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {item.rating === null ? null : (
                    <Badge tone="neutral">
                      <Star aria-hidden="true" />
                      {t("ownerDashboard.operations.ratingValue", {
                        value: formatNumber(item.rating),
                      })}
                      <span className="sr-only">
                        {t("ownerDashboard.operations.reviewRatingAria", {
                          rating: item.rating,
                        })}
                      </span>
                    </Badge>
                  )}
                  <time
                    dateTime={item.createdAt}
                    className="text-xs text-muted-foreground tabular"
                  >
                    {formatReviewDate(item.createdAt)}
                  </time>
                </div>
                {item.comment && (
                  <p className="text-sm leading-5">{item.comment}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardShellBody>
      <CardShellFooter>
        <TileSource
          tile={tile}
          className="font-semibold text-primary underline-offset-4 hover:underline"
        />
      </CardShellFooter>
    </CardShell>
  );
}

export function OperationsSection() {
  const t = useT();
  const board = useOwnerBoardContext();
  const layout = board.layout;
  const servingTile = ownerBoardTile(layout, OWNER_TILE.servingTime);
  const queueTile = ownerBoardTile(layout, OWNER_TILE.kitchenQueue);
  const bestTile = ownerBoardTile(layout, OWNER_TILE.bestSellers);
  const soldOutTile = ownerBoardTile(layout, OWNER_TILE.soldOut);
  const waiterTile = ownerBoardTile(layout, OWNER_TILE.waiterCalls);
  const ratingTile = ownerBoardTile(layout, OWNER_TILE.rating);
  const reviewsTile = ownerBoardTile(layout, OWNER_TILE.latestReviews);

  const reportCodes = [
    ...new Set(
      [
        servingTile,
        queueTile,
        bestTile,
        soldOutTile,
        waiterTile,
        ratingTile,
        reviewsTile,
      ]
        .map((tile) => (tile === null ? null : tileReportCode(tile)))
        .filter((code): code is string => code !== null),
    ),
  ];
  const allEmpty =
    reportCodes.length > 0 &&
    reportCodes.every((code) => board.report(code).status === "empty") &&
    board.reviews.status === "empty";
  if (allEmpty) return <BoardEmpty />;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <StatStrip label={t("ownerDashboard.operations.stripLabel")} columns={2}>
        {soldOutTile && (
          <KpiTile
            tile={soldOutTile}
            metricCode="sold_out_menu_count"
            label={t("ownerDashboard.operations.soldOut")}
            context={t("ownerDashboard.operations.soldOutContext")}
          />
        )}
        {ratingTile && (
          <KpiTile
            tile={ratingTile}
            metricCode="review_rating"
            label={t("ownerDashboard.operations.rating")}
            valueSuffix="/5"
            contextFor={(result) => {
              const count = countOf(metricCell(result, "review_count"));
              return count === null
                ? undefined
                : t("ownerDashboard.operations.ratingContext", { count });
            }}
          />
        )}
      </StatStrip>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-2">
        <div className="min-w-0">
          {queueTile && <KitchenQueueTable tile={queueTile} />}
        </div>
        <div className="min-w-0">
          {servingTile && <ServingTimeTable tile={servingTile} />}
        </div>
        <div className="min-w-0">
          {bestTile && <BestSellersTable tile={bestTile} />}
        </div>
        <div className="min-w-0">
          {waiterTile && <WaiterCallsTable tile={waiterTile} />}
        </div>
      </div>

      {reviewsTile && <ReviewsCard tile={reviewsTile} />}
    </div>
  );
}
