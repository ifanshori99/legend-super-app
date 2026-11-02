// Stock locations (PRD §16 "Gudang utama, chiller, freezer, bar, dapur, dan
// pastry per outlet"): the six location types, their stock summary, and
// activation. Adding a location and renaming one stay in a dialog; the list
// shows the derived stock value from the balances.
import * as React from "react";
import { Pencil, Plus, Power, PowerOff } from "lucide-react";
import { z } from "zod";
import type { MessageKey } from "@starter/shared/i18n";
import type {
  StockLocation,
  StockLocationType,
} from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fieldErrors, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
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
import { ApiError } from "@/lib/api/errors";
import {
  useCreateStockLocation,
  useStockBalances,
  useStockLocations,
  useUpdateStockLocation,
} from "../hooks";
import { locationStock } from "../lib";
import { INVENTORY_OUTLET_ID } from "../outlet";

const LOCATION_TYPES: StockLocationType[] = [
  "warehouse",
  "chiller",
  "freezer",
  "bar",
  "kitchen",
  "pastry",
];

const TYPE_LABEL: Record<StockLocationType, MessageKey> = {
  warehouse: "inventory.locationTypes.warehouse",
  chiller: "inventory.locationTypes.chiller",
  freezer: "inventory.locationTypes.freezer",
  bar: "inventory.locationTypes.bar",
  kitchen: "inventory.locationTypes.kitchen",
  pastry: "inventory.locationTypes.pastry",
};

type Editor = { mode: "new" } | { mode: "edit"; location: StockLocation };

function LocationDialog({
  editor,
  onClose,
}: {
  editor: Editor;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const createLocation = useCreateStockLocation();
  const updateLocation = useUpdateStockLocation();
  const editing = editor.mode === "edit" ? editor.location : null;

  const [name, setName] = React.useState(editing?.name ?? "");
  const [type, setType] = React.useState<StockLocationType>(
    editing?.type ?? "warehouse",
  );
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string | undefined>();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = z
      .object({
        name: z
          .string()
          .trim()
          .min(1, t("inventory.errors.required"))
          .max(150, t("inventory.errors.tooLong", { max: 150 })),
      })
      .safeParse({ name });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }
    setErrors({});
    setFormError(undefined);
    const onError = (error: unknown) =>
      setFormError(
        error instanceof ApiError
          ? error.message
          : t("inventory.errors.saveFailed"),
      );
    if (editing) {
      updateLocation.mutate(
        {
          params: { locationId: editing.id },
          body: { name: parsed.data.name, type },
        },
        {
          onSuccess: () => {
            toast({ title: t("inventory.locations.saved"), tone: "success" });
            onClose();
          },
          onError,
        },
      );
      return;
    }
    createLocation.mutate(
      {
        outletId: INVENTORY_OUTLET_ID,
        name: parsed.data.name,
        type,
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: () => {
          toast({ title: t("inventory.locations.created"), tone: "success" });
          onClose();
        },
        onError,
      },
    );
  }

  const pending = createLocation.isPending || updateLocation.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t("inventory.locations.editorEdit")
              : t("inventory.locations.editorCreate")}
          </DialogTitle>
          <DialogDescription>
            {t("inventory.locations.activeHint")}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <FormField
            label={t("inventory.locations.fields.name")}
            error={errors.name}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <FormField label={t("inventory.locations.fields.type")} required>
            <Select
              value={type}
              onValueChange={(value) => setType(value as StockLocationType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCATION_TYPES.map((locationType) => (
                  <SelectItem key={locationType} value={locationType}>
                    {t(TYPE_LABEL[locationType])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {formError && (
            <p
              role="alert"
              className="rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
            >
              {formError}
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
            <Button type="submit" loading={pending}>
              {t("inventory.locations.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LocationsPage() {
  const t = useT();
  const toast = useToast();
  const locationsQuery = useStockLocations();
  const balancesQuery = useStockBalances();
  const updateLocation = useUpdateStockLocation();
  const [editor, setEditor] = React.useState<Editor | null>(null);

  const locations = React.useMemo(
    () => locationsQuery.data?.data ?? [],
    [locationsQuery.data],
  );
  const balances = React.useMemo(
    () => balancesQuery.data?.data ?? [],
    [balancesQuery.data],
  );
  const rows = React.useMemo(
    () => locationStock(locations, balances),
    [locations, balances],
  );

  const state: DataState =
    locationsQuery.isPending || balancesQuery.isPending
      ? "loading"
      : locationsQuery.isError || balancesQuery.isError
        ? "error"
        : locations.length === 0
          ? "empty"
          : "ready";

  function toggleActive(location: StockLocation) {
    updateLocation.mutate(
      {
        params: { locationId: location.id },
        body: { isActive: !location.isActive },
      },
      {
        onSuccess: () =>
          toast({ title: t("inventory.locations.saved"), tone: "success" }),
        onError: (error) =>
          toast({
            title:
              error instanceof ApiError
                ? error.message
                : t("inventory.errors.saveFailed"),
            tone: "danger",
          }),
      },
    );
  }

  return (
    <>
      <DataTableShell
        title={t("inventory.locations.title")}
        description={t("inventory.locations.description")}
        state={state}
        onRetry={() => {
          void locationsQuery.refetch();
          void balancesQuery.refetch();
        }}
        actions={
          <Button type="button" onClick={() => setEditor({ mode: "new" })}>
            <Plus aria-hidden="true" />
            {t("inventory.locations.add")}
          </Button>
        }
        rowCount={rows.length}
        empty={{
          title: t("inventory.locations.empty"),
          description: t("inventory.locations.emptyHint"),
          action: (
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditor({ mode: "new" })}
            >
              <Plus aria-hidden="true" />
              {t("inventory.locations.add")}
            </Button>
          ),
        }}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("inventory.locations.columns.name")}</TableHead>
              <TableHead>{t("inventory.locations.columns.type")}</TableHead>
              <TableHead numeric>
                {t("inventory.locations.columns.stock")}
              </TableHead>
              <TableHead numeric>
                {t("inventory.locations.columns.value")}
              </TableHead>
              <TableHead>{t("inventory.locations.columns.status")}</TableHead>
              <TableHead className="text-right">
                {t("inventory.list.columns.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ location, itemCount, valueIdr }) => (
              <TableRow key={location.id}>
                <TableCell className="min-w-40 font-medium">
                  {location.name}
                </TableCell>
                <TableCell>{t(TYPE_LABEL[location.type])}</TableCell>
                <TableCell numeric>
                  {itemCount === 0
                    ? t("inventory.locations.noStock")
                    : t("inventory.locations.itemsCount", {
                        count: itemCount,
                      })}
                </TableCell>
                <TableCell numeric>
                  <Money amount={valueIdr} />
                </TableCell>
                <TableCell>
                  <Badge tone={location.isActive ? "success" : "neutral"}>
                    {location.isActive
                      ? t("inventory.active.yes")
                      : t("inventory.active.no")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${t("inventory.locations.edit")}: ${location.name}`}
                      onClick={() => setEditor({ mode: "edit", location })}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${
                        location.isActive
                          ? t("inventory.locations.deactivate")
                          : t("inventory.locations.activate")
                      }: ${location.name}`}
                      disabled={updateLocation.isPending}
                      onClick={() => toggleActive(location)}
                    >
                      {location.isActive ? (
                        <PowerOff aria-hidden="true" />
                      ) : (
                        <Power aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>
      {editor && (
        <LocationDialog
          key={editor.mode === "edit" ? editor.location.id : "new"}
          editor={editor}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );
}
