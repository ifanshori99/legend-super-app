// Confirm step for every platform change (PRD §3 F4: Super Admin changes
// packages, flags, quotas and gateways; each is audited with a reason). The
// reason is required by the contract (10-500 characters, setTenantPackageInput).
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

export const REASON_MIN = 10;
export const REASON_MAX = 500;

export function ChangeDialog({
  open,
  onOpenChange,
  title,
  description,
  summary,
  destructive = false,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** What is about to change, as a list the admin reads before confirming. */
  summary: React.ReactNode;
  destructive?: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
}) {
  const t = useT();
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const short = reason.trim().length < REASON_MIN;
  // Every open starts with an empty reason, however the last one closed
  // (cancel button, Esc, or a successful save that closed it from outside).
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setReason("");
      setTouched(false);
    }
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!short) onConfirm(reason.trim());
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // No closing mid-save: the result would land on a closed dialog.
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <p className="type-eyebrow text-muted-foreground">
            {t("platformOps.confirm.changes")}
          </p>
          {summary}
        </div>
        <form className="grid gap-3" onSubmit={submit} noValidate>
          <FormField
            label={t("platformOps.confirm.reason")}
            hint={t("platformOps.confirm.reasonHint", { min: REASON_MIN })}
            error={
              touched && short
                ? t("platformOps.confirm.reasonError", { min: REASON_MIN })
                : undefined
            }
            required
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={REASON_MAX}
              rows={3}
            />
          </FormField>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant={destructive ? "destructive" : "default"}
              loading={pending}
            >
              {t("platformOps.confirm.apply")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Ditambah: A, B" / "Dicabut: C" lines for the dialog summary. */
export function DiffSummary({
  rows,
}: {
  rows: { label: string; value: string; tone?: "add" | "remove" }[];
}) {
  return (
    <ul className="grid gap-1 rounded-control border-(length:--border-w) bg-surface-2 p-3 text-sm">
      {rows.map((row) => (
        <li key={row.label} className="flex flex-wrap gap-x-2">
          <span className="font-semibold">{row.label}</span>
          <span
            className={
              row.tone === "remove" ? "text-danger" : "text-foreground"
            }
          >
            {row.value}
          </span>
        </li>
      ))}
    </ul>
  );
}
