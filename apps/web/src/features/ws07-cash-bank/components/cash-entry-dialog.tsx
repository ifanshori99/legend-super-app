// Cash in, cash out and transfer dialog (legend-4961). One dialog, three
// kinds: cash in/out name a bank account and a counter account the user picks
// (the system never guesses it); a transfer names two accounts. Amounts are
// whole rupiah. The request keeps one idempotency key per body for the life of
// the dialog, so a resend after a slow answer replays instead of moving the
// money twice.
import * as React from "react";
import type {
  Account,
  BankAccount,
  CreatableCashBankEntryKind,
} from "@starter/shared/accounting";
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
import { formatRupiah } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";
import {
  businessDateToday,
  formatRupiahInput,
  parseRupiahInput,
} from "@/features/ws07-accounting/lib";
import { useOutlets } from "@/features/ws07-accounting/hooks";
import type { CreateCashBankEntryBody } from "../api";
import { useCashApprovalLimit, useCreateCashBankEntry } from "../hooks";
import {
  cashOutNeedsApproval,
  counterAccountChoices,
  createIdempotencyKeySession,
  moneyErrorKey,
} from "../lib";
import { ServerError } from "./server-error";

const NO_OUTLET = "none";

const TITLE_KEYS = {
  cash_in: "accounting.cash.entries.form.titleCashIn",
  cash_out: "accounting.cash.entries.form.titleCashOut",
  transfer: "accounting.cash.entries.form.titleTransfer",
} as const;

const DESCRIPTION_KEYS = {
  cash_in: "accounting.cash.entries.form.descriptionCashIn",
  cash_out: "accounting.cash.entries.form.descriptionCashOut",
  transfer: "accounting.cash.entries.form.descriptionTransfer",
} as const;

