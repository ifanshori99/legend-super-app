// Reject an entry that waits for approval (Q7). A rejected entry never gets
// a journal and cannot be approved again, so the dialog says so and asks for a
// reason (1 to 500 characters), which the list then shows.
import * as React from "react";
import type { CashBankEntry } from "@starter/shared/accounting";
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
import { Money } from "@/components/ui/money";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useRejectCashBankEntry } from "../hooks";
import { CASH_ENTRY_KIND_KEYS, CASH_REASON_MAX, moneyErrorKey } from "../lib";
import { ServerError } from "./server-error";

export function CashEntryRejectDialog({
  entry,
  onClose,
}: {
  /** The entry being rejected; null keeps the dialog closed. */
  entry: CashBankEntry | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {entry !== null ? <RejectForm entry={entry} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RejectForm({
  entry,
  onClose,
}: {
  entry: CashBankEntry;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const kindLabel = t(CASH_ENTRY_KIND_KEYS[entry.kind]);
  const reject = useRejectCashBankEntry();
  const [reason, setReason] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const trimmed = reason.trim();
  const error =
    trimmed === ""
      ? t("accounting.cash.entries.approval.reasonRequired")
      : trimmed.length > CASH_REASON_MAX
        ? t("accounting.cash.entries.approval.reasonTooLong")
        : undefined;
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t("accounting.cash.entries.approval.rejectTitle", {
            kind: kindLabel.toLocaleLowerCase("id"),
          })}
        </DialogTitle>
        <DialogDescription>
          {t("accounting.cash.entries.approval.rejectDescription", {
            kind: kindLabel,
          })}
        </DialogDescription>
      </DialogHeader>
      <p className="text-sm leading-5">
        {t("accounting.cash.entries.approval.rejectTarget", {
          description: entry.description,
        })}{" "}
        <Money amount={entry.amountIdr} />
      </p>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (reject.isPending || error !== undefined) return;
          reject.mutate(
            { entryId: entry.id, reason: trimmed },
            {
              onSuccess: () => {
                toast({
                  title: t("accounting.cash.entries.approval.rejected", {
                    kind: kindLabel,
                  }),
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
                      : t("accounting.cash.entries.approval.failed"),
                );
              },
            },
          );
        }}
      >
        <FormField
          label={t("accounting.cash.entries.approval.reason")}
          error={submitted ? error : undefined}
          required
        >
          <Textarea
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setServerError(null);
            }}
            maxLength={CASH_REASON_MAX}
          />
        </FormField>
        <ServerError message={serverError} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="destructive"
            loading={reject.isPending}
          >
            {t("accounting.cash.entries.approval.rejectSubmit", {
              kind: kindLabel.toLocaleLowerCase("id"),
            })}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
