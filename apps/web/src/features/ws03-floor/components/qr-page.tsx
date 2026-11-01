// QR meja (PRD §3 F9 "Meja": QR permanen dengan token bertanda tangan).
// The screen issues the signed QR per table through the contract, keeps the
// returned token (it is shown once), and lays the labels out as a printable
// sheet. Printing hides the app shell with a scoped print rule, because the
// shell chrome is not ours to change from a feature folder.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { LayoutGrid, Printer, QrCode } from "lucide-react";
import type { TableQr } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import {
  Table as TableView,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { ApiError } from "@/lib/api/errors";
import { useCurrentFloor, useIssueTableQr } from "../hooks";
import { matchesTableQuery, sortZones, tablesOfZone } from "../lib";
import { QrLabel } from "./qr-label";

/** Print only the label sheet; the shell around it stays out of the paper. */
const PRINT_STYLE = `@media print {
  body * { visibility: hidden; }
  .floor-print-sheet, .floor-print-sheet * { visibility: visible; }
  .floor-print-sheet { position: absolute; top: 0; left: 0; right: 0; padding: 12mm; }
}`;

function QrPage() {
  const t = useT();
  const toast = useToast();
  const floor = useCurrentFloor();
  const issueQr = useIssueTableQr();

  const [search, setSearch] = React.useState("");
  const [zoneFilter, setZoneFilter] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [labels, setLabels] = React.useState<Record<string, TableQr>>({});

  const zones = React.useMemo(
    () => sortZones(floor.data?.zones ?? []),
    [floor.data],
  );
  const tables = React.useMemo(
    () => (floor.data?.tables ?? []).map((row) => row.table),
    [floor.data],
  );
  const activeZoneId =
    zoneFilter !== null && zones.some((zone) => zone.id === zoneFilter)
      ? zoneFilter
      : null;
  const rows = tablesOfZone(tables, activeZoneId).filter((table) =>
    matchesTableQuery(table, search),
  );
  const zoneName = (id: string) =>
    zones.find((zone) => zone.id === id)?.name ?? "";
  const issued = Object.values(labels);
  const state: DataState = floor.isPending
    ? "loading"
    : floor.isError
      ? "error"
      : tables.length === 0
        ? "empty"
        : "ready";

  const toggle = (tableId: string) =>
    setSelectedIds((current) =>
      current.includes(tableId)
        ? current.filter((id) => id !== tableId)
        : [...current, tableId],
    );

  const allVisibleSelected =
    rows.length > 0 && rows.every((table) => selectedIds.includes(table.id));

  const toggleAll = () =>
    setSelectedIds(
      allVisibleSelected
        ? selectedIds.filter((id) => !rows.some((table) => table.id === id))
        : [...new Set([...selectedIds, ...rows.map((table) => table.id)])],
    );

  const issue = async (tableIds: string[]) => {
    if (tableIds.length === 0) {
      toast({ title: t("floor.qrNothingSelected"), tone: "info" });
      return;
    }
    try {
      const next: Record<string, TableQr> = {};
      // One request per table, in order, so a slow API is not flooded.
      for (const tableId of tableIds)
        next[tableId] = (await issueQr.mutateAsync(tableId)).data;
      setLabels((current) => ({ ...current, ...next }));
      toast({
        title: t("floor.qrIssued", {
          code: tableIds
            .map((id) => tables.find((table) => table.id === id)?.code ?? "")
            .join(", "),
        }),
        tone: "success",
      });
    } catch (error) {
      toast({
        title: t("state.errorTitle"),
        description: (error as ApiError).message,
        tone: "danger",
      });
    }
  };

  return (
    <div className="grid gap-4">
      <style>{PRINT_STYLE}</style>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-2xl font-semibold">{t("floor.qrTitle")}</h2>
          <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
            {t("floor.qrDescription")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/kelola/meja">
              <LayoutGrid aria-hidden="true" />
              {t("floor.title")}
            </Link>
          </Button>
          <Button
            variant="outline"
            onClick={() => void issue(selectedIds)}
            loading={issueQr.isPending}
            disabled={tables.length === 0}
          >
            <QrCode aria-hidden="true" />
            {selectedIds.length > 0
              ? t("floor.qrIssueSelected", { count: selectedIds.length })
              : t("floor.qrIssue")}
          </Button>
        </div>
      </header>

      <p className="rounded-lg bg-info-subtle px-3 py-2 text-sm leading-5 font-medium text-info">
        {t("floor.qrHint")}
      </p>

      {floor.isError && (
        <div className="rounded-xl border-(length:--border-w) bg-card">
          <ErrorState
            description={(floor.error as ApiError | null)?.message}
            onRetry={() => void floor.refetch()}
          />
        </div>
      )}

      {!floor.isError && (
        <DataTableShell
          title={t("floor.qrTableTitle")}
          state={state}
          onRetry={() => void floor.refetch()}
          search={{
            value: search,
            onChange: setSearch,
            label: t("common.search"),
          }}
          rowCount={state === "ready" ? rows.length : undefined}
          empty={{
            title: t("floor.qrEmptyTitle"),
            description: t("floor.qrEmptyHint"),
            action: (
              <Button asChild variant="outline" size="sm">
                <Link to="/kelola/meja">{t("floor.addTable")}</Link>
              </Button>
            ),
          }}
          actions={
            <div
              role="group"
              aria-label={t("floor.zonesTitle")}
              className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]"
            >
              <Button
                size="sm"
                variant={activeZoneId === null ? "secondary" : "ghost"}
                aria-pressed={activeZoneId === null}
                onClick={() => setZoneFilter(null)}
              >
                {t("floor.planAllZones")}
              </Button>
              {zones.map((zone) => (
                <Button
                  key={zone.id}
                  size="sm"
                  variant={activeZoneId === zone.id ? "secondary" : "ghost"}
                  aria-pressed={activeZoneId === zone.id}
                  onClick={() => setZoneFilter(zone.id)}
                >
                  {zone.name}
                </Button>
              ))}
            </div>
          }
          loadingRows={6}
        >
          <TableView>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={toggleAll}
                    aria-label={t("floor.qrSelectAll")}
                  />
                </TableHead>
                <TableHead>{t("floor.tableCode")}</TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("floor.tableZone")}
                </TableHead>
                <TableHead numeric className="hidden md:table-cell">
                  {t("floor.tableCapacity")}
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t("floor.tableType")}
                </TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("common.more")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((table) => (
                <TableRow
                  key={table.id}
                  data-state={labels[table.id] ? "selected" : undefined}
                >
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.includes(table.id)}
                      onCheckedChange={() => toggle(table.id)}
                      aria-label={t("floor.qrSelect", { code: table.code })}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-semibold tabular">
                        {table.code}
                      </span>
                      {/* Phones: zone, seats and type fold into this line. */}
                      <span className="text-xs leading-4 text-muted-foreground md:hidden">
                        {[
                          zoneName(table.zoneId),
                          t("floor.planSeats", { count: table.capacity }),
                        ].join(" · ")}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {zoneName(table.zoneId)}
                  </TableCell>
                  <TableCell numeric className="hidden md:table-cell">
                    {table.capacity}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {t(`floor.type.${table.type}`)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      loading={issueQr.isPending}
                      onClick={() => void issue([table.id])}
                    >
                      {labels[table.id]
                        ? t("floor.qrReissue")
                        : t("floor.qrIssue")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableView>
        </DataTableShell>
      )}

      {state === "ready" && issued.length === 0 && (
        <div className="rounded-xl border-(length:--border-w) bg-card">
          <EmptyState
            title={t("floor.qrPreviewEmptyTitle")}
            description={t("floor.qrPreviewEmptyHint")}
          />
        </div>
      )}

      {issued.length > 0 && (
        <ThemeScope
          mode="light"
          className="floor-print-sheet grid gap-3 rounded-xl"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
            <h2 id="floor-labels-title" className="text-xl font-semibold">
              {t("floor.qrPreviewTitle")}
            </h2>
            <Button onClick={() => window.print()}>
              <Printer aria-hidden="true" />
              {t("floor.qrPrint")}
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 print:grid-cols-2">
            {issued.map((qr) => {
              const table = tables.find((entry) => entry.id === qr.tableId);
              if (!table) return null;
              return (
                <QrLabel
                  key={qr.tableId}
                  qr={qr}
                  table={table}
                  zone={zones.find((zone) => zone.id === table.zoneId)}
                  brand={t("app.defaultBrand")}
                />
              );
            })}
          </div>
        </ThemeScope>
      )}
    </div>
  );
}

export { QrPage };
