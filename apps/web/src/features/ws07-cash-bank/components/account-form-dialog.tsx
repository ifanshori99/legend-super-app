// "Tambah rekening" dialog. The input is the contract's
// createBankAccountInputSchema (digits-only number, encrypted at rest by the
// API; the screen only ever shows the masked value afterwards).
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
import {
  createBankAccountInputSchema,
  type Account,
} from "@starter/shared/accounting";
import { ApiError } from "@/lib/api/errors";
import { useCreateBankAccount } from "../hooks";
import { accountLabel, postableAccounts } from "@/features/ws07-accounting/lib";
import { useAccounts } from "@/features/ws07-accounting/hooks";

export function BankAccountDialog({
  open,
  onOpenChange,
  legalEntityId,
  glAccounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  glAccounts: readonly Account[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <BankAccountForm
          legalEntityId={legalEntityId}
          glAccounts={glAccounts}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

type Draft = {
  bank: string;
  accountName: string;
  accountNumber: string;
  glAccountId: string;
};

function BankAccountForm({
  legalEntityId,
  glAccounts,
  onClose,
}: {
  legalEntityId: string;
  glAccounts: readonly Account[];
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const accountsQuery = useAccounts(legalEntityId);
  const create = useCreateBankAccount();
  const [draft, setDraft] = React.useState<Draft>({
    bank: "",
    accountName: "",
    accountNumber: "",
    glAccountId: "",
  });
  const [touched, setTouched] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const accounts = accountsQuery.data ?? glAccounts;
  const cashAccounts = postableAccounts(accounts).filter(
    (account) => account.reportGroup === "cash_and_equivalents",
  );
  const parsed = createBankAccountInputSchema.safeParse({
    legalEntityId,
    bank: draft.bank,
    accountName: draft.accountName,
    accountNumber: draft.accountNumber,
    glAccountId: draft.glAccountId,
  });
  const errors = touched && !parsed.success ? fieldErrors(parsed.error) : {};
  const canSubmit =
    parsed.success && cashAccounts.length > 0 && !create.isPending;

  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setTouched(true);
    setServerError(null);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("accounting.cash.accounts.form.title")}</DialogTitle>
        <DialogDescription>
          {t("accounting.cash.accounts.form.description")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!parsed.success || cashAccounts.length === 0) return;
          create.mutate(parsed.data, {
            onSuccess: () => {
              toast({
                title: t("accounting.cash.accounts.form.saved"),
                tone: "success",
              });
              onClose();
            },
            onError: (error) => {
              setServerError(
                error instanceof ApiError
                  ? error.message
                  : t("accounting.cash.accounts.form.failed"),
              );
            },
          });
        }}
      >
        <FormField
          label={t("accounting.cash.accounts.form.bank")}
          hint={t("accounting.cash.accounts.form.bankHint")}
          error={errors.bank}
          required
        >
          <Input
            value={draft.bank}
            onChange={(event) => update({ bank: event.target.value })}
            autoComplete="off"
            maxLength={50}
          />
        </FormField>
        <FormField
          label={t("accounting.cash.accounts.form.name")}
          error={errors.accountName}
          required
        >
          <Input
            value={draft.accountName}
            onChange={(event) => update({ accountName: event.target.value })}
            autoComplete="off"
            maxLength={150}
          />
        </FormField>
        <FormField
          label={t("accounting.cash.accounts.form.number")}
          hint={t("accounting.cash.accounts.form.numberHint")}
          error={errors.accountNumber}
          required
        >
          <Input
            value={draft.accountNumber}
            onChange={(event) =>
              update({
                accountNumber: event.target.value.replace(/\D/g, ""),
              })
            }
            inputMode="numeric"
            autoComplete="off"
            className="tabular"
            maxLength={20}
          />
        </FormField>
        <FormField
          id="cash-account-gl"
          label={t("accounting.cash.accounts.form.gl")}
          hint={
            cashAccounts.length === 0
              ? t("accounting.cash.accounts.form.noGlAccounts")
              : t("accounting.cash.accounts.form.glHint")
          }
          error={errors.glAccountId}
          required
        >
          <Select
            value={draft.glAccountId}
            onValueChange={(value) => update({ glAccountId: value })}
            disabled={cashAccounts.length === 0}
          >
            <SelectTrigger id="cash-account-gl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {cashAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {accountLabel(account)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        {serverError && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {serverError}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            loading={create.isPending}
            disabled={!canSubmit}
          >
            {t("accounting.cash.accounts.form.submit")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
