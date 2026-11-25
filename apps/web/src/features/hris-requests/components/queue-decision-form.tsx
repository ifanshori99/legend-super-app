// Confirmation form for rejection and rule override.
import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";

export type DecisionFormMode = "reject" | "override";

export function QueueDecisionForm({
  mode,
  summary,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  mode: DecisionFormMode;
  /** "Cuti tahunan · Maya Anggraini": names what is being decided. */
  summary: string;
  pending: boolean;
  /** Validation message of the reason; undefined when valid. */
  error: string | undefined;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [reason, setReason] = React.useState("");
  const copy =
    mode === "reject"
      ? {
          title: t("hrisRequestsQueue.rejectForm.title"),
          label: t("hrisRequestsQueue.rejectForm.reasonLabel"),
          hint: t("hrisRequestsQueue.rejectForm.reasonHint"),
          cancel: t("hrisRequestsQueue.rejectForm.cancel"),
          submit: t("hrisRequestsQueue.rejectForm.submit"),
          submitting: t("hrisRequestsQueue.rejectForm.submitting"),
        }
      : {
          title: t("hrisRequestsQueue.overrideForm.title"),
          label: t("hrisRequestsQueue.overrideForm.reasonLabel"),
          hint: t("hrisRequestsQueue.overrideForm.reasonHint"),
          cancel: t("hrisRequestsQueue.overrideForm.cancel"),
          submit: t("hrisRequestsQueue.overrideForm.submit"),
          submitting: t("hrisRequestsQueue.overrideForm.submitting"),
        };

  return (
    <form
      className="grid gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) onSubmit(reason);
      }}
    >
      <div className="grid gap-1">
        <h3 className="type-heading">{copy.title}</h3>
        <p className="text-muted-foreground">{summary}</p>
      </div>
      <FormField label={copy.label} hint={copy.hint} error={error} required>
        <Textarea
          value={reason}
          maxLength={500}
          autoFocus
          onChange={(event) => setReason(event.target.value)}
        />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={pending}
          onClick={onCancel}
        >
          {copy.cancel}
        </Button>
        <Button
          type="submit"
          className="min-h-11"
          aria-busy={pending || undefined}
          aria-disabled={pending || undefined}
        >
          {pending && (
            <LoaderCircle
              className="motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
          {pending ? copy.submitting : copy.submit}
        </Button>
      </div>
    </form>
  );
}
