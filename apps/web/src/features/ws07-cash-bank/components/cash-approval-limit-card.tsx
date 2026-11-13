// The cash out approval limit (Q7): a cash out above this amount waits for a
// second person before it is journalled. Shown only to people who hold
// accounting.cash_bank.limit.manage; the API refuses everyone else. The limit
// is whole rupiah from 1 up to the contract's ceiling, never zero or negative.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import {
  formatRupiahInput,
  parseRupiahInput,
} from "@/features/ws07-accounting/lib";
import { useCashApprovalLimit, useUpdateCashApprovalLimit } from "../hooks";
import { CASH_LIMIT_MAX_IDR, moneyErrorKey } from "../lib";
import { ServerError } from "./server-error";

export function CashApprovalLimitCard() {
  const t = useT();
  const limit = useCashApprovalLimit();
  const [open, setOpen] = React.useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("accounting.cash.entries.limit.title")}</CardTitle>
        <CardDescription>
          {t("accounting.cash.entries.limit.description")}
        </CardDescription>
        {limit.data ? (
          <CardAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(true)}
            >
              {t("accounting.cash.entries.limit.edit")}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-1">
        {limit.isPending ? (
          <Skeleton className="h-7 w-40" />
        ) : limit.isError ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {t("accounting.cash.entries.limit.loadFailed")}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t("accounting.cash.entries.limit.current")}
            </p>
            <Money amount={limit.data.limitIdr} size="lg" />
            {limit.data.isDefault ? (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("accounting.cash.entries.limit.defaultNote")}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
      {limit.data ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <LimitForm
              currentIdr={limit.data.limitIdr}
              onClose={() => setOpen(false)}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}

function LimitForm({
  currentIdr,
  onClose,
}: {
  currentIdr: number;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const update = useUpdateCashApprovalLimit();
  const [value, setValue] = React.useState(() =>
    formatRupiahInput(String(currentIdr)),
  );
  const [submitted, setSubmitted] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const parsed = parseRupiahInput(value);
  const error =
    parsed === null || parsed < 1
      ? t("accounting.cash.entries.limit.invalid")
      : parsed > CASH_LIMIT_MAX_IDR
        ? t("accounting.cash.entries.limit.tooLarge")
        : undefined;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("accounting.cash.entries.limit.title")}</DialogTitle>
        <DialogDescription>
          {t("accounting.cash.entries.limit.description")}
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (update.isPending || error !== undefined || parsed === null)
            return;
          update.mutate(parsed, {
            onSuccess: () => {
              toast({
                title: t("accounting.cash.entries.limit.saved"),
                tone: "success",
              });
              onClose();
            },
            onError: (cause) => {
              const key =
                cause instanceof ApiError ? moneyErrorKey(cause.code) : null;
              setServerError(
                key
                  ? t(key)
                  : cause instanceof ApiError
                    ? cause.message
                    : t("accounting.cash.entries.limit.failed"),
              );
            },
          });
        }}
      >
        <FormField
          label={t("accounting.cash.entries.limit.field")}
          hint={t("accounting.cash.entries.limit.fieldHint")}
          error={submitted ? error : undefined}
          required
        >
          <Input
            value={value}
            onChange={(event) => {
              setValue(formatRupiahInput(event.target.value));
              setServerError(null);
            }}
            inputMode="numeric"
            autoComplete="off"
            className="tabular"
          />
        </FormField>
        <ServerError message={serverError} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={update.isPending}>
            {t("accounting.cash.entries.limit.save")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
