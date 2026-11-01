// Availability per outlet item (PRD §8 "Ketersediaan"): publish schedule,
// daily limit, and the 86 toggle that broadcasts to every sales channel.
import * as React from "react";
import { CircleCheck, CircleSlash, Settings2 } from "lucide-react";
import type { Availability } from "@starter/shared/menu";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useToast } from "@/components/ui/toast";
import {
  useAvailability,
  useItems,
  useSetAvailabilityStatus,
  useStations,
  useUpdateAvailability,
} from "../hooks";
import { describeSchedule } from "../lib";
import { ConfirmDialog } from "./confirm-dialog";
import { AvailabilityBadge } from "./status-badge";

const ALL = "all";
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function AvailabilityActions({
  row,
  pending,
  onToggle,
  onManage,
}: {
  row: Availability;
  pending: boolean;
  onToggle: () => void;
  onManage: () => void;
}) {
  const t = useT();
  return (
    <div className="flex justify-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={
          row.status === "sold_out"
            ? t("menu.availability.restore")
            : t("menu.availability.sellOut")
        }
        disabled={pending}
        onClick={onToggle}
      >
        {row.status === "sold_out" ? (
          <CircleCheck aria-hidden="true" />
        ) : (
          <CircleSlash aria-hidden="true" />
        )}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("menu.availability.manage")}
        onClick={onManage}
      >
        <Settings2 aria-hidden="true" />
      </Button>
    </div>
  );
}

