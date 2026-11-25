// One pending read_write request with the owner's decision (legend-8r77t).
import * as React from "react";
import { Clock } from "lucide-react";
import type { SupportAccessRequest } from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatInstant } from "@/features/ws01-support-access/components/shared";

/** Label over value, with an optional caption (the mockup's detail rows). */
export function OwnerDetail({
  label,
  caption,
  children,
}: {
  label: string;
  caption?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 border-t-(length:--border-w) py-3">
      <dt className="text-sm font-semibold text-muted-foreground">{label}</dt>
      <dd className="grid gap-0.5">
        <span className="text-base font-semibold break-words">{children}</span>
        {caption && (
          <span className="text-sm text-muted-foreground">{caption}</span>
        )}
      </dd>
    </div>
  );
}

export function OwnerPendingCard({
  request,
  blockedText,
  busy,
  onApprove,
  onReject,
}: {
  request: SupportAccessRequest;
  /** Why the decision buttons are off, already in words; null when allowed. */
  blockedText: string | null;
  busy: "approve" | "reject" | null;
  onApprove: (requestId: string) => void;
  onReject: (requestId: string) => void;
}) {
  const t = useT();
  const disabled = blockedText !== null || busy !== null;
  const [confirming, setConfirming] = React.useState(false);
  const [confirmingReject, setConfirmingReject] = React.useState(false);
  const noteId = `owner-request-note-${request.id}`;
  return (
    <Card aria-busy={busy !== null || undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-lg leading-7 font-semibold">
            {t("supportAccessOwner.pending.cardTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("supportAccessOwner.pending.received", {
              time: formatInstant(request.requestedAt),
            })}
          </p>
        </div>
        <Badge tone="warning">
          <Clock aria-hidden="true" />
          {t("supportAccessOwner.status.pending")}
        </Badge>
      </div>

      <dl className="grid">
        <OwnerDetail label={t("supportAccessOwner.pending.requestedBy")}>
          {request.requesterName?.trim() ||
            t("supportAccessOwner.pending.requesterFallback")}
        </OwnerDetail>
        <OwnerDetail label={t("supportAccessOwner.pending.reason")}>
          {request.reason}
        </OwnerDetail>
        <OwnerDetail
          label={t("supportAccessOwner.pending.scope")}
          caption={t("supportAccessOwner.pending.scopeNote")}
        >
          {t("supportAccessOwner.pending.scopeValue")}
        </OwnerDetail>
        <OwnerDetail label={t("supportAccessOwner.pending.duration")}>
          {t("supportAccessOwner.pending.durationValue", {
            minutes: request.durationMinutes,
          })}
        </OwnerDetail>
        <OwnerDetail
          label={t("supportAccessOwner.pending.deadline")}
          caption={t("supportAccessOwner.pending.deadlineNote")}
        >
          {formatInstant(request.approvalExpiresAt)}
        </OwnerDetail>
      </dl>

      <p className="rounded-control bg-surface-2 p-3 text-sm">
        {t("supportAccessOwner.pending.consent")}
      </p>

      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          className="flex-1 text-danger sm:flex-none"
          disabled={disabled}
          aria-describedby={blockedText ? noteId : undefined}
          onClick={() => setConfirmingReject(true)}
        >
          {busy === "reject"
            ? t("supportAccessOwner.pending.rejecting")
            : t("supportAccessOwner.pending.reject")}
        </Button>
        <Button
          type="button"
          className="flex-1 sm:flex-none"
          disabled={disabled}
          aria-describedby={blockedText ? noteId : undefined}
          onClick={() => setConfirming(true)}
        >
          {busy === "approve"
            ? t("supportAccessOwner.pending.approving")
            : t("supportAccessOwner.pending.approve")}
        </Button>
      </div>
      <p id={noteId} className="text-sm text-muted-foreground">
        {blockedText ?? t("supportAccessOwner.pending.ownerOnly")}
      </p>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("supportAccessOwner.pending.confirmTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("supportAccessOwner.pending.confirmBody", {
                minutes: request.durationMinutes,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(false)}
            >
              {t("supportAccessOwner.pending.cancel")}
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={() => {
                setConfirming(false);
                onApprove(request.id);
              }}
            >
              {t("supportAccessOwner.pending.confirmAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmingReject} onOpenChange={setConfirmingReject}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("supportAccessOwner.pending.rejectConfirmTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("supportAccessOwner.pending.rejectConfirmBody")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmingReject(false)}
            >
              {t("supportAccessOwner.pending.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                setConfirmingReject(false);
                onReject(request.id);
              }}
            >
              {t("supportAccessOwner.pending.rejectConfirmAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
