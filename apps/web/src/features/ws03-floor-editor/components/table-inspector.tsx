// Inspector for the selected table. Two groups, two saves, because the
// contract splits them: position/width/height/shape belong to `tables.layout`
// (saved with the whole plan), while code, capacity, type, zone and status are
// the table row itself (PATCH one table).
import * as React from "react";
import { MousePointerClick, RotateCw, Trash2 } from "lucide-react";
import {
  TABLE_TYPES,
  tableTypeSchema,
  updateTableInputSchema,
} from "@starter/shared/qr-order";
import type {
  FloorZone,
  Table,
  TableLayout,
  TableType,
} from "@starter/shared/qr-order";
import type { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormField, fieldErrors } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useDeleteTable, useUpdateTable } from "../hooks";
import { PLAN_HEIGHT, PLAN_WIDTH, clampLayout, rotateLayout } from "../lib";
import { ConfirmDialog } from "./confirm-dialog";

type Props = {
  table: Table | null;
  zones: FloorZone[];
  /** Unsaved layout of this table, when the plan has been moved. */
  draft: TableLayout | undefined;
  dirty: boolean;
  onLayoutChange: (layout: TableLayout) => void;
  onDeleted: () => void;
};

function TableInspectorBody({
  table,
  zones,
  draft,
  dirty,
  onLayoutChange,
  onDeleted,
}: Omit<Props, "table"> & { table: Table }) {
  const t = useT();
  const toast = useToast();
  const updateTable = useUpdateTable();
  const deleteTable = useDeleteTable();
  const layout = draft ?? table.layout;

  const [code, setCode] = React.useState(table.code);
  const [capacity, setCapacity] = React.useState(String(table.capacity));
  const [type, setType] = React.useState<TableType>(table.type);
  const [zoneId, setZoneId] = React.useState<string>(table.zoneId);
  const [active, setActive] = React.useState(table.status !== "inactive");
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<ApiError | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<ApiError | null>(null);

  // Only the on/off switch is sent: an occupied, reserved or dirty table keeps
  // its live state when the manager edits its code or capacity (ORD-10).
  const activeChanged = active !== (table.status !== "inactive");
  const status = active ? "available" : "inactive";
  const attributesChanged =
    code !== table.code ||
    Number(capacity) !== table.capacity ||
    type !== table.type ||
    zoneId !== table.zoneId ||
    activeChanged;

  const save = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const parsed = updateTableInputSchema.safeParse({
      code: code.trim(),
      capacity: Number(capacity),
      type,
      zoneId,
      ...(activeChanged ? { status } : {}),
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    updateTable.mutate(
      { tableId: table.id, body: parsed.data },
      {
        onSuccess: () =>
          toast({ title: t("floorEditor.tableSaved"), tone: "success" }),
        onError: (error: Error) => setFormError(error as ApiError),
      },
    );
  };

  const remove = () => {
    setDeleteError(null);
    deleteTable.mutate(table.id, {
      onSuccess: () => {
        toast({ title: t("floorEditor.tableDeleted"), tone: "success" });
        setConfirmingDelete(false);
        onDeleted();
      },
      onError: (error: Error) => setDeleteError(error as ApiError),
    });
  };

  const setLayoutField =
    (field: "x" | "y" | "width" | "height") =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(event.target.value);
      if (!Number.isFinite(value)) return;
      onLayoutChange(clampLayout({ ...layout, [field]: value }));
    };

  return (
    <section
      aria-labelledby="floor-inspector-title"
      className="grid gap-4 rounded-xl border-(length:--border-w) bg-card p-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="floor-inspector-title"
            className="text-base leading-6 font-semibold"
          >
            {t("floorEditor.tableTitle", { code: table.code })}
          </h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t(`floorEditor.tableState.${table.status}`)} ·{" "}
            {t("floorEditor.planSeats", { count: table.capacity })}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("floorEditor.tableDelete")}
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>

      <div className="grid gap-3 border-t pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            {t("floorEditor.tablePosition")}
          </h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onLayoutChange(rotateLayout(layout))}
          >
            <RotateCw aria-hidden="true" />
            {t("floorEditor.tableRotate")}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="X" required>
            <Input
              type="number"
              inputMode="numeric"
              step={10}
              min={0}
              max={PLAN_WIDTH}
              value={Math.round(layout.x)}
              onChange={setLayoutField("x")}
            />
          </FormField>
          <FormField label="Y" required>
            <Input
              type="number"
              inputMode="numeric"
              step={10}
              min={0}
              max={PLAN_HEIGHT}
              value={Math.round(layout.y)}
              onChange={setLayoutField("y")}
            />
          </FormField>
          <FormField label={t("floorEditor.tableWidth")} required>
            <Input
              type="number"
              inputMode="numeric"
              step={10}
              min={10}
              max={PLAN_WIDTH}
              value={Math.round(layout.width)}
              onChange={setLayoutField("width")}
            />
          </FormField>
          <FormField label={t("floorEditor.tableHeight")} required>
            <Input
              type="number"
              inputMode="numeric"
              step={10}
              min={10}
              max={PLAN_HEIGHT}
              value={Math.round(layout.height)}
              onChange={setLayoutField("height")}
            />
          </FormField>
        </div>
        <div className="grid gap-1.5">
          <span className="text-sm font-semibold">
            {t("floorEditor.tableShape")}
          </span>
          <SegmentedControl
            label={t("floorEditor.tableShape")}
            value={layout.shape}
            onValueChange={(shape) => onLayoutChange({ ...layout, shape })}
            options={[
              { value: "rect", label: t("floorEditor.shape.rect") },
              { value: "round", label: t("floorEditor.shape.round") },
            ]}
          />
        </div>
        {dirty && (
          <p className="text-sm leading-5 font-medium text-warning">
            {t("floorEditor.tableDirty")}
          </p>
        )}
      </div>

      <form className="grid gap-4 border-t pt-4" onSubmit={save} noValidate>
        <FormField
          label={t("floorEditor.tableCode")}
          hint={t("floorEditor.tableCodeHint")}
          error={errors.code}
          required
        >
          <Input
            value={code}
            autoComplete="off"
            onChange={(event) => setCode(event.target.value.toUpperCase())}
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t("floorEditor.tableCapacity")}
            error={errors.capacity}
            required
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={50}
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
            />
          </FormField>
          <FormField
            label={t("floorEditor.tableType")}
            error={errors.type}
            required
          >
            <Select
              value={type}
              onValueChange={(value) => setType(tableTypeSchema.parse(value))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TABLE_TYPES.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {t(`floorEditor.type.${entry}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
        <FormField
          label={t("floorEditor.tableZone")}
          error={errors.zoneId}
          required
        >
          <Select value={zoneId} onValueChange={setZoneId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {zones.map((zone) => (
                <SelectItem key={zone.id} value={zone.id}>
                  {zone.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <div className="grid gap-1.5">
          <div className="flex items-center gap-3">
            <Switch
              id="table-active"
              checked={active}
              onCheckedChange={setActive}
            />
            <label htmlFor="table-active" className="text-sm font-medium">
              {t("floorEditor.tableActiveSwitch")}
            </label>
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("floorEditor.tableActiveHint")}
          </p>
        </div>

        {formError && (
          <p
            role="alert"
            className="rounded-lg bg-danger-subtle p-3 text-sm leading-5 font-medium text-danger"
          >
            {formError.message}
          </p>
        )}

        <Button
          type="submit"
          loading={updateTable.isPending}
          disabled={!attributesChanged}
        >
          {t("floorEditor.tableSave")}
        </Button>
      </form>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t("floorEditor.tableDeleteTitle", { code: table.code })}
        description={t("floorEditor.tableDeleteBody")}
        confirmLabel={t("floorEditor.tableDeleteConfirm")}
        pending={deleteTable.isPending}
        error={deleteError}
        onConfirm={remove}
      />
    </section>
  );
}

function TableInspector({ table, ...rest }: Props) {
  const t = useT();
  if (!table)
    return (
      <section className="grid h-fit gap-2 rounded-xl border-(length:--border-w) bg-card p-card">
        <span className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground">
          <MousePointerClick className="size-icon" aria-hidden="true" />
        </span>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("floorEditor.tableSelectHint")}
        </p>
      </section>
    );
  // Remount per table so the form always starts from the saved row.
  return <TableInspectorBody key={table.id} table={table} {...rest} />;
}

export { TableInspector };