export function CashEntryDialog({
  open,
  onOpenChange,
  kind,
  legalEntityId,
  accounts,
  glAccounts,
  defaultBankAccountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: CreatableCashBankEntryKind;
  legalEntityId: string;
  accounts: readonly BankAccount[];
  glAccounts: readonly Account[];
  defaultBankAccountId: string | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <CashEntryForm
          kind={kind}
          legalEntityId={legalEntityId}
          accounts={accounts}
          glAccounts={glAccounts}
          defaultBankAccountId={defaultBankAccountId}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function CashEntryForm({
  kind,
  legalEntityId,
  accounts,
  glAccounts,
  defaultBankAccountId,
  onClose,
}: {
  kind: CreatableCashBankEntryKind;
  legalEntityId: string;
  accounts: readonly BankAccount[];
  glAccounts: readonly Account[];
  defaultBankAccountId: string | undefined;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const outletsQuery = useOutlets();
  const create = useCreateCashBankEntry();
  const limitQuery = useCashApprovalLimit(kind === "cash_out");
  const today = businessDateToday();
  // The form lives inside DialogContent, so it mounts once per opened dialog:
  // keys are stable across resends of one body and new for the next dialog.
  const [keySession] = React.useState(() => createIdempotencyKeySession());
  const firstAccount = defaultBankAccountId ?? accounts[0]?.id ?? "";
  const [bankAccountId, setBankAccountId] = React.useState(firstAccount);
  const [toBankAccountId, setToBankAccountId] = React.useState(
    () => accounts.find((account) => account.id !== firstAccount)?.id ?? "",
  );
  const [counterAccountId, setCounterAccountId] = React.useState("");
  const [outletId, setOutletId] = React.useState(NO_OUTLET);
  const [amount, setAmount] = React.useState("");
  const [entryDate, setEntryDate] = React.useState(today);
  const [description, setDescription] = React.useState("");
  const [reference, setReference] = React.useState("");
  // A field shows its error after the person leaves or changes it, or after a
  // submit; a select never raises the amount's error.
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const isTransfer = kind === "transfer";
  const counters = React.useMemo(
    () => counterAccountChoices(glAccounts),
    [glAccounts],
  );
  const outlets = outletsQuery.data ?? [];
  const amountIdr = parseRupiahInput(amount);
  // Above the tenant limit a cash out is parked until a second person
  // approves it; the API decides, this only tells the person first.
  const needsApproval = cashOutNeedsApproval(
    kind,
    amountIdr,
    limitQuery.data?.limitIdr,
  );
  const sameAccount = isTransfer && bankAccountId === toBankAccountId;
  const errors = {
    bank:
      bankAccountId === ""
        ? t("accounting.cash.entries.form.bankRequired")
        : undefined,
    toBank:
      isTransfer && toBankAccountId === ""
        ? t("accounting.cash.entries.form.toAccountRequired")
        : sameAccount
          ? t("accounting.cash.entries.form.sameAccount")
          : undefined,
    // Money safety: the counter account is always chosen, never defaulted.
    counter:
      !isTransfer && counterAccountId === ""
        ? t("accounting.cash.entries.form.counterRequired")
        : undefined,
    amount:
      amountIdr === null || amountIdr <= 0
        ? t("accounting.cash.entries.form.invalidAmount")
        : undefined,
    date:
      entryDate === "" || entryDate > today
        ? t("accounting.cash.entries.form.futureDate")
        : undefined,
    description:
      description.trim() === ""
        ? t("accounting.cash.entries.form.descriptionRequired")
        : undefined,
  };
  const shown = (field: keyof typeof errors) =>
    submitted || touched.has(field) ? errors[field] : undefined;
  const valid = Object.values(errors).every((error) => error === undefined);

  const touch = (field: string) =>
    setTouched((current) =>
      current.has(field) ? current : new Set(current).add(field),
    );
  const update = (field: string, fn: () => void) => {
    fn();
    touch(field);
    setServerError(null);
  };

  const buildRequest = (amountValue: number) => {
    const common = {
      legalEntityId,
      amountIdr: amountValue,
      entryDate,
      description: description.trim(),
      reference: reference.trim() === "" ? null : reference.trim(),
    };
    return isTransfer
      ? {
          kind,
          ...common,
          fromBankAccountId: bankAccountId,
          toBankAccountId,
        }
      : {
          kind,
          ...common,
          bankAccountId,
          counterAccountId,
          ...(outletId === NO_OUTLET ? {} : { outletId }),
        };
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t(TITLE_KEYS[kind])}</DialogTitle>
        <DialogDescription>{t(DESCRIPTION_KEYS[kind])}</DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (create.isPending || !valid || amountIdr === null) return;
          const request = buildRequest(amountIdr);
          // Same body, same key (the server replays); another body, another key.
          const body = {
            ...request,
            idempotencyKey: keySession.current(JSON.stringify(request)),
          } as CreateCashBankEntryBody;
          create.mutate(body, {
            onSuccess: (entry) => {
              keySession.reset();
              toast({
                title: t(
                  entry.status === "pending_approval"
                    ? "accounting.cash.entries.form.savedPending"
                    : "accounting.cash.entries.form.saved",
                ),
                tone: "success",
              });
              onClose();
            },
            onError: (error) => {
              const key =
                error instanceof ApiError ? moneyErrorKey(error.code) : null;
              setServerError(
                key
                  ? t(key)
                  : error instanceof ApiError
                    ? error.message
                    : t("accounting.cash.entries.form.failed"),
              );
            },
          });
        }}
      >
        <FormField
          id="cash-entry-bank"
          label={t(
            isTransfer
              ? "accounting.cash.entries.form.fromAccount"
              : "accounting.cash.entries.form.bankAccount",
          )}
          error={shown("bank")}
          required
        >
          <Select
            value={bankAccountId}
            onValueChange={(value) =>
              update("bank", () => setBankAccountId(value))
            }
          >
            <SelectTrigger id="cash-entry-bank">
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
        {isTransfer ? (
          <FormField
            id="cash-entry-to-bank"
            label={t("accounting.cash.entries.form.toAccount")}
            hint={
              accounts.length < 2
                ? t("accounting.cash.entries.form.needTwoAccounts")
                : undefined
            }
            error={shown("toBank")}
            required
          >
            <Select
              value={toBankAccountId}
              onValueChange={(value) =>
                update("toBank", () => setToBankAccountId(value))
              }
            >
              <SelectTrigger id="cash-entry-to-bank">
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
        ) : (
          <>
            <FormField
              id="cash-entry-counter"
              label={t("accounting.cash.entries.form.counterAccount")}
              hint={
                counters.length === 0
                  ? t("accounting.cash.entries.form.noCounterAccounts")
                  : t("accounting.cash.entries.form.counterHint")
              }
              error={shown("counter")}
              required
            >
              <Select
                value={counterAccountId}
                onValueChange={(value) =>
                  update("counter", () => setCounterAccountId(value))
                }
              >
                <SelectTrigger
                  id="cash-entry-counter"
                  disabled={counters.length === 0}
                >
                  <SelectValue
                    placeholder={t(
                      "accounting.cash.entries.form.counterPlaceholder",
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {counters.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {`${account.code} · ${account.name}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              id="cash-entry-outlet"
              label={t("accounting.cash.entries.form.outlet")}
              hint={t("accounting.cash.entries.form.outletHint")}
            >
              <Select
                value={outletId}
                onValueChange={(value) =>
                  update("outlet", () => setOutletId(value))
                }
              >
                <SelectTrigger id="cash-entry-outlet">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_OUTLET}>
                    {t("accounting.cash.entries.form.noOutlet")}
                  </SelectItem>
                  {outlets.map((outlet) => (
                    <SelectItem key={outlet.id} value={outlet.id}>
                      {outlet.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </>
        )}
        <FormField
          label={t("accounting.cash.entries.form.amount")}
          hint={t("accounting.cash.entries.form.amountHint")}
          error={shown("amount")}
          required
        >
          <Input
            value={amount}
            onChange={(event) =>
              update("amount", () =>
                setAmount(formatRupiahInput(event.target.value)),
              )
            }
            inputMode="numeric"
            onBlur={() => touch("amount")}
            autoComplete="off"
            className="tabular"
          />
        </FormField>
        <FormField
          label={t("accounting.cash.entries.form.date")}
          hint={t("accounting.cash.entries.form.dateHint")}
          error={shown("date")}
          required
        >
          <Input
            type="date"
            value={entryDate}
            max={today}
            onBlur={() => touch("date")}
            className="tabular"
            onChange={(event) =>
              update("date", () => setEntryDate(event.target.value))
            }
          />
        </FormField>
        <FormField
          label={t("accounting.cash.entries.form.description")}
          error={shown("description")}
          required
        >
          <Input
            value={description}
            onChange={(event) =>
              update("description", () => setDescription(event.target.value))
            }
            autoComplete="off"
            maxLength={255}
            onBlur={() => touch("description")}
          />
        </FormField>
        <FormField
          label={t("accounting.cash.entries.form.reference")}
          hint={t("accounting.cash.entries.form.referenceHint")}
        >
          <Input
            value={reference}
            onChange={(event) =>
              update("reference", () => setReference(event.target.value))
            }
            autoComplete="off"
            maxLength={60}
          />
        </FormField>
        {needsApproval && limitQuery.data ? (
          <p
            role="status"
            className="rounded-control border border-warning bg-warning-subtle px-3 py-2 text-sm leading-5 text-foreground"
          >
            {t("accounting.cash.entries.form.approvalBanner", {
              limit: formatRupiah(limitQuery.data.limitIdr),
            })}
          </p>
        ) : null}
        <ServerError message={serverError} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t("accounting.cash.entries.form.submit")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
