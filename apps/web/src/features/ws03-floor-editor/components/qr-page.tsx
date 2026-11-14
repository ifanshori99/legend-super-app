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
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
import { QR_SHEET_GRID_CLASS, QR_SHEET_PRINT_STYLE } from "./qr-sheet-print";

function QrPage() {
  const t = useT();
  const toast = useToast();
  const floor = useCurrentFloor();
  const issueQr = useIssueTableQr();

  const [search, setSearch] = React.useState("");
  const [zoneFilter, setZoneFilter] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [labels, setLabels] = React.useState<Record<string, TableQr>>({});
  // Only the row being issued shows a spinner, the other rows stay usable.
  const [pendingIds, setPendingIds] = React.useState<string[]>([]);

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
  // Labels follow the table order, not the order they were issued in, so a
  // reprint never moves a sticker to another place on the sheet.
  const issued = tables.flatMap((table) =>
    labels[table.id] ? [labels[table.id]] : [],
  );
  // The sheet sits below the long table list: when it first appears, bring it
  // into view and move focus to its title. Later reprints leave the scroll
  // position alone so a row of reprints does not throw the page around.
  const hadSheet = React.useRef(false);
  React.useEffect(() => {
    const hasSheet = issued.length > 0;
    if (hasSheet && !hadSheet.current) {
      const title = document.getElementById("floor-labels-title");
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      title?.scrollIntoView({
        behavior: reduced ? "auto" : "smooth",
        block: "start",
      });
      title?.focus({ preventScroll: true });
    }
    hadSheet.current = hasSheet;
  }, [issued.length]);
  const busy = pendingIds.length > 0;
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
      toast({ title: t("floorEditor.qrNothingSelected"), tone: "info" });
      return;
    }
    setPendingIds(tableIds);
    try {
      const next: Record<string, TableQr> = {};
      // One request per table, in order, so a slow API is not flooded.
      for (const tableId of tableIds)
        next[tableId] = (await issueQr.mutateAsync(tableId)).data;
      setLabels((current) => ({ ...current, ...next }));
      toast({
        title: t("floorEditor.qrIssued", {
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
    } finally {
      setPendingIds([]);
    }
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <style>{QR_SHEET_PRINT_STYLE}</style>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="type-title">{t("floorEditor.qrTitle")}</h2>
          <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
            {t("floorEditor.qrDescription")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/kelola/meja">
              <LayoutGrid aria-hidden="true" />
              {t("floorEditor.title")}
            </Link>
          </Button>
          <Button
            variant="outline"
            onClick={() => void issue(selectedIds)}
            loading={pendingIds.length > 1}
            disabled={tables.length === 0 || busy}
          >
            <QrCode aria-hidden="true" />
            {selectedIds.length > 0
              ? t("floorEditor.qrIssueSelected", { count: selectedIds.length })
              : t("floorEditor.qrIssue")}
          </Button>
        </div>
      </header>

      <p className="rounded-control bg-info-subtle px-3 py-2 text-sm leading-5 font-medium text-info">
        {t("floorEditor.qrHint")}
      </p>

      {floor.isError && (
        <Card>
          <ErrorState
            description={(floor.error as ApiError | null)?.message}
            onRetry={() => void floor.refetch()}
          />
        </Card>
      )}

      {!floor.isError && (
        <DataTableShell
          title={t("floorEditor.qrTableTitle")}
          state={state}
          onRetry={() => void floor.refetch()}
          search={{
            value: search,
            onChange: setSearch,
            label: t("common.search"),
          }}
          rowCount={state === "ready" ? rows.length : undefined}
          empty={{
            title: t("floorEditor.qrEmptyTitle"),
            description: t("floorEditor.qrEmptyHint"),
            action: (
              <Button asChild variant="outline" size="sm">
                <Link to="/kelola/meja">{t("floorEditor.addTable")}</Link>
              </Button>
            ),
          }}
          actions={
            zones.length > 0 ? (
              <SegmentedControl
                label={t("floorEditor.zonesTitle")}
                value={activeZoneId ?? "all"}
                onValueChange={(value) =>
                  setZoneFilter(value === "all" ? null : value)
                }
                options={[
                  { value: "all", label: t("floorEditor.planAllZones") },
                  ...zones.map((zone) => ({
                    value: zone.id,
                    label: zone.name,
                  })),
                ]}
              />
            ) : undefined
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
                    aria-label={t("floorEditor.qrSelectAll")}
                  />
                </TableHead>
                <TableHead>{t("floorEditor.tableCode")}</TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("floorEditor.tableZone")}
                </TableHead>
                <TableHead numeric className="hidden md:table-cell">
                  {t("floorEditor.tableCapacity")}
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t("floorEditor.tableType")}
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
                      aria-label={t("floorEditor.qrSelect", {
                        code: table.code,
                      })}
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
                          t("floorEditor.planSeats", { count: table.capacity }),
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
                    {t(`floorEditor.type.${table.type}`)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      loading={pendingIds.includes(table.id)}
                      disabled={busy}
                      onClick={() => void issue([table.id])}
                    >
                      {labels[table.id]
                        ? t("floorEditor.qrReissue")
                        : t("floorEditor.qrIssue")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableView>
        </DataTableShell>
      )}

      {state === "ready" && issued.length === 0 && (
        <Card>
          <EmptyState
            title={t("floorEditor.qrPreviewEmptyTitle")}
            description={t("floorEditor.qrPreviewEmptyHint")}
          />
        </Card>
      )}

      {issued.length > 0 && (
        <ThemeScope mode="light" className="floor-print-sheet grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
            <h2
              id="floor-labels-title"
              tabIndex={-1}
              className="type-title outline-none"
            >
              {t("floorEditor.qrPreviewTitle")}
            </h2>
            <Button onClick={() => window.print()}>
              <Printer aria-hidden="true" />
              {t("floorEditor.qrPrint")}
            </Button>
          </div>
          <div className={QR_SHEET_GRID_CLASS}>
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
