// Denah & Meja (PRD §3 F9): the zone filter, the plan editor and the selected
// table's inspector. Reads one floor snapshot (zones, tables, live sessions)
// and saves moved tables as one request, so a drag session never lands half.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Plus, QrCode, Save, Undo2 } from "lucide-react";
import type { FloorZone, TableLayout } from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ErrorState, EmptyState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import type { ApiError } from "@/lib/api/errors";
import { useCurrentFloor, useSaveLayout } from "../hooks";
import {
  changedPlacements,
  clampLayout,
  layoutsEqual,
  moveLayout,
  snapLayout,
  sortZones,
  tablesOfZone,
} from "../lib";
import { FloorCanvas } from "./floor-canvas";
import { TableFormDialog } from "./table-form-dialog";
import { TableInspector } from "./table-inspector";
import { ZoneFormDialog } from "./zone-form-dialog";
import { ZoneList } from "./zone-list";

function FloorEditorPage() {
  const t = useT();
  const toast = useToast();
  const floor = useCurrentFloor();
  const saveLayout = useSaveLayout();

  const [zoneFilter, setZoneFilter] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, TableLayout>>({});
  const [zoneEditor, setZoneEditor] = React.useState<{
    open: boolean;
    zone?: FloorZone;
  }>({ open: false });
  const [tableFormOpen, setTableFormOpen] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");

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
  const visibleTables = tablesOfZone(tables, activeZoneId);
  const selected = tables.find((table) => table.id === selectedId) ?? null;
  const changes = changedPlacements(drafts, tables);

  const setDraft = (tableId: string, layout: TableLayout) =>
    setDrafts((current) => ({ ...current, [tableId]: layout }));

  const move = (tableId: string, x: number, y: number) => {
    const table = tables.find((entry) => entry.id === tableId);
    if (!table) return;
    const current = drafts[tableId] ?? table.layout;
    setDraft(tableId, clampLayout(snapLayout({ ...current, x, y })));
  };

  const step = (tableId: string, dx: number, dy: number) => {
    const table = tables.find((entry) => entry.id === tableId);
    if (!table) return;
    const current = drafts[tableId] ?? table.layout;
    const next = moveLayout(current, dx, dy);
    setDraft(tableId, next);
    setSelectedId(tableId);
    setAnnouncement(
      t("floorEditor.planMoved", {
        code: table.code,
        x: Math.round(next.x),
        y: Math.round(next.y),
      }),
    );
  };

  const save = () => {
    if (changes.length === 0) return;
    saveLayout.mutate(
      { placements: changes },
      {
        onSuccess: () => {
          toast({ title: t("floorEditor.saved"), tone: "success" });
          setDrafts({});
        },
        onError: (error: Error) =>
          toast({
            title: t("state.errorTitle"),
            description: (error as ApiError).message,
            tone: "danger",
          }),
      },
    );
  };

  const error = floor.error as ApiError | null;

  return (
    <div className="grid gap-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* The management shell's topbar already renders the page title as
            the document h1, so this screen only adds context and actions. */}
        <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
          {t("floorEditor.description")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/kelola/meja/qr">
              <QrCode aria-hidden="true" />
              {t("floorEditor.qrSheet")}
            </Link>
          </Button>
          <Button
            variant="outline"
            disabled={zones.length === 0}
            onClick={() => setTableFormOpen(true)}
          >
            <Plus aria-hidden="true" />
            {t("floorEditor.addTable")}
          </Button>
          {changes.length > 0 && (
            <Button loading={saveLayout.isPending} onClick={save}>
              <Save aria-hidden="true" />
              {t("floorEditor.saveLayout")}
            </Button>
          )}
        </div>
      </header>

      {floor.isPending && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Skeleton className="h-[420px]" />
          <Skeleton className="h-[280px]" />
        </div>
      )}

      {floor.isError && (
        <div className="rounded-xl border-(length:--border-w) bg-card">
          <ErrorState
            description={error?.message ?? t("state.errorHint")}
            onRetry={() => void floor.refetch()}
          />
        </div>
      )}

      {floor.isSuccess && zones.length === 0 && (
        <div className="rounded-xl border-(length:--border-w) bg-card">
          <EmptyState
            title={t("floorEditor.zonesEmptyTitle")}
            description={t("floorEditor.zonesEmptyHint")}
            action={
              <Button onClick={() => setZoneEditor({ open: true })}>
                <Plus aria-hidden="true" />
                {t("floorEditor.addZone")}
              </Button>
            }
          />
        </div>
      )}

      {floor.isSuccess && zones.length > 0 && (
        <>
          {changes.length > 0 && (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning-subtle px-3 py-2 text-sm font-medium text-warning"
            >
              <span>{t("floorEditor.unsaved", { count: changes.length })}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDrafts({})}
                disabled={saveLayout.isPending}
              >
                <Undo2 aria-hidden="true" />
                {t("floorEditor.resetLayout")}
              </Button>
            </div>
          )}

          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="grid min-w-0 content-start gap-3 self-start">
              <div
                role="group"
                aria-label={t("floorEditor.zonesTitle")}
                className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]"
              >
                <Button
                  size="sm"
                  variant={activeZoneId === null ? "secondary" : "ghost"}
                  aria-pressed={activeZoneId === null}
                  onClick={() => setZoneFilter(null)}
                >
                  {t("floorEditor.planAllZones")}
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
              <p className="text-sm leading-5 text-muted-foreground">
                {t("floorEditor.planHint")}
              </p>
              <FloorCanvas
                tables={visibleTables}
                zones={zones}
                drafts={drafts}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMoveTo={(tableId, x, y) => move(tableId, x, y)}
                onStep={step}
                onAddTable={() => setTableFormOpen(true)}
              />
            </div>

            <TableInspector
              table={selected}
              zones={zones}
              draft={
                selected &&
                drafts[selected.id] &&
                !layoutsEqual(drafts[selected.id], selected.layout)
                  ? drafts[selected.id]
                  : undefined
              }
              dirty={Boolean(
                selected &&
                drafts[selected.id] &&
                !layoutsEqual(drafts[selected.id], selected.layout),
              )}
              onLayoutChange={(layout) => {
                if (selected) setDraft(selected.id, layout);
              }}
              onDeleted={() => {
                setSelectedId(null);
                setDrafts((current) => {
                  const next = { ...current };
                  if (selected) delete next[selected.id];
                  return next;
                });
              }}
            />
          </div>

          <ZoneList
            zones={zones}
            tables={tables}
            state="ready"
            onRetry={() => void floor.refetch()}
            onCreate={() => setZoneEditor({ open: true })}
            onEdit={(zone) => setZoneEditor({ open: true, zone })}
          />
        </>
      )}

      <ZoneFormDialog
        open={zoneEditor.open}
        onOpenChange={(open) => setZoneEditor({ open })}
        zone={zoneEditor.zone}
      />
      <TableFormDialog
        open={tableFormOpen}
        onOpenChange={setTableFormOpen}
        zones={zones}
        tables={tables}
        defaultZoneId={activeZoneId}
      />

      <p className="sr-only" role="status">
        {announcement}
      </p>
    </div>
  );
}

export { FloorEditorPage };
