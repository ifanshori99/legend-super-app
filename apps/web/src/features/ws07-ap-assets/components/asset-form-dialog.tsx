// Register one fixed asset (PRD v1.7 §3.19 "Aset Tetap [P0] — Registrasi aset
// dari pembelian"). The contract carries no method input: straight line is the
// only v1 method (contract note in assets.ts). Money fields are typed as whole
// rupiah and parsed for display only.
import * as React from "react";
import { createFixedAssetInputSchema } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
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
import { businessDateToday, monthRange } from "@/features/ws07-accounting/lib";
import { useAccountingOutlets, useCreateFixedAsset } from "../hooks";
import { parseAmountInput } from "../lib";

/** The form omits the idempotency key; the endpoint caller mints it. */
const createAssetFormSchema = createFixedAssetInputSchema.omit({
  idempotencyKey: true,
});

export function FixedAssetFormDialog({
  open,
  onOpenChange,
  legalEntityId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <FixedAssetForm
          legalEntityId={legalEntityId}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

function FixedAssetForm({
  legalEntityId,
  onOpenChange,
}: {
  legalEntityId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateFixedAsset();
  const outletsQuery = useAccountingOutlets();
  const today = React.useMemo(() => businessDateToday(), []);
  const [values, setValues] = React.useState({
    name: "",
    acquiredOn: today,
    cost: "",
    residual: "",
    usefulLife: "60",
    startPeriod: monthRange(today).from.slice(0, 7),
    outletId: "none",
  });
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [serverError, setServerError] = React.useState<string | null>(null);

  const patch = (next: Partial<typeof values>) =>
    setValues((current) => ({ ...current, ...next }));

  const submit = async () => {
    setServerError(null);
    const nextErrors: Record<string, string | undefined> = {};
    const costIdr = parseAmountInput(values.cost);
    const residualValueIdr =
      values.residual.trim() === "" ? 0 : parseAmountInput(values.residual);
    const usefulLifeMonths = Number(values.usefulLife);

    if (values.name.trim() === "")
      nextErrors.name = t("accounting.ap.assets.form.nameRequired");
    if (values.acquiredOn.trim() === "")
      nextErrors.acquiredOn = t("accounting.ap.assets.form.dateRequired");
    if (costIdr === null || costIdr <= 0)
      nextErrors.cost = t("accounting.ap.assets.form.costRequired");
    if (
      residualValueIdr === null ||
      residualValueIdr < 0 ||
      (costIdr !== null && residualValueIdr >= costIdr)
    )
      nextErrors.residual = t("accounting.ap.assets.form.residualInvalid");
    if (
      !Number.isInteger(usefulLifeMonths) ||
      usefulLifeMonths < 1 ||
      usefulLifeMonths > 600
    )
      nextErrors.usefulLifeMonths = t("accounting.ap.assets.form.lifeInvalid");
    if (values.startPeriod.trim() === "")
      nextErrors.depreciationStartPeriod = t(
        "accounting.ap.assets.form.periodRequired",
      );

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    const parsed = createAssetFormSchema.safeParse({
      legalEntityId,
      outletId: values.outletId === "none" ? null : values.outletId,
      name: values.name.trim(),
      acquiredOn: values.acquiredOn,
      costIdr,
      residualValueIdr,
      usefulLifeMonths,
      depreciationStartPeriod: values.startPeriod,
      sourceDocumentId: null,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    try {
      await create.mutateAsync(parsed.data);
      toast({ title: t("accounting.ap.assets.form.saved") });
      onOpenChange(false);
    } catch (error) {
      setServerError(
        error instanceof ApiError ? error.message : t("state.errorTitle"),
      );
    }
  };

  const outlets = outletsQuery.data ?? [];

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("accounting.ap.assets.form.title")}</DialogTitle>
        <DialogDescription>
          {t("accounting.ap.assets.form.hint")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField
          label={t("accounting.ap.assets.form.name")}
          error={errors.name}
          required
        >
          <Input
            value={values.name}
            onChange={(event) => patch({ name: event.target.value })}
            autoComplete="off"
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t("accounting.ap.assets.form.acquiredOn")}
            error={errors.acquiredOn}
            required
          >
            <Input
              type="date"
              value={values.acquiredOn}
              onChange={(event) => patch({ acquiredOn: event.target.value })}
              className="tabular"
            />
          </FormField>
          <FormField
            label={t("accounting.ap.assets.form.startPeriod")}
            hint={t("accounting.ap.assets.form.startPeriodHint")}
            error={errors.depreciationStartPeriod}
            required
          >
            <Input
              type="month"
              value={values.startPeriod}
              onChange={(event) => patch({ startPeriod: event.target.value })}
              className="tabular"
            />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t("accounting.ap.assets.form.cost")}
            hint={t("accounting.ap.assets.form.costHint")}
            error={errors.cost}
            required
          >
            <Input
              value={values.cost}
              onChange={(event) => patch({ cost: event.target.value })}
              inputMode="numeric"
              autoComplete="off"
              className="tabular"
            />
          </FormField>
          <FormField
            label={t("accounting.ap.assets.form.residual")}
            hint={t("accounting.ap.assets.form.residualHint")}
            error={errors.residual}
          >
            <Input
              value={values.residual}
              onChange={(event) => patch({ residual: event.target.value })}
              inputMode="numeric"
              autoComplete="off"
              className="tabular"
            />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t("accounting.ap.assets.form.usefulLife")}
            hint={t("accounting.ap.assets.form.usefulLifeHint")}
            error={errors.usefulLifeMonths}
            required
          >
            <Input
              type="number"
              min={1}
              max={600}
              value={values.usefulLife}
              onChange={(event) => patch({ usefulLife: event.target.value })}
              className="tabular"
            />
          </FormField>
          <FormField label={t("accounting.ap.assets.form.outlet")}>
            <Select
              value={values.outletId}
              onValueChange={(outletId) => patch({ outletId })}
            >
              <SelectTrigger className="h-control-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  {t("accounting.ap.assets.form.outletNone")}
                </SelectItem>
                {outlets.map((outlet) => (
                  <SelectItem key={outlet.id} value={outlet.id}>
                    {outlet.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
        {serverError && (
          <p
            role="alert"
            className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
          >
            {serverError}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t("accounting.ap.assets.form.save")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
