// Production stations and their target times (PRD §8 "Routing Stasiun").
// Items and modifiers point at a station; the KDS colours timers from its
// targetSeconds.
import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { Station } from "@starter/shared/menu";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
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
import { ApiError } from "@/lib/api/errors";
import {
  useCreateStation,
  useDeleteStation,
  useItems,
  useStations,
  useUpdateStation,
} from "../hooks";
import { useMenuWrites } from "../access";
import { ConfirmDialog } from "./confirm-dialog";

const STATION_TYPES = [
  "coffee_bar",
  "beverage_bar",
  "hot_kitchen",
  "cold_kitchen",
  "pastry",
] as const;

type StationType = (typeof STATION_TYPES)[number];

type Editor = { mode: "new" } | { mode: "edit"; station: Station };

function StationActions({
  station,
  onEdit,
  onDelete,
}: {
  station: Station;
  onEdit: () => void;
  /** Absent when the account may not delete stations. */
  onDelete?: () => void;
}) {
  const t = useT();
  return (
    <div className="flex justify-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("menu.stations.edit")}
        onClick={onEdit}
      >
        <Pencil aria-hidden="true" />
      </Button>
      {onDelete && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("menu.stations.deleteTitle", { name: station.name })}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

export function StationsPage() {
  const t = useT();
  const toast = useToast();
  // Station writes authorize with menu.item.manage on the API; the catalog has
  // no menu.station.manage (kds.station.manage is KDS configuration). Name,
  // type, create and delete need it at outlet scope (legend-cot3): an account
  // holding it only at one station edits target time and nothing else.
  const { canManageItems, canManageStationConfig } = useMenuWrites();
  const stationsQuery = useStations({ limit: 100 });
  const itemsQuery = useItems({ limit: 100 });
  const createStation = useCreateStation();
  const updateStation = useUpdateStation();
  const deleteStation = useDeleteStation();

  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<StationType>("coffee_bar");
  const [target, setTarget] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();
  const [deleting, setDeleting] = React.useState<Station | null>(null);

  const stations = stationsQuery.data?.data ?? [];
  const itemCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of itemsQuery.data?.data ?? [])
      if (item.stationId)
        counts.set(item.stationId, (counts.get(item.stationId) ?? 0) + 1);
    return counts;
  }, [itemsQuery.data]);

  function openNew() {
    setName("");
    setType("coffee_bar");
    setTarget("");
    setError(undefined);
    setEditor({ mode: "new" });
  }

  function openEdit(station: Station) {
    setName(station.name);
    setType(
      STATION_TYPES.includes(station.type as StationType)
        ? (station.type as StationType)
        : "coffee_bar",
    );
    setTarget(
      station.targetSeconds === null ? "" : String(station.targetSeconds),
    );
    setError(undefined);
    setEditor({ mode: "edit", station });
  }

  // A refused save or delete: the API answers 403 PERMISSION_DENIED when the
  // grant does not reach the outlet (legend-huz8).
  function isPermissionDenied(error: unknown): boolean {
    return (
      error instanceof ApiError &&
      error.status === 403 &&
      error.code === "PERMISSION_DENIED"
    );
  }

  function saveError(error: unknown): string {
    return isPermissionDenied(error)
      ? t("menu.stations.permissionDenied")
      : t("menu.errors.saveFailed");
  }

  function save() {
    // Station-only grant: name and type are not editable, so they are not
    // validated or sent; only the target time goes.
    const configLocked = editor?.mode === "edit" && !canManageStationConfig;
    const trimmed = name.trim();
    if (!configLocked && trimmed === "") {
      setError(t("menu.errors.required"));
      return;
    }
    const targetSeconds =
      target.trim() === "" ? null : Number.parseInt(target, 10);
    if (
      targetSeconds !== null &&
      (!Number.isInteger(targetSeconds) || targetSeconds <= 0)
    ) {
      setError(t("menu.errors.invalidAmount"));
      return;
    }
    const body = configLocked
      ? { targetSeconds }
      : { name: trimmed, type, targetSeconds };
    const onSuccess = () => {
      toast({
        title:
          editor?.mode === "edit"
            ? t("menu.stations.updatedToast")
            : t("menu.stations.createdToast"),
        tone: "success",
      });
      setEditor(null);
    };
    if (editor?.mode === "edit") {
      updateStation.mutate(
        { stationId: editor.station.id, body },
        { onSuccess, onError: (error) => setError(saveError(error)) },
      );
      return;
    }
    if (!canManageStationConfig) return;
    createStation.mutate(
      { name: trimmed, type, targetSeconds },
      { onSuccess, onError: (error) => setError(saveError(error)) },
    );
  }

  function confirmDelete() {
    if (!deleting) return;
    deleteStation.mutate(deleting.id, {
      onSuccess: () => {
        toast({ title: t("menu.stations.deletedToast"), tone: "success" });
        setDeleting(null);
      },
      onError: (error) =>
        toast({
          title: isPermissionDenied(error)
            ? t("menu.stations.permissionDenied")
            : t("menu.errors.deleteInUse"),
          tone: "danger",
        }),
    });
  }

  return (
    <>
      <DataTableShell
        title={t("menu.stations.title")}
        description={t("menu.stations.description")}
        state={
          stationsQuery.isPending || itemsQuery.isPending
            ? "loading"
            : stationsQuery.isError || itemsQuery.isError
              ? "error"
              : stations.length === 0
                ? "empty"
                : "ready"
        }
        actions={
          canManageStationConfig ? (
            <Button type="button" onClick={openNew}>
              <Plus aria-hidden="true" />
              {t("menu.stations.add")}
            </Button>
          ) : undefined
        }
        onRetry={() => {
          void stationsQuery.refetch();
          void itemsQuery.refetch();
        }}
        empty={{
          title: t("menu.stations.emptyTitle"),
          description: t("menu.stations.emptyHint"),
          action: canManageStationConfig ? (
            <Button type="button" variant="outline" onClick={openNew}>
              {t("menu.stations.add")}
            </Button>
          ) : undefined,
        }}
        rowCount={stations.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("menu.stations.columns.name")}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t("menu.stations.columns.type")}
                </TableHead>
                <TableHead numeric>
                  {t("menu.stations.columns.target")}
                </TableHead>
                <TableHead numeric>
                  {t("menu.stations.columns.items")}
                </TableHead>
                {canManageItems && (
                  <TableHead numeric>
                    {t("menu.stations.columns.actions")}
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {stations.map((station) => (
                <TableRow key={station.id}>
                  <TableCell className="font-medium">{station.name}</TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">
                    {STATION_TYPES.includes(station.type as StationType)
                      ? t(`menu.stations.types.${station.type as StationType}`)
                      : station.type}
                  </TableCell>
                  <TableCell numeric>
                    {station.targetSeconds === null ? (
                      <span className="text-sm text-muted-foreground">—</span>
                    ) : (
                      t("menu.stations.targetSeconds", {
                        seconds: station.targetSeconds,
                      })
                    )}
                  </TableCell>
                  <TableCell numeric>
                    {t("menu.categories.itemCount", {
                      count: itemCounts.get(station.id) ?? 0,
                    })}
                  </TableCell>
                  {canManageItems && (
                    <TableCell numeric>
                      <StationActions
                        station={station}
                        onEdit={() => openEdit(station)}
                        onDelete={
                          canManageStationConfig
                            ? () => setDeleting(station)
                            : undefined
                        }
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {stations.map((station) => (
            <li
              key={station.id}
              className="grid gap-2 border-b px-card py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-medium">{station.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {STATION_TYPES.includes(station.type as StationType)
                      ? t(`menu.stations.types.${station.type as StationType}`)
                      : station.type}
                    {" · "}
                    {t("menu.categories.itemCount", {
                      count: itemCounts.get(station.id) ?? 0,
                    })}
                  </span>
                </div>
                {canManageItems && (
                  <StationActions
                    station={station}
                    onEdit={() => openEdit(station)}
                    onDelete={
                      canManageStationConfig
                        ? () => setDeleting(station)
                        : undefined
                    }
                  />
                )}
              </div>
              {station.targetSeconds !== null && (
                <span className="text-sm text-muted-foreground">
                  {t("menu.stations.targetSeconds", {
                    seconds: station.targetSeconds,
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
      </DataTableShell>

      <Dialog
        open={canManageItems && editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === "edit"
                ? t("menu.stations.edit")
                : t("menu.stations.add")}
            </DialogTitle>
          </DialogHeader>
          {canManageStationConfig ? (
            <>
              <FormField
                label={t("menu.stations.name")}
                hint={t("menu.stations.nameHint")}
                error={error}
                required
              >
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                />
              </FormField>
              <FormField label={t("menu.stations.type")} required>
                <Select
                  value={type}
                  onValueChange={(value) => setType(value as StationType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATION_TYPES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {t(`menu.stations.types.${option}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("menu.stations.configLockedHint")}
            </p>
          )}
          <FormField
            label={t("menu.stations.target")}
            hint={t("menu.stations.targetHint")}
            error={canManageStationConfig ? undefined : error}
          >
            <Input
              type="number"
              min={1}
              step={30}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditor(null)}
              disabled={createStation.isPending || updateStation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              loading={createStation.isPending || updateStation.isPending}
              onClick={save}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={canManageStationConfig && deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("menu.stations.deleteTitle", {
          name: deleting?.name ?? "",
        })}
        description={t("menu.stations.deleteBody")}
        confirmLabel={t("common.delete")}
        pending={deleteStation.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}
