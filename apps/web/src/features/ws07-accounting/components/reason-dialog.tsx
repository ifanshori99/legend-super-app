// Reason dialog for rejections: approve/reject need a different person than
// the requester (AUTH-06), and a rejection must say why (visible to the
// requester). The submit button is never disabled for a short reason: a click
// shows why and moves focus to the field. While saving the dialog cannot be
// closed and the field is read-only.
// The form lives inside DialogContent, which Radix unmounts on close, so every
// opening starts with an empty field without an effect resetting state.
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

export type ReasonDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  hint?: string;
  submitLabel: string;
  /** Label of the dismiss button (default "Batal"); say "Kembali" when the submit label also starts with "Batal". */
  cancelLabel?: string;
  pending?: boolean;
  /** Refusal of the reason itself, shown under the field. */
  error?: string;
  /** Server refusal of the action, shown above the buttons as an alert. */
  formError?: string;
  onSubmit: (reason: string) => void;
  maxLength?: number;
  /** Shortest accepted reason (default 1); `minLengthError` words the refusal. */
  minLength?: number;
  minLengthError?: string;
};

export function ReasonDialog(props: ReasonDialogProps) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next && props.pending) return;
        props.onOpenChange(next);
      }}
    >
      <DialogContent
        hideClose={props.pending}
        onEscapeKeyDown={(event) => {
          if (props.pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (props.pending) event.preventDefault();
        }}
      >
        <ReasonForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({
  title,
  label,
  hint,
  submitLabel,
  cancelLabel,
  pending = false,
  error,
  formError,
  onSubmit,
  onOpenChange,
  maxLength = 500,
  minLength = 1,
  minLengthError,
}: ReasonDialogProps) {
  const t = useT();
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  // A phone's keyboard would cover the dialog the moment it opens.
  const [autoFocus] = React.useState(
    () => !window.matchMedia("(pointer: coarse)").matches,
  );
  const trimmed = reason.trim();
  const tooShort = trimmed.length < minLength;
  const fieldError =
    touched && trimmed === ""
      ? t("accounting.manual.actions.reasonRequired")
      : touched && tooShort && minLengthError
        ? minLengthError
        : error;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {hint && <DialogDescription>{hint}</DialogDescription>}
      </DialogHeader>
      <FormField
        label={label}
        error={fieldError}
        hint={
          minLength > 1 ? (
            <span className="tabular">
              {trimmed.length}/{minLength}
            </span>
          ) : undefined
        }
        required
      >
        <Textarea
          ref={fieldRef}
          value={reason}
          readOnly={pending}
          onChange={(event) => {
            setReason(event.target.value);
            setTouched(true);
          }}
          rows={4}
          maxLength={maxLength}
          autoFocus={autoFocus}
        />
      </FormField>
      {formError && (
        <p className="text-sm leading-5 font-medium text-danger" role="alert">
          {formError}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={pending}
        >
          {cancelLabel ?? t("common.cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          loading={pending}
          onClick={() => {
            setTouched(true);
            if (tooShort) fieldRef.current?.focus();
            else onSubmit(trimmed);
          }}
        >
          {submitLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
