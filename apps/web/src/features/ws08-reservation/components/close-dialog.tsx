// Closing a reservation: cancellation and no-show (PRD §3.22 "DP & Kebijakan",
// RSV-03). Both follow the policy snapshot captured at booking; the result view
// states what happens to the DP, because the refund itself is a WS-05 action.
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
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { Money } from "@/components/ui/money";
import { useToast } from "@/components/ui/toast";
import type {
  Reservation,
  ReservationCloseResult,
} from "@starter/shared/reservation";
import { reservationErrorKey } from "../lib";
import { useCancelReservation, useMarkNoShow } from "../hooks";

type Mode = "cancel" | "noShow";

export function CloseReservationDialog({
  open,
  onOpenChange,
  outletId,
  reservation,
  mode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outletId: string;
  reservation: Reservation;
  mode: Mode;
}) {
  const t = useT();
  const toast = useToast();
  const cancel = useCancelReservation();
  const noShow = useMarkNoShow();
  const mutation = mode === "cancel" ? cancel : noShow;
  // Mounted per open by the detail sheet, so these start clean every time.
  const [text, setText] = React.useState("");
  const [showError, setShowError] = React.useState(false);
  const [result, setResult] = React.useState<ReservationCloseResult | null>(
    null,
  );

  const reasonMissing = mode === "cancel" && text.trim() === "";
  const fieldError =
    mode === "cancel" && showError && reasonMissing
      ? t("reservation.cancel.reasonRequired")
      : undefined;
  const error = mutation.error ? t(reservationErrorKey(mutation.error)) : null;

  const submit = () => {
    if (reasonMissing) {
      setShowError(true);
      return;
    }
    const input = { outletId, reservationId: reservation.id };
    const options = {
      onSuccess: (closed: ReservationCloseResult) => {
        setResult(closed);
        toast({
          title: t(
            mode === "cancel"
              ? "reservation.cancel.success"
              : "reservation.noShow.success",
          ),
          tone: "success",
        });
      },
    };
    if (mode === "cancel")
      cancel.mutate({ ...input, reason: text.trim() }, options);
    else noShow.mutate({ ...input, note: text.trim() || undefined }, options);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(
              mode === "cancel"
                ? "reservation.cancel.title"
                : "reservation.noShow.title",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              mode === "cancel"
                ? "reservation.cancel.hint"
                : "reservation.noShow.hint",
            )}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="grid gap-2 rounded-lg bg-muted p-3 text-sm">
            <p className="font-semibold">
              {t("reservation.cancel.outcomeTitle")}
            </p>
            {result.depositOutcome.resolution === "nothing_paid" ? (
              <p>
                {t(
                  result.reservation.depositStatus === "refunded"
                    ? "reservation.cancel.depositAlreadyRefunded"
                    : "reservation.cancel.nothingPaid",
                )}
              </p>
            ) : (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">
                  {t("reservation.cancel.refund")}
                </dt>
                <dd className="text-right">
                  <Money amount={result.depositOutcome.refundIdr} size="sm" />
                </dd>
                <dt className="text-muted-foreground">
                  {t("reservation.cancel.forfeited")}
                </dt>
                <dd className="text-right">
                  <Money
                    amount={result.depositOutcome.forfeitedIdr}
                    size="sm"
                  />
                </dd>
              </dl>
            )}
          </div>
        ) : (
          <FormField
            id="reservation-close-note"
            label={t(
              mode === "cancel"
                ? "reservation.cancel.reasonLabel"
                : "reservation.noShow.noteLabel",
            )}
            required={mode === "cancel"}
            error={fieldError}
          >
            <Textarea
              id="reservation-close-note"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t(
                mode === "cancel"
                  ? "reservation.cancel.reasonPlaceholder"
                  : "reservation.noShow.notePlaceholder",
              )}
            />
          </FormField>
        )}

        {error && (
          <p role="alert" className="text-sm font-semibold text-danger">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.close")}
          </Button>
          {!result && (
            <Button
              type="button"
              variant="destructive"
              loading={mutation.isPending}
              disabled={reasonMissing}
              onClick={submit}
            >
              {t(
                mode === "cancel"
                  ? "reservation.cancel.confirm"
                  : "reservation.noShow.confirm",
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
