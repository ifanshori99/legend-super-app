// Add a table: number, capacity, type, size and its zone. The place on the
// plan is the first free slot the plan has (PRD §3 F9 "Meja": nomor,
// kapasitas, tipe, posisi), so a new table never lands on top of another.
import * as React from "react";
import {
  TABLE_TYPES,
  createTableInputSchema,
  tableTypeSchema,
} from "@starter/shared/qr-order";
import type { FloorZone, Table, TableType } from "@starter/shared/qr-order";
import type { ApiError } from "@/lib/api/errors";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, fieldErrors } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useCreateTable } from "../hooks";
import {
  findFreeSpot,
  sortZones,
  suggestTableCode,
  tablesOfZone,
} from "../lib";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zones: FloorZone[];
  tables: Table[];
  defaultZoneId?: string | null;
};

function TableFormBody({
  zones,
  tables,
  defaultZoneId,
  onClose,
}: Omit<Props, "open" | "onOpenChange"> & { onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const createTable = useCreateTable();
  const ordered = React.useMemo(() => sortZones(zones), [zones]);
  const [zoneId, setZoneId] = React.useState<string>(
    () => defaultZoneId ?? ordered[0]?.id ?? "",
  );
  const [code, setCode] = React.useState(() => {
    const initial = defaultZoneId ?? ordered[0]?.id ?? "";
    const index = ordered.findIndex((zone) => zone.id === initial);
    return suggestTableCode(
      tablesOfZone(tables, initial),
      index < 0 ? 0 : index,
    );
  });
  const [capacity, setCapacity] = React.useState("2");
  const [type, setType] = React.useState<TableType>("regular");
  const [shape, setShape] = React.useState<"rect" | "round">("rect");
  const [width, setWidth] = React.useState("60");
  const [height, setHeight] = React.useState("60");
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<ApiError | null>(null);

  const suggest = (nextZoneId: string) => {
    const index = ordered.findIndex((zone) => zone.id === nextZoneId);
    setCode(
      suggestTableCode(tablesOfZone(tables, nextZoneId), index < 0 ? 0 : index),
    );
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const spot = findFreeSpot(tables, {
      width: Number(width) || 60,
      height: Number(height) || 60,
    });
    const parsed = createTableInputSchema.safeParse({
      zoneId,
      code: code.trim(),
      capacity: Number(capacity),
      type,
      status: "available",
      layout: {
        x: spot.x,
        y: spot.y,
        width: Number(width) || 60,
        height: Number(height) || 60,
        rotation: 0,
        shape,
      },
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    createTable.mutate(parsed.data, {
      onSuccess: ({ data: table }) => {
        toast({
          title: t("floorEditor.tableAdded", { code: table.code }),
          tone: "success",
        });
        onClose();
      },
      onError: (error: Error) => setFormError(error as ApiError),
    });
  };

  return (
    <DialogContent>
      <form className="grid gap-4" onSubmit={submit} noValidate>
        <DialogHeader>
          <DialogTitle>{t("floorEditor.tableAddTitle")}</DialogTitle>
          <DialogDescription>
            {t("floorEditor.tableFreeSpot")}
          </DialogDescription>
        </DialogHeader>

        <FormField
          label={t("floorEditor.tableZone")}
          error={errors.zoneId}
          required
        >
          <Select
            value={zoneId}
            onValueChange={(value) => {
              setZoneId(value);
              suggest(value);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ordered.map((zone) => (
                <SelectItem key={zone.id} value={zone.id}>
                  {zone.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
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
        </div>

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

        <div className="grid gap-1.5">
          <span className="text-sm font-semibold">
            {t("floorEditor.tableShape")}
          </span>
          <SegmentedControl
            label={t("floorEditor.tableShape")}
            value={shape}
            onValueChange={setShape}
            options={[
              { value: "rect", label: t("floorEditor.shape.rect") },
              { value: "round", label: t("floorEditor.shape.round") },
            ]}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label={t("floorEditor.tableWidth")} error={errors.layout}>
            <Input
              type="number"
              inputMode="numeric"
              step={10}
              min={10}
              max={640}
              value={width}
              onChange={(event) => setWidth(event.target.value)}
            />
          </FormField>
          <FormField label={t("floorEditor.tableHeight")}>
            <Input
              type="number"
              inputMode="numeric"
              step={10}
              min={10}
              max={360}
              value={height}
              onChange={(event) => setHeight(event.target.value)}
            />
          </FormField>
        </div>

        {formError && (
          <p
            role="alert"
            className="rounded-control border-(length:--border-w) bg-danger-subtle p-3 text-sm leading-5 font-medium text-danger"
          >
            {formError.message}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={createTable.isPending}>
            {t("floorEditor.tableAdd")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function TableFormDialog({ open, onOpenChange, ...rest }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <TableFormBody {...rest} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

export { TableFormDialog };
