// /operasional/peralatan — equipment registry (PRD v1.7 §3 F41 "Peralatan &
// Perawatan"; acceptance OPS-04). Ops density ("Kontras"): the "Perlu
// tindakan" strip comes first, then one StatStrip, the linked-menu view, and
// the registry table. Every state the gate asks for: loading, empty, error +
// retry, offline.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { CalendarClock, WifiOff, Wrench } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTenantContext } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import { ActionRow, ActionStrip } from "./action-strip.tsx";
import { EquipmentFormDialog } from "./equipment-form-dialog.tsx";
import { EquipmentStatusPill } from "./pills.tsx";
import { ScheduleFormDialog } from "./schedule-form-dialog.tsx";
import { TicketFormDialog } from "./ticket-form-dialog.tsx";
import {
  useEquipmentList,
  useMenuItems,
  useSchedules,
  useServiceVendors,
  useTickets,
} from "../hooks.ts";
import {
  EQUIPMENT_CATEGORY_KEYS,
  SERVICE_DUE_WINDOW_DAYS,
  daysUntil,
  dueSchedules,
  formatDate,
  lastResolvedTicket,
  monthlyServiceCostIdr,
  nextSchedule,
} from "../lib.ts";

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh registry, so
 * the search text of the previous outlet cannot filter this one's rows.
 */
export function EquipmentRegistryScreen() {
  const { outlet } = useTenantContext();
  return <EquipmentRegistryContent key={outlet?.id ?? "none"} />;
}

