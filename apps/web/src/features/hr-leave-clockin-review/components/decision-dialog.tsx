// Confirmation dialog of the leave clock-in decision (bead legend-3jem1). One
// dialog for both outcomes; the copy names the date so a multi-day leave never
// reads as cancelled in full. A failed save keeps the dialog open with the
// reason in view and the confirm button ready to retry.
import * as React from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";
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
import { formatBusinessDate } from "@/features/ws10-attendance-qr/format.ts";
import type { LeaveClockinAction } from "../types.ts";

export function DecisionDialog({
  action,
  businessDate,
  pending,
  offline,
  blocked,
  errorMessage,
  onConfirm,
  onOpenChange,
}: {
  /** The decision being confirmed; null keeps the dialog closed. */
  action: LeaveClockinAction | null;
  /** Business date (YYYY-MM-DD) named in the copy. */
  businessDate: string;
  pending: boolean;
  offline: boolean;
  /** The failure cannot succeed on retry (409 / 403): confirm stays disabled. */
  blocked: boolean;
  /** Human message of the last failed attempt; null when none. */
  errorMessage: string | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const date = formatBusinessDate(businessDate);
  // The close animation outlives `action`; keep the last copy so it does not
  // flip to the other decision while fading out.
  const [shown, setShown] = React.useState<LeaveClockinAction>("keep_leave");
  if (action !== null && action !== shown) setShown(action);
  const copy =
    (action ?? shown) === "cancel_leave"
      ? {
          title: t("leaveClockinReview.confirmCancel.title"),
          description: t("leaveClockinReview.confirmCancel.description", {
            date,
          }),
          back: t("leaveClockinReview.confirmCancel.back"),
          confirm: t("leaveClockinReview.confirmCancel.confirm"),
          confirming: t("leaveClockinReview.confirmCancel.confirming"),
        }
      : {
          title: t("leaveClockinReview.confirmKeep.title"),
          description: t("leaveClockinReview.confirmKeep.description", {
            date,
          }),
          back: t("leaveClockinReview.confirmKeep.back"),
          confirm: t("leaveClockinReview.confirmKeep.confirm"),
          confirming: t("leaveClockinReview.confirmKeep.confirming"),
        };
  const failure = offline
    ? t("leaveClockinReview.confirmFailed.offline")
    : errorMessage;

  return (
    <Dialog
      open={action !== null}
      // A save in flight cannot be dismissed: the outcome would be invisible.
      onOpenChange={(open) => {
        if (!pending) onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-lg" hideClose={pending}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        {failure && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-container bg-danger-subtle p-3 text-sm leading-5 text-danger"
          >
            <CircleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <div className="grid gap-0.5">
              <p className="font-semibold">
                {t("leaveClockinReview.confirmFailed.title")}
              </p>
              <p>{failure}</p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {copy.back}
          </Button>
          <Button
            disabled={offline || blocked}
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
            onClick={() => {
              // aria-disabled keeps focus on the button while saving.
              if (!pending) onConfirm();
            }}
          >
            {pending && (
              <LoaderCircle
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />
            )}
            {pending ? copy.confirming : copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
