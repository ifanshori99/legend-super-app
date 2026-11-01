// Printer/KDS offline alerts for the supervisor (PRD v1.7 EDG-05: a printer
// or KDS failure is detected within 30 seconds and notifies the supervisor).
// The hook is reusable by any ops screen; this bead wires it into the
// connectivity screen.
import { useEffect, useRef } from "react";
import { CircleAlert, CircleCheck, Printer, MonitorPlay } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState, EmptyState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import type { Device } from "@starter/shared/edge";
import { useEdgeDevices } from "../hooks.ts";
import { formatClock, isDeviceOffline, offlineAlertDevices } from "../logic.ts";
import { useNowMs } from "../use-now.ts";

/** Announce each device that stops reporting once, never on first load. */
export function useDeviceOfflineToasts(devices: readonly Device[] | undefined) {
  const t = useT();
  const toast = useToast();
  const knownOffline = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!devices) return;
    const offline = offlineAlertDevices(devices, Date.now());
    const ids = new Set(offline.map((device) => device.id));
    if (knownOffline.current === null) {
      knownOffline.current = ids;
      return;
    }
    for (const device of offline) {
      if (knownOffline.current.has(device.id)) continue;
      toast({
        title: t("edge.devices.toastTitle", { label: device.label }),
        description: t(
          device.type === "kds"
            ? "edge.devices.toastKds"
            : "edge.devices.toastPrinter",
        ),
        tone: "danger",
      });
    }
    knownOffline.current = ids;
  }, [devices, t, toast]);
}

function DeviceIcon({ type }: { type: Device["type"] }) {
  return type === "kds" ? (
    <MonitorPlay className="size-4 shrink-0" aria-hidden="true" />
  ) : (
    <Printer className="size-4 shrink-0" aria-hidden="true" />
  );
}

export function DeviceAlerts() {
  const t = useT();
  const now = useNowMs();
  const { data, isPending, isError, refetch } = useEdgeDevices();
  const devices = data?.data;
  useDeviceOfflineToasts(now === null ? undefined : devices);

  if (isPending || now === null) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-row" />
        <Skeleton className="h-row" />
      </div>
    );
  }

  if (isError) {
    return (
      <ErrorState
        title={t("state.errorTitle")}
        description={t("state.errorHint")}
        onRetry={() => void refetch()}
      />
    );
  }

  // The devices query and the clock only run in the browser, so `now` is set
  // before this branch is reached.
  const offline = offlineAlertDevices(devices ?? [], now);
  const connected = (devices ?? []).filter(
    (device) => device.status === "active" && !isDeviceOffline(device, now),
  ).length;

  if ((devices ?? []).length === 0)
    return (
      <EmptyState
        icon={MonitorPlay}
        title={t("edge.devices.emptyTitle")}
        description={t("edge.devices.emptyHint")}
      />
    );

  if (offline.length === 0) {
    return (
      <div className="flex items-start gap-3 py-2">
        <CircleCheck
          className="mt-0.5 size-5 shrink-0 text-success"
          aria-hidden="true"
        />
        <div>
          <p className="font-semibold">{t("edge.devices.noneTitle")}</p>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("edge.devices.noneHint")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <ul className="divide-y divide-border">
        {offline.map((device) => {
          const lastSeen = formatClock(device.lastSeenAt);
          return (
            <li
              key={device.id}
              className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <DeviceIcon type={device.type} />
                <span className="font-semibold">{device.label}</span>
                <Badge tone="danger">
                  <CircleAlert aria-hidden="true" />
                  {t("edge.devices.offline")}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground tabular">
                {lastSeen
                  ? t("edge.devices.lastSeen", { time: lastSeen })
                  : t("edge.devices.neverSeen")}
              </p>
              <p className="text-sm leading-5 text-muted-foreground">
                {t(
                  device.type === "kds"
                    ? "edge.devices.toastKds"
                    : "edge.devices.toastPrinter",
                )}
              </p>
            </li>
          );
        })}
      </ul>
      {connected > 0 && (
        <div className="flex items-center justify-between gap-3 border-t pt-3">
          <p className="text-sm text-muted-foreground">
            {t("edge.devices.others", { count: connected })}
          </p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {t("common.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
