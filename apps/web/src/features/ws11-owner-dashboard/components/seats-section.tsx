// PRD §3 F34 "Kursi & WFC": seat occupancy and RevPASH per zone, time spent
// against spend, and guest Wi-Fi usage.
import { useT } from "@/components/i18n";
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
  decimalOf,
  formatDecimal,
  metricCell,
  ownerBoardTile,
  OWNER_TILE,
  reportRows,
} from "../board";
import { useOwnerBoardContext } from "../board-context";
import { BoardEmpty } from "./board-widget";
import { BoardTable } from "./board-table";
import { KpiTile } from "./kpi-tile";
import { DecimalText, MetricCellView } from "./metric-display";
import { TileSource } from "./tile-source";

function ZoneOccupancyTable({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const state = useOwnerBoardContext().report(tile.reportCode);
  const rows = state.result
    ? reportRows(state.result, ["seat_occupancy_pct", "revpash"])
    : [];
  return (
    <BoardTable
      title={t("ownerDashboard.seats.zoneTitle")}
      description={t("ownerDashboard.seats.zoneHint")}
      status={state.status}
      onRetry={state.retry}
      source={<TileSource tile={tile} />}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("ownerDashboard.seats.zone")}</TableHead>
            <TableHead numeric>
              {t("ownerDashboard.seats.occupancy")}
            </TableHead>
            <TableHead numeric>{t("ownerDashboard.seats.revpash")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label ?? "total"}>
              <TableCell className="font-medium">{row.label}</TableCell>
              <TableCell numeric>
                <MetricCellView
                  value={row.values.get("seat_occupancy_pct") ?? null}
                />
              </TableCell>
              <TableCell numeric>
                <MetricCellView value={row.values.get("revpash") ?? null} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </BoardTable>
  );
}

function DwellTable({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const state = useOwnerBoardContext().report(tile.reportCode);
  const rows = state.result
    ? reportRows(state.result, [
        "avg_dwell_minutes",
        "avg_spend_per_pax",
        "table_turnover",
      ])
    : [];
  return (
    <BoardTable
      title={t("ownerDashboard.seats.dwellTitle")}
      description={t("ownerDashboard.seats.dwellHint")}
      status={state.status}
      onRetry={state.retry}
      source={<TileSource tile={tile} />}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("ownerDashboard.seats.zone")}</TableHead>
            <TableHead numeric>
              {t("ownerDashboard.seats.dwellColumn")}
            </TableHead>
            <TableHead numeric>
              {t("ownerDashboard.seats.spendPerPax")}
            </TableHead>
            <TableHead numeric>
              {t("ownerDashboard.seats.turnover")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const dwell = decimalOf(
              row.values.get("avg_dwell_minutes") ?? null,
            );
            const turnover = decimalOf(
              row.values.get("table_turnover") ?? null,
            );
            return (
              <TableRow key={row.label ?? "total"}>
                <TableCell className="font-medium">{row.label}</TableCell>
                <TableCell numeric>
                  {dwell === null ? "—" : <DecimalText value={dwell} suffix="mnt" />}
                </TableCell>
                <TableCell numeric>
                  <MetricCellView
                    value={row.values.get("avg_spend_per_pax") ?? null}
                  />
                </TableCell>
                <TableCell numeric>
                  {turnover === null ? (
                    "—"
                  ) : (
                    <span className="tabular">{formatDecimal(turnover)}×</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </BoardTable>
  );
}

export function SeatsSection() {
  const t = useT();
  const board = useOwnerBoardContext();
  const layout = board.layout;
  const zoneTile = ownerBoardTile(layout, OWNER_TILE.zoneOccupancy);
  const dwellTile = ownerBoardTile(layout, OWNER_TILE.dwellVsSpend);
  const wifiTile = ownerBoardTile(layout, OWNER_TILE.wifiUsage);

  const reportCodes = [
    ...new Set(
      [zoneTile, dwellTile, wifiTile]
        .map((tile) => tile?.reportCode ?? null)
        .filter((code): code is string => code !== null),
    ),
  ];
  const allEmpty =
    reportCodes.length > 0 &&
    reportCodes.every((code) => board.report(code).status === "empty");
  if (allEmpty) return <BoardEmpty />;

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <div className="min-w-0">
          {zoneTile && <ZoneOccupancyTable tile={zoneTile} />}
        </div>
        <div className="min-w-0">{dwellTile && <DwellTable tile={dwellTile} />}</div>
      </div>

      {wifiTile && (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <KpiTile
            tile={wifiTile}
            metricCode="wifi_sessions"
            label={t("ownerDashboard.seats.wifi")}
            contextFor={(result) => {
              const quota = decimalOf(metricCell(result, "wifi_quota_used"));
              return quota === null
                ? null
                : t("ownerDashboard.seats.wifiQuotaContext", {
                    quota: formatDecimal(quota),
                  });
            }}
          />
        </div>
      )}
    </div>
  );
}
