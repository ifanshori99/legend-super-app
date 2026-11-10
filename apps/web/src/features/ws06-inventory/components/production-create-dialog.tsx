// Create a production batch order (PRD v1.7 §17 "Produksi Batch", §3 F17).
// Only recipes with a semi-finished output item can be produced; the planned
// quantity is in the recipe's yield unit.
import * as React from "react";
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
import { useTenantContext } from "@/lib/tenant-context";
import { quantityFromInput, uomCode } from "../lib";
import {
  useAttemptKey,
  useCreateProductionOrder,
  useRecipes,
} from "../recipe-hooks";
import { useUnits } from "../hooks";

export function ProductionCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const { outlet } = useTenantContext();
  const recipesQuery = useRecipes();
  const unitsQuery = useUnits({ limit: 100 });
  const createOrder = useCreateProductionOrder();
  const attempt = useAttemptKey();

  const [recipeId, setRecipeId] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [formError, setFormError] = React.useState<string>();

  const recipes = React.useMemo(
    () =>
      [...(recipesQuery.data?.data ?? [])]
        .filter((recipe) => recipe.outputItemId !== null && recipe.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID")),
    [recipesQuery.data],
  );
  const units = React.useMemo(
    () => unitsQuery.data?.data ?? [],
    [unitsQuery.data],
  );
  const effectiveRecipeId = recipeId !== "" ? recipeId : (recipes[0]?.id ?? "");
  const recipe = recipes.find((row) => row.id === effectiveRecipeId);

  function handleOpenChange(next: boolean) {
    if (next) {
      attempt.settle();
      setErrors({});
      setFormError(undefined);
    }
    onOpenChange(next);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const planned = quantityFromInput(quantity);
    const nextErrors: Record<string, string | undefined> = {};
    if (effectiveRecipeId === "")
      nextErrors.recipeId = t("inventoryRecipe.production.create.errorRecipe");
    if (planned === null)
      nextErrors.quantity = t(
        "inventoryRecipe.production.create.errorQuantity",
      );
    setErrors(nextErrors);
    if (!outlet) return;
    if (Object.values(nextErrors).some(Boolean) || planned === null) return;
    setFormError(undefined);
    const payload = {
      outletId: outlet.id,
      recipeId: effectiveRecipeId,
      plannedQty: planned,
    };
    createOrder.mutate(
      {
        body: { ...payload, idempotencyKey: attempt.keyFor(payload) },
        idempotencyKey: attempt.keyFor(payload),
      },
      {
        onSuccess: () => {
          attempt.settle();
          toast({
            title: t("inventoryRecipe.production.create.successTitle"),
            description: t("inventoryRecipe.production.create.successBody"),
            tone: "success",
          });
          setQuantity("");
          onOpenChange(false);
        },
        onError: (error) =>
          setFormError(
            error instanceof ApiError
              ? error.message
              : t("inventoryRecipe.production.create.errorSubmit"),
          ),
      },
    );
  }

  const pending = recipesQuery.isPending || unitsQuery.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("inventoryRecipe.production.create.title")}
          </DialogTitle>
          <DialogDescription>
            {t("inventoryRecipe.production.create.description")}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <FormField
            label={t("inventoryRecipe.production.create.recipe")}
            hint={t("inventoryRecipe.production.create.recipeHint")}
            error={errors.recipeId}
            required
          >
            <Select value={effectiveRecipeId} onValueChange={setRecipeId}>
              <SelectTrigger
                aria-label={t("inventoryRecipe.production.create.recipe")}
              >
                <SelectValue
                  placeholder={t(
                    "inventoryRecipe.production.create.recipePlaceholder",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {recipes.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {recipes.length === 0 && !pending && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryRecipe.production.create.emptyRecipes")}
            </p>
          )}
          <FormField
            label={t("inventoryRecipe.production.create.quantity")}
            hint={
              recipe
                ? `${t("inventoryRecipe.production.create.quantityHint")} (${uomCode(units, recipe.yieldUomId)})`
                : t("inventoryRecipe.production.create.quantityHint")
            }
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
              loading={createOrder.isPending}
              disabled={pending || recipes.length === 0 || !outlet}
            >
              {t("inventoryRecipe.production.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
