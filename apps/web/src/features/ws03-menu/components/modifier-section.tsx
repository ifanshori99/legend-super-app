// Modifier groups for one item (PRD §8 "Struktur Menu": modifier group with
// min/max, e.g. tingkat gula, es, susu alternatif, extra shot).
// Two parts: which groups appear on this item, and the tenant-wide group
// catalog with its modifiers.
import * as React from "react";
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
import { idr } from "@starter/shared/core";
import type { ModifierGroup, Station } from "@starter/shared/menu";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
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
  useCreateModifier,
  useCreateModifierGroup,
  useDeleteModifier,
  useDeleteModifierGroup,
  useItemModifierGroups,
  useModifierGroups,
  useModifiers,
  useSetItemModifierGroups,
  useStations,
  useUpdateModifier,
  useUpdateModifierGroup,
} from "../hooks";
import { useMenuWrites } from "../access";
import { ConfirmDialog } from "./confirm-dialog";

type GroupEditor = { mode: "new" } | { mode: "edit"; group: ModifierGroup };

export function ModifierSection({ itemId }: { itemId: string }) {
  const t = useT();
  const toast = useToast();
  const { canManageItems, canManagePrices } = useMenuWrites();
  const groupsQuery = useModifierGroups({ limit: 100 });
  const attachedQuery = useItemModifierGroups(itemId);
  const stationsQuery = useStations({ limit: 100 });
  const setItemGroups = useSetItemModifierGroups();
  const createGroup = useCreateModifierGroup();
  const updateGroup = useUpdateModifierGroup();
  const deleteGroup = useDeleteModifierGroup();

  const [override, setOverride] = React.useState<string[] | null>(null);
  const attachedIds = override ?? attachedQuery.data?.data.groupIds ?? [];
  const groups = groupsQuery.data?.data ?? [];
  const attachedGroups = groups.filter((group) =>
    attachedIds.includes(group.id),
  );
  const stations = stationsQuery.data?.data ?? [];

  const [editor, setEditor] = React.useState<GroupEditor | null>(null);
  const [name, setName] = React.useState("");
  const [minSelect, setMinSelect] = React.useState("0");
  const [maxSelect, setMaxSelect] = React.useState("1");
  const [error, setError] = React.useState<string | undefined>();
  const [deleting, setDeleting] = React.useState<ModifierGroup | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  function openNewGroup() {
    setName("");
    setMinSelect("0");
    setMaxSelect("1");
    setError(undefined);
    setEditor({ mode: "new" });
  }

  function openEditGroup(group: ModifierGroup) {
    setName(group.name);
    setMinSelect(String(group.minSelect));
    setMaxSelect(String(group.maxSelect));
    setError(undefined);
    setEditor({ mode: "edit", group });
  }

  function saveGroup() {
    const trimmed = name.trim();
    const min = Number(minSelect);
    const max = Number(maxSelect);
    if (trimmed === "") {
      setError(t("menu.errors.required"));
      return;
    }
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < 0
    ) {
      setError(t("menu.modifiers.boundsHint"));
      return;
    }
    if (min > max) {
      setError(t("menu.errors.minGreaterThanMax"));
      return;
    }
    const onSuccess = () => {
      toast({
        title:
          editor?.mode === "edit"
            ? t("menu.modifiers.groupUpdatedToast")
            : t("menu.modifiers.groupCreatedToast"),
        tone: "success",
      });
      setEditor(null);
    };
    if (editor?.mode === "edit") {
      updateGroup.mutate(
        {
          groupId: editor.group.id,
          body: { name: trimmed, minSelect: min, maxSelect: max },
        },
        { onSuccess, onError: () => setError(t("menu.errors.saveFailed")) },
      );
      return;
    }
    createGroup.mutate(
      { name: trimmed, minSelect: min, maxSelect: max },
      { onSuccess, onError: () => setError(t("menu.errors.saveFailed")) },
    );
  }

  function toggleGroup(groupId: string, checked: boolean) {
    const next = checked
      ? [...attachedIds, groupId]
      : attachedIds.filter((id) => id !== groupId);
    setOverride(next);
    setItemGroups.mutate(
      { itemId, body: { groupIds: next } },
      {
        onSuccess: () =>
          toast({ title: t("menu.modifiers.attachedToast"), tone: "success" }),
        onError: () => setOverride(null),
      },
    );
  }

  function confirmDeleteGroup() {
    if (!deleting) return;
    deleteGroup.mutate(deleting.id, {
      onSuccess: () => {
        toast({
          title: t("menu.modifiers.groupDeletedToast"),
          tone: "success",
        });
        setDeleting(null);
      },
      onError: () =>
        toast({ title: t("menu.errors.deleteInUse"), tone: "danger" }),
    });
  }

  const loading = groupsQuery.isPending || attachedQuery.isPending;
  const failed = groupsQuery.isError || attachedQuery.isError;

  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <div className="min-w-0">
          <h3 className="type-heading">{t("menu.modifiers.attachedTitle")}</h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("menu.modifiers.attachedHint")}
          </p>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("common.loading")}
          </p>
        ) : failed ? (
          <div className="rounded-container border-(length:--border-w) bg-card p-4 shadow-hairline">
            <p className="text-sm text-danger" role="alert">
              {t("state.errorHint")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                void groupsQuery.refetch();
                void attachedQuery.refetch();
              }}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("menu.modifiers.attachedEmpty")}
          </p>
        ) : !canManageItems ? (
          attachedGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("menu.modifiers.attachedEmpty")}
            </p>
          ) : (
            <ul className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-3 shadow-hairline sm:grid-cols-2">
              {attachedGroups.map((group) => (
                <li key={group.id} className="grid gap-0.5">
                  <span className="font-medium">{group.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {t("menu.modifiers.bounds", {
                      min: group.minSelect,
                      max: group.maxSelect,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <ul className="grid gap-2 rounded-container border-(length:--border-w) bg-card p-3 shadow-hairline sm:grid-cols-2">
            {groups.map((group) => {
              const id = `item-group-${group.id}`;
              return (
                <li key={group.id} className="flex items-start gap-2">
                  <Checkbox
                    id={id}
                    checked={attachedIds.includes(group.id)}
                    disabled={setItemGroups.isPending}
                    onCheckedChange={(checked) =>
                      toggleGroup(group.id, checked === true)
                    }
                  />
                  <Label htmlFor={id} className="grid gap-0.5 font-normal">
                    <span className="font-medium">{group.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {t("menu.modifiers.bounds", {
                        min: group.minSelect,
                        max: group.maxSelect,
                      })}
                    </span>
                  </Label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="type-heading">{t("menu.modifiers.manageTitle")}</h3>
          {canManageItems && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openNewGroup}
            >
              <Plus aria-hidden="true" />
              {t("menu.modifiers.addGroup")}
            </Button>
          )}
        </div>

        {groupsQuery.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("common.loading")}
          </p>
        ) : groupsQuery.isError ? (
          <div className="rounded-container border-(length:--border-w) bg-card p-4 shadow-hairline">
            <p className="text-sm text-danger" role="alert">
              {t("state.errorHint")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void groupsQuery.refetch()}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-container border-(length:--border-w) bg-card px-4 py-6 text-center shadow-hairline">
            <p className="text-sm font-semibold">
              {t("menu.modifiers.emptyTitle")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("menu.modifiers.emptyHint")}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("menu.modifiers.columns.group")}</TableHead>
                  <TableHead>{t("menu.modifiers.columns.bounds")}</TableHead>
                  <TableHead>{t("menu.modifiers.columns.count")}</TableHead>
                  <TableHead numeric>
                    {t("menu.modifiers.columns.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => {
                  const open = expanded === group.id;
                  return (
                    <React.Fragment key={group.id}>
                      <TableRow>
                        <TableCell className="font-medium">
                          {group.name}
                        </TableCell>
                        <TableCell>
                          {t("menu.modifiers.bounds", {
                            min: group.minSelect,
                            max: group.maxSelect,
                          })}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          <ExpandedGroupLabel open={open} groupId={group.id} />
                        </TableCell>
                        <TableCell numeric>
                          <div className="flex justify-end gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-expanded={open}
                              aria-label={
                                open
                                  ? t("menu.modifiers.hideModifiers")
                                  : t("menu.modifiers.showModifiers")
                              }
                              onClick={() =>
                                setExpanded(open ? null : group.id)
                              }
                            >
                              {open ? (
                                <ChevronUp aria-hidden="true" />
                              ) : (
                                <ChevronDown aria-hidden="true" />
                              )}
                            </Button>
                            {canManageItems && (
                              <>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t("menu.modifiers.editGroup")}
                                  onClick={() => openEditGroup(group)}
                                >
                                  <Pencil aria-hidden="true" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t(
                                    "menu.modifiers.deleteGroupTitle",
                                    {
                                      name: group.name,
                                    },
                                  )}
                                  onClick={() => setDeleting(group)}
                                >
                                  <Trash2 aria-hidden="true" />
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {open && (
                        <TableRow>
                          <TableCell colSpan={4} className="bg-surface-2">
                            <GroupModifiers
                              groupId={group.id}
                              stations={stations}
                              canManageItems={canManageItems}
                              canManagePrices={canManagePrices}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <Dialog
        open={canManageItems && editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === "edit"
                ? t("menu.modifiers.editGroup")
                : t("menu.modifiers.addGroup")}
            </DialogTitle>
          </DialogHeader>
          <FormField
            label={t("menu.modifiers.groupName")}
            hint={t("menu.modifiers.groupNameHint")}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t("menu.modifiers.min")} required>
              <Input
                type="number"
                min={0}
                max={50}
                step={1}
                value={minSelect}
                onChange={(event) => setMinSelect(event.target.value)}
              />
            </FormField>
            <FormField
              label={t("menu.modifiers.max")}
              hint={t("menu.modifiers.boundsHint")}
              error={error}
              required
            >
              <Input
                type="number"
                min={0}
                max={50}
                step={1}
                value={maxSelect}
                onChange={(event) => setMaxSelect(event.target.value)}
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditor(null)}
              disabled={createGroup.isPending || updateGroup.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              loading={createGroup.isPending || updateGroup.isPending}
              onClick={saveGroup}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={canManageItems && deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("menu.modifiers.deleteGroupTitle", {
          name: deleting?.name ?? "",
        })}
        description={t("menu.modifiers.deleteGroupBody")}
        confirmLabel={t("common.delete")}
        pending={deleteGroup.isPending}
        onConfirm={confirmDeleteGroup}
      />
    </div>
  );
}

/** Count without loading every group's modifiers up front. */
function ExpandedGroupLabel({
  open,
  groupId,
}: {
  open: boolean;
  groupId: string;
}) {
  const t = useT();
  const modifiers = useModifiers(open ? groupId : undefined);
  if (!open) return <>—</>;
  if (modifiers.isPending) return <>{t("common.loading")}</>;
  return (
    <>
      {t("menu.modifiers.modifierCount", {
        count: modifiers.data?.data.length ?? 0,
      })}
    </>
  );
}

type ModifierEditor =
  | { mode: "new" }
  | {
      mode: "edit";
      id: string;
      name: string;
      priceIdr: number;
      stationId: string | null;
    };

function GroupModifiers({
  groupId,
  stations,
  canManageItems,
  canManagePrices,
}: {
  groupId: string;
  stations: Station[];
  canManageItems: boolean;
  canManagePrices: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const modifiers = useModifiers(groupId);
  const createModifier = useCreateModifier();
  const updateModifier = useUpdateModifier();
  const deleteModifier = useDeleteModifier();

  const [editor, setEditor] = React.useState<ModifierEditor | null>(null);
  const [name, setName] = React.useState("");
  const [price, setPrice] = React.useState("0");
  const [stationId, setStationId] = React.useState("none");
  const [error, setError] = React.useState<string | undefined>();
  const [deleting, setDeleting] = React.useState<{
    id: string;
    name: string;
  } | null>(null);

  function openNew() {
    setName("");
    setPrice("0");
    setStationId("none");
    setError(undefined);
    setEditor({ mode: "new" });
  }

  function openEdit(modifier: {
    id: string;
    name: string;
    priceIdr: number;
    stationId: string | null;
  }) {
    setName(modifier.name);
    setPrice(String(modifier.priceIdr));
    setStationId(modifier.stationId ?? "none");
    setError(undefined);
    setEditor({ mode: "edit", ...modifier });
  }

  function save() {
    const trimmed = name.trim();
    const priceIdr = Number(price);
    if (trimmed === "") {
      setError(t("menu.errors.required"));
      return;
    }
    if (!Number.isInteger(priceIdr) || priceIdr < 0) {
      setError(t("menu.errors.invalidAmount"));
      return;
    }
    const body = {
      name: trimmed,
      // A creation always carries a price (the API requires price.manage);
      // when editing without it, leave the stored price untouched.
      ...(editor?.mode !== "edit" || canManagePrices
        ? { priceIdr: idr(priceIdr) }
        : {}),
      stationId: stationId === "none" ? null : stationId,
    };
    const onSuccess = () => {
      toast({
        title:
          editor?.mode === "edit"
            ? t("menu.modifiers.modifierUpdatedToast")
            : t("menu.modifiers.modifierCreatedToast"),
        tone: "success",
      });
      setEditor(null);
    };
    if (editor?.mode === "edit") {
      updateModifier.mutate(
        { modifierId: editor.id, body },
        { onSuccess, onError: () => setError(t("menu.errors.saveFailed")) },
      );
      return;
    }
    createModifier.mutate(
      { groupId, body },
      { onSuccess, onError: () => setError(t("menu.errors.saveFailed")) },
    );
  }

  function confirmDelete() {
    if (!deleting) return;
    deleteModifier.mutate(deleting.id, {
      onSuccess: () => {
        toast({
          title: t("menu.modifiers.modifierDeletedToast"),
          tone: "success",
        });
        setDeleting(null);
      },
      onError: () =>
        toast({ title: t("menu.errors.deleteInUse"), tone: "danger" }),
    });
  }

  const rows = modifiers.data?.data ?? [];

  return (
    <div className="grid gap-2 py-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {t("menu.modifiers.modifiersTitle")}
        </p>
        {canManageItems && canManagePrices && (
          <Button type="button" variant="outline" size="sm" onClick={openNew}>
            <Plus aria-hidden="true" />
            {t("menu.modifiers.addModifier")}
          </Button>
        )}
      </div>
      {modifiers.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("common.loading")}
        </p>
      ) : modifiers.isError ? (
        <div>
          <p className="text-sm text-danger" role="alert">
            {t("state.errorHint")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={() => void modifiers.refetch()}
          >
            {t("common.retry")}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("menu.modifiers.noModifiers")}
        </p>
      ) : (
        <div className="overflow-hidden rounded-container border-(length:--border-w) bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("menu.modifiers.modifierName")}</TableHead>
                <TableHead numeric>
                  {t("menu.modifiers.modifierPrice")}
                </TableHead>
                {canManageItems && (
                  <TableHead numeric>
                    {t("menu.modifiers.columns.actions")}
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((modifier) => (
                <TableRow key={modifier.id}>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-2">
                      {modifier.name}
                      {modifier.stationId && (
                        <Badge tone="neutral">
                          {stations.find(
                            (station) => station.id === modifier.stationId,
                          )?.name ?? t("menu.list.noStation")}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={modifier.priceIdr} size="sm" />
                  </TableCell>
                  {canManageItems && (
                    <TableCell numeric>
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("menu.modifiers.editModifier")}
                          onClick={() => openEdit(modifier)}
                        >
                          <Pencil aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("menu.modifiers.deleteModifierTitle", {
                            name: modifier.name,
                          })}
                          onClick={() =>
                            setDeleting({
                              id: modifier.id,
                              name: modifier.name,
                            })
                          }
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={canManageItems && editor !== null}
        onOpenChange={(open) => !open && setEditor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === "edit"
                ? t("menu.modifiers.editModifier")
                : t("menu.modifiers.addModifier")}
            </DialogTitle>
          </DialogHeader>
          <FormField
            label={t("menu.modifiers.modifierName")}
            hint={t("menu.modifiers.modifierNameHint")}
            error={error}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          {canManagePrices && (
            <FormField label={t("menu.modifiers.modifierPrice")} required>
              <Input
                type="number"
                min={0}
                step={500}
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </FormField>
          )}
          <FormField
            label={t("menu.modifiers.modifierStation")}
            hint={t("menu.modifiers.modifierStationHint")}
          >
            <Select value={stationId} onValueChange={setStationId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("menu.list.noStation")}</SelectItem>
                {stations.map((station) => (
                  <SelectItem key={station.id} value={station.id}>
                    {station.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditor(null)}
              disabled={createModifier.isPending || updateModifier.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              loading={createModifier.isPending || updateModifier.isPending}
              onClick={save}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={canManageItems && deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("menu.modifiers.deleteModifierTitle", {
          name: deleting?.name ?? "",
        })}
        description={t("menu.modifiers.deleteModifierBody")}
        confirmLabel={t("common.delete")}
        pending={deleteModifier.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
