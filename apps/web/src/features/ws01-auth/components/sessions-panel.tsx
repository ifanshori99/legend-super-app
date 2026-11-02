import * as React from "react";
import { CircleCheck, Clock, Laptop, Smartphone, Trash2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import type { SessionView } from "@starter/shared/identity";
import { formatDateTime } from "../format";
import { useRevokeSession, useSecuritySessions } from "../hooks";
import { sessionRowStatus } from "../state";

const STATUS_TONE = {
  active: "success",
  ending: "warning",
  mfa_pending: "info",
} as const;

function DeviceIcon({ label }: { label: string }) {
  const phone = /iphone|android|pixel|galaxy/i.test(label);
  const Icon = phone ? Smartphone : Laptop;
  return (
    <Icon
      className="size-4 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
  );
}

/** One device's status, always icon + text (never color alone). */
function SessionStatus({
  view,
  mfaRequired,
  now,
}: {
  view: SessionView;
  mfaRequired: boolean;
  now: Date;
}) {
  const t = useT();
  const status = sessionRowStatus({ view, mfaRequired, now });
  const Icon = status === "active" ? CircleCheck : Clock;
  return (
    <Badge tone={STATUS_TONE[status]} className="gap-1">
      <Icon aria-hidden="true" />
      {status === "active"
        ? t("staffAuth.sessions.statusActive")
        : status === "ending"
          ? t("staffAuth.sessions.statusEnding")
          : t("staffAuth.sessions.statusMfaPending")}
    </Badge>
  );
}

/**
 * "Sesi & perangkat" (PRD §3 F6): server-held sessions, revocable per device.
 * A row list rather than a table: one device is one object with a name, a
 * status and one action, and the rows stay readable on a 390px phone without
 * horizontal scrolling. The current session is marked, not revocable from here
 * (signing out is the header action).
 */
export function SessionsPanel({ mfaRequired }: { mfaRequired: boolean }) {
  const t = useT();
  const toast = useToast();
  const sessions = useSecuritySessions();
  const revoke = useRevokeSession();
  const [now, setNow] = React.useState(() => new Date());
  const [target, setTarget] = React.useState<SessionView | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const rows = sessions.data ?? [];
  const state = sessions.isPending
    ? "loading"
    : sessions.isError
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  function confirmRevoke() {
    if (!target) return;
    setError(null);
    revoke.mutate(target.session.id, {
      onSuccess: () => {
        toast({
          title: t("staffAuth.sessions.revoked", {
            device: target.session.deviceLabel,
          }),
          tone: "success",
        });
        setTarget(null);
      },
      onError: () => setError(t("staffAuth.sessions.revokeFailed")),
    });
  }

  return (
    <>
      <DataTableShell
        title={t("staffAuth.sessions.title")}
        description={t("staffAuth.sessions.description")}
        state={state}
        onRetry={() => void sessions.refetch()}
        loadingRows={2}
        empty={{
          title: t("staffAuth.sessions.emptyTitle"),
          description: t("staffAuth.sessions.emptyHint"),
        }}
      >
        <ul className="divide-y">
          {rows.map((view) => {
            const { session } = view;
            return (
              <li
                key={session.id}
                className="flex flex-wrap items-center gap-3 px-card py-3"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                  <DeviceIcon label={session.deviceLabel} />
                </span>
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm leading-5 font-semibold">
                      {session.deviceLabel}
                    </span>
                    {view.current && (
                      <Badge tone="neutral">
                        {t("staffAuth.sessions.current")}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs leading-4 text-muted-foreground">
                    {session.kind === "management"
                      ? t("staffAuth.sessions.kindManagement")
                      : t("staffAuth.sessions.kindCustomer")}
                    {" · "}
                    {t("staffAuth.sessions.lastSeen", {
                      time: formatDateTime(session.lastSeenAt),
                    })}
                  </p>
                  <p className="text-xs leading-4 text-muted-foreground">
                    {t("staffAuth.sessions.endsAt", {
                      time: formatDateTime(session.expiresAt),
                    })}
                  </p>
                </div>
                <SessionStatus
                  view={view}
                  mfaRequired={mfaRequired}
                  now={now}
                />
                {!view.current && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setError(null);
                      setTarget(view);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    {t("staffAuth.sessions.revoke")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </DataTableShell>

      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("staffAuth.sessions.revokeTitle")}</DialogTitle>
            <DialogDescription>
              {t("staffAuth.sessions.revokeDescription", {
                device: target?.session.deviceLabel ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm leading-5 text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              loading={revoke.isPending}
              onClick={confirmRevoke}
            >
              {t("staffAuth.sessions.revokeConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
