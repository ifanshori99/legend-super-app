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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

/** One device row's status, always icon + text (never color alone). */
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
  const Icon =
    status === "active" ? CircleCheck : status === "ending" ? Clock : Clock;
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
 * The current session is marked, not revocable from here (signing out is the
 * header action).
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
        rowCount={rows.length}
        loadingRows={2}
        empty={{
          title: t("staffAuth.sessions.emptyTitle"),
          description: t("staffAuth.sessions.emptyHint"),
        }}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("staffAuth.sessions.columnDevice")}</TableHead>
              <TableHead>{t("staffAuth.sessions.columnKind")}</TableHead>
              <TableHead>{t("staffAuth.sessions.columnLastSeen")}</TableHead>
              <TableHead>{t("staffAuth.sessions.columnStatus")}</TableHead>
              <TableHead className="text-right">
                {t("staffAuth.sessions.columnActions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((view) => {
              const { session } = view;
              return (
                <TableRow key={session.id}>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-2">
                      <DeviceIcon label={session.deviceLabel} />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">
                          {session.deviceLabel}
                        </span>
                        {view.current && (
                          <Badge tone="neutral" className="mt-1">
                            {t("staffAuth.sessions.current")}
                          </Badge>
                        )}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {session.kind === "management"
                      ? t("staffAuth.sessions.kindManagement")
                      : t("staffAuth.sessions.kindCustomer")}
                  </TableCell>
                  <TableCell>
                    <span className="block whitespace-nowrap">
                      {formatDateTime(session.lastSeenAt)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t("staffAuth.sessions.endsAt", {
                        time: formatDateTime(session.expiresAt),
                      })}
                    </span>
                  </TableCell>
                  <TableCell>
                    <SessionStatus
                      view={view}
                      mfaRequired={mfaRequired}
                      now={now}
                    />
                  </TableCell>
                  <TableCell className="text-right">
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
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
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
