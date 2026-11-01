// Combos / packages (PRD §8 "Paket & Combo"): the combo item, its contents,
// optional variant choices, and the revenue allocation per component which
// must total exactly 100% for menu reports.
import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { Combo, MenuItemAdmin } from "@starter/shared/menu";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
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
  useCombos,
  useCreateCombo,
  useDeleteCombo,
  useItems,
  usePriceListItems,
  usePriceLists,
  useUpdateCombo,
  useVariants,
} from "../hooks";
import {
  allocationIsValid,
  businessDateToday,
  effectivePriceList,
  percentToBp,
  priceByItem,
  totalAllocationBp,
} from "../lib";
import { ConfirmDialog } from "./confirm-dialog";

type Editor = { mode: "new" } | { mode: "edit"; combo: Combo };

type DraftComponent = {
  key: string;
  itemId: string;
  options: string[];
  percent: string;
};

function ComboActions({
  name,
  onEdit,
  onDelete,
}: {
  name: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <div className="flex justify-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("menu.combos.edit")}
        onClick={onEdit}
      >
        <Pencil aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("menu.combos.deleteTitle", { name })}
        onClick={onDelete}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

export function CombosPage() {
  const t = useT();
  const toast = useToast();
  const combosQuery = useCombos({ limit: 100 });
  const itemsQuery = useItems({ limit: 100 });
  const priceListsQuery = usePriceLists({ limit: 100 });
  const createCombo = useCreateCombo();
  const updateCombo = useUpdateCombo();
  const deleteCombo = useDeleteCombo();

  const activePriceList = effectivePriceList(
    priceListsQuery.data?.data ?? [],
    "dine_in",
    businessDateToday(),
  );
  const priceItemsQuery = usePriceListItems(activePriceList?.id);

  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [error, setError] = React.useState<string | undefined>();
  const [deleting, setDeleting] = React.useState<Combo | null>(null);

  const combos = combosQuery.data?.data ?? [];
  const items = React.useMemo(
    () => itemsQuery.data?.data ?? [],
    [itemsQuery.data],
  );
  const itemsById = React.useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  const prices = priceByItem(priceItemsQuery.data?.data ?? []);
  const comboItems = items.filter((item) => item.type === "combo");

  function confirmDelete() {
    if (!deleting) return;
    deleteCombo.mutate(deleting.id, {
      onSuccess: () => {
        toast({ title: t("menu.combos.deletedToast"), tone: "success" });
        setDeleting(null);
      },
      onError: () =>
        toast({ title: t("menu.errors.deleteInUse"), tone: "danger" }),
    });
  }

  return (
    <>
      <DataTableShell
        title={t("menu.combos.title")}
        description={t("menu.combos.description")}
        state={
          combosQuery.isPending || itemsQuery.isPending
            ? "loading"
            : combosQuery.isError || itemsQuery.isError
              ? "error"
              : combos.length === 0
                ? "empty"
                : "ready"
        }
        actions={
          <Button
            type="button"
            onClick={() => {
              setError(undefined);
              setEditor({ mode: "new" });
            }}
            disabled={comboItems.length === 0}
          >
            <Plus aria-hidden="true" />
            {t("menu.combos.add")}
          </Button>
        }
        onRetry={() => {
          void combosQuery.refetch();
          void itemsQuery.refetch();
        }}
        empty={{
          title: t("menu.combos.emptyTitle"),
          description:
            comboItems.length === 0
              ? t("menu.combos.noComboItems")
              : t("menu.combos.emptyHint"),
        }}
        rowCount={combos.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("menu.combos.columns.name")}</TableHead>
                <TableHead numeric>
                  {t("menu.combos.columns.components")}
                </TableHead>
                <TableHead numeric>{t("menu.combos.columns.price")}</TableHead>
                <TableHead numeric>
                  {t("menu.combos.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {combos.map((combo) => {
                const item = itemsById.get(combo.comboItemId);
                const price = prices.get(combo.comboItemId);
                return (
                  <TableRow key={combo.id}>
                    <TableCell className="font-medium">
                      <span className="flex flex-wrap items-center gap-2">
                        {item?.name ?? combo.comboItemId}
                        <Badge
                          tone={
                            allocationIsValid(combo.components)
                              ? "success"
                              : "danger"
                          }
                        >
                          {t("menu.combos.allocationTotal", {
                            percent: totalAllocationBp(combo.components) / 100,
                          })}
                        </Badge>
                      </span>
                    </TableCell>
                    <TableCell numeric>
                      {t("menu.combos.componentCount", {
                        count: combo.components.length,
                      })}
                    </TableCell>
                    <TableCell numeric>
                      {price === undefined ? (
                        <span className="text-sm text-muted-foreground">
                          {t("menu.list.noPrice")}
                        </span>
                      ) : (
                        <Money amount={price} size="sm" />
                      )}
                    </TableCell>
                    <TableCell numeric>
                      <ComboActions
                        name={item?.name ?? ""}
                        onEdit={() => {
                          setError(undefined);
                          setEditor({ mode: "edit", combo });
                        }}
                        onDelete={() => setDeleting(combo)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {combos.map((combo) => {
            const item = itemsById.get(combo.comboItemId);
            const price = prices.get(combo.comboItemId);
            return (
              <li
                key={combo.id}
                className="grid gap-2 border-b px-card py-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-medium">
                      {item?.name ?? combo.comboItemId}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t("menu.combos.componentCount", {
                        count: combo.components.length,
                      })}
                      {" · "}
                      {price === undefined ? (
                        t("menu.list.noPrice")
                      ) : (
                        <Money amount={price} size="sm" />
                      )}
                    </span>
                  </div>
                  <Badge
                    tone={
                      allocationIsValid(combo.components) ? "success" : "danger"
                    }
                  >
                    {t("menu.combos.allocationTotal", {
                      percent: totalAllocationBp(combo.components) / 100,
                    })}
                  </Badge>
                </div>
                <ComboActions
                  name={item?.name ?? ""}
                  onEdit={() => {
                    setError(undefined);
                    setEditor({ mode: "edit", combo });
                  }}
                  onDelete={() => setDeleting(combo)}
                />
              </li>
            );
          })}
        </ul>
      </DataTableShell>

      {editor && (
        <ComboEditor
          editor={editor}
          items={items}
          error={error}
          setError={setError}
          pending={createCombo.isPending || updateCombo.isPending}
          onClose={() => setEditor(null)}
          onSave={(comboItemId, components) => {
            if (editor.mode === "edit") {
              updateCombo.mutate(
                { comboId: editor.combo.id, body: { components } },
                {
                  onSuccess: () => {
                    toast({
                      title: t("menu.combos.updatedToast"),
                      tone: "success",
                    });
                    setEditor(null);
                  },
                  onError: () => setError(t("menu.errors.saveFailed")),
                },
              );
              return;
            }
            createCombo.mutate(
              { comboItemId, components },
              {
                onSuccess: () => {
                  toast({
                    title: t("menu.combos.createdToast"),
                    tone: "success",
                  });
                  setEditor(null);
                },
                onError: () => setError(t("menu.errors.saveFailed")),
              },
            );
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("menu.combos.deleteTitle", {
          name: itemsById.get(deleting?.comboItemId ?? "")?.name ?? "",
        })}
        description={t("menu.combos.deleteBody")}
        confirmLabel={t("common.delete")}
        pending={deleteCombo.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}

function ComboEditor({
  editor,
  items,
  error,
  setError,
  pending,
  onClose,
  onSave,
}: {
  editor: Editor;
  items: MenuItemAdmin[];
  error: string | undefined;
  setError: (message: string | undefined) => void;
  pending: boolean;
  onClose: () => void;
  onSave: (comboItemId: string, components: Combo["components"]) => void;
}) {
  const t = useT();
  const comboItems = items.filter((item) => item.type === "combo");
  const sellableItems = items.filter((item) => item.type !== "combo");

  const [comboItemId, setComboItemId] = React.useState(
    editor.mode === "edit"
      ? editor.combo.comboItemId
      : (comboItems[0]?.id ?? ""),
  );
  const [components, setComponents] = React.useState<DraftComponent[]>(() =>
    editor.mode === "edit"
      ? editor.combo.components.map((component) => ({
          key: component.menuItemId,
          itemId: component.menuItemId,
          options: component.options,
          percent: String(component.revenueAllocationBp / 100),
        }))
      : [
          {
            key: "new-1",
            itemId: sellableItems[0]?.id ?? "",
            options: [],
            percent: "100",
          },
        ],
  );

  const total = components.reduce(
    (sum, component) => sum + percentToBp(Number(component.percent)),
    0,
  );
  const valid = allocationIsValid(
    components.map((component) => ({
      menuItemId: component.itemId,
      options: component.options,
      revenueAllocationBp: percentToBp(Number(component.percent)),
    })),
  );

  function updateComponent(index: number, patch: Partial<DraftComponent>) {
    setComponents((current) =>
      current.map((component, i) =>
        i === index ? { ...component, ...patch } : component,
      ),
    );
    setError(undefined);
  }

  function addComponent() {
    if (components.length >= 10) return;
    setComponents((current) => [
      ...current,
      {
        key: `new-${current.length + 1}-${Date.now()}`,
        itemId: sellableItems[0]?.id ?? "",
        options: [],
        percent: "0",
      },
    ]);
    setError(undefined);
  }

  function save() {
    if (comboItemId === "") {
      setError(t("menu.errors.required"));
      return;
    }
    if (components.length === 0) {
      setError(t("menu.combos.allocationInvalid"));
      return;
    }
    if (
      components.some((component) => component.itemId === "") ||
      new Set(components.map((component) => component.itemId)).size !==
        components.length
    ) {
      setError(t("menu.errors.required"));
      return;
    }
    if (!valid) {
      setError(t("menu.combos.allocationInvalid"));
      return;
    }
    onSave(
      comboItemId,
      components.map((component) => ({
        menuItemId: component.itemId,
        options: component.options,
        revenueAllocationBp: percentToBp(Number(component.percent)),
      })),
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editor.mode === "edit"
              ? t("menu.combos.edit")
              : t("menu.combos.add")}
          </DialogTitle>
          <DialogDescription>{t("menu.combos.description")}</DialogDescription>
        </DialogHeader>

        <FormField
          label={t("menu.combos.comboItem")}
          hint={t("menu.combos.comboItemHint")}
          required
        >
          <Select
            value={comboItemId}
            onValueChange={setComboItemId}
            disabled={editor.mode === "edit"}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {comboItems.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">
              {t("menu.combos.components")}
            </p>
            <Badge tone={valid ? "success" : "danger"}>
              {t("menu.combos.allocationTotal", { percent: total / 100 })}
            </Badge>
          </div>

          {components.map((component, index) => (
            <div
              key={component.key}
              className="grid gap-2 rounded-lg border bg-background p-3"
            >
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
                <FormField label={t("menu.combos.componentItem")} required>
                  <Select
                    value={component.itemId}
                    onValueChange={(value) =>
                      updateComponent(index, { itemId: value, options: [] })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sellableItems.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField label={t("menu.combos.allocation")} required>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.01}
                    value={component.percent}
                    onChange={(event) =>
                      updateComponent(index, { percent: event.target.value })
                    }
                  />
                </FormField>
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("menu.combos.removeComponent")}
                    disabled={components.length === 1}
                    onClick={() =>
                      setComponents((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </div>
              {component.itemId && (
                <ComponentOptions
                  itemId={component.itemId}
                  value={component.options}
                  onChange={(options) => updateComponent(index, { options })}
                />
              )}
            </div>
          ))}

          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addComponent}
              disabled={components.length >= 10}
            >
              <Plus aria-hidden="true" />
              {t("menu.combos.addComponent")}
            </Button>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="button" loading={pending} onClick={save}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ComponentOptions({
  itemId,
  value,
  onChange,
}: {
  itemId: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const t = useT();
  const variants = useVariants(itemId);
  const rows = variants.data?.data ?? [];
  if (variants.isPending)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {t("common.loading")}
      </p>
    );
  if (variants.isError)
    return (
      <p className="text-sm text-danger" role="alert">
        {t("state.errorHint")}
      </p>
    );
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {t("menu.combos.componentOptionsHint")}
      </p>
    );
  return (
    <fieldset className="grid gap-1">
      <legend className="text-sm font-medium">
        {t("menu.combos.componentOptions")}
      </legend>
      <div className="flex flex-wrap gap-3">
        {rows.map((variant) => {
          const id = `combo-option-${itemId}-${variant.id}`;
          return (
            <span key={variant.id} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={value.includes(variant.id)}
                onCheckedChange={() =>
                  onChange(
                    value.includes(variant.id)
                      ? value.filter((option) => option !== variant.id)
                      : [...value, variant.id],
                  )
                }
              />
              <Label htmlFor={id} className="font-normal">
                {variant.name}
              </Label>
            </span>
          );
        })}
      </div>
    </fieldset>
  );
}
