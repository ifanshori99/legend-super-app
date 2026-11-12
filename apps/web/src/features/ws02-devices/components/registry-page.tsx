// Device registry panel per outlet (PRD v1.7 §3 F5 Registri Perangkat, Mode
// Latihan; acceptance EDG-03 UI): summary strip, filters, dense table on
// desktop, cards on phones, detail drawer, revoke dialog.
import * as React from "react";
import { ChevronRight, MonitorSmartphone, Plus, WifiOff } from "lucide-react";
import type { Device } from "@starter/shared/edge";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOnline } from "@/lib/use-online";
import { useNowMs } from "@/features/ws02-edge/use-now";
import { useEdgeDevices, useRevokedOverlay } from "../hooks.ts";
import {
  ALL,
  DEVICE_TYPES,
  DEVICE_TYPE_LABEL,
  EMPTY_FILTERS,
  deviceCounts,
  filterDevices,
  mergeRevocations,
  outletOptions,
  serverClockOffsetMs,
  shortId,
  type RegistryFilters,
} from "../logic.ts";
import { DeviceDrawer } from "./device-drawer.tsx";
import { DeviceTokenDialog, type IssuedToken } from "./device-token-dialog.tsx";
import { EnrollDialog } from "./enroll-dialog.tsx";
import { ReissueTokenDialog } from "./reissue-token-dialog.tsx";
import { HeartbeatCell } from "./heartbeat-status.tsx";
import { RevokeDialog } from "./revoke-dialog.tsx";
import { TrainingSwitch } from "./training-control.tsx";

