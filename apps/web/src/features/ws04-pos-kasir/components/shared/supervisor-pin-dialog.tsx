import { useId, useRef, useState, type ReactNode } from "react";
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
import { PinPad } from "@/features/ws01-device-pin/components/pin-pad";

export type SupervisorApproval = { reason: string; pin: string };

export type SupervisorPinDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What is being approved: a short sentence or a small summary block. */
  summary: ReactNode;
  /** Extra block under the header (outside the description), e.g. limits. */
  details?: ReactNode;
  /** Called once a reason and a full PIN are in. The parent verifies. */
  onSubmit: (approval: SupervisorApproval) => void;
  /** The parent is verifying the PIN. */
  pending?: boolean;
  /** Why the last try failed (wrong PIN, no permission), with how to recover. */
  error?: string | null;
  /** Shortest reason accepted; the default only asks for a non-empty one. */
  minReasonLength?: number;
  /** Label of the reason field when it is more than a plain reason. */
  reasonLabel?: string;
  /** The dialog cannot be closed (Cancel, X, Escape, outside tap) meanwhile. */
  locked?: boolean;
};

function PinDialogBody({
  title,
  summary,
  details,
  onSubmit,
  onCancel,
  pending,
  error,
  minReasonLength,
  reasonLabel,
  locked,
}: Omit<SupervisorPinDialogProps, "open" | "onOpenChange"> & {
  onCancel: () => void;
}) {
  const t = useT();
  const reasonId = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string>();
  // Empty the dots and shake once per new error (adjusted during render, as the
  // pad itself does).
  const [seenError, setSeenError] = useState(error);
  const [signal, setSignal] = useState(0);
  if (seenError !== error) {
    setSeenError(error);
    if (error) setSignal((current) => current + 1);
  }

  function handlePin(pin: string) {
    const trimmed = reason.trim();
    if (trimmed === "") {
      setReasonError(t("posKasirCommon.pinDialog.reasonRequired"));
      setSignal((current) => current + 1);
      reasonRef.current?.focus();
      return;
    }
    if (minReasonLength && trimmed.length < minReasonLength) {
      setReasonError(
        t("posKasirCommon.pinDialog.reasonTooShort", { min: minReasonLength }),
      );
      setSignal((current) => current + 1);
      reasonRef.current?.focus();
      return;
    }
    onSubmit({ reason: trimmed, pin });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription asChild>
          <div>{summary}</div>
        </DialogDescription>
      </DialogHeader>
      {details}
      <FormField
        label={reasonLabel ?? t("posKasirCommon.pinDialog.reasonLabel")}
        id={reasonId}
        required
        error={reasonError}
      >
        <Textarea
          ref={reasonRef}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            if (reasonError) setReasonError(undefined);
          }}
          rows={3}
          onBlur={(event) => {
            // On a phone the pad sits below the fields, out of sight: once a
            // reason is in, bring it up unless focus moved to another control
            // (a tap on plain text lands on the dialog itself).
            const next = event.relatedTarget;
            const toControl =
              next instanceof HTMLElement &&
              next.matches(
                "input,textarea,select,button,a[href],[role='combobox']",
              ) &&
              !padRef.current?.contains(next);
            if (reason.trim() !== "" && !toControl)
              padRef.current?.scrollIntoView({ block: "nearest" });
          }}
        />
      </FormField>
      <div ref={padRef}>
        <PinPad
          onComplete={handlePin}
          pending={pending}
          clearSignal={signal}
          shakeSignal={signal}
          error={error}
          status={pending ? t("posKasirCommon.pinDialog.checking") : null}
          label={t("posKasirCommon.pinDialog.pinLabel")}
        />
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={locked}
        >
          {t("posKasirCommon.pinDialog.cancel")}
        </Button>
      </DialogFooter>
    </>
  );
}

// The supervisor's approval step: a summary, a required reason and the PIN pad
// (PRD AUTH-06 overrides). It only collects `{reason, pin}`; the parent calls
// the override endpoint and passes back `pending` and `error`. The body mounts
// only while open, so a reason or PIN never lingers after the dialog closes.
export function SupervisorPinDialog({
  open,
  onOpenChange,
  ...body
}: SupervisorPinDialogProps) {
  const stay = (event: Event) => {
    if (body.locked) event.preventDefault();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose={body.locked}
        onEscapeKeyDown={stay}
        onPointerDownOutside={stay}
        onInteractOutside={stay}
      >
        <PinDialogBody {...body} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
