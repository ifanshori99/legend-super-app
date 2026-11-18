// An approved read_write grant that is still running: end time and revoke
// behind a confirmation (legend-8r77t).
import * as React from "react";
import { CircleCheck } from "lucide-react";
import type { ActiveEntry } from "./owner-logic.ts";
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
import { Countdown, formatInstant } from "./shared.tsx";
import { shortId } from "./owner-logic.ts";
import { OwnerDetail } from "./owner-request-card.tsx";

export function OwnerActiveCard({
  entry,
  skewMs,
  blockedText,
  revoking,
  revokeError,
  onRevoke,
}: {
  entry: ActiveEntry;
  /** Device clock offset from the API clock (see `clockSkewMs`). */
  skewMs: number;
  /** Why revoking is off, already in words; null when allowed. */
  blockedText: string | null;
  revoking: boolean;
  revokeError: string | null;
  onRevoke: (grantId: string) => Promise<boolean>;
}) {
  const t = useT();
  const [confirming, setConfirming] = React.useState(false);
  const { request, grant } = entry;

  const confirm = async () => {
    const done = await onRevoke(grant.id);
    if (done) setConfirming(false);
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-lg leading-7 font-semibold">
            {t("supportAccessOwner.active.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("supportAccessOwner.active.approvedAt", {
              time: formatInstant(grant.startedAt),
            })}
          </p>
        </div>
        <Badge tone="success">
          <CircleCheck aria-hidden="true" />
          {t("supportAccess.status.active")}
        </Badge>
      </div>

      <dl className="grid">
        <OwnerDetail label={t("supportAccessOwner.active.holder")}>
          {t("supportAccessOwner.pending.requester", {
            id: shortId(request.superAdminUserId),
          })}
        </OwnerDetail>
        <OwnerDetail label={t("supportAccessOwner.active.scope")}>
          {t("supportAccessOwner.pending.scopeValue")}
        </OwnerDetail>
        <OwnerDetail label={t("supportAccessOwner.active.endsAt")}>
          {formatInstant(grant.expiresAt)}
        </OwnerDetail>
        <OwnerDetail label={t("supportAccessOwner.active.remaining")}>
          <Countdown grant={grant} skewMs={skewMs} />
        </OwnerDetail>
      </dl>

      <div className="grid gap-2">
        <div>
          <Button
            type="button"
            variant="outline"
            className="text-danger"
            disabled={blockedText !== null}
            aria-describedby={
              blockedText ? `owner-revoke-${grant.id}` : undefined
            }
            onClick={() => setConfirming(true)}
          >
            {t("supportAccessOwner.active.revoke")}
          </Button>
        </div>
        <p
          id={`owner-revoke-${grant.id}`}
          className="text-sm text-muted-foreground"
        >
          {blockedText ?? t("supportAccessOwner.active.revokeNote")}
        </p>
      </div>

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!revoking) setConfirming(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("supportAccessOwner.revoke.title")}</DialogTitle>
            <DialogDescription>
              {t("supportAccessOwner.revoke.body")}
            </DialogDescription>
          </DialogHeader>
          {revokeError && (
            <p className="text-sm text-danger" role="alert">
              {revokeError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={revoking}
              onClick={() => setConfirming(false)}
            >
              {t("supportAccessOwner.revoke.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={revoking || blockedText !== null}
              onClick={() => void confirm()}
            >
              {revoking
                ? t("supportAccessOwner.revoke.confirming")
                : t("supportAccessOwner.revoke.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
