// Confirm one production-order transition (PRD v1.7 §17 "Produksi Batch").
// The contract state machine already chose the action (`allowedProductionActions`
// in recipe-lib), so this dialog never offers a transition the API rejects:
// starting needs a confirmation, completing needs the actual output, and
// cancelling is destructive and therefore confirmed too (DESIGN.md §4).
import * as React from "react";
import type {
  ProductionOrder,
  ProductionOrderAction,
  Uom,
} from "@starter/shared/inventory";
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
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { formatQuantity, quantityFromInput, uomCode } from "../lib";
import { decimalInputText } from "../recipe-lib";
import { useAttemptKey, useProductionTransition } from "../recipe-hooks";

const TITLE_KEY: Record<
  ProductionOrderAction,
  | "inventoryRecipe.production.transition.startTitle"
  | "inventoryRecipe.production.transition.completeTitle"
  | "inventoryRecipe.production.transition.cancelTitle"
> = {
  start: "inventoryRecipe.production.transition.startTitle",
  complete: "inventoryRecipe.production.transition.completeTitle",
  cancel: "inventoryRecipe.production.transition.cancelTitle",
};

const BODY_KEY: Record<
  ProductionOrderAction,
  | "inventoryRecipe.production.transition.startBody"
  | "inventoryRecipe.production.transition.completeBody"
  | "inventoryRecipe.production.transition.cancelBody"
> = {
  start: "inventoryRecipe.production.transition.startBody",
  complete: "inventoryRecipe.production.transition.completeBody",
  cancel: "inventoryRecipe.production.transition.cancelBody",
};

const SUBMIT_KEY: Record<
  ProductionOrderAction,
  | "inventoryRecipe.production.transition.startSubmit"
  | "inventoryRecipe.production.transition.completeSubmit"
  | "inventoryRecipe.production.transition.cancelSubmit"
> = {
  start: "inventoryRecipe.production.transition.startSubmit",
  complete: "inventoryRecipe.production.transition.completeSubmit",
  cancel: "inventoryRecipe.production.transition.cancelSubmit",
};

const TOAST_KEY: Record<
  ProductionOrderAction,
  | "inventoryRecipe.production.transition.started"
  | "inventoryRecipe.production.transition.completed"
  | "inventoryRecipe.production.transition.cancelled"
> = {
  start: "inventoryRecipe.production.transition.started",
  complete: "inventoryRecipe.production.transition.completed",
  cancel: "inventoryRecipe.production.transition.cancelled",
};

export function ProductionTransitionDialog({
  order,
  recipeName,
  units,
  yieldUomId,
  action,
  onOpenChange,
}: {
  order: ProductionOrder;
  recipeName: string;
  units: readonly Uom[];
  yieldUomId: string;
  action: ProductionOrderAction;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const transition = useProductionTransition();
  const attempt = useAttemptKey();
  const [actualQty, setActualQty] = React.useState(() =>
    decimalInputText(order.plannedQty),
  );
  const [error, setError] = React.useState<string>();
  const [formError, setFormError] = React.useState<string>();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const actual =
      action === "complete" ? quantityFromInput(actualQty) : undefined;
    if (actual === null) {
      setError(t("inventoryRecipe.production.transition.actualError"));
      return;
    }
    setError(undefined);
    setFormError(undefined);
    const payload = {
      productionOrderId: order.id,
      action,
      ...(actual === undefined ? {} : { actualQty: actual }),
    };
    transition.mutate(
      {
        productionOrderId: order.id,
        body: {
          action,
          ...(actual === undefined ? {} : { actualQty: actual }),
          idempotencyKey: attempt.keyFor(payload),
        },
        idempotencyKey: attempt.keyFor(payload),
      },
      {
        onSuccess: () => {
          attempt.settle();
          toast({ title: t(TOAST_KEY[action]), tone: "success" });
          onOpenChange(false);
        },
        onError: (cause) =>
          setFormError(
            cause instanceof ApiError
              ? cause.message
              : t("inventoryRecipe.production.transition.failed"),
          ),
      },
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(TITLE_KEY[action])}</DialogTitle>
          <DialogDescription>{t(BODY_KEY[action])}</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-1 rounded-container bg-surface-2 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">
              {t("inventoryRecipe.production.columns.recipe")}
            </dt>
            <dd className="font-semibold">{recipeName}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">
              {t("inventoryRecipe.production.columns.quantity")}
            </dt>
            <dd className="tabular">
              {formatQuantity(order.plannedQty)} {uomCode(units, yieldUomId)}
            </dd>
          </div>
        </dl>
        <form className="grid gap-3" onSubmit={submit} noValidate>
          {action === "complete" && (
            <FormField
              label={t("inventoryRecipe.production.transition.actualQuantity")}
              hint={t(
                "inventoryRecipe.production.transition.actualQuantityHint",
              )}
              error={error}
              required
            >
              <Input
                value={actualQty}
                onChange={(event) => setActualQty(event.target.value)}
                inputMode="decimal"
                autoComplete="off"
              />
            </FormField>
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
              {t("inventoryRecipe.production.transition.keep")}
            </Button>
            <Button
              type="submit"
              variant={action === "cancel" ? "destructive" : "default"}
              loading={transition.isPending}
            >
              {t(SUBMIT_KEY[action])}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
