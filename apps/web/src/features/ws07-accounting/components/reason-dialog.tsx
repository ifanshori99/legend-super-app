// Reason dialog for rejections: approve/reject need a different person than
// the requester (AUTH-06), and a rejection must say why (visible to the
// requester). The submit button stays disabled until the reason is filled.
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
  pending?: boolean;
  error?: string;
  onSubmit: (reason: string) => void;
  maxLength?: number;
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
  label,
  hint,
  submitLabel,
  pending = false,
  error,
  onSubmit,
  onOpenChange,
  maxLength = 500,
}: ReasonDialogProps) {
  const t = useT();
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const trimmed = reason.trim();
  const fieldError =
    touched && trimmed === ""
      ? t("accounting.manual.actions.reasonRequired")
      : error;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {hint && <DialogDescription>{hint}</DialogDescription>}
      </DialogHeader>
      <FormField label={label} error={fieldError} required>
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
          disabled={trimmed === ""}
          onClick={() => {
            setTouched(true);
            if (trimmed !== "") onSubmit(trimmed);
          }}
        >
          {submitLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
