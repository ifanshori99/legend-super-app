// Reason dialog with a minimum length, used by the reopen request and the
// rejection decision. The form lives inside DialogContent, which Radix
// unmounts on close, so every opening starts empty without an effect reset.
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
  description?: string;
  label: string;
  hint?: string;
  submitLabel: string;
  requiredMessage: string;
  tooShortMessage: string;
  minLength?: number;
  maxLength?: number;
  pending?: boolean;
  /** Server refusal, shown under the field until the next submit. */
  error?: string;
  onSubmit: (reason: string) => void;
};

export function ReasonDialog(props: ReasonDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <ReasonForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({
  title,
  description,
  label,
  hint,
  submitLabel,
  requiredMessage,
  tooShortMessage,
  minLength = 1,
  maxLength = 500,
  pending = false,
  error,
  onSubmit,
  onOpenChange,
}: ReasonDialogProps) {
  const t = useT();
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const trimmed = reason.trim();
  const issue =
    trimmed === ""
      ? requiredMessage
      : trimmed.length < minLength
        ? tooShortMessage
        : null;
  const fieldError = touched ? (issue ?? error) : error;
  const valid = trimmed !== "" && trimmed.length >= minLength;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      <FormField label={label} hint={hint} error={fieldError} required>
        <Textarea
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setTouched(true);
          }}
          rows={4}
          maxLength={maxLength}
          autoFocus
        />
      </FormField>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={pending}
        >
          {t("common.cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          loading={pending}
          disabled={pending}
          onClick={() => {
            setTouched(true);
            if (valid) onSubmit(trimmed);
          }}
        >
          {submitLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
