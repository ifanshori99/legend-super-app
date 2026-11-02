// Create a stock-count session (PRD §16 "Stok Opname", Alur J step 1). A full
// count snapshots every active item; a cycle count narrows the item set. The
// session starts as a draft so the counter can begin when the shelf is ready.
import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import type { StockCountType } from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useCreateStockCount, useInventoryItems, useStockLocations, useUnits } from "../hooks";
import { INVENTORY_OUTLET_ID } from "../outlet";
import { businessDateToday, typeLabelKey } from "../opname-lib";

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function CountFormDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const locations = useStockLocations();
  const items = useInventoryItems();
  const units = useUnits();
  const createCount = useCreateStockCount();

  const [locationId, setLocationId] = React.useState("");
  const [type, setType] = React.useState<StockCountType>("full");
  const [blind, setBlind] = React.useState(true);
  const [businessDate, setBusinessDate] = React.useState(() =>
    businessDateToday(),
  );
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [search, setSearch] = React.useState("");
  const [note, setNote] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>(
    {},
  );
  const [formError, setFormError] = React.useState<string>();
  const idempotencyKey = React.useRef(crypto.randomUUID());

  const locationRows = React.useMemo(
    () => locations.data?.data ?? [],
    [locations.data],
  );
  const unitCode = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const unit of units.data?.data ?? []) map.set(unit.id, unit.code);
    return map;
  }, [units.data]);
  const activeItems = React.useMemo(
    () =>
      (items.data?.data ?? [])
        .filter((item) => item.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID")),
    [items.data],
  );
  const filteredItems = React.useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("id-ID");
    if (needle === "") return activeItems;
    return activeItems.filter((item) =>
      item.name.toLocaleLowerCase("id-ID").includes(needle),
    );
  }, [activeItems, search]);

  React.useEffect(() => {
    if (!open) return;
    idempotencyKey.current = crypto.randomUUID();
  }, [open]);

  React.useEffect(() => {
    if (!open || locationId !== "") return;
    const first = locationRows[0];
    if (first) setLocationId(first.id);
  }, [open, locationId, locationRows]);

  function toggleItem(itemId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string | undefined> = {};
    if (locationId === "")
      nextErrors.location = t("opname.create.errorLocation");
    if (type === "cycle" && selected.size === 0)
      nextErrors.items = t("opname.create.errorItems");
    if (businessDate === "")
      nextErrors.businessDate = t("opname.create.errorDate");
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;

    setFormError(undefined);
    createCount.mutate(
      {
        outletId: INVENTORY_OUTLET_ID,
        locationId,
        type,
        blind,
        businessDate,
        inventoryItemIds: type === "cycle" ? [...selected] : undefined,
        note: note.trim() === "" ? null : note.trim(),
        idempotencyKey: idempotencyKey.current,
      },
      {
        onSuccess: (detail) => {
          toast({
            title: t("opname.create.successTitle"),
            description: t("opname.create.successBody"),
            tone: "success",
          });
          onOpenChange(false);
          setSelected(new Set());
          setSearch("");
          setNote("");
          void navigate({
            to: "/kelola/inventori/opname/$countId",
            params: { countId: detail.count.id },
          });
        },
        onError: (error) =>
          setFormError(errorText(error, t("opname.create.errorSubmit"))),
      },
    );
  }

  const locationField = errors.location;
  const itemsField = errors.items;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("opname.create.title")}</DialogTitle>
          <DialogDescription>{t("opname.create.description")}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <FormField
            label={t("opname.create.location")}
            id="count-location"
            error={locationField}
            required
          >
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger id="count-location">
                <SelectValue placeholder={t("opname.create.locationPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {locationRows.map((location) => (
                  <SelectItem key={location.id} value={location.id}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {locationRows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("opname.create.noLocations")}
            </p>
          )}

          <FormField label={t("opname.create.type")} required>
            <SegmentedControl
              value={type}
              onValueChange={(value) => setType(value)}
              label={t("opname.create.type")}
              options={[
                { value: "full", label: t(typeLabelKey("full")) },
                { value: "cycle", label: t(typeLabelKey("cycle")) },
              ]}
            />
          </FormField>
          <p className="-mt-2 text-sm text-muted-foreground">
            {t(
              type === "full"
                ? "opname.typeHint.full"
                : "opname.typeHint.cycle",
            )}
          </p>

          <div className="flex items-start justify-between gap-4 rounded-xl border p-3">
            <div className="grid gap-0.5">
              <Label htmlFor="count-blind">{t("opname.create.blind")}</Label>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("opname.create.blindHint")}
              </p>
            </div>
            <Switch
              id="count-blind"
              checked={blind}
              onCheckedChange={setBlind}
            />
          </div>

          <FormField
            label={t("opname.create.businessDate")}
            id="count-date"
            hint={t("opname.create.businessDateHint")}
            error={errors.businessDate}
            required
          >
            <Input
              id="count-date"
              type="date"
              value={businessDate}
              onChange={(event) => setBusinessDate(event.target.value)}
            />
          </FormField>

          {type === "cycle" ? (
            <fieldset className="grid gap-2">
              <legend className="text-sm leading-5 font-semibold">
                {t("opname.create.items")}
              </legend>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("opname.create.itemsHint")}
              </p>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-icon -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("opname.create.itemSearch")}
                  aria-label={t("opname.create.itemSearch")}
                  className="h-control-sm pl-10"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm tabular text-muted-foreground">
                  {t("opname.create.selectedCount", { count: selected.size })}
                </span>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setSelected(
                        (current) =>
                          new Set([...current, ...filteredItems.map((i) => i.id)]),
                      )
                    }
                  >
                    {t("opname.create.selectAll")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelected(new Set())}
                  >
                    {t("opname.create.clearAll")}
                  </Button>
                </div>
              </div>
              <ul className="max-h-56 divide-y overflow-y-auto rounded-xl border">
                {filteredItems.map((item) => (
                  <li
                    key={item.id}
                    className="flex min-h-control items-center gap-3 px-3 py-1"
                  >
                    <Checkbox
                      id={`count-item-${item.id}`}
                      checked={selected.has(item.id)}
                      onCheckedChange={(checked) =>
                        toggleItem(item.id, checked === true)
                      }
                    />
                    <Label
                      htmlFor={`count-item-${item.id}`}
                      className="flex min-w-0 flex-1 items-baseline justify-between gap-3 font-normal"
                    >
                      <span className="truncate">{item.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {unitCode.get(item.baseUomId) ?? ""}
                      </span>
                    </Label>
                  </li>
                ))}
              </ul>
              {filteredItems.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("opname.create.noItems")}
                </p>
              )}
              {itemsField && (
                <p role="alert" className="text-sm font-medium text-danger">
                  {itemsField}
                </p>
              )}
            </fieldset>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("opname.create.fullCount", { count: activeItems.length })}
            </p>
          )}

          <FormField
            label={t("opname.create.note")}
            id="count-note"
            hint={t("opname.create.noteHint")}
          >
            <Textarea
              id="count-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={300}
              rows={2}
            />
          </FormField>

          {formError && (
            <p role="alert" className="text-sm font-medium text-danger">
              {formError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={createCount.isPending}
              disabled={locationRows.length === 0 || activeItems.length === 0}
            >
              {t("opname.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
