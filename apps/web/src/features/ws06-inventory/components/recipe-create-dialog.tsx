// Create a recipe (PRD v1.7 §17 "Resep Bertingkat", §3 F17). The contract
// requires at least one BOM line (`createRecipeInputSchema.lines.min(1)`), so
// the dialog collects the identity plus the first component; the rest of the
// BOM is edited on the recipe screen it opens.
import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
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
import { FormField } from "@/components/ui/form-field";
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
import { useInventoryItems, useUnits } from "../hooks";
import { LIST_LIMIT, quantityFromInput } from "../lib";
import { RECIPE_BRAND_ID } from "../recipe-lib";
import { useCreateRecipe } from "../recipe-hooks";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

const MENU_OUTPUT = "none";

export function RecipeCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const itemsQuery = useInventoryItems({ limit: LIST_LIMIT });
  const unitsQuery = useUnits({ limit: LIST_LIMIT });
  const createRecipe = useCreateRecipe();

  const [name, setName] = React.useState("");
  const [outputItemId, setOutputItemId] = React.useState(MENU_OUTPUT);
  const [yieldQuantity, setYieldQuantity] = React.useState("1");
  const [yieldUomId, setYieldUomId] = React.useState("");
  const [componentId, setComponentId] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [componentUomId, setComponentUomId] = React.useState("");
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string>();
  const idempotencyKey = React.useRef(newIdempotencyKey());

  const items = React.useMemo(
    () =>
      [...(itemsQuery.data?.data ?? [])]
        .filter((item) => item.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID")),
    [itemsQuery.data],
  );
  const units = React.useMemo(
    () => unitsQuery.data?.data ?? [],
    [unitsQuery.data],
  );
  const semiFinished = React.useMemo(
    () => items.filter((item) => item.type === "semi_finished"),
    [items],
  );
  const effectiveYieldUomId =
    yieldUomId !== ""
      ? yieldUomId
      : (units.find((unit) => unit.code === "pcs")?.id ?? units[0]?.id ?? "");
  const component = items.find((item) => item.id === componentId);
  const effectiveComponentUomId =
    componentUomId !== ""
      ? componentUomId
      : (component?.baseUomId ?? units[0]?.id ?? "");

  // A new dialog is a new attempt: closing rotates the key, while a retry
  // inside one open dialog reuses it so a timeout cannot create two recipes.
  function handleOpenChange(next: boolean) {
    if (!next) idempotencyKey.current = newIdempotencyKey();
    onOpenChange(next);
  }

  function selectComponent(nextId: string) {
    setComponentId(nextId);
    const next = items.find((item) => item.id === nextId);
    setComponentUomId(next?.baseUomId ?? "");
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalizedYield = quantityFromInput(yieldQuantity);
    const normalizedQuantity = quantityFromInput(quantity);
    const nextErrors: Record<string, string | undefined> = {};
    if (name.trim() === "")
      nextErrors.name = t("inventoryRecipe.create.errorName");
    if (normalizedYield === null)
      nextErrors.yieldQuantity = t("inventoryRecipe.create.errorYieldQuantity");
    if (effectiveYieldUomId === "")
      nextErrors.yieldUomId = t("inventoryRecipe.create.errorYieldUnit");
    if (componentId === "")
      nextErrors.componentId = t("inventoryRecipe.create.errorComponent");
    if (normalizedQuantity === null)
      nextErrors.quantity = t("inventoryRecipe.create.errorQuantity");
    if (effectiveComponentUomId === "")
      nextErrors.componentUomId = t("inventoryRecipe.create.errorUnit");
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    if (normalizedYield === null || normalizedQuantity === null) return;

    setFormError(undefined);
    createRecipe.mutate(
      {
        body: {
          brandId: RECIPE_BRAND_ID,
          name: name.trim(),
          outputItemId: outputItemId === MENU_OUTPUT ? null : outputItemId,
          yieldQuantity: normalizedYield,
          yieldUomId: effectiveYieldUomId,
          lines: [
            {
              componentType: "item",
              componentId,
              quantity: normalizedQuantity,
              uomId: effectiveComponentUomId,
              wastePctBp: 0,
            },
          ],
          idempotencyKey: idempotencyKey.current,
        },
        idempotencyKey: idempotencyKey.current,
      },
      {
        onSuccess: (detail) => {
          // The next "Resep baru" is a different document: a fresh key keeps
          // the mock/API from replaying this recipe for it.
          idempotencyKey.current = newIdempotencyKey();
          toast({
            title: t("inventoryRecipe.create.successTitle"),
            description: t("inventoryRecipe.create.successBody"),
            tone: "success",
          });
          onOpenChange(false);
          void navigate({
            to: "/kelola/inventori/resep/$recipeId",
            params: { recipeId: detail.recipe.id },
          });
        },
        onError: (error) =>
          setFormError(
            error instanceof ApiError
              ? error.message
              : t("inventoryRecipe.create.errorSubmit"),
          ),
      },
    );
  }

  const loading = itemsQuery.isPending || unitsQuery.isPending;
  const failed = itemsQuery.isError || unitsQuery.isError;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("inventoryRecipe.create.title")}</DialogTitle>
          <DialogDescription>
            {t("inventoryRecipe.create.description")}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <FormField
            label={t("inventoryRecipe.create.name")}
            hint={t("inventoryRecipe.create.nameHint")}
            error={errors.name}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              maxLength={150}
            />
          </FormField>

          <FormField
            label={t("inventoryRecipe.create.output")}
            hint={t("inventoryRecipe.create.outputHint")}
          >
            <Select value={outputItemId} onValueChange={setOutputItemId}>
              <SelectTrigger aria-label={t("inventoryRecipe.create.output")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MENU_OUTPUT}>
                  {t("inventoryRecipe.create.outputMenu")}
                </SelectItem>
                {semiFinished.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {semiFinished.length === 0 && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryRecipe.create.noSemiFinished")}
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("inventoryRecipe.create.yieldQuantity")}
              hint={t("inventoryRecipe.create.yieldQuantityHint")}
              error={errors.yieldQuantity}
              required
            >
              <Input
                value={yieldQuantity}
                onChange={(event) => setYieldQuantity(event.target.value)}
                inputMode="decimal"
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={t("inventoryRecipe.create.yieldUnit")}
              error={errors.yieldUomId}
              required
            >
              <Select value={effectiveYieldUomId} onValueChange={setYieldUomId}>
                <SelectTrigger
                  aria-label={t("inventoryRecipe.create.yieldUnit")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {units.map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.code} — {unit.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <fieldset className="grid gap-3 rounded-container border p-3">
            <legend className="px-1 text-sm leading-5 font-semibold">
              {t("inventoryRecipe.create.firstLineTitle")}
            </legend>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryRecipe.create.firstLineHint")}
            </p>
            <FormField
              label={t("inventoryRecipe.create.component")}
              error={errors.componentId}
              required
            >
              <Select value={componentId} onValueChange={selectComponent}>
                <SelectTrigger
                  aria-label={t("inventoryRecipe.create.component")}
                >
                  <SelectValue
                    placeholder={t(
                      "inventoryRecipe.create.componentPlaceholder",
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t("inventoryRecipe.create.quantity")}
                error={errors.quantity}
                required
              >
                <Input
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                />
              </FormField>
              <FormField
                label={t("inventoryRecipe.create.unit")}
                error={errors.componentUomId}
                required
              >
                <Select
                  value={effectiveComponentUomId}
                  onValueChange={setComponentUomId}
                >
                  <SelectTrigger aria-label={t("inventoryRecipe.create.unit")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {units.map((unit) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {unit.code} — {unit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
          </fieldset>

          {items.length === 0 && !loading && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryRecipe.create.noItems")}
            </p>
          )}
          {failed && (
            <p role="alert" className="text-sm font-medium text-danger">
              {t("inventoryRecipe.errors.load")}
            </p>
          )}
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
              loading={createRecipe.isPending}
              disabled={loading || items.length === 0}
            >
              {t("inventoryRecipe.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
