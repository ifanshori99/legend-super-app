// "Catat setoran" dialog (ACC-05: every cash deposit is recorded and matched
// with the bank statement). Amounts are whole rupiah parsed with the shared
// form helper; the deposit time is stored as an ISO instant.
import * as React from "react";
import type { BankAccount } from "@starter/shared/accounting";
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
import {
  businessDateToday,
  parseRupiahInput,
} from "@/features/ws07-accounting/lib";
import { useOutlets } from "@/features/ws07-accounting/hooks";
import type { CreateCashDepositBody } from "../api";
import { useCreateCashDeposit } from "../hooks";

function nowLocalInputValue(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate(),
  )}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function CashDepositDialog({
  open,
  onOpenChange,
  accounts,
  defaultBankAccountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: readonly BankAccount[];
  defaultBankAccountId: string | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <CashDepositForm
          accounts={accounts}
          defaultBankAccountId={defaultBankAccountId}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function CashDepositForm({
  accounts,
  defaultBankAccountId,
  onClose,
}: {
  accounts: readonly BankAccount[];
  defaultBankAccountId: string | undefined;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const outletsQuery = useOutlets();
  const create = useCreateCashDeposit();
  const today = businessDateToday();
  const [outletId, setOutletId] = React.useState("");
  const [bankAccountId, setBankAccountId] = React.useState(
    defaultBankAccountId ?? accounts[0]?.id ?? "",
  );
  const [amount, setAmount] = React.useState("");
  const [coversFrom, setCoversFrom] = React.useState(today);
  const [coversTo, setCoversTo] = React.useState(today);
  const [depositedAt, setDepositedAt] = React.useState(nowLocalInputValue);
  const [slipReference, setSlipReference] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const outlets = outletsQuery.data?.data ?? [];
  const effectiveOutlet = outletId || outlets[0]?.id || "";
  const amountIdr = parseRupiahInput(amount);
  const amountError =
    touched && (amountIdr === null || amountIdr <= 0)
      ? t("accounting.cash.deposits.form.invalidAmount")
      : undefined;
  const rangeError =
    touched && coversTo < coversFrom
      ? t("accounting.cash.deposits.form.invalidRange")
      : undefined;
  const instant = depositedAt === "" ? null : new Date(depositedAt);
  const instantValid = instant !== null && !Number.isNaN(instant.getTime());
  const canSubmit =
    effectiveOutlet !== "" &&
    bankAccountId !== "" &&
    amountIdr !== null &&
    amountIdr > 0 &&
    coversTo >= coversFrom &&
    instantValid &&
    !create.isPending;

  const update = (fn: () => void) => {
    fn();
    setTouched(true);
    setServerError(null);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("accounting.cash.deposits.form.title")}</DialogTitle>
        <DialogDescription>
          {t("accounting.cash.deposits.form.description")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!canSubmit || !instant || amountIdr === null) return;
          const body: CreateCashDepositBody = {
            outletId: effectiveOutlet as CreateCashDepositBody["outletId"],
            bankAccountId:
              bankAccountId as CreateCashDepositBody["bankAccountId"],
            amountIdr: amountIdr as CreateCashDepositBody["amountIdr"],
            coversFrom: coversFrom as CreateCashDepositBody["coversFrom"],
            coversTo: coversTo as CreateCashDepositBody["coversTo"],
            depositedAt: instant.toISOString(),
            slipReference:
              slipReference.trim() === "" ? null : slipReference.trim(),
          };
          create.mutate(body, {
            onSuccess: () => {
              toast({
                title: t("accounting.cash.deposits.form.saved"),
                tone: "success",
              });
              onClose();
            },
            onError: (error) => {
              setServerError(
                error instanceof ApiError
                  ? error.message
                  : t("accounting.cash.deposits.form.invalidAmount"),
              );
            },
          });
        }}
      >
        <FormField
          label={t("accounting.cash.deposits.form.outlet")}
          hint={
            outlets.length === 0
              ? t("accounting.cash.deposits.form.noOutlets")
              : t("accounting.cash.deposits.form.outletHint")
          }
          required
        >
          <Select value={effectiveOutlet} onValueChange={setOutletId}>
            <SelectTrigger disabled={outlets.length === 0}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {outlets.map((outlet) => (
                <SelectItem key={outlet.id} value={outlet.id}>
                  {outlet.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField
          label={t("accounting.cash.deposits.form.bankAccount")}
          required
        >
          <Select value={bankAccountId} onValueChange={setBankAccountId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {`${account.bank} · ${account.accountNumberMasked}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField
          label={t("accounting.cash.deposits.form.amount")}
          hint={t("accounting.cash.deposits.form.amountHint")}
          error={amountError}
          required
        >
          <Input
            value={amount}
            onChange={(event) => update(() => setAmount(event.target.value))}
            inputMode="numeric"
            autoComplete="off"
            className="tabular"
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t("accounting.cash.deposits.form.coversFrom")}
            required
          >
            <Input
              type="date"
              value={coversFrom}
              max={coversTo}
              className="tabular"
              onChange={(event) =>
                update(() => {
                  setCoversFrom(event.target.value);
                  if (event.target.value > coversTo)
                    setCoversTo(event.target.value);
                })
              }
            />
          </FormField>
          <FormField
            label={t("accounting.cash.deposits.form.coversTo")}
            error={rangeError}
            required
          >
            <Input
              type="date"
              value={coversTo}
              min={coversFrom}
              className="tabular"
              onChange={(event) =>
                update(() => setCoversTo(event.target.value))
              }
            />
          </FormField>
        </div>
        <FormField
          label={t("accounting.cash.deposits.form.depositedAt")}
          hint={t("accounting.cash.deposits.form.depositedAtHint")}
          required
        >
          <Input
            type="datetime-local"
            value={depositedAt}
            className="tabular"
            onChange={(event) =>
              update(() => setDepositedAt(event.target.value))
            }
          />
        </FormField>
        <FormField
          label={t("accounting.cash.deposits.form.slip")}
          hint={t("accounting.cash.deposits.form.slipHint")}
        >
          <Input
            value={slipReference}
            onChange={(event) =>
              update(() => setSlipReference(event.target.value))
            }
            autoComplete="off"
            maxLength={60}
          />
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
            {t("accounting.cash.deposits.form.submit")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