function EquipmentRegistryContent() {
  const t = useT();
  const online = useOnline();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();
  const equipment = useEquipmentList(outlet?.id);
  const schedules = useSchedules(outlet?.id);
  const tickets = useTickets(outlet?.id);
  const menu = useMenuItems();
  const vendors = useServiceVendors();
  const [query, setQuery] = React.useState("");
  // A render-scoped clock keeps SSR and the browser render on the same day.
  const [now] = React.useState(() => new Date());

  const loading =
    outlet !== null &&
    (equipment.isPending || schedules.isPending || tickets.isPending);
  const failed = equipment.isError || schedules.isError || tickets.isError;

  const rows = equipment.data?.data ?? [];
  const scheduleRows = schedules.data?.data ?? [];
  const ticketRows = tickets.data?.data ?? [];
  const menuItems = menu.data?.data ?? [];
  const vendorRows = vendors.data?.data ?? [];
  const timeZone = outlet?.timeZone ?? "Asia/Jakarta";
  const menuName = new Map(menuItems.map((item) => [item.id, item.name]));
  const vendorName = new Map(vendorRows.map((row) => [row.id, row.name]));

  const down = rows.filter((row) => row.status === "broken");
  const due = dueSchedules(scheduleRows, now, timeZone);
  const monthlyCost = monthlyServiceCostIdr(ticketRows, now, timeZone);
  const needle = query.trim().toLocaleLowerCase("id-ID");
  const visible = rows.filter((row) => {
    if (!needle) return true;
    const category = t(EQUIPMENT_CATEGORY_KEYS[row.category]);
    return (
      row.name.toLocaleLowerCase("id-ID").includes(needle) ||
      category.toLocaleLowerCase("id-ID").includes(needle)
    );
  });

  const heading = (
    <header className="grid gap-1">
      <h1 className="type-display">{t("opsEquipment.equipment.pageTitle")}</h1>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("opsEquipment.equipment.pageHint")}
      </p>
      {outlet && (
        <p className="text-sm font-semibold">
          {t("opsEquipment.equipment.statsContext", { name: outlet.name })}
        </p>
      )}
    </header>
  );

  if (!outlet)
    return (
      <div className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] gap-4">
        {heading}
        <EmptyState
          title={t("state.emptyTitle")}
          description={t("state.emptyHint")}
        />
      </div>
    );

  if (loading)
    return (
      <div
        className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] gap-4"
        aria-busy="true"
      >
        <span className="sr-only" role="status">
          {t("common.loading")}
        </span>
        {heading}
        <Skeleton className="h-32 w-full rounded-shell" />
        <Skeleton className="h-24 w-full rounded-shell" />
        <Skeleton className="h-80 w-full rounded-shell" />
      </div>
    );

  if (failed)
    return (
      <div className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] gap-4">
        {heading}
        <ErrorState
          error={equipment.error ?? schedules.error ?? tickets.error}
          title={t("state.errorTitle")}
          description={t("state.errorHint")}
          onRetry={() => {
            void equipment.refetch();
            void schedules.refetch();
            void tickets.refetch();
            void menu.refetch();
            void vendors.refetch();
          }}
        />
      </div>
    );

  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-[minmax(0,1fr)] gap-4">
      {heading}

      {!online && (
        <div className="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm text-foreground">
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold">
              {t("opsEquipment.offline.title")}
            </span>{" "}
            {t("opsEquipment.offline.hint")}
          </span>
        </div>
      )}

      <ActionStrip label={t("opsEquipment.equipment.actionsLabel")}>
        {down.length > 0 && (
          <ActionRow
            title={t("opsEquipment.equipment.downTitle")}
            hint={t("opsEquipment.equipment.downHint")}
            pill={
              <StatusPill status="danger" solid>
                {down.length}
              </StatusPill>
            }
          >
            <ul className="grid gap-1">
              {down.map((row) => (
                <li key={row.id}>
                  <Link
                    to="/operasional/peralatan/$equipmentId"
                    params={{ equipmentId: row.id }}
                    className="text-sm font-semibold underline-offset-4 hover:underline"
                  >
                    {t("opsEquipment.equipment.downItem", {
                      name: row.name,
                      category: t(EQUIPMENT_CATEGORY_KEYS[row.category]),
                    })}
                  </Link>
                </li>
              ))}
            </ul>
          </ActionRow>
        )}
        {due.length > 0 && (
          <ActionRow
            title={t("opsEquipment.equipment.dueTitle")}
            hint={t("opsEquipment.equipment.dueHint", {
              days: SERVICE_DUE_WINDOW_DAYS,
            })}
            pill={<StatusPill status="warning">{due.length}</StatusPill>}
          >
            <ul className="grid gap-1">
              {due.map((schedule) => {
                const row = rows.find(
                  (item) => item.id === schedule.equipmentId,
                );
                return (
                  <li key={schedule.id}>
                    <Link
                      to="/operasional/peralatan/$equipmentId"
                      params={{ equipmentId: schedule.equipmentId }}
                      className="text-sm font-semibold underline-offset-4 hover:underline"
                    >
                      {t("opsEquipment.equipment.dueItem", {
                        name: row?.name ?? schedule.equipmentId,
                        date: formatDate(schedule.nextDueAt, timeZone),
                      })}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </ActionRow>
        )}
        {down.length === 0 && due.length === 0 && (
          <ActionRow
            title={t("opsEquipment.equipment.healthyTitle")}
            hint={t("opsEquipment.equipment.healthyHint")}
            pill={<StatusPill status="success">0</StatusPill>}
          />
        )}
      </ActionStrip>

      <StatStrip label={t("opsEquipment.equipment.summaryLabel")}>
        <StatTile
          label={t("opsEquipment.equipment.stats.total")}
          value={<NumberDisplay value={rows.length} />}
          context={outlet.name}
        />
        <StatTile
          label={t("opsEquipment.equipment.stats.due")}
          value={<NumberDisplay value={due.length} />}
          context={t("opsEquipment.equipment.dueHint", {
            days: SERVICE_DUE_WINDOW_DAYS,
          })}
        />
        <StatTile
          label={t("opsEquipment.equipment.stats.broken")}
          value={<NumberDisplay value={down.length} />}
          context={t("opsEquipment.equipment.downTitle")}
        />
        <StatTile
          label={t("opsEquipment.equipment.stats.monthCost")}
          value={<Money amount={monthlyCost} size="stat" />}
          context={outlet.name}
        />
      </StatStrip>

      <Card data-slot="disabled-menu-card">
        <div className="grid gap-1">
          <h2 className="type-title">
            {t("opsEquipment.equipment.menuDisabledTitle")}
          </h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("opsEquipment.equipment.menuDisabledHint")}
          </p>
        </div>
        {down.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("opsEquipment.equipment.menuDisabledEmpty")}
          </p>
        ) : menu.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            <span className="sr-only">{t("common.loading")}</span>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-64" />
          </div>
        ) : menu.isError ? (
          <p className="text-sm text-danger">
            {t("opsEquipment.equipment.menuUnavailable")}
          </p>
        ) : (
          <div className="grid gap-4">
            {down.map((row) => (
              <section
                key={row.id}
                data-slot="disabled-menu-group"
                aria-label={row.name}
                className="grid gap-2"
              >
                <h3 className="text-sm font-semibold">
                  {t("opsEquipment.equipment.menuDisabledFor", {
                    equipment: row.name,
                  })}
                </h3>
                {row.linkedMenuItemIds.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("opsEquipment.equipment.menuDisabledEmpty")}
                  </p>
                ) : (
                  <ul
                    data-slot="disabled-menu-list"
                    className="flex flex-wrap gap-2"
                  >
                    {row.linkedMenuItemIds.map((menuId) => (
                      <li
                        key={menuId}
                        data-slot="disabled-menu-item"
                        className="rounded-full bg-danger-subtle px-2.5 py-0.5 text-sm font-semibold text-danger"
                      >
                        {menuName.get(menuId) ??
                          t("opsEquipment.equipment.menuUnavailable")}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </Card>

      <DataTableShell
        title={t("opsEquipment.equipment.listTitle")}
        description={t("opsEquipment.equipment.listHint")}
        state={rows.length === 0 ? "empty" : "ready"}
        search={{
          value: query,
          onChange: setQuery,
          label: t("opsEquipment.equipment.searchPlaceholder"),
        }}
        actions={
          <div className="flex flex-wrap gap-2">
            <EquipmentFormDialog
              outletId={outlet.id}
              menuItems={menuItems}
              menuItemsLoading={menu.isPending}
              menuItemsFailed={menu.isError}
              trigger={
                <Button type="button">
                  <Wrench aria-hidden="true" />
                  {t("opsEquipment.equipment.add")}
                </Button>
              }
            />
            <ScheduleFormDialog
              outletId={outlet.id}
              timeZone={timeZone}
              equipmentOptions={rows}
              vendors={vendorRows}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  disabled={rows.length === 0}
                >
                  <CalendarClock aria-hidden="true" />
                  {t("opsEquipment.equipment.schedule")}
                </Button>
              }
            />
            <TicketFormDialog
              outletId={outlet.id}
              equipmentOptions={rows}
              vendors={vendorRows}
              menuItems={menuItems}
              menuItemsLoading={menu.isPending}
              menuItemsFailed={menu.isError}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  disabled={rows.length === 0}
                >
                  {t("opsEquipment.equipment.report")}
                </Button>
              }
            />
          </div>
        }
        empty={{
          title: t("opsEquipment.equipment.emptyTitle"),
          description: t("opsEquipment.equipment.emptyHint"),
        }}
        noResults={visible.length === 0 && query.trim().length > 0}
        rowCount={visible.length}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("opsEquipment.equipment.table.name")}</TableHead>
              <TableHead>
                {t("opsEquipment.equipment.table.category")}
              </TableHead>
              <TableHead>{t("opsEquipment.equipment.table.status")}</TableHead>
              <TableHead>
                {t("opsEquipment.equipment.table.nextService")}
              </TableHead>
              <TableHead>{t("opsEquipment.equipment.table.vendor")}</TableHead>
              <TableHead>
                {t("opsEquipment.equipment.table.lastService")}
              </TableHead>
              <TableHead>
                <span className="sr-only">
                  {t("opsEquipment.equipment.open")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => {
              const schedule = nextSchedule(scheduleRows, row.id);
              const last = lastResolvedTicket(ticketRows, row.id);
              const vendorId = schedule?.vendorId ?? last?.vendorId ?? null;
              const days = schedule
                ? daysUntil(schedule.nextDueAt, now, timeZone)
                : null;
              const timing = schedule
                ? days !== null && days < 0
                  ? t("opsEquipment.equipment.overdueDays", {
                      days: Math.abs(days),
                    })
                  : days !== null && days <= SERVICE_DUE_WINDOW_DAYS
                    ? t("opsEquipment.equipment.dueInDays", { days })
                    : ""
                : "";
              return (
                <TableRow
                  key={row.id}
                  data-equipment-id={row.id}
                  // DESIGN.md §5 (Q25): the urgent row keeps the solid pill
                  // company with a 2px status border and a 6px start rule.
                  className={
                    row.status === "broken"
                      ? "border-s-2 border-s-danger [&>*:first-child]:shadow-[inset_6px_0_0_var(--danger)]"
                      : undefined
                  }
                >
                  <TableCell className="font-semibold">
                    <Link
                      to="/operasional/peralatan/$equipmentId"
                      params={{ equipmentId: row.id }}
                      className="underline-offset-4 hover:underline"
                    >
                      {row.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {t(EQUIPMENT_CATEGORY_KEYS[row.category])}
                  </TableCell>
                  <TableCell>
                    <EquipmentStatusPill status={row.status} />
                  </TableCell>
                  <TableCell>
                    {schedule ? (
                      <span className="grid gap-0.5">
                        <span>{formatDate(schedule.nextDueAt, timeZone)}</span>
                        {timing && (
                          <span className="text-xs text-muted-foreground">
                            {timing}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("opsEquipment.equipment.noSchedule")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {vendorId ? (
                      (vendorName.get(vendorId) ??
                      t("opsEquipment.equipment.noVendor"))
                    ) : (
                      <span className="text-muted-foreground">
                        {t("opsEquipment.equipment.noVendor")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {last?.resolvedAt ? (
                      formatDate(last.resolvedAt, timeZone)
                    ) : (
                      <span className="text-muted-foreground">
                        {t("opsEquipment.equipment.neverServiced")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/operasional/peralatan/$equipmentId"
                      params={{ equipmentId: row.id }}
                      aria-label={`${t("opsEquipment.equipment.open")}: ${row.name}`}
                      className="font-semibold text-primary underline-offset-4 hover:underline"
                    >
                      {t("opsEquipment.equipment.open")}
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}