export function AvailabilityPage() {
  const t = useT();
  const toast = useToast();
  const availabilityQuery = useAvailability({ limit: 100 });
  const itemsQuery = useItems({ limit: 100 });
  const stationsQuery = useStations({ limit: 100 });
  const updateAvailability = useUpdateAvailability();
  const toggleAvailability = useSetAvailabilityStatus();

  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState(ALL);
  const [editing, setEditing] = React.useState<Availability | null>(null);
  const [toggleTarget, setToggleTarget] = React.useState<Availability | null>(
    null,
  );

  const items = React.useMemo(
    () => itemsQuery.data?.data ?? [],
    [itemsQuery.data],
  );
  const itemsById = React.useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  const stations = stationsQuery.data?.data ?? [];

  const rows = (availabilityQuery.data?.data ?? []).filter((row) => {
    const item = itemsById.get(row.menuItemId);
    if (!item) return false;
    if (status !== ALL && row.status !== status) return false;
    return item.name
      .toLocaleLowerCase("id-ID")
      .includes(search.trim().toLocaleLowerCase("id-ID"));
  });

  const dayLabels = Object.fromEntries(
    WEEK.map((day) => [day, t(`menu.availability.days.${DAY_KEYS[day]}`)]),
  );

  function applyToggle() {
    if (!toggleTarget) return;
    const item = itemsById.get(toggleTarget.menuItemId);
    toggleAvailability.mutate(
      {
        availabilityId: toggleTarget.id,
        body: {
          action: toggleTarget.status === "sold_out" ? "restore" : "sell_out",
          idempotencyKey: crypto.randomUUID(),
        },
      },
      {
        onSuccess: () => {
          toast({
            title:
              toggleTarget.status === "sold_out"
                ? t("menu.availability.restoredToast", {
                    name: item?.name ?? "",
                  })
                : t("menu.availability.soldOutToast", {
                    name: item?.name ?? "",
                  }),
            tone: "success",
          });
          setToggleTarget(null);
        },
        onError: () =>
          toast({ title: t("menu.errors.saveFailed"), tone: "danger" }),
      },
    );
  }

  const pending =
    availabilityQuery.isPending ||
    itemsQuery.isPending ||
    stationsQuery.isPending;
  const failed =
    availabilityQuery.isError || itemsQuery.isError || stationsQuery.isError;

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger
            className="h-control-sm w-full sm:w-48"
            aria-label={t("menu.availability.columns.status")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {t("menu.availability.allStatuses")}
            </SelectItem>
            <SelectItem value="available">
              {t("menu.availability.status.available")}
            </SelectItem>
            <SelectItem value="sold_out">
              {t("menu.availability.status.sold_out")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTableShell
        title={t("menu.availability.title")}
        description={t("menu.availability.description")}
        state={
          pending
            ? "loading"
            : failed
              ? "error"
              : rows.length === 0
                ? "empty"
                : "ready"
        }
        search={{
          value: search,
          onChange: setSearch,
          label: t("menu.availability.searchPlaceholder"),
        }}
        onRetry={() => {
          void availabilityQuery.refetch();
          void itemsQuery.refetch();
          void stationsQuery.refetch();
        }}
        empty={{
          title: t("menu.availability.emptyTitle"),
          description: t("menu.availability.emptyHint"),
        }}
        noResults={
          rows.length === 0 && (availabilityQuery.data?.data.length ?? 0) > 0
        }
        rowCount={rows.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("menu.availability.columns.item")}</TableHead>
                <TableHead className="hidden md:table-cell">
                  {t("menu.availability.columns.station")}
                </TableHead>
                <TableHead className="hidden lg:table-cell">
                  {t("menu.availability.columns.schedule")}
                </TableHead>
                <TableHead numeric className="hidden sm:table-cell">
                  {t("menu.availability.columns.dailyLimit")}
                </TableHead>
                <TableHead>{t("menu.availability.columns.status")}</TableHead>
                <TableHead numeric>
                  {t("menu.availability.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const item = itemsById.get(row.menuItemId);
                const station = stations.find(
                  (entry) => entry.id === item?.stationId,
                );
                return (
                  <TableRow key={row.id}>
                    <TableCell className="min-w-48 font-medium">
                      {item?.name ?? ""}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">
                      {station?.name ?? t("menu.list.noStation")}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                      {describeSchedule(row.schedule, {
                        noSchedule: t("menu.availability.noSchedule"),
                        everyDay: t("menu.availability.everyDay"),
                        days: dayLabels,
                      })}
                    </TableCell>
                    <TableCell numeric className="hidden sm:table-cell">
                      {row.dailyLimit === null
                        ? t("menu.availability.noLimit")
                        : t("menu.availability.dailyLimitValue", {
                            count: row.dailyLimit,
                          })}
                    </TableCell>
                    <TableCell>
                      <AvailabilityBadge status={row.status} />
                    </TableCell>
                    <TableCell numeric>
                      <AvailabilityActions
                        row={row}
                        pending={toggleAvailability.isPending}
                        onToggle={() => setToggleTarget(row)}
                        onManage={() => setEditing(row)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {rows.map((row) => {
            const item = itemsById.get(row.menuItemId);
            const station = stations.find(
              (entry) => entry.id === item?.stationId,
            );
            return (
              <li
                key={row.id}
                className="grid gap-2 border-b px-card py-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-medium">{item?.name ?? ""}</span>
                    <span className="text-sm text-muted-foreground">
                      {station?.name ?? t("menu.list.noStation")} ·{" "}
                      {describeSchedule(row.schedule, {
                        noSchedule: t("menu.availability.noSchedule"),
                        everyDay: t("menu.availability.everyDay"),
                        days: dayLabels,
                      })}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {row.dailyLimit === null
                        ? t("menu.availability.noLimit")
                        : t("menu.availability.dailyLimitValue", {
                            count: row.dailyLimit,
                          })}
                    </span>
                  </div>
                  <AvailabilityBadge status={row.status} />
                </div>
                <AvailabilityActions
                  row={row}
                  pending={toggleAvailability.isPending}
                  onToggle={() => setToggleTarget(row)}
                  onManage={() => setEditing(row)}
                />
              </li>
            );
          })}
        </ul>
      </DataTableShell>

      {editing && (
        <AvailabilitySettings
          availability={editing}
          name={itemsById.get(editing.menuItemId)?.name ?? ""}
          onClose={() => setEditing(null)}
          onSave={(body) =>
            updateAvailability.mutate(
              { availabilityId: editing.id, body },
              {
                onSuccess: () => {
                  toast({
                    title: t("menu.availability.savedToast"),
                    tone: "success",
                  });
                  setEditing(null);
                },
                onError: () =>
                  toast({
                    title: t("menu.errors.saveFailed"),
                    tone: "danger",
                  }),
              },
            )
          }
          pending={updateAvailability.isPending}
        />
      )}

      <ConfirmDialog
        open={toggleTarget !== null}
        onOpenChange={(open) => !open && setToggleTarget(null)}
        title={
          toggleTarget?.status === "sold_out"
            ? t("menu.availability.confirmRestoreTitle", {
                name: itemsById.get(toggleTarget?.menuItemId ?? "")?.name ?? "",
              })
            : t("menu.availability.confirmSellOutTitle", {
                name: itemsById.get(toggleTarget?.menuItemId ?? "")?.name ?? "",
              })
        }
        description={
          toggleTarget?.status === "sold_out"
            ? t("menu.availability.confirmRestoreBody")
            : t("menu.availability.confirmSellOutBody")
        }
        confirmLabel={
          toggleTarget?.status === "sold_out"
            ? t("menu.availability.confirmRestore")
            : t("menu.availability.confirmSellOut")
        }
        destructive={toggleTarget?.status !== "sold_out"}
        pending={toggleAvailability.isPending}
        onConfirm={applyToggle}
      />
    </>
  );
}

type SettingsBody = {
  schedule: { daysOfWeek: number[]; start: string; end: string }[];
  dailyLimit: number | null;
};

function AvailabilitySettings({
  availability,
  name,
  pending,
  onClose,
  onSave,
}: {
  availability: Availability;
  name: string;
  pending: boolean;
  onClose: () => void;
  onSave: (body: SettingsBody) => void;
}) {
  const t = useT();
  const existing = availability.schedule[0];
  const [days, setDays] = React.useState<number[]>(existing?.daysOfWeek ?? []);
  const [start, setStart] = React.useState(existing?.start ?? "08:00");
  const [end, setEnd] = React.useState(existing?.end ?? "11:00");
  const [dailyLimit, setDailyLimit] = React.useState(
    availability.dailyLimit === null ? "" : String(availability.dailyLimit),
  );
  const [error, setError] = React.useState<string | undefined>();

  function submit() {
    if (days.length > 0 && end <= start) {
      setError(t("menu.availability.timeInvalid"));
      return;
    }
    const limit =
      dailyLimit.trim() === "" ? null : Number.parseInt(dailyLimit, 10);
    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
      setError(t("menu.errors.invalidAmount"));
      return;
    }
    setError(undefined);
    onSave({
      schedule:
        days.length === 0
          ? []
          : [
              {
                daysOfWeek: [...days].sort((a, b) => a - b),
                start,
                end,
              },
            ],
      dailyLimit: limit,
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("menu.availability.settingsTitle", { name })}
          </DialogTitle>
          <DialogDescription>
            {t("menu.availability.description")}
          </DialogDescription>
        </DialogHeader>

        <fieldset className="grid gap-2">
          <legend className="text-sm font-semibold">
            {t("menu.availability.daysLabel")}
          </legend>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("menu.availability.scheduleHint")}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {WEEK.map((day) => {
              const id = `availability-day-${day}`;
              return (
                <span key={day} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={days.includes(day)}
                    onCheckedChange={() =>
                      setDays((current) =>
                        current.includes(day)
                          ? current.filter((value) => value !== day)
                          : [...current, day],
                      )
                    }
                  />
                  <Label htmlFor={id} className="font-normal">
                    {t(`menu.availability.days.${DAY_KEYS[day]}`)}
                  </Label>
                </span>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={t("menu.availability.startTime")} required>
            <Input
              type="time"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              disabled={days.length === 0}
            />
          </FormField>
          <FormField
            label={t("menu.availability.endTime")}
            error={error}
            required
          >
            <Input
              type="time"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              disabled={days.length === 0}
            />
          </FormField>
        </div>

        <FormField
          label={t("menu.availability.dailyLimit")}
          hint={t("menu.availability.dailyLimitHint")}
        >
          <Input
            type="number"
            min={0}
            step={1}
            value={dailyLimit}
            onChange={(event) => setDailyLimit(event.target.value)}
          />
        </FormField>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="button" loading={pending} onClick={submit}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
