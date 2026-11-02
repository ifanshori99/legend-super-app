// Create/edit one account of a legal entity (PRD v1.7 §3.19 "Chart of
// Accounts"). Type is immutable after creation (it would move the account's
// history on the statements); the parent must be the same type and entity, and
// the contract re-checks codes and cycles on save.
import * as React from "react";
import {
  REPORT_GROUPS,
  createAccountInputSchema,
  type Account,
  type AccountType,
  type ReportGroup,
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
import { useCreateAccount, useUpdateAccount } from "../hooks";
import {
  ACCOUNT_TYPE_KEYS,
  REPORT_GROUP_KEYS,
  accountLabel,
  compareAccountCodes,
} from "../lib";

const TYPES = Object.keys(ACCOUNT_TYPE_KEYS) as AccountType[];
const GROUPS = Object.keys(REPORT_GROUP_KEYS) as ReportGroup[];
const groupsFor = (type: AccountType) =>
  GROUPS.filter((group) => REPORT_GROUPS[group] === type);

type Values = {
  code: string;
  name: string;
  type: AccountType;
  reportGroup: ReportGroup;
  parentId: string | null;
  isActive: boolean;
};

function initialValues(account: Account | null): Values {
  if (account)
    return {
      code: account.code,
      name: account.name,
      type: account.type,
      reportGroup: account.reportGroup,
      parentId: account.parentId,
      isActive: account.isActive,
    };
  return {
    code: "",
    name: "",
    type: "expense",
    reportGroup: "operating_expense",
    parentId: null,
    isActive: true,
  };
}

export function AccountFormDialog({
  open,
  onOpenChange,
  legalEntityId,
  accounts,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  accounts: readonly Account[];
  /** null = create a new account. */
  account: Account | null;
}) {
  // Radix unmounts DialogContent on close, so AccountForm re-mounts (and
  // re-seeds its state) on every opening — no effect resetting state.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <AccountForm
          onOpenChange={onOpenChange}
          legalEntityId={legalEntityId}
          accounts={accounts}
          account={account}
        />
      </DialogContent>
    </Dialog>
  );
}

function AccountForm({
  onOpenChange,
  legalEntityId,
  accounts,
  account,
}: {
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  accounts: readonly Account[];
  account: Account | null;
}) {
  const t = useT();
  const toast = useToast();
  const create = useCreateAccount(legalEntityId);
  const update = useUpdateAccount(legalEntityId);
  const [values, setValues] = React.useState<Values>(() =>
    initialValues(account),
  );
  const [errors, setErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [serverError, setServerError] = React.useState<string | null>(null);

  const patch = (next: Partial<Values>) =>
    setValues((current) => ({ ...current, ...next }));

  const parents = React.useMemo(
    () =>
      accounts
        .filter((row) => row.type === values.type && row.id !== account?.id)
        .sort((a, b) => compareAccountCodes(a.code, b.code)),
    [accounts, values.type, account?.id],
  );

  const pending = create.isPending || update.isPending;

  const submit = async () => {
    setServerError(null);
    if (account) {
      if (values.name.trim() === "") {
        setErrors({ name: t("form.invalid") });
        return;
      }
      try {
        await update.mutateAsync({
          accountId: account.id,
          body: {
            name: values.name.trim(),
            reportGroup: values.reportGroup,
            parentId: values.parentId,
            isActive: values.isActive,
          },
        });
        toast({ title: t("accounting.coa.saved") });
        onOpenChange(false);
      } catch (error) {
        setServerError(
          error instanceof ApiError ? error.message : t("errorPage.errorTitle"),
        );
      }
      return;
    }
    const result = createAccountInputSchema.safeParse({
      code: values.code.trim(),
      name: values.name.trim(),
      type: values.type,
      reportGroup: values.reportGroup,
      parentId: values.parentId,
    });
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }
    try {
      await create.mutateAsync(result.data);
      toast({ title: t("accounting.coa.saved") });
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
          {account
            ? t("accounting.coa.form.titleEdit")
            : t("accounting.coa.form.titleCreate")}
        </DialogTitle>
        <DialogDescription>{t("accounting.entity.hint")}</DialogDescription>
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
            label={t("accounting.coa.form.code")}
            hint={account ? undefined : t("accounting.coa.form.codeHint")}
            error={errors.code}
            required
          >
            <Input
              value={values.code}
              onChange={(event) => patch({ code: event.target.value })}
              inputMode="numeric"
              autoComplete="off"
              disabled={Boolean(account)}
              className="tabular"
            />
          </FormField>
          <FormField
            label={t("accounting.coa.form.name")}
            error={errors.name}
            required
          >
            <Input
              value={values.name}
              onChange={(event) => patch({ name: event.target.value })}
              autoComplete="off"
            />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t("accounting.coa.form.type")}
            hint={account ? t("accounting.coa.form.typeHint") : undefined}
          >
            <Select
              value={values.type}
              disabled={Boolean(account)}
              onValueChange={(type) => {
                const nextType = type as AccountType;
                patch({
                  type: nextType,
                  reportGroup: groupsFor(nextType)[0] ?? values.reportGroup,
                  parentId: null,
                });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(ACCOUNT_TYPE_KEYS[type])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("accounting.coa.form.group")}
            hint={t("accounting.coa.form.groupHint")}
            error={errors.reportGroup}
            required
          >
            <Select
              value={values.reportGroup}
              onValueChange={(group) =>
                patch({ reportGroup: group as ReportGroup })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {groupsFor(values.type).map((group) => (
                  <SelectItem key={group} value={group}>
                    {t(REPORT_GROUP_KEYS[group])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
        <FormField
          label={t("accounting.coa.form.parent")}
          hint={t("accounting.coa.form.parentHint")}
        >
          <Select
            value={values.parentId ?? "none"}
            onValueChange={(parentId) =>
              patch({ parentId: parentId === "none" ? null : parentId })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                {t("accounting.coa.form.parentNone")}
              </SelectItem>
              {parents.map((parent) => (
                <SelectItem key={parent.id} value={parent.id}>
                  {accountLabel(parent)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        {account && (
          <div className="grid gap-1.5">
            <div className="flex items-center gap-2">
              <Switch
                id="account-active"
                checked={values.isActive}
                onCheckedChange={(isActive) => patch({ isActive })}
              />
              <Label htmlFor="account-active">
                {t("accounting.coa.form.active")}
              </Label>
            </div>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("accounting.coa.form.activeHint")}
            </p>
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
            {t("accounting.coa.form.save")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
