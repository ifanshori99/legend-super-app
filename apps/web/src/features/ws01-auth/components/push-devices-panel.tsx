import * as React from "react";
import { BellRing, CircleCheck, Trash2, TriangleAlert } from "lucide-react";
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
import { ApiError } from "@/lib/api/errors";
import {
  forgetSubscriptionId,
  readOwnerEndpoint,
  readStoredSubscriptionId,
  unsubscribeThisBrowser,
} from "@/features/ws05-notifications/push";
import type { PushDevice } from "@starter/shared/identity";
import { formatDateTime } from "../format";
import { usePushDevices, useRevokePushDevice } from "../hooks";

/**
 * "Perangkat alarm" (legend-gchkf): every phone that receives panic alarms for
 * this account, including phones whose login session already ended. Those
 * still get alarms until revoked, so they carry a visible warning (icon +
 * text, never color alone). Revoking asks first, then stops the alarms to that
 * phone. A row list like SessionsPanel so it stays readable at 390px.
 */
export function PushDevicesPanel() {
  const t = useT();
  const toast = useToast();
  const devices = usePushDevices();
  const revoke = useRevokePushDevice();
  const [target, setTarget] = React.useState<PushDevice | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const focusTitleRef = React.useRef(false);
  // Keep the last device so the dialog text is not blank during the close animation.
  const [lastTarget, setLastTarget] = React.useState<PushDevice | null>(null);
  if (target && target !== lastTarget) setLastTarget(target);
  const shown = target ?? lastTarget;

  const rows = devices.data ?? [];
  // A failed background refetch keeps the list we already have.
  const state = devices.isPending
    ? "loading"
    : devices.isError && devices.data === undefined
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";
  const offline =
    devices.error instanceof ApiError && devices.error.code === "NETWORK_ERROR";

  const nameOf = (device: PushDevice) =>
    device.deviceLabel ?? t("staffAuth.pushDevices.unnamed");

  function closeDialog() {
    if (revoke.isPending) return;
    setTarget(null);
  }

  // Only this browser's own stored subscription is dropped; a failure here
  // must not undo the revoke.
  function dropOwnSubscription(device: PushDevice) {
    if (device.id !== readStoredSubscriptionId()) return;
    void unsubscribeThisBrowser(readOwnerEndpoint())
      .then(forgetSubscriptionId)
      .catch(() => undefined);
  }

  function confirmRevoke() {
    if (!target) return;
    const device = target;
    setError(null);
    revoke.mutate(device.id, {
      onSuccess: () => {
        // The API row is gone; drop this browser's own subscription too, or
        // the panic control would register it again. A failure here must not
        // undo the revoke.
        dropOwnSubscription(device);
        toast({
          title: t("staffAuth.pushDevices.revoked", { device: nameOf(device) }),
          tone: "success",
        });
        focusTitleRef.current = true;
        setTarget((current) => (current?.id === device.id ? null : current));
      },
      onError: (failure) => {
        if (failure instanceof ApiError && failure.status === 404) {
          // Already gone (revoked elsewhere): refresh the list and close.
          dropOwnSubscription(device);
          void devices.refetch();
          toast({
            title: t("staffAuth.pushDevices.revokeGone"),
            tone: "info",
          });
          focusTitleRef.current = true;
          setTarget((current) => (current?.id === device.id ? null : current));
          return;
        }
        setError(t("staffAuth.pushDevices.revokeFailed"));
      },
    });
  }

  // The revoked row is gone, so focus the panel title instead of the body.
  function focusTitle(event: Event) {
    if (!focusTitleRef.current) return;
    focusTitleRef.current = false;
    const title = panelRef.current?.querySelector<HTMLElement>("h2");
    if (!title) return;
    event.preventDefault();
    title.tabIndex = -1;
    title.classList.add("outline-none");
    title.focus();
  }

  return (
    <div ref={panelRef}>
      <DataTableShell
        title={t("staffAuth.pushDevices.title")}
        description={t("staffAuth.pushDevices.description")}
        state={state}
        onRetry={() => void devices.refetch()}
        error={devices.error}
        errorCopy={{
          title: offline
            ? t("staffAuth.errors.offlineTitle")
            : t("staffAuth.pushDevices.loadErrorTitle"),
          description: offline
            ? t("staffAuth.errors.offlineHint")
            : t("staffAuth.pushDevices.loadErrorHint"),
        }}
        loadingRows={2}
        empty={{
          title: t("staffAuth.pushDevices.emptyTitle"),
          description: t("staffAuth.pushDevices.emptyHint"),
        }}
      >
        <ul className="divide-y">
          {rows.map((device) => (
            <li
              key={device.id}
              className="flex flex-wrap items-center gap-3 px-card py-3"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-3 text-muted-foreground">
                <BellRing className="size-4" aria-hidden="true" />
              </span>
              <div className="grid min-w-0 flex-1 gap-1">
                <span
                  title={nameOf(device)}
                  className="line-clamp-2 text-sm leading-5 font-semibold break-words"
                >
                  {nameOf(device)}
                </span>
                <p className="text-xs leading-4 text-muted-foreground tabular-nums">
                  {t("staffAuth.pushDevices.registeredAt", {
                    time: formatDateTime(device.registeredAt),
                  })}
                </p>
                <StatusBadges device={device} />
              </div>
              <Button
                variant="outline"
                className="min-h-11 max-sm:w-full"
                aria-label={t("staffAuth.pushDevices.revokeLabel", {
                  device: nameOf(device),
                })}
                onClick={() => {
                  setError(null);
                  setTarget(device);
                }}
              >
                <Trash2 aria-hidden="true" />
                {t("staffAuth.pushDevices.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      </DataTableShell>

      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent onCloseAutoFocus={focusTitle}>
          <DialogHeader>
            <DialogTitle>{t("staffAuth.pushDevices.revokeTitle")}</DialogTitle>
            <DialogDescription>
              {t("staffAuth.pushDevices.revokeDescription", {
                device: shown ? nameOf(shown) : "",
              })}
            </DialogDescription>
          </DialogHeader>
          {shown && (
            <div className="grid gap-1 rounded-container border bg-surface-3 p-3">
              <span
                title={nameOf(shown)}
                className="line-clamp-2 text-sm leading-5 font-semibold break-words"
              >
                {nameOf(shown)}
              </span>
              <p className="text-xs leading-4 text-muted-foreground tabular-nums">
                {t("staffAuth.pushDevices.registeredAt", {
                  time: formatDateTime(shown.registeredAt),
                })}
              </p>
              <StatusBadges device={shown} />
            </div>
          )}
          {shown?.current && (
            <p className="flex items-start gap-2 text-sm leading-5">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              {t("staffAuth.pushDevices.revokeCurrentWarning")}
            </p>
          )}
          {shown && !shown.current && shown.sessionActive && (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("staffAuth.pushDevices.revokeSessionNote")}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm leading-5 text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={revoke.isPending}
              onClick={closeDialog}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              loading={revoke.isPending}
              onClick={confirmRevoke}
            >
              {t("staffAuth.pushDevices.revokeConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBadges({ device }: { device: PushDevice }) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-1">
      {device.current && (
        <Badge tone="info" className="h-auto whitespace-normal">
          {t("staffAuth.pushDevices.currentBadge")}
        </Badge>
      )}
      <SessionBadge device={device} />
    </div>
  );
}

function SessionBadge({ device }: { device: PushDevice }) {
  const t = useT();
  return device.sessionActive ? (
    <Badge tone="success" className="h-auto gap-1 whitespace-normal">
      <CircleCheck aria-hidden="true" />
      {t("staffAuth.pushDevices.statusSessionActive")}
    </Badge>
  ) : (
    <Badge tone="warning" className="h-auto gap-1 whitespace-normal">
      <TriangleAlert aria-hidden="true" />
      {t("staffAuth.pushDevices.statusSessionEnded")}
    </Badge>
  );
}
