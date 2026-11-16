// Supervisor screen for the connectivity kit: cloud link, edge node,
// synchronisation backlog, the print queue drawer and printer/KDS alerts
// (PRD v1.7 §3 F5, §4 Alur F, EDG-05). Components here are the shared kit;
// POS and KDS mount the same banner, watermark and drawer.
import { useState, type ReactNode } from "react";
import { HardDrive, Printer, Wifi, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useOnline } from "@/lib/use-online";
import { DeviceAlerts } from "./device-alerts.tsx";
import { useEdgeStatus, useSetTrainingMode } from "../hooks.ts";
import { formatAlertTime, formatClock, EDGE_ROLE_LABEL } from "../logic.ts";
import { PrintQueueButton } from "./print-queue-drawer.tsx";
import { ReceiptRunAlert } from "./receipt-run-alert.tsx";
import { WaiterOrderNotice } from "./waiter-order-notice.tsx";

function StatusRow({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-baseline sm:gap-4">
      <dt className="text-sm font-semibold text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">{children}</div>
        {hint && (
          <p className="mt-1 text-sm text-muted-foreground tabular">{hint}</p>
        )}
      </dd>
    </div>
  );
}

function CardHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="grid gap-1">
      <h2 className="type-title">{title}</h2>
      {hint && (
        <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

export function KoneksiScreen({
  canManageDevices,
}: {
  canManageDevices: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const browserOnline = useOnline();
  const status = useEdgeStatus();
  const setTraining = useSetTrainingMode();
  const data = status.data?.data;
  const thisDevice = data?.thisDevice ?? null;
  // The queue, device alerts and guest preview only make sense once the edge
  // node is known: a failed probe shows one error with one retry, and the
  // empty state shows one honest "not registered yet" instead of three.
  const edgeReady = data !== undefined && data.edgeNode !== null;

  const heartbeat = formatClock(data?.edgeNode?.lastHeartbeatAt ?? null);
  const lastSynced = formatClock(data?.lastSyncedAt ?? null);

  const registry = data?.deviceRegistry;
  const registryPulled = formatAlertTime(registry?.lastPulledAt ?? null);

  const runAlert = data?.deviceRegistry?.receiptRunAlert === true;
  // Confirms a manual refresh that found no receipt-run alert (legend-s7szu).
  const [refreshed, setRefreshed] = useState(false);
  // Spinner only for a manual refresh: background fetches on mount would make
  // the client markup differ from the server HTML (hydration mismatch).
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshed(false);
    setRefreshing(true);
    void status
      .refetch()
      .then((result) => {
        if (
          result.isSuccess &&
          result.data.data.deviceRegistry?.receiptRunAlert !== true
        )
          setRefreshed(true);
      })
      .finally(() => setRefreshing(false));
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h1 className="type-display">{t("edge.pageTitle")}</h1>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("edge.pageHint")}
          </p>
        </div>
        <Button
          variant="outline"
          className="shrink-0"
          loading={refreshing}
          onClick={refresh}
        >
          {t("edge.refresh")}
        </Button>
      </header>

      {refreshed && !runAlert && !refreshing && (
        <p
          role="status"
          className="rounded-container border-(length:--border-w) border-success bg-success-subtle p-4 text-sm leading-5 font-semibold text-foreground"
        >
          {t("edge.refreshed")}
        </p>
      )}

      {data && data.edgeNode !== null && runAlert && (
        <ReceiptRunAlert
          edgeNodeId={data.edgeNode.id}
          alertAt={data.deviceRegistry?.receiptRunAlertAt ?? null}
        />
      )}

      {status.isError && (
        <Card>
          <ErrorState
            error={status.error}
            title={t("state.errorTitle")}
            description={t("state.errorHint")}
            onRetry={() => void status.refetch()}
          />
        </Card>
      )}

      {status.isPending && (
        <Card aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </Card>
      )}

      {data && data.edgeNode === null && (
        <Card role="region" aria-label={t("edge.statusTitle")}>
          <CardHeading title={t("edge.statusTitle")} />
          <EmptyState
            icon={HardDrive}
            title={t("edge.empty.title")}
            description={t("edge.empty.hint")}
          />
        </Card>
      )}

      {data && data.edgeNode !== null && (
        <Card role="region" aria-label={t("edge.statusTitle")}>
          <CardHeading title={t("edge.statusTitle")} />
          <dl className="grid gap-4">
            <StatusRow
              label={t("edge.cloudLabel")}
              hint={
                data.pendingEventCount > 0
                  ? t("edge.syncPending", { count: data.pendingEventCount })
                  : t("edge.syncClear")
              }
            >
              <StatusPill
                status={data.cloudLink === "connected" ? "success" : "danger"}
              >
                {t(
                  data.cloudLink === "connected"
                    ? "edge.cloudConnected"
                    : "edge.cloudDisconnected",
                )}
              </StatusPill>
            </StatusRow>

            <StatusRow
              label={t("edge.edgeNodeLabel")}
              hint={
                heartbeat
                  ? t("edge.heartbeatLast", { time: heartbeat })
                  : t("edge.heartbeatNever")
              }
            >
              <span className="font-semibold">
                {t(EDGE_ROLE_LABEL[data.edgeNode.role])}
              </span>
              <span className="text-sm text-muted-foreground">
                {t("edge.edgeNodeDetail", {
                  version: data.edgeNode.version,
                })}
              </span>
            </StatusRow>

            <StatusRow
              label={t("edge.syncLabel")}
              hint={
                lastSynced ? t("edge.syncLast", { time: lastSynced }) : null
              }
            >
              <span className="font-semibold tabular">
                {data.pendingEventCount > 0
                  ? t("edge.syncPending", { count: data.pendingEventCount })
                  : t("edge.syncClear")}
              </span>
            </StatusRow>

            <StatusRow
              label={t("deviceRegistry.staleNotice.rowLabel")}
              hint={
                registryPulled
                  ? t("deviceRegistry.staleNotice.rowPulled", {
                      time: registryPulled,
                    })
                  : t("deviceRegistry.staleNotice.rowNever")
              }
            >
              <StatusPill
                status={
                  registry?.hardStale === true
                    ? "danger"
                    : registry?.stale === true
                      ? "warning"
                      : "success"
                }
              >
                {registry?.hardStale === true
                  ? t("deviceRegistry.staleNotice.rowHard")
                  : registry?.stale === true
                    ? t("deviceRegistry.staleNotice.rowStale")
                    : t("deviceRegistry.staleNotice.rowFresh")}
              </StatusPill>
            </StatusRow>

            <StatusRow label={t("edge.deviceLabel")}>
              {thisDevice ? (
                <span className="font-semibold">{thisDevice.label}</span>
              ) : (
                <span className="text-muted-foreground">
                  {t("edge.deviceMissing")}
                </span>
              )}
              <Badge tone={browserOnline ? "success" : "danger"}>
                {browserOnline ? (
                  <Wifi aria-hidden="true" />
                ) : (
                  <WifiOff aria-hidden="true" />
                )}
                {t(
                  browserOnline
                    ? "edge.devices.online"
                    : "edge.devices.offline",
                )}
              </Badge>
            </StatusRow>

            <StatusRow
              label={t("edge.training.title")}
              hint={t("edge.training.hint")}
            >
              {thisDevice && canManageDevices ? (
                <div className="flex min-h-11 items-center gap-2">
                  <Switch
                    aria-label={t("edge.training.label")}
                    checked={thisDevice.trainingMode}
                    disabled={setTraining.isPending}
                    onCheckedChange={(checked) =>
                      setTraining.mutate(
                        { deviceId: thisDevice.id, trainingMode: checked },
                        {
                          onSuccess: () =>
                            toast({
                              title: t("edge.training.saved"),
                              tone: "success",
                            }),
                          onError: () =>
                            toast({
                              title: t("edge.training.saveFailed"),
                              tone: "danger",
                            }),
                        },
                      )
                    }
                  />
                  <span className="text-sm font-semibold">
                    {thisDevice.trainingMode
                      ? t("edge.training.on")
                      : t("edge.training.off")}
                  </span>
                </div>
              ) : (
                <Badge tone={thisDevice?.trainingMode ? "warning" : "neutral"}>
                  {thisDevice?.trainingMode
                    ? t("edge.training.on")
                    : t("edge.training.off")}
                </Badge>
              )}
            </StatusRow>
          </dl>
        </Card>
      )}

      {edgeReady && (
        <Card role="region" aria-label={t("edge.print.title")}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <Printer
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <CardHeading
                title={t("edge.print.title")}
                hint={t("edge.print.description")}
              />
            </div>
            <PrintQueueButton className="w-full sm:w-auto" />
          </div>
        </Card>
      )}

      {edgeReady && (
        <Card role="region" aria-label={t("edge.devices.title")}>
          <CardHeading
            title={t("edge.devices.title")}
            hint={t("edge.devices.hint")}
          />
          <DeviceAlerts />
        </Card>
      )}

      {data?.cloudLink === "disconnected" && edgeReady && (
        <Card role="region" aria-label={t("edge.waiter.title")}>
          <CardHeading
            title={t("edge.waiter.title")}
            hint={t("edge.waiter.previewHint")}
          />
          <ThemeScope density="hangat" className="rounded-container">
            <WaiterOrderNotice />
          </ThemeScope>
        </Card>
      )}
    </div>
  );
}
