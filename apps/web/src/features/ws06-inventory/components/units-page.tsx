// Units and conversions screen (PRD §16 "satuan beli, satuan simpan, satuan
// resep dengan konversi"): the tenant's unit catalog plus one item's
// purchase→storage factors. The catalog is seeded per tenant; factors are
// edited per item.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { EmptyState } from "@/components/ui/feedback-state";
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
import { useInventoryItems, useUnits } from "../hooks";
import { LIST_LIMIT } from "../lib";
import { ConversionsEditor } from "./conversions-editor";

export function UnitsPage() {
  const t = useT();
  const unitsQuery = useUnits({ limit: LIST_LIMIT });
  const itemsQuery = useInventoryItems({ limit: LIST_LIMIT });

  const units = React.useMemo(
    () => unitsQuery.data?.data ?? [],
    [unitsQuery.data],
  );
  const items = React.useMemo(
    () => itemsQuery.data?.data ?? [],
    [itemsQuery.data],
  );
  const [selectedItemId, setSelectedItemId] = React.useState("");
  const selectedItem =
    items.find((item) => item.id === selectedItemId) ?? items[0];

  const state: DataState =
    unitsQuery.isPending || itemsQuery.isPending
      ? "loading"
      : unitsQuery.isError || itemsQuery.isError
        ? "error"
        : units.length === 0
          ? "empty"
          : "ready";

  const usedBy = (unitId: string) =>
    items.filter((item) => item.baseUomId === unitId).length;

  return (
    <div className="grid min-w-0 gap-4">
      <DataTableShell
        title={t("inventory.units.catalogTitle")}
        description={t("inventory.units.catalogHint")}
        state={state}
        onRetry={() => {
          void unitsQuery.refetch();
          void itemsQuery.refetch();
        }}
        rowCount={units.length}
        loadingRows={6}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("inventory.units.columns.code")}</TableHead>
              <TableHead>{t("inventory.units.columns.name")}</TableHead>
              <TableHead numeric>
                {t("inventory.units.columns.baseFor")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {units.map((unit) => (
              <TableRow key={unit.id}>
                <TableCell>
                  <Badge tone="neutral">{unit.code}</Badge>
                </TableCell>
                <TableCell className="font-medium">{unit.name}</TableCell>
                <TableCell numeric>
                  {t("inventory.units.baseFor", { count: usedBy(unit.id) })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>

      {state === "ready" && items.length === 0 && (
        <div className="rounded-container border bg-card">
          <EmptyState
            title={t("inventory.units.noItems")}
            description={t("inventory.units.noItemsHint")}
          />
        </div>
      )}

      {state === "ready" && selectedItem && (
        <section className="grid gap-4 rounded-container border bg-card p-card shadow-hairline">
          <div className="grid gap-2 sm:max-w-sm">
            <label
              className="text-sm font-semibold"
              htmlFor="units-item-picker"
            >
              {t("inventory.units.itemPicker")}
            </label>
            <Select value={selectedItem.id} onValueChange={setSelectedItemId}>
              <SelectTrigger id="units-item-picker">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventory.units.itemPickerHint")}
            </p>
          </div>
          <ConversionsEditor
            key={selectedItem.id}
            itemId={selectedItem.id}
            itemName={selectedItem.name}
            units={units}
          />
        </section>
      )}
    </div>
  );
}