export function DeviceRegistryPage({
  canManage,
  canRevoke,
  outlets,
}: {
  outlets: readonly { id: string; name: string }[];
  canManage: boolean;
  canRevoke: boolean;
}) {
  const t = useT();
  const online = useOnline();
  const viewerNowMs = useNowMs();
  const revoked = useRevokedOverlay();
  const [filters, setFilters] = React.useState<RegistryFilters>(EMPTY_FILTERS);
  const outletId = filters.outletId === ALL ? outlets[0]?.id : filters.outletId;
  const query = useEdgeDevices({ outletId, enabled: Boolean(outletId) });
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [revokeId, setRevokeId] = React.useState<string | null>(null);
  const [enrollOpen, setEnrollOpen] = React.useState(false);
  const [reissueId, setReissueId] = React.useState<string | null>(null);
  // The one-time device token lives only here, until the dialog is closed.
  const [issued, setIssued] = React.useState<IssuedToken | null>(null);

  const devices = React.useMemo(
    () => mergeRevocations(query.data?.data ?? [], revoked),
    [query.data, revoked],
  );
  const options = React.useMemo(
    () => outletOptions(outlets, devices),
    [outlets, devices],
  );
  const outletName = React.useCallback(
    (id: string) => {
      const found = options.find((o) => o.id === id);
      return (
        found?.name ??
        t("deviceRegistry.filters.outletFallback", { code: shortId(id) })
      );
    },
    [options, t],
  );
  // Heartbeat age is measured on the edge clock, not only the viewer's.
  const offsetMs = React.useMemo(
    () =>
      query.data
        ? serverClockOffsetMs(query.data.meta.serverTime, query.dataUpdatedAt)
        : 0,
    [query.data, query.dataUpdatedAt],
  );
  const nowMs = viewerNowMs === null ? null : viewerNowMs + offsetMs;
  const rows = React.useMemo(
    () => filterDevices(devices, filters),
    [devices, filters],
  );
  const counts = nowMs === null ? null : deviceCounts(devices, nowMs);
  const opened = devices.find((d) => d.id === openId) ?? null;
  const revokeTarget = devices.find((d) => d.id === revokeId) ?? null;
  const reissueTarget = devices.find((d) => d.id === reissueId) ?? null;

  const state: DataState =
    Boolean(outletId) && query.isPending
      ? "loading"
      : query.isError
        ? "error"
        : devices.length === 0
          ? "empty"
          : "ready";
  const set = (patch: Partial<RegistryFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));

  const filterControls = (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Select
        value={outletId ?? ""}
        onValueChange={(v) => set({ outletId: v })}
      >
        <SelectTrigger
          className="h-control-sm sm:w-44"
          aria-label={t("deviceRegistry.filters.outlet")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {outletName(o.id)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filters.type} onValueChange={(v) => set({ type: v })}>
        <SelectTrigger
          className="h-control-sm sm:w-40"
          aria-label={t("deviceRegistry.filters.type")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>
            {t("deviceRegistry.filters.allTypes")}
          </SelectItem>
          {DEVICE_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {t(DEVICE_TYPE_LABEL[type])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filters.status} onValueChange={(v) => set({ status: v })}>
        <SelectTrigger
          className="h-control-sm sm:w-36"
          aria-label={t("deviceRegistry.filters.status")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>
            {t("deviceRegistry.filters.allStatuses")}
          </SelectItem>
          <SelectItem value="active">
            {t("deviceRegistry.status.active")}
          </SelectItem>
          <SelectItem value="revoked">
            {t("deviceRegistry.status.revoked")}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );

  const statusBadge = (d: Device) => (
    <Badge tone={d.status === "revoked" ? "danger" : "neutral"}>
      {t(`deviceRegistry.status.${d.status}`)}
    </Badge>
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="min-w-0 text-sm leading-5 text-muted-foreground">
          {t("deviceRegistry.subtitle")}
        </p>
        {(API_MOCK || canManage) && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            {API_MOCK && (
              <Badge tone="info">{t("deviceRegistry.sampleData")}</Badge>
            )}
            {canManage && (
              <Button disabled={!online} onClick={() => setEnrollOpen(true)}>
                <Plus aria-hidden="true" />
                {t("deviceRegistry.enroll.action")}
              </Button>
            )}
          </div>
        )}
      </div>

      {!online && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-container border-(length:--border-w) bg-warning-subtle p-card text-warning"
        >
          <WifiOff className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="grid gap-0.5">
            <p className="text-sm font-semibold">
              {t("deviceRegistry.offline.title")}
            </p>
            <p className="text-sm">{t("deviceRegistry.offline.hint")}</p>
          </div>
        </div>
      )}

      {state === "ready" && counts && (
        <StatStrip label={t("deviceRegistry.summary.label")} columns={4}>
          <StatTile
            label={t("deviceRegistry.summary.total")}
            value={counts.total}
          />
          <StatTile
            label={t("deviceRegistry.summary.online")}
            value={counts.online}
          />
          <StatTile
            label={t("deviceRegistry.summary.attention")}
            value={counts.attention}
            context={t("deviceRegistry.summary.attentionContext")}
          />
          <StatTile
            label={t("deviceRegistry.summary.revoked")}
            value={counts.revoked}
          />
        </StatStrip>
      )}

      <DataTableShell
        title={t("deviceRegistry.tableTitle")}
        description={t("deviceRegistry.tableHint")}
        state={state}
        search={{
          value: filters.search,
          onChange: (search) => set({ search }),
          label: t("deviceRegistry.filters.search"),
        }}
        actions={filterControls}
        onRetry={() => void query.refetch()}
        error={query.error}
        empty={{
          title: t("deviceRegistry.empty.title"),
          description: t("deviceRegistry.empty.hint"),
        }}
        noResults={state === "ready" && rows.length === 0}
        rowCount={state === "ready" ? rows.length : undefined}
      >
        {query.data?.meta.nextCursor && (
          <p className="border-b px-card py-2 text-sm text-muted-foreground">
            {t("deviceRegistry.filters.truncated", { count: devices.length })}
          </p>
        )}

        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("deviceRegistry.columns.type")}</TableHead>
                <TableHead>{t("deviceRegistry.columns.name")}</TableHead>
                <TableHead>{t("deviceRegistry.columns.outlet")}</TableHead>
                <TableHead>{t("deviceRegistry.columns.heartbeat")}</TableHead>
                <TableHead>{t("deviceRegistry.columns.version")}</TableHead>
                <TableHead>{t("deviceRegistry.columns.status")}</TableHead>
                <TableHead>{t("deviceRegistry.columns.training")}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">
                    {t("deviceRegistry.columns.actions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => (
                <TableRow key={d.id} data-device-id={d.id}>
                  <TableCell>{t(DEVICE_TYPE_LABEL[d.type])}</TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setOpenId(d.id)}
                      className="min-h-11 text-left font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {d.label}
                    </button>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {outletName(d.outletId)}
                  </TableCell>
                  <TableCell>
                    <HeartbeatCell device={d} nowMs={nowMs} />
                  </TableCell>
                  <TableCell className="tabular">{d.version}</TableCell>
                  <TableCell>{statusBadge(d)}</TableCell>
                  <TableCell>
                    <Badge tone={d.trainingMode ? "warning" : "neutral"}>
                      {d.trainingMode
                        ? t("deviceRegistry.training.on")
                        : t("deviceRegistry.training.off")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("deviceRegistry.detail.open", {
                        name: d.label,
                      })}
                      onClick={() => setOpenId(d.id)}
                    >
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className="grid gap-2 p-card md:hidden">
          {rows.map((d) => (
            <li
              key={d.id}
              data-device-id={d.id}
              className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => setOpenId(d.id)}
                    className="min-h-11 text-left font-semibold break-words hover:underline"
                  >
                    {d.label}
                  </button>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <MonitorSmartphone
                      className="size-3.5"
                      aria-hidden="true"
                    />
                    {t(DEVICE_TYPE_LABEL[d.type])} · {outletName(d.outletId)}
                  </p>
                </div>
                {statusBadge(d)}
              </div>
              <HeartbeatCell device={d} nowMs={nowMs} />
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground tabular">
                  {t("deviceRegistry.detail.version")} {d.version}
                </span>
                <TrainingSwitch
                  device={d}
                  canManage={canManage}
                  online={online}
                />
              </div>
            </li>
          ))}
        </ul>
      </DataTableShell>

      <DeviceDrawer
        device={opened}
        outletName={opened ? outletName(opened.outletId) : ""}
        nowMs={nowMs}
        canManage={canManage}
        canRevoke={canRevoke}
        online={online}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
        onRevoke={(d) => setRevokeId(d.id)}
        onReissue={(d) => setReissueId(d.id)}
      />
      <EnrollDialog
        open={enrollOpen}
        outlets={outlets}
        defaultOutletId={outletId}
        onOpenChange={setEnrollOpen}
        onEnrolled={setIssued}
      />
      <ReissueTokenDialog
        device={reissueTarget}
        onOpenChange={(open) => {
          if (!open) setReissueId(null);
        }}
        onIssued={setIssued}
      />
      <DeviceTokenDialog issued={issued} onClose={() => setIssued(null)} />
      <RevokeDialog
        device={revokeTarget}
        open={revokeTarget !== null}
        onRevoked={() => setOpenId(null)}
        onOpenChange={(open) => {
          if (!open) setRevokeId(null);
        }}
      />
    </div>
  );
}
