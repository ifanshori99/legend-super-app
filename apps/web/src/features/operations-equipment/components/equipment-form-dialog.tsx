// Create/edit an equipment row (PRD v1.7 §3 F41 "Peralatan & Perawatan").
// The contract's equipment schema has name, category, asset link, linked menu
// items and the chiller/freezer temperature threshold only; serial number,
// purchase date, warranty, location and notes have no field yet (reported as a
// follow-up gap, not invented here). Linked menu items are the OPS-04 mapping.
import * as React from "react";
import {
  createEquipmentInputSchema,
  temperatureThresholdSchema,
  updateEquipmentInputSchema,
  type Equipment,
  type EquipmentCategory,
  type TemperatureThreshold,
} from "@starter/shared/operations";
import type { MenuItemAdmin } from "@starter/shared/menu";
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
  DialogTrigger,
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
import { useToast } from "@/components/ui/toast";
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_CATEGORY_KEYS,
  toDecimal4,
} from "../lib.ts";
import {
  useAttemptKey,
  useCreateEquipment,
  useUpdateEquipment,
} from "../hooks.ts";

export function EquipmentFormDialog({
  outletId,
  menuItems,
  menuItemsLoading,
  menuItemsFailed,
  equipment,
  trigger,
}: {
  outletId: string;
  menuItems: readonly MenuItemAdmin[];
  menuItemsLoading: boolean;
  menuItemsFailed: boolean;
  /** Present for edit mode. */
  equipment?: Equipment;
  trigger: React.ReactElement;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateEquipment();
  const update = useUpdateEquipment();
  const attempt = useAttemptKey();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(equipment?.name ?? "");
  const [category, setCategory] = React.useState<EquipmentCategory>(
    equipment?.category ?? "other",
  );
  const [minCelsius, setMinCelsius] = React.useState(
    equipment?.temperatureThreshold?.minCelsius ?? "",
  );
  const [maxCelsius, setMaxCelsius] = React.useState(
    equipment?.temperatureThreshold?.maxCelsius ?? "",
  );
  const [linkedMenuIds, setLinkedMenuIds] = React.useState<string[]>(
    equipment?.linkedMenuItemIds ?? [],
  );
  const [menuFilter, setMenuFilter] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    // Reset the dialog each time it opens (React lint flags setState in an
    // effect; the dialog state intentionally starts from the row).
    /* eslint-disable react-hooks/set-state-in-effect */
    setName(equipment?.name ?? "");
    setCategory(equipment?.category ?? "other");
    setMinCelsius(equipment?.temperatureThreshold?.minCelsius ?? "");
    setMaxCelsius(equipment?.temperatureThreshold?.maxCelsius ?? "");
    setLinkedMenuIds(equipment?.linkedMenuItemIds ?? []);
    setMenuFilter("");
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, equipment]);

  const visibleMenus = menuItems.filter((item) =>
    menuFilter.trim()
      ? item.name
          .toLocaleLowerCase("id-ID")
          .includes(menuFilter.trim().toLocaleLowerCase("id-ID"))
      : true,
  );

  function toggleMenu(id: string, checked: boolean) {
    setLinkedMenuIds((current) =>
      checked ? [...current, id] : current.filter((item) => item !== id),
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const hasMin = minCelsius.trim().length > 0;
    const hasMax = maxCelsius.trim().length > 0;
    if (hasMin !== hasMax) {
      setError(t("opsEquipment.equipment.form.thresholdInvalid"));
      return;
    }
    let temperatureThreshold: TemperatureThreshold | null = null;
    if (hasMin && hasMax) {
      const threshold = temperatureThresholdSchema.safeParse({
        minCelsius: toDecimal4(minCelsius),
        maxCelsius: toDecimal4(maxCelsius),
      });
      if (!threshold.success) {
        setError(t("opsEquipment.equipment.form.thresholdInvalid"));
        return;
      }
      temperatureThreshold = threshold.data;
    }
    const payload = {
      name,
      category,
      linkedMenuItemIds: linkedMenuIds,
      temperatureThreshold,
    };
    try {
      // Parse inside each branch: the create and update inputs have different
      // required fields, so their parsed unions must not be mixed.
      if (equipment) {
        const parsed = updateEquipmentInputSchema.safeParse({
          ...payload,
          expectedUpdatedAt: equipment.updatedAt,
          idempotencyKey: attempt.keyFor({
            equipmentId: equipment.id,
            ...payload,
          }),
        });
        if (!parsed.success) {
          setError(t("opsEquipment.equipment.form.invalid"));
          return;
        }
        await update.mutateAsync({
          equipmentId: equipment.id,
          body: parsed.data,
        });
      } else {
        const parsed = createEquipmentInputSchema.safeParse({
          ...payload,
          outletId,
          idempotencyKey: attempt.keyFor(payload),
        });
        if (!parsed.success) {
          setError(t("opsEquipment.equipment.form.invalid"));
          return;
        }
        await create.mutateAsync(parsed.data);
      }
      attempt.settle();
      toast({
        title: t(
          equipment
            ? "opsEquipment.equipment.toasts.updated"
            : "opsEquipment.equipment.toasts.created",
        ),
        tone: "success",
      });
      setOpen(false);
    } catch {
      setError(t("opsEquipment.errors.action"));
    }
  }

  const busy = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t(
              equipment
                ? "opsEquipment.equipment.form.editTitle"
                : "opsEquipment.equipment.form.createTitle",
            )}
          </DialogTitle>
          <DialogDescription>
            {t("opsEquipment.equipment.form.linkedMenusHint")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <FormField label={t("opsEquipment.equipment.form.name")} required>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <FormField label={t("opsEquipment.equipment.form.category")} required>
            <Select
              value={category}
              onValueChange={(value) => setCategory(value as EquipmentCategory)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EQUIPMENT_CATEGORIES.map((value) => (
                  <SelectItem key={value} value={value} className="min-h-11">
                    {t(EQUIPMENT_CATEGORY_KEYS[value])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <fieldset className="grid gap-3 rounded-container border border-border p-3">
            <legend className="px-1 text-sm font-semibold">
              {t("opsEquipment.equipment.form.temperature")}
            </legend>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("opsEquipment.equipment.form.temperatureHint")}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t("opsEquipment.equipment.form.minCelsius")}>
                <Input
                  type="number"
                  step="0.1"
                  value={minCelsius}
                  onChange={(event) => setMinCelsius(event.target.value)}
                />
              </FormField>
              <FormField label={t("opsEquipment.equipment.form.maxCelsius")}>
                <Input
                  type="number"
                  step="0.1"
                  value={maxCelsius}
                  onChange={(event) => setMaxCelsius(event.target.value)}
                />
              </FormField>
            </div>
          </fieldset>
          <fieldset className="grid gap-3 rounded-container border border-border p-3">
            <legend className="px-1 text-sm font-semibold">
              {t("opsEquipment.equipment.form.linkedMenus")}
            </legend>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("opsEquipment.equipment.form.linkedMenusHint")}
            </p>
            {menuItemsLoading ? (
              <p className="text-sm text-muted-foreground">
                {t("opsEquipment.equipment.form.menusLoading")}
              </p>
            ) : menuItemsFailed ? (
              <p className="text-sm text-danger">
                {t("opsEquipment.equipment.form.menusFailed")}
              </p>
            ) : menuItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("opsEquipment.equipment.form.menusEmpty")}
              </p>
            ) : (
              <>
                <Input
                  type="search"
                  value={menuFilter}
                  onChange={(event) => setMenuFilter(event.target.value)}
                  placeholder={t("opsEquipment.equipment.searchPlaceholder")}
                  aria-label={t("opsEquipment.equipment.form.linkedMenus")}
                  className="h-control-sm"
                />
                <div className="grid max-h-64 gap-2 overflow-y-auto rounded-field border border-border p-3">
                  {visibleMenus.map((item) => (
                    <div key={item.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`equipment-menu-${item.id}`}
                        checked={linkedMenuIds.includes(item.id)}
                        onCheckedChange={(checked) =>
                          toggleMenu(item.id, checked === true)
                        }
                      />
                      <Label
                        htmlFor={`equipment-menu-${item.id}`}
                        className="font-normal"
                      >
                        {item.name}
                      </Label>
                    </div>
                  ))}
                </div>
              </>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" loading={busy}>
              {t(
                equipment
                  ? "opsEquipment.equipment.form.saveEdit"
                  : "opsEquipment.equipment.form.saveCreate",
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
