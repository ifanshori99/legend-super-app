// /operasional/peralatan/$equipmentId — one equipment's status, specs, service
// history, cost history, and the typed transitions (PRD v1.7 §3 F41
// "Peralatan & Perawatan"; OPS-04). All state changes go through the
// contract's equipment/ticket machines; the screen only offers actions the
// machine accepts for the current status.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, CalendarClock, WifiOff, Wrench } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useOnline } from "@/lib/use-online";
import { newIdempotencyKey } from "@/lib/idempotency";
import { EquipmentFormDialog } from "./equipment-form-dialog.tsx";
import {
  EquipmentStatusPill,
  TicketStatusPill,
  UrgencyPill,
} from "./pills.tsx";
import { ScheduleFormDialog } from "./schedule-form-dialog.tsx";
import { TicketFormDialog } from "./ticket-form-dialog.tsx";
import {
  useEquipment,
  useEquipmentTransition,
  useMenuItems,
  useOutlets,
  useSchedules,
  useServiceVendors,
  useTickets,
  useTicketTransition,
} from "../hooks.ts";
import {
  EQUIPMENT_ACTION_KEYS,
  EQUIPMENT_CATEGORY_KEYS,
  TICKET_ACTION_KEYS,
  canRunEquipmentAction,
  canRunTicketAction,
  daysUntil,
  formatDate,
  formatDateTime,
  formatDecimalValue,
  serviceTiming,
} from "../lib.ts";
import {
  menuItemsDisabledByEquipment,
  type Equipment,
  type EquipmentAction,
  type MaintenanceTicket,
  type MaintenanceTicketAction,
  type MaintenanceUrgency,
} from "@starter/shared/operations";
import type { Supplier } from "@starter/shared/inventory";
import { ApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";

const URGENCY_RANK: Record<MaintenanceUrgency, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function isOpenTicket(ticket: MaintenanceTicket): boolean {
  return ticket.status === "reported" || ticket.status === "in_progress";
}

function isUrgentTicket(ticket: MaintenanceTicket): boolean {
  return ticket.urgency === "critical" && isOpenTicket(ticket);
}

const EQUIPMENT_ACTION_ORDER: EquipmentAction[] = [
  "report_breakdown",
  "start_maintenance",
  "complete_maintenance",
  "retire",
];

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="grid gap-1">
      <h2 className="type-title">{title}</h2>
      {hint && (
        <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function RetireDialog({ equipment }: { equipment: Equipment }) {
  const t = useT();
  const toast = useToast();
  const transition = useEquipmentTransition();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const key = React.useRef(newIdempotencyKey());

  async function retire() {
    setError(null);
    try {
      await transition.mutateAsync({
        equipmentId: equipment.id,
        body: { action: "retire", idempotencyKey: key.current },
      });
      key.current = newIdempotencyKey();
      toast({
        title: t("opsEquipment.equipment.toasts.transitioned"),
        tone: "success",
      });
      setOpen(false);
    } catch {
      setError(t("opsEquipment.equipment.detail.actionError"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          {t(EQUIPMENT_ACTION_KEYS.retire)}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("opsEquipment.equipment.detail.retireTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("opsEquipment.equipment.detail.retireHint")}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            loading={transition.isPending}
            onClick={() => void retire()}
          >
            {t("opsEquipment.equipment.detail.confirmRetire")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EquipmentTransitions({ equipment }: { equipment: Equipment }) {
  const t = useT();
  const toast = useToast();
  const transition = useEquipmentTransition();
  const [error, setError] = React.useState<string | null>(null);
  const key = React.useRef(newIdempotencyKey());
  const allowed = EQUIPMENT_ACTION_ORDER.filter((action) =>
    canRunEquipmentAction(equipment.status, action),
  );

  async function act(action: EquipmentAction) {
    setError(null);
    try {
      await transition.mutateAsync({
        equipmentId: equipment.id,
        body: { action, idempotencyKey: key.current },
      });
      key.current = newIdempotencyKey();
      toast({
        title: t("opsEquipment.equipment.toasts.transitioned"),
        tone: "success",
      });
    } catch {
      setError(t("opsEquipment.equipment.detail.actionError"));
    }
  }

  return (
    <Card>
      <SectionHeading
        title={t("opsEquipment.equipment.detail.transitionsTitle")}
        hint={t("opsEquipment.equipment.detail.transitionsHint")}
      />
      {allowed.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("opsEquipment.equipment.detail.retiredHint")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {allowed.map((action) =>
            action === "retire" ? (
              <RetireDialog key={action} equipment={equipment} />
            ) : (
              <Button
                key={action}
                type="button"
                variant="outline"
                disabled={transition.isPending}
                onClick={() => void act(action)}
              >
                {t(EQUIPMENT_ACTION_KEYS[action])}
              </Button>
            ),
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}

function ResolveTicketDialog({
  ticket,
  vendors,
  trigger,
}: {
  ticket: MaintenanceTicket;
  vendors: readonly Pick<Supplier, "id" | "name">[];
  trigger: React.ReactElement;
}) {
  const t = useT();
  const toast = useToast();
  const transition = useTicketTransition();
  const [open, setOpen] = React.useState(false);
  const [vendorId, setVendorId] = React.useState(ticket.vendorId ?? "none");
  const [cost, setCost] = React.useState(
    ticket.costIdr === null ? "" : String(ticket.costIdr),
  );
  const [error, setError] = React.useState<string | null>(null);
  const [key, setKey] = React.useState(() => newIdempotencyKey());

  async function resolve() {
    setError(null);
    const costIdr = cost.trim() ? Number(cost) : null;
    if (cost.trim() && (!Number.isSafeInteger(costIdr) || (costIdr ?? 0) < 0)) {
      setError(t("opsEquipment.equipment.ticketForm.invalid"));
      return;
    }
    try {
      await transition.mutateAsync({
        ticketId: ticket.id,
        body: {
          action: "resolve",
          vendorId: vendorId === "none" ? null : vendorId,
          costIdr,
          idempotencyKey: key,
        },
      });
      setKey(newIdempotencyKey());
      toast({
        title: t("opsEquipment.equipment.toasts.ticketResolved"),
        tone: "success",
      });
      setOpen(false);
    } catch {
      setError(t("opsEquipment.equipment.detail.actionError"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("opsEquipment.equipment.detail.resolveTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("opsEquipment.equipment.detail.resolveHint")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <FormField label={t("opsEquipment.equipment.detail.resolveVendor")}>
            <Select value={vendorId} onValueChange={setVendorId}>
              <SelectTrigger>
                <SelectValue
                  placeholder={t(
                    "opsEquipment.equipment.scheduleForm.chooseVendor",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="min-h-11">
                  {t("opsEquipment.equipment.scheduleForm.noVendor")}
                </SelectItem>
                {vendors.map((vendor) => (
                  <SelectItem
                    key={vendor.id}
                    value={vendor.id}
                    className="min-h-11"
                  >
                    {vendor.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label={t("opsEquipment.equipment.detail.resolveCost")}>
            <Input
              type="number"
              min="0"
              step="1"
              value={cost}
              onChange={(event) => setCost(event.target.value)}
            />
          </FormField>
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            loading={transition.isPending}
            onClick={() => void resolve()}
          >
            {t("opsEquipment.equipment.detail.confirmResolve")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelTicketDialog({
  ticket,
  trigger,
}: {
  ticket: MaintenanceTicket;
  trigger: React.ReactElement;
}) {
  const t = useT();
  const toast = useToast();
  const transition = useTicketTransition();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const key = React.useRef(newIdempotencyKey());

  async function cancel() {
    setError(null);
    try {
      await transition.mutateAsync({
        ticketId: ticket.id,
        body: { action: "cancel", idempotencyKey: key.current },
      });
      key.current = newIdempotencyKey();
      toast({
        title: t("opsEquipment.equipment.toasts.ticketCancelled"),
        tone: "success",
      });
      setOpen(false);
    } catch {
      setError(t("opsEquipment.equipment.detail.actionError"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("opsEquipment.equipment.detail.cancelTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("opsEquipment.equipment.detail.cancelHint")}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            loading={transition.isPending}
            onClick={() => void cancel()}
          >
            {t("opsEquipment.equipment.detail.confirmCancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TicketActions({
  ticket,
  vendors,
}: {
  ticket: MaintenanceTicket;
  vendors: readonly Pick<Supplier, "id" | "name">[];
}) {
  const t = useT();
  const toast = useToast();
  const transition = useTicketTransition();
  const [error, setError] = React.useState<string | null>(null);
  const key = React.useRef(newIdempotencyKey());

  async function start() {
    setError(null);
    try {
      await transition.mutateAsync({
        ticketId: ticket.id,
        body: { action: "start", idempotencyKey: key.current },
      });
      key.current = newIdempotencyKey();
      toast({
        title: t("opsEquipment.equipment.toasts.ticketTransitioned"),
        tone: "success",
      });
    } catch {
      setError(t("opsEquipment.equipment.detail.actionError"));
    }
  }

  const actions: MaintenanceTicketAction[] = (
    ["start", "resolve", "cancel"] as const
  ).filter((action) => canRunTicketAction(ticket.status, action));

  return (
    <div className="grid gap-2" data-slot="ticket-actions">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) =>
          action === "resolve" ? (
            <ResolveTicketDialog
              key={action}
              ticket={ticket}
              vendors={vendors}
              trigger={
                <Button type="button" variant="outline">
                  {t(TICKET_ACTION_KEYS[action])}
                </Button>
              }
            />
          ) : action === "cancel" ? (
            <CancelTicketDialog
              key={action}
              ticket={ticket}
              trigger={
                <Button type="button" variant="ghost">
                  {t(TICKET_ACTION_KEYS[action])}
                </Button>
              }
            />
          ) : (
            <Button
              key={action}
              type="button"
              variant="outline"
              disabled={transition.isPending}
              onClick={() => void start()}
            >
              {t(TICKET_ACTION_KEYS[action])}
            </Button>
          ),
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function EquipmentDetailScreen({
  equipmentId,
}: {
  equipmentId: string;
}) {
  const t = useT();
  const online = useOnline();
  const outlets = useOutlets();
  const outlet =
    outlets.data?.data.find((row) => row.status === "active") ??
    outlets.data?.data[0];
  const detail = useEquipment(equipmentId);
  const schedules = useSchedules(outlet?.id);
  const tickets = useTickets(outlet?.id);
  const menu = useMenuItems();
  const vendors = useServiceVendors();
  const [now] = React.useState(() => new Date());

  const outletId = outlet?.id ?? "";
  const timeZone = outlet?.timeZone ?? "Asia/Jakarta";
  const equipment = detail.data?.data;
  // Stable option array: a fresh array every render would re-run the dialogs'
  // reset effects while they are open.
  const equipmentOptions = React.useMemo(
    () => (equipment ? [equipment] : []),
    [equipment],
  );

  const loading =
    outlets.isPending ||
    (outlet !== undefined &&
      (detail.isPending || schedules.isPending || tickets.isPending));
  const detailError = detail.error;
  const notFound =
    detailError instanceof ApiError && detailError.status === 404;
  const failed =
    !notFound &&
    (outlets.isError || detail.isError || schedules.isError || tickets.isError);

  const heading = (
    <header className="grid gap-2">
      <Link
        to="/operasional/peralatan"
        className="inline-flex w-fit items-center gap-1 text-sm font-semibold text-primary underline-offset-4 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("opsEquipment.equipment.detail.back")}
      </Link>
      <h1 className="type-display">
        {equipment?.name ?? t("opsEquipment.equipment.pageTitle")}
      </h1>
    </header>
  );

  if (loading)
    return (
      <div
        className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-4"
        aria-busy="true"
      >
        <span className="sr-only" role="status">
          {t("common.loading")}
        </span>
        {heading}
        <Skeleton className="h-28 w-full rounded-shell" />
        <Skeleton className="h-56 w-full rounded-shell" />
        <Skeleton className="h-72 w-full rounded-shell" />
      </div>
    );

  if (failed || !outlet)
    return (
      <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-4">
        {heading}
        <ErrorState
          title={t("state.errorTitle")}
          description={t("state.errorHint")}
          onRetry={() => {
            void outlets.refetch();
            void detail.refetch();
            void schedules.refetch();
            void tickets.refetch();
            void menu.refetch();
            void vendors.refetch();
          }}
        />
      </div>
    );

  if (!equipment)
    return (
      <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-4">
        {heading}
        <EmptyState
          title={t("opsEquipment.equipment.detail.notFoundTitle")}
          description={t("opsEquipment.equipment.detail.notFoundHint")}
        />
      </div>
    );

  const scheduleRows = (schedules.data?.data ?? []).filter(
    (schedule) => schedule.equipmentId === equipment.id,
  );
  // Open tickets first (most urgent on top), then the history newest first.
  const ticketRows = (tickets.data?.data ?? [])
    .filter((ticket) => ticket.equipmentId === equipment.id)
    .sort(
      (left, right) =>
        Number(isOpenTicket(right)) - Number(isOpenTicket(left)) ||
        URGENCY_RANK[right.urgency] - URGENCY_RANK[left.urgency] ||
        Date.parse(right.reportedAt) - Date.parse(left.reportedAt),
    );
  const vendorRows = vendors.data?.data ?? [];
  const vendorName = new Map(vendorRows.map((row) => [row.id, row.name]));
  const menuItems = menu.data?.data ?? [];
  const menuName = new Map(menuItems.map((item) => [item.id, item.name]));
  const disabledMenuIds = new Set(menuItemsDisabledByEquipment(equipment));
  const costRows = ticketRows
    .filter((ticket) => ticket.status === "resolved" && ticket.costIdr !== null)
    .sort(
      (left, right) =>
        Date.parse(right.resolvedAt ?? "") - Date.parse(left.resolvedAt ?? ""),
    );
  const costTotal = costRows.reduce(
    (total, ticket) => total + (ticket.costIdr ?? 0),
    0,
  );

  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-4">
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

      <Card data-slot="equipment-header">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <EquipmentStatusPill status={equipment.status} />
              <Badge tone="neutral">
                {t(EQUIPMENT_CATEGORY_KEYS[equipment.category])}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("opsEquipment.equipment.detail.updatedAt", {
                date: formatDateTime(equipment.updatedAt, timeZone),
              })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <EquipmentFormDialog
              outletId={outletId}
              menuItems={menuItems}
              menuItemsLoading={menu.isPending}
              menuItemsFailed={menu.isError}
              equipment={equipment}
              trigger={
                <Button type="button" variant="outline">
                  <Wrench aria-hidden="true" />
                  {t("opsEquipment.equipment.edit")}
                </Button>
              }
            />
            <ScheduleFormDialog
              outletId={outletId}
              timeZone={timeZone}
              equipmentOptions={equipmentOptions}
              vendors={vendorRows}
              defaultEquipmentId={equipment.id}
              trigger={
                <Button type="button" variant="outline">
                  <CalendarClock aria-hidden="true" />
                  {t("opsEquipment.equipment.detail.addSchedule")}
                </Button>
              }
            />
            <TicketFormDialog
              outletId={outletId}
              equipmentOptions={equipmentOptions}
              vendors={vendorRows}
              menuItems={menuItems}
              menuItemsLoading={menu.isPending}
              menuItemsFailed={menu.isError}
              defaultEquipmentId={equipment.id}
              trigger={
                <Button type="button">
                  {t("opsEquipment.equipment.detail.addTicket")}
                </Button>
              }
            />
          </div>
        </div>
      </Card>

      {equipment.status === "broken" && (
        <Card
          data-slot="equipment-broken"
          className="border-(length:--border-w) border-danger bg-danger-subtle"
        >
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">
              {t("opsEquipment.equipment.menuDisabledHint")}
            </p>
          </div>
          {disabledMenuIds.size === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("opsEquipment.equipment.menuDisabledEmpty")}
            </p>
          ) : (
            <ul data-slot="disabled-menu-list" className="flex flex-wrap gap-2">
              {[...disabledMenuIds].map((menuId) => (
                <li
                  key={menuId}
                  data-slot="disabled-menu-item"
                  className="rounded-full bg-card px-2.5 py-0.5 text-sm font-semibold text-danger"
                >
                  {menuName.get(menuId) ??
                    t("opsEquipment.equipment.menuUnavailable")}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionHeading
            title={t("opsEquipment.equipment.detail.specsTitle")}
          />
          <dl className="grid gap-3">
            <div className="grid gap-0.5">
              <dt className="text-sm font-semibold text-muted-foreground">
                {t("opsEquipment.equipment.table.category")}
              </dt>
              <dd>{t(EQUIPMENT_CATEGORY_KEYS[equipment.category])}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-sm font-semibold text-muted-foreground">
                {t("opsEquipment.equipment.form.temperature")}
              </dt>
              <dd>
                {equipment.temperatureThreshold
                  ? t("opsEquipment.equipment.detail.temperature", {
                      min: formatDecimalValue(
                        equipment.temperatureThreshold.minCelsius,
                      ),
                      max: formatDecimalValue(
                        equipment.temperatureThreshold.maxCelsius,
                      ),
                    })
                  : t("opsEquipment.equipment.detail.temperatureNone")}
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-sm font-semibold text-muted-foreground">
                {t("opsEquipment.equipment.detail.linkedMenus")}
              </dt>
              <dd>
                {equipment.linkedMenuItemIds.length === 0 ? (
                  <span className="text-sm text-muted-foreground">
                    {t("opsEquipment.equipment.detail.linkedMenusNone")}
                  </span>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {equipment.linkedMenuItemIds.map((menuId) => (
                      <li key={menuId}>
                        <Badge
                          tone={
                            disabledMenuIds.has(menuId) ? "danger" : "neutral"
                          }
                        >
                          {menuName.get(menuId) ??
                            t("opsEquipment.equipment.menuUnavailable")}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          </dl>
        </Card>

        <EquipmentTransitions equipment={equipment} />
      </div>

      <Card data-slot="service-schedules">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SectionHeading
            title={t("opsEquipment.equipment.detail.schedulesTitle")}
          />
          <ScheduleFormDialog
            outletId={outletId}
            timeZone={timeZone}
            equipmentOptions={equipmentOptions}
            vendors={vendorRows}
            defaultEquipmentId={equipment.id}
            trigger={
              <Button type="button" variant="outline">
                {t("opsEquipment.equipment.detail.addSchedule")}
              </Button>
            }
          />
        </div>
        {scheduleRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("opsEquipment.equipment.detail.schedulesEmpty")}
          </p>
        ) : (
          <ul className="grid gap-3">
            {scheduleRows.map((schedule) => {
              const timing = serviceTiming(schedule, now, timeZone);
              const days = daysUntil(schedule.nextDueAt, now, timeZone);
              return (
                <li
                  key={schedule.id}
                  className="grid gap-1 rounded-container border border-border p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">
                      {t("opsEquipment.equipment.detail.scheduleInterval", {
                        days: schedule.intervalDays,
                      })}
                    </span>
                    {timing === "overdue" ? (
                      <StatusPill status="danger" solid>
                        {t("opsEquipment.equipment.detail.scheduleOverdue")}
                      </StatusPill>
                    ) : timing === "due_soon" ? (
                      <StatusPill status="warning">
                        {t("opsEquipment.equipment.detail.scheduleDueSoon")}
                      </StatusPill>
                    ) : (
                      <Badge tone="neutral">
                        {t("opsEquipment.equipment.dueInDays", {
                          days: Math.max(days, 0),
                        })}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t("opsEquipment.equipment.detail.scheduleDue", {
                      date: formatDate(schedule.nextDueAt, timeZone),
                    })}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {schedule.vendorId
                      ? (vendorName.get(schedule.vendorId) ??
                        t("opsEquipment.equipment.noVendor"))
                      : t("opsEquipment.equipment.noVendor")}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card data-slot="maintenance-tickets">
        <SectionHeading
          title={t("opsEquipment.equipment.detail.ticketsTitle")}
          hint={t("opsEquipment.equipment.detail.ticketsHint")}
        />
        {ticketRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("opsEquipment.equipment.detail.ticketsEmpty")}
          </p>
        ) : (
          <ul className="grid gap-3">
            {ticketRows.map((ticket) => (
              <li
                key={ticket.id}
                data-slot="maintenance-ticket"
                data-urgent={isUrgentTicket(ticket) || undefined}
                // DESIGN.md §5 (Q25): an open critical ticket is urgent — solid
                // pill + 2px status border + 6px start rule.
                className={cn(
                  "grid gap-2 rounded-container border border-border p-3",
                  isUrgentTicket(ticket) &&
                    "border-2 border-danger border-s-[6px]",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <UrgencyPill urgency={ticket.urgency} />
                  <TicketStatusPill status={ticket.status} />
                </div>
                <p className="font-semibold">{ticket.description}</p>
                <p className="text-sm text-muted-foreground">
                  {t("opsEquipment.equipment.detail.ticketReported", {
                    date: formatDateTime(ticket.reportedAt, timeZone),
                  })}
                  {ticket.resolvedAt
                    ? ` · ${t("opsEquipment.equipment.detail.ticketResolved", {
                        date: formatDateTime(ticket.resolvedAt, timeZone),
                      })}`
                    : ""}
                </p>
                <p className="text-sm text-muted-foreground">
                  {ticket.vendorId
                    ? (vendorName.get(ticket.vendorId) ??
                      t("opsEquipment.equipment.noVendor"))
                    : t("opsEquipment.equipment.noVendor")}
                  {" · "}
                  {ticket.costIdr === null ? (
                    t("opsEquipment.equipment.noCost")
                  ) : (
                    <Money amount={ticket.costIdr} />
                  )}
                </p>
                <TicketActions ticket={ticket} vendors={vendorRows} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card data-slot="cost-history">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionHeading
            title={t("opsEquipment.equipment.detail.costHistoryTitle")}
          />
          <p className="text-sm font-semibold">
            {t("opsEquipment.equipment.detail.costHistoryTotal")}:{" "}
            <Money amount={costTotal} />
          </p>
        </div>
        {costRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("opsEquipment.equipment.detail.costHistoryEmpty")}
          </p>
        ) : (
          <ul className="grid gap-2">
            {costRows.map((ticket) => (
              <li
                key={ticket.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 last:border-0"
              >
                <span className="text-sm">
                  {t("opsEquipment.equipment.detail.costHistoryLine", {
                    description: ticket.description,
                    date: formatDate(ticket.resolvedAt, timeZone),
                  })}
                </span>
                <Money amount={ticket.costIdr ?? 0} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
