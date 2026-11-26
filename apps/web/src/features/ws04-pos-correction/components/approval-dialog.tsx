import { useState, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Notice,
  SupervisorPinDialog,
} from "../../ws04-pos-kasir/components/shared";
import type { OverrideAction } from "../../ws04-pos-kasir/types";
import { useApproverOptions } from "../hooks";

export type ApprovalSubmit = {
  approverUserId: string;
  pin: string;
  reason: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What is approved: the correction, its value and the order. */
  summary: ReactNode;
  onSubmit: (approval: ApprovalSubmit) => void;
  pending: boolean;
  /** Why the last try failed, with how to recover. */
  error: string | null;
  /** The override action: the server then lists only who may approve it. */
  action?: OverrideAction;
  /** Label of the reason field when it has a special meaning. */
  reasonLabel?: string;
};

// The supervisor's approval step (PRD AUTH-06): choose who approves, then that
// person types a reason and their own PIN. The approver must differ from the
// requester; the API enforces it and answers an error this dialog shows.
export function ApprovalDialog({
  open,
  onOpenChange,
  title,
  summary,
  onSubmit,
  pending,
  error,
  action,
  reasonLabel,
}: Props) {
  const t = useT();
  const approvers = useApproverOptions(action);
  const [pickedId, setPickedId] = useState<string>();

  if (approvers.isLoading || approvers.isError || !approvers.data?.length) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription asChild>
              <div>{summary}</div>
            </DialogDescription>
          </DialogHeader>
          {approvers.isLoading ? (
            <div aria-busy="true" role="status" className="grid gap-2">
              <span className="sr-only">{t("common.loading")}</span>
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : approvers.isError ? (
            <Notice
              tone="danger"
              title={t("posCorrection.approval.supervisorsError")}
            />
          ) : (
            <Notice
              tone="warning"
              title={t("posCorrection.approval.supervisorsEmpty")}
            />
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            {approvers.isError && (
              <Button
                type="button"
                loading={approvers.isFetching}
                onClick={() => void approvers.refetch()}
              >
                <RotateCw aria-hidden="true" />
                {t("common.retry")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const options = approvers.data;
  // The first supervisor stays chosen until another is picked; a pick that
  // dropped off a refreshed list falls back to the first.
  const approverUserId = (
    options.find((option) => option.userId === pickedId) ?? options[0]
  ).userId;

  return (
    <SupervisorPinDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      summary={summary}
      details={
        <div className="grid gap-2">
          <FormField
            label={t("posCorrection.approval.supervisorLabel")}
            hint={t("posCorrection.approval.supervisorHint")}
            required
          >
            <Select
              value={approverUserId}
              onValueChange={setPickedId}
              disabled={pending}
            >
              <SelectTrigger className="h-control">
                <SelectValue
                  placeholder={t(
                    "posCorrection.approval.supervisorPlaceholder",
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.userId} value={option.userId}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <p className="text-sm text-muted-foreground">
            {t("posCorrection.approval.recorded")}
          </p>
        </div>
      }
      onSubmit={({ pin, reason }) => onSubmit({ approverUserId, pin, reason })}
      pending={pending}
      error={error}
      minReasonLength={4}
      reasonLabel={reasonLabel}
    />
  );
}
