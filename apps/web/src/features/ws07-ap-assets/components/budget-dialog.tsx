// "Atur anggaran": per-account amounts for one period and outlet (PRD v1.7
// §3.19 "Anggaran [P0] — Anggaran per akun dan outlet dengan laporan
// realisasi"). Only postable revenue and expense accounts are budgeted; the
// save sends one row per filled account through upsertBudgets and the live
// total is display-only.
import * as React from "react";
import type { Budget } from "@starter/shared/accounting";
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
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { accountLabel, postableAccounts } from "@/features/ws07-accounting/lib";
import { useBudgetAccounts, useBudgets, useUpsertBudgets } from "../hooks";
import { parseAmountInput } from "../lib";

export function BudgetDialog({
  open,
  onOpenChange,
  legalEntityId,
  period,
  outletId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  legalEntityId: string;
  period: string;
  outletId: string | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <BudgetDialogBody
          legalEntityId={legalEntityId}
          period={period}
          outletId={outletId}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

function BudgetDialogBody({
  legalEntityId,
  period,
  outletId,
  onOpenChange,
}: {
  legalEntityId: string;
  period: string;
  outletId: string | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const accountsQuery = useBudgetAccounts(legalEntityId);
  const budgetsQuery = useBudgets({ legalEntityId, period, outletId });

  if (accountsQuery.isPending || budgetsQuery.isPending)
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("accounting.ap.budgets.dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("accounting.ap.budgets.dialog.hint")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </div>
      </>
    );
  if (accountsQuery.isError || budgetsQuery.isError)
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("accounting.ap.budgets.dialog.title")}</DialogTitle>
        </DialogHeader>
        <ErrorState
          onRetry={() => {
            void accountsQuery.refetch();
            void budgetsQuery.refetch();
          }}
        />
      </>
    );

  return (
    <BudgetForm
      legalEntityId={legalEntityId}
      period={period}
      outletId={outletId}
      accounts={postableAccounts(accountsQuery.data ?? []).filter(
        (account) => account.type === "revenue" || account.type === "expense",
      )}
      budgets={budgetsQuery.data ?? []}
      onOpenChange={onOpenChange}
    />
  );
}

function BudgetForm({
  legalEntityId,
  period,
  outletId,
  accounts,
  budgets,
  onOpenChange,
}: {
  legalEntityId: string;
  period: string;
  outletId: string | undefined;
  accounts: ReturnType<typeof postableAccounts>;
  budgets: readonly Budget[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const upsert = useUpsertBudgets();
  const [values, setValues] = React.useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const budget of budgets)
      initial[budget.accountId] = String(budget.amountIdr);
    return initial;
  });
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [search, setSearch] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const needle = search.trim().toLocaleLowerCase("id-ID");
  const visible = accounts.filter(
    (account) =>
      needle === "" ||
      account.code.toLocaleLowerCase("id-ID").includes(needle) ||
      account.name.toLocaleLowerCase("id-ID").includes(needle),
  );

  const totalIdr = accounts.reduce((total, account) => {
    const raw = values[account.id] ?? "";
    if (raw.trim() === "" && !touched.has(account.id)) return total;
    const amount = parseAmountInput(raw);
    return amount === null ? total : total + amount;
  }, 0);

  const update = (accountId: string, value: string) => {
    setValues((current) => ({ ...current, [accountId]: value }));
    setTouched((current) => {
      if (current.has(accountId)) return current;
      const next = new Set(current);
      next.add(accountId);
      return next;
    });
    setErrors((current) => {
      if (!(accountId in current)) return current;
      const next = { ...current };
      delete next[accountId];
      return next;
    });
  };

  const submit = async () => {
    setFormError(null);
    setServerError(null);
    if (outletId === undefined) {
      setFormError(t("accounting.ap.budgets.dialog.outletRequired"));
      return;
    }
    const nextErrors: Record<string, string> = {};
    const rows: {
      outletId: string;
      accountId: string;
      period: string;
      amountIdr: number;
    }[] = [];
    for (const account of accounts) {
      const raw = values[account.id] ?? "";
      const hasValue = raw.trim() !== "";
      if (!hasValue && !touched.has(account.id)) continue;
      const amountIdr = parseAmountInput(raw);
      if (amountIdr === null) {
        nextErrors[account.id] = t(
          "accounting.ap.budgets.dialog.amountInvalid",
        );
        continue;
      }
      rows.push({
        outletId,
        accountId: account.id,
        period,
        amountIdr,
      });
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    if (rows.length === 0) {
      setFormError(t("accounting.ap.budgets.dialog.atLeastOne"));
      return;
    }
    try {
      await upsert.mutateAsync({ legalEntityId, rows });
      toast({ title: t("accounting.ap.budgets.dialog.saved") });
      onOpenChange(false);
    } catch (error) {
      setServerError(
        error instanceof ApiError ? error.message : t("state.errorTitle"),
      );
    }
  };

  if (accounts.length === 0)
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("accounting.ap.budgets.dialog.title")}</DialogTitle>
        </DialogHeader>
        <EmptyState
          title={t("accounting.ap.budgets.dialog.noAccounts")}
          description={t("accounting.ap.budgets.dialog.hint")}
        />
      </>
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("accounting.ap.budgets.dialog.title")}</DialogTitle>
        <DialogDescription>
          {t("accounting.ap.budgets.dialog.hint")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField label={t("accounting.ap.budgets.dialog.search")}>
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-control-sm"
          />
        </FormField>
        <div className="grid max-h-[40dvh] gap-3 overflow-y-auto pr-1">
          {visible.map((account) => {
            const id = `budget-${account.id}`;
            return (
              <FormField
                key={account.id}
                id={id}
                label={accountLabel(account)}
                hint={t("accounting.ap.budgets.dialog.amount")}
                error={errors[account.id]}
              >
                <Input
                  value={values[account.id] ?? ""}
                  onChange={(event) => update(account.id, event.target.value)}
                  inputMode="numeric"
                  autoComplete="off"
                  className="tabular"
                />
              </FormField>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-3">
          <span className="text-sm font-semibold">
            {t("accounting.ap.budgets.dialog.total")}
          </span>
          <Money amount={totalIdr} size="lg" />
        </div>
        {formError && (
          <p
            role="alert"
            className="rounded-lg border-(length:--border-w) border-danger bg-danger-subtle p-3 text-sm text-danger"
          >
            {formError}
          </p>
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
            disabled={upsert.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={upsert.isPending}>
            {t("accounting.ap.budgets.dialog.save")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
