// Petty cash top-up and return dialog (legend-4961). A top-up moves money from
// a bank account into the outlet's fund; a return moves it back and cannot
// exceed the balance (the form says so first, the API refuses it anyway). One
// idempotency key per body for the life of the dialog, so a resend replays.
import * as React from "react";
import type { BankAccount, PettyCashFund } from "@starter/shared/accounting";
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
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
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
  formatRupiahInput,
  parseRupiahInput,
} from "@/features/ws07-accounting/lib";
import { useOutlets } from "@/features/ws07-accounting/hooks";
import type { CreatePettyCashMovementBody } from "../api";
import { useCreatePettyCashMovement, usePettyCashFunds } from "../hooks";
import {
  createIdempotencyKeySession,
  moneyErrorKey,
  pettyReturnExceedsBalance,
} from "../lib";
import { ServerError } from "./server-error";

export function PettyCashMovementDialog({
  open,
  onOpenChange,
  kind,
  legalEntityId,
  defaultOutletId,
  accounts,
  defaultBankAccountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "topup" | "return";
  legalEntityId: string;
  defaultOutletId: string | undefined;
  accounts: readonly BankAccount[];
  defaultBankAccountId: string | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <MovementForm
          kind={kind}
          legalEntityId={legalEntityId}
          defaultOutletId={defaultOutletId}
          accounts={accounts}
          defaultBankAccountId={defaultBankAccountId}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function MovementForm({
  kind,
  legalEntityId,
  defaultOutletId,
  accounts,
  defaultBankAccountId,
  onClose,
}: {
  kind: "topup" | "return";
  legalEntityId: string;
  defaultOutletId: string | undefined;
  accounts: readonly BankAccount[];
  defaultBankAccountId: string | undefined;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const outletsQuery = useOutlets();
  const fundsQuery = usePettyCashFunds(legalEntityId);
  const create = useCreatePettyCashMovement();
  // Mounts once per opened dialog: stable keys across resends of one body.
  const [keySession] = React.useState(() => createIdempotencyKeySession());
  const outlets = outletsQuery.data ?? [];
  const funds: readonly PettyCashFund[] = fundsQuery.data ?? [];
  // Money safety: the outlet is chosen, never defaulted to the first one,
  // unless the person came from that outlet's own row.
  const [outletId, setOutletId] = React.useState(defaultOutletId ?? "");
  const [bankAccountId, setBankAccountId] = React.useState(
    defaultBankAccountId ?? accounts[0]?.id ?? "",
  );
  const [amount, setAmount] = React.useState("");
  const [description, setDescription] = React.useState("");
  // A field shows its error after the person leaves or changes it, or after a
  // submit; a select never raises the amount's error.
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(new Set());
  const [submitted, setSubmitted] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const isTopup = kind === "topup";
  // The return limit needs the real balance: while it loads (or failed) the
  // balance is unknown, never zero.
  const balanceKnown = fundsQuery.isSuccess;
  const balance = balanceKnown
    ? (funds.find((fund) => fund.outletId === outletId)?.balanceIdr ?? 0)
    : null;
  const amountIdr = parseRupiahInput(amount);
  const overBalance =
    balance !== null &&
    amountIdr !== null &&
    pettyReturnExceedsBalance(kind, amountIdr, balance);
  const errors = {
    outlet:
      outletId === ""
        ? t("accounting.cash.petty.form.outletRequired")
        : undefined,
    bank:
      bankAccountId === ""
        ? t("accounting.cash.petty.form.bankRequired")
        : undefined,
    amount:
      amountIdr === null || amountIdr <= 0
        ? t("accounting.cash.petty.form.invalidAmount")
        : overBalance
          ? t("accounting.cash.petty.form.overBalance")
          : !isTopup && !balanceKnown
            ? t("accounting.cash.petty.form.balanceError")
            : undefined,
    description:
      description.trim() === ""
        ? t("accounting.cash.petty.form.descriptionRequired")
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

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t(
            isTopup
              ? "accounting.cash.petty.form.titleTopup"
              : "accounting.cash.petty.form.titleReturn",
          )}
        </DialogTitle>
        <DialogDescription>
          {t(
            isTopup
              ? "accounting.cash.petty.form.descriptionTopup"
              : "accounting.cash.petty.form.descriptionReturn",
          )}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (create.isPending || !valid || amountIdr === null) return;
          const request = {
            kind,
            outletId,
            bankAccountId,
            amountIdr,
            description: description.trim(),
          };
          // Same body, same key (the server replays); another body, another key.
          const body = {
            ...request,
            idempotencyKey: keySession.current(JSON.stringify(request)),
          } as CreatePettyCashMovementBody;
          create.mutate(body, {
            onSuccess: (result) => {
              keySession.reset();
              // 202: a top-up above the limit is held as a pending cash/bank
              // entry (no balance, no journal yet); the list shows its status.
              toast(
                result.kind === "petty_topup"
                  ? {
                      title: t("accounting.cash.petty.form.pendingApproval"),
                      tone: "info",
                    }
                  : {
                      title: t("accounting.cash.petty.form.saved"),
                      tone: "success",
                    },
              );
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
                    : t("accounting.cash.petty.form.failed"),
              );
            },
          });
        }}
      >
        <FormField
          id="petty-movement-outlet"
          label={t("accounting.cash.petty.form.outlet")}
          hint={
            outlets.length === 0 ? (
              t("accounting.cash.petty.form.noOutlets")
            ) : (
              <>
                <span>{t("accounting.cash.petty.form.outletHint")}</span>
                {outletId !== "" ? (
                  <span
                    role="status"
                    className="mt-1 flex flex-wrap items-baseline gap-x-2"
                  >
                    <span>
                      {t("accounting.cash.petty.form.currentBalance")}
                    </span>
                    {fundsQuery.isPending ? (
                      <Skeleton className="inline-block h-4 w-24 align-middle" />
                    ) : balance !== null ? (
                      <Money amount={balance} size="sm" />
                    ) : (
                      <>
                        <span>
                          {t("accounting.cash.petty.form.balanceError")}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void fundsQuery.refetch();
                          }}
                        >
                          {t("accounting.cash.petty.form.balanceRetry")}
                        </Button>
                      </>
                    )}
                  </span>
                ) : null}
              </>
            )
          }
          error={shown("outlet")}
          required
        >
          <Select
            value={outletId}
            onValueChange={(value) =>
              update("outlet", () => setOutletId(value))
            }
          >
            <SelectTrigger
              id="petty-movement-outlet"
              disabled={outlets.length === 0}
            >
              <SelectValue
                placeholder={t("accounting.cash.petty.form.outletPlaceholder")}
              />
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
          id="petty-movement-bank"
          label={t("accounting.cash.petty.form.bankAccount")}
          error={shown("bank")}
          required
        >
          <Select
            value={bankAccountId}
            onValueChange={(value) =>
              update("bank", () => setBankAccountId(value))
            }
          >
            <SelectTrigger id="petty-movement-bank">
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
          label={t("accounting.cash.petty.form.amount")}
          hint={t("accounting.cash.petty.form.amountHint")}
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
          label={t("accounting.cash.petty.form.description")}
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
        <ServerError message={serverError} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t("accounting.cash.petty.form.submit")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
