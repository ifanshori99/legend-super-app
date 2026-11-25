// Confirm-then-publish dialog for the weekly roster (PRD v1.7 §3 Kelompok D 28
// "Roster Mingguan" → publikasi). Publishing flips every draft of the week to
// published through `publishRoster`; the page mints the idempotency key so a
// double tap or a retry replays the same request.
import { TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PendingDialog,
  PendingDialogContent,
} from "@/components/ui/pending-dialog";
import { ApiError } from "@/lib/api/errors";

export function PublishDialog({
  open,
  onOpenChange,
  range,
  shiftCount,
  employeeCount,
  warningCount,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  range: string;
  shiftCount: number;
  employeeCount: number;
  warningCount: number;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <PendingDialog pending={pending} open={open} onOpenChange={onOpenChange}>
      <PendingDialogContent>
        <DialogHeader>
          <DialogTitle>{t("roster.publish.title")}</DialogTitle>
          <DialogDescription>
            {t("roster.publish.description", { range })}
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-container bg-surface-2 p-3 text-sm font-medium">
          {t("roster.publish.summary", {
            shifts: shiftCount,
            employees: employeeCount,
          })}{" "}
          · <span className="tabular">{range}</span>
        </p>
        {warningCount > 0 ? (
          <p className="flex items-start gap-2 rounded-container bg-warning-subtle p-3 text-sm font-medium text-warning">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {t("roster.publish.warnings", { count: warningCount })}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("roster.publish.noWarnings")}
          </p>
        )}
        {error !== null && error !== undefined && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error instanceof ApiError
              ? error.message
              : t("roster.publish.error")}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              {t("common.cancel")}
            </Button>
          </DialogClose>
          <Button
            type="button"
            loading={pending}
            disabled={shiftCount === 0}
            onClick={onConfirm}
          >
            {t("roster.publish.confirm")}
          </Button>
        </DialogFooter>
      </PendingDialogContent>
    </PendingDialog>
  );
}
