// Create/update one shareholder. NPWP and the payout account number are
// write-only: the form never shows them, and an empty field on edit keeps the
// stored value (the masked read model has no plaintext to re-send).
import * as React from "react";
import {
  createShareholderInputSchema,
  updateShareholderInputSchema,
  type Shareholder,
  type ShareholderType,
} from "@starter/shared/accounting";
import { ApiError } from "@/lib/api/errors";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useCreateShareholder, useUpdateShareholder } from "../hooks";
import { SHAREHOLDER_TYPE_KEYS } from "../lib";

type Values = {
  name: string;
  type: ShareholderType;
  npwp: string;
  bank: string;
  accountNumber: string;
  accountHolder: string;
  active: boolean;
};

function initialValues(shareholder: Shareholder | null): Values {
  return {
    name: shareholder?.name ?? "",
    type: shareholder?.type ?? "person",
    npwp: "",
    bank: shareholder?.payoutAccount?.bank ?? "",
    accountNumber: "",
    accountHolder: shareholder?.payoutAccount?.accountHolder ?? "",
    active: shareholder ? shareholder.status === "active" : true,
  };
}

export function ShareholderDialog({
  open,
  onOpenChange,
  shareholder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create. */
  shareholder: Shareholder | null;
}) {
  // Radix unmounts DialogContent on close, so the form re-seeds every opening.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ShareholderForm
          onOpenChange={onOpenChange}
          shareholder={shareholder}
        />
      </DialogContent>
    </Dialog>
  );
}

function ShareholderForm({
  onOpenChange,
  shareholder,
}: {
  onOpenChange: (open: boolean) => void;
  shareholder: Shareholder | null;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateShareholder();
  const update = useUpdateShareholder();
  const [values, setValues] = React.useState<Values>(() =>
    initialValues(shareholder),
  );
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [serverError, setServerError] = React.useState<string | null>(null);

  const patch = (next: Partial<Values>) =>
    setValues((current) => ({ ...current, ...next }));
  const pending = create.isPending || update.isPending;
  const hasAccountInput =
    values.bank.trim() !== "" ||
    values.accountNumber.trim() !== "" ||
    values.accountHolder.trim() !== "";
  const completeAccount =
    values.bank.trim() !== "" &&
    values.accountNumber.trim() !== "" &&
    values.accountHolder.trim() !== "";

  const submit = async () => {
    setServerError(null);
    setErrors({});
    const payoutAccount = completeAccount
      ? {
          bank: values.bank.trim(),
          accountNumber: values.accountNumber.trim(),
          accountHolder: values.accountHolder.trim(),
        }
      : null;
    if (hasAccountInput && !completeAccount) {
      setErrors({
        accountNumber: t("form.invalid"),
        bank: t("form.invalid"),
        accountHolder: t("form.invalid"),
      });
      return;
    }
    const npwp = values.npwp.trim() === "" ? null : values.npwp.trim();

    try {
      if (shareholder) {
        const body = {
          name: values.name.trim(),
          type: values.type,
          status: values.active ? ("active" as const) : ("inactive" as const),
          // An empty plaintext field keeps the stored (masked) value.
          ...(npwp === null ? {} : { npwp }),
          ...(payoutAccount === null ? {} : { payoutAccount }),
        };
        const result = updateShareholderInputSchema.safeParse(body);
        if (!result.success) {
          setErrors(fieldErrors(result.error));
          return;
        }
        await update.mutateAsync({
          shareholderId: shareholder.id,
          body: result.data,
        });
      } else {
        const result = createShareholderInputSchema.safeParse({
          name: values.name.trim(),
          type: values.type,
          userId: null,
          npwp,
          payoutAccount,
        });
        if (!result.success) {
          setErrors(fieldErrors(result.error));
          return;
        }
        await create.mutateAsync(result.data);
      }
      toast({ title: t("accounting.share.shareholders.form.saved") });
      onOpenChange(false);
    } catch (error) {
      setServerError(
        error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
      );
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {shareholder
            ? t("accounting.share.shareholders.form.titleEdit", {
                name: shareholder.name,
              })
            : t("accounting.share.shareholders.form.titleCreate")}
        </DialogTitle>
        <DialogDescription>
          {t("accounting.share.shareholders.subtitle")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t("accounting.share.shareholders.form.name")}
            error={errors.name}
            required
          >
            <Input
              value={values.name}
              onChange={(event) => patch({ name: event.target.value })}
              autoComplete="off"
            />
          </FormField>
          <FormField
            label={t("accounting.share.shareholders.form.type")}
            required
          >
            <Select
              value={values.type}
              onValueChange={(type) => patch({ type: type as ShareholderType })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="person">
                  {t(SHAREHOLDER_TYPE_KEYS.person)}
                </SelectItem>
                <SelectItem value="company">
                  {t(SHAREHOLDER_TYPE_KEYS.company)}
                </SelectItem>
              </SelectContent>
            </Select>
          </FormField>
        </div>

        <FormField
          label={t("accounting.share.shareholders.form.npwp")}
          hint={t("accounting.share.shareholders.form.npwpHint")}
          error={errors.npwp}
        >
          <Input
            value={values.npwp}
            onChange={(event) => patch({ npwp: event.target.value })}
            inputMode="numeric"
            autoComplete="off"
            className="tabular"
          />
        </FormField>

        <fieldset className="grid gap-4">
          <legend className="text-sm font-semibold">
            {t("accounting.share.allocations.columns.payout")}
          </legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("accounting.share.shareholders.form.bank")}
              error={errors.bank}
            >
              <Input
                value={values.bank}
                onChange={(event) => patch({ bank: event.target.value })}
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={t("accounting.share.shareholders.form.accountNumber")}
              hint={
                shareholder
                  ? t("accounting.share.shareholders.form.accountNumberKeep")
                  : t("accounting.share.shareholders.form.accountNumberHint")
              }
              error={errors.accountNumber}
            >
              <Input
                value={values.accountNumber}
                onChange={(event) =>
                  patch({ accountNumber: event.target.value })
                }
                inputMode="numeric"
                autoComplete="off"
                className="tabular"
              />
            </FormField>
          </div>
          <FormField
            label={t("accounting.share.shareholders.form.holder")}
            error={errors.accountHolder}
          >
            <Input
              value={values.accountHolder}
              onChange={(event) => patch({ accountHolder: event.target.value })}
              autoComplete="off"
            />
          </FormField>
        </fieldset>

        {shareholder && (
          <div className="flex items-center gap-2">
            <Switch
              id="shareholder-active"
              checked={values.active}
              onCheckedChange={(active) => patch({ active })}
            />
            <Label htmlFor="shareholder-active">
              {t("accounting.share.shareholders.form.status")}
            </Label>
          </div>
        )}

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
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={pending}>
            {t("accounting.share.shareholders.form.save")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
