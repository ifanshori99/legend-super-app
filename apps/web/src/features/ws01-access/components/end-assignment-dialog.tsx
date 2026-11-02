// End a role assignment now (PRD §3.7 "masa berlaku"): the API sets
// valid_until and audits the reason. The dialog never offers to end the last
// active Owner; that protection is server-side (legend-vbws/tj8o) and the API
// answers CONFLICT, which the screen shows.
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
import { useToast } from "@/components/ui/toast";
import { accessErrorMessage } from "../errors";
import { useEndRoleAssignment } from "../hooks";

export function EndAssignmentDialog({
  assignmentId,
  label,
  open,
  onOpenChange,
}: {
  assignmentId: string | null;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const end = useEndRoleAssignment();
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError(t("access.assignments.endReasonError"));
      return;
    }
    if (!assignmentId) return;
    setError(null);
    end.mutate(
      { assignmentId, body: { reason: reason.trim() } },
      {
        onSuccess: () => {
          toast({ title: t("access.assignments.ended") });
          setReason("");
          onOpenChange(false);
        },
        onError: (failure) => setError(accessErrorMessage(failure, t)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason("");
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("access.assignments.endTitle")}</DialogTitle>
          <DialogDescription>
            {t("access.assignments.endDescription")}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm font-semibold">{label}</p>
        <form className="grid gap-3" onSubmit={submit} noValidate>
          <FormField
            label={t("access.assignments.endReason")}
            hint={t("access.assignments.endReasonHint")}
            error={error ?? undefined}
            required
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={3}
            />
          </FormField>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="destructive" loading={end.isPending}>
              {t("access.assignments.end")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
