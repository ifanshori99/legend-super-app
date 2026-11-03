// Add one supplier catalog price (contract createSupplierCatalogItemInputSchema;
// PRD §6.E supplier_prices). A new row supersedes older rows from its
// effective date, so the date is part of the form.
import * as React from "react";
import { createSupplierCatalogItemInputSchema } from "@starter/shared/inventory";
import type { InventoryItem, Uom } from "@starter/shared/inventory";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useAttemptKey, useCreateSupplierCatalogItem } from "../supplier-hooks";
import { businessDateToday, parsePriceInput } from "../supplier-lib";

function SupplierCatalogForm({
  supplierId,
  items,
  units,
  onClose,
}: {
  supplierId: string;
  items: readonly InventoryItem[];
  units: readonly Uom[];
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateSupplierCatalogItem();
  const attempt = useAttemptKey();
  // The wrapper mounts this form only while open, so initial state is the reset.
  const [inventoryItemId, setInventoryItemId] = React.useState("");
  const [purchaseUomId, setPurchaseUomId] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [effectiveFrom, setEffectiveFrom] = React.useState(businessDateToday());
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string | null>(null);

  function selectItem(itemId: string) {
    setInventoryItemId(itemId);
    const item = items.find((row) => row.id === itemId);
    if (item && units.some((unit) => unit.id === item.baseUomId))
      setPurchaseUomId(item.baseUomId);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    setFormError(null);
    const priceIdr = parsePriceInput(price);
    if (priceIdr === null) {
      setErrors({ priceIdr: t("inventorySuppliers.form.invalid") });
      setFormError(t("inventorySuppliers.form.invalid"));
      return;
    }
    const payload = {
      inventoryItemId,
      purchaseUomId,
      priceIdr,
      effectiveFrom,
    };
    const parsed = createSupplierCatalogItemInputSchema.safeParse({
      ...payload,
      idempotencyKey: attempt.keyFor(payload),
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      setFormError(t("inventorySuppliers.catalog.saveError"));
      return;
    }
    try {
      await create.mutateAsync({ supplierId, body: parsed.data });
      attempt.settle();
      toast({
        title: t("inventorySuppliers.catalog.created"),
        description: t("inventorySuppliers.catalog.createdHint"),
        tone: "success",
      });
      onClose();
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.message.length > 0
          ? error.message
          : t("inventorySuppliers.catalog.saveError"),
      );
    }
  }

  const noItems = items.length === 0;

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("inventorySuppliers.catalog.dialogTitle")}</DialogTitle>
        <DialogDescription>
          {t("inventorySuppliers.catalog.dialogDescription")}
        </DialogDescription>
      </DialogHeader>
      {noItems ? (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("inventorySuppliers.catalog.dialogNoItems")}
        </p>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <FormField
            label={t("inventorySuppliers.catalog.dialogItem")}
            required
            error={errors.inventoryItemId}
          >
            <Select value={inventoryItemId} onValueChange={selectItem}>
              <SelectTrigger
                aria-label={t("inventorySuppliers.catalog.dialogItem")}
              >
                <SelectValue
                  placeholder={t(
                    "inventorySuppliers.catalog.dialogItemPlaceholder",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem
                    key={item.id}
                    value={item.id}
                    className="min-h-11"
                  >
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("inventorySuppliers.catalog.dialogUnit")}
            required
            hint={
              units.length === 0
                ? t("inventorySuppliers.catalog.dialogNoUnits")
                : undefined
            }
            error={errors.purchaseUomId}
          >
            <Select value={purchaseUomId} onValueChange={setPurchaseUomId}>
              <SelectTrigger
                aria-label={t("inventorySuppliers.catalog.dialogUnit")}
              >
                <SelectValue
                  placeholder={t(
                    "inventorySuppliers.catalog.dialogUnitPlaceholder",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {units.map((unit) => (
                  <SelectItem
                    key={unit.id}
                    value={unit.id}
                    className="min-h-11"
                  >
                    {unit.code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("inventorySuppliers.catalog.dialogPrice")}
            hint={t("inventorySuppliers.catalog.dialogPriceHint")}
            required
            error={errors.priceIdr}
          >
            <Input
              type="number"
              min="0"
              step="0.0001"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </FormField>
          <FormField
            label={t("inventorySuppliers.catalog.dialogEffectiveFrom")}
            required
            error={errors.effectiveFrom}
          >
            <Input
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </FormField>
          {formError && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {formError}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onClose()}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t("inventorySuppliers.catalog.dialogSubmit")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogContent>
  );
}

export function SupplierCatalogDialog({
  supplierId,
  items,
  units,
  open,
  onOpenChange,
}: {
  supplierId: string;
  items: readonly InventoryItem[];
  units: readonly Uom[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <SupplierCatalogForm
          supplierId={supplierId}
          items={items}
          units={units}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}
