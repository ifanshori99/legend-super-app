// Units and conversions screen (PRD §16 "satuan beli, satuan simpan, satuan
// resep dengan konversi"): the tenant's unit catalog plus one item's
// purchase→storage factors. The catalog is seeded per tenant; factors are
// edited per item.
import * as React from "react";
import { useRouteContext } from "@tanstack/react-router";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
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
import { UOM_COPY, canRenameUom, uomListState } from "../uom-state";
import { ConversionsEditor } from "./conversions-editor";
import { UomDialog, type UomEditor } from "./uom-dialog";

/** Writing a unit needs the same permission as the API route. */
function useCanManageUnits(): boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return context.access
    ? holdsAny(context.access, ["inventory.item.manage"])
    : false;
}

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

  const canManage = useCanManageUnits();
  const [editor, setEditor] = React.useState<UomEditor | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const state: DataState = uomListState({
    isPending: unitsQuery.isPending,
    isError: unitsQuery.isError,
    count: units.length,
  });
  const itemsReady = itemsQuery.isSuccess;

  function openEditor(next: UomEditor) {
    setNotice(null);
    setEditor(next);
  }

  // The inventory shell has no header-action slot, so the page hint and the
  // add button sit in this row, as in the mockup heading.
  const addButton = (variant: "default" | "outline", label: string) =>
    canManage ? (
      <Button
        type="button"
        variant={variant}
        onClick={() => openEditor({ mode: "new" })}
      >
        {label}
      </Button>
    ) : undefined;

  return (
    <div className="grid min-w-0 gap-4">
      <div>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {UOM_COPY.hint}
          </p>
          {addButton("default", UOM_COPY.add)}
        </div>
        {/* Persistent live region: it exists before the notice fills it. */}
        <div
          role="status"
          aria-live="polite"
          className={notice ? "mt-4" : undefined}
        >
          {notice && (
            <p className="rounded-container border-(length:--border-w) border-success bg-success-subtle p-4 text-sm leading-5 font-semibold text-foreground">
              {notice}
            </p>
          )}
        </div>
      </div>
      <DataTableShell
        title={UOM_COPY.listTitle}
        description={UOM_COPY.listHint}
        state={state}
        error={unitsQuery.error}
        errorCopy={{
          title: UOM_COPY.errorTitle,
          description: UOM_COPY.errorHint,
        }}
        onRetry={() => void unitsQuery.refetch()}
        empty={{
          title: UOM_COPY.emptyTitle,
          description: UOM_COPY.emptyHint,
          action: addButton("outline", UOM_COPY.emptyAction),
        }}
        rowCount={units.length}
        loadingRows={3}
      >
        {/* The scroll container lives in the shared Table: a focusable table keeps
            it keyboard-reachable even when every row action is locked. */}
        <Table
          tabIndex={0}
          aria-label={UOM_COPY.listTitle}
          className="focus-visible:shadow-focus focus-visible:outline-none"
        >
          <TableHeader>
            <TableRow>
              <TableHead>{t("inventory.units.columns.name")}</TableHead>
              <TableHead>{t("inventory.units.columns.code")}</TableHead>
              <TableHead>{UOM_COPY.columns.kind}</TableHead>
              <TableHead>{UOM_COPY.columns.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {units.map((unit) => (
              <TableRow key={unit.id}>
                <TableCell className="font-medium">{unit.name}</TableCell>
                <TableCell>
                  <span className="font-mono text-sm">{unit.code}</span>
                </TableCell>
                <TableCell>
                  <Badge tone="neutral">
                    {unit.isSystem ? UOM_COPY.kindSystem : UOM_COPY.kindTenant}
                  </Badge>
                </TableCell>
                <TableCell>
                  {!canRenameUom(unit) ? (
                    <span className="text-sm text-muted-foreground">
                      {UOM_COPY.locked}
                    </span>
                  ) : canManage ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={UOM_COPY.renameLabel(unit.name)}
                      onClick={() => openEditor({ mode: "edit", unit })}
                    >
                      {UOM_COPY.rename}
                    </Button>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {UOM_COPY.readOnlyNote}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTableShell>

      {state === "ready" && itemsQuery.isError && (
        <div className="rounded-container border bg-card">
          <ErrorState
            error={itemsQuery.error}
            onRetry={() => void itemsQuery.refetch()}
          />
        </div>
      )}

      {state === "ready" && itemsReady && items.length === 0 && (
        <div className="rounded-container border bg-card">
          <EmptyState
            title={t("inventory.units.noItems")}
            description={t("inventory.units.noItemsHint")}
          />
        </div>
      )}

      {state === "ready" && itemsReady && selectedItem && (
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

      {editor && (
        <UomDialog
          key={editor.mode === "edit" ? editor.unit.id : "new"}
          editor={editor}
          existing={units}
          onClose={() => setEditor(null)}
          onSaved={(mode) => {
            setEditor(null);
            setNotice(
              mode === "edit" ? UOM_COPY.renamedNotice : UOM_COPY.createdNotice,
            );
          }}
        />
      )}
    </div>
  );
}
