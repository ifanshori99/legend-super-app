// Device detail drawer: identity, heartbeat, capabilities, training mode and
// the revoke action (PRD v1.7 §3 F5 Registri Perangkat).
import type { ReactNode } from "react";
import type { Device } from "@starter/shared/edge";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DEVICE_TYPE_LABEL, HEARTBEAT_HINT, heartbeatState } from "../logic.ts";
import { formatDateTime } from "../format.ts";
import { HeartbeatCell } from "./heartbeat-status.tsx";
import { TrainingExplanation, TrainingSwitch } from "./training-control.tsx";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

export function DeviceDrawer({
  device,
  outletName,
  nowMs,
  canManage,
  canRevoke,
  online,
  onOpenChange,
  onRevoke,
}: {
  device: Device | null;
  outletName: string;
  nowMs: number | null;
  canManage: boolean;
  canRevoke: boolean;
  online: boolean;
  onOpenChange: (open: boolean) => void;
  onRevoke: (device: Device) => void;
}) {
  const t = useT();
  const state = device && nowMs !== null ? heartbeatState(device, nowMs) : null;
  const hintKey = state ? HEARTBEAT_HINT[state] : null;
  return (
    <Sheet open={device !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(28rem,calc(100%-1rem))]">
        {device && (
          <>
            <SheetHeader>
              <SheetTitle>{device.label}</SheetTitle>
              <SheetDescription>
                {t("deviceRegistry.detail.description")}
              </SheetDescription>
            </SheetHeader>
            <dl className="grid gap-3">
              <Row label={t("deviceRegistry.columns.type")}>
                {t(DEVICE_TYPE_LABEL[device.type])}
              </Row>
              <Row label={t("deviceRegistry.detail.outlet")}>{outletName}</Row>
              <Row label={t("deviceRegistry.detail.lastSeen")}>
                <HeartbeatCell device={device} nowMs={nowMs} />
                {hintKey && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(hintKey)}
                  </p>
                )}
                {device.lastSeenAt && (
                  <p className="mt-1 text-xs text-muted-foreground tabular">
                    {formatDateTime(device.lastSeenAt)}
                  </p>
                )}
              </Row>
              <Row label={t("deviceRegistry.detail.version")}>
                <span className="tabular">{device.version}</span>
              </Row>
              <Row label={t("deviceRegistry.columns.status")}>
                <Badge
                  tone={device.status === "revoked" ? "danger" : "neutral"}
                >
                  {t(`deviceRegistry.status.${device.status}`)}
                </Badge>
              </Row>
              {device.revokedAt && (
                <Row label={t("deviceRegistry.detail.revokedAt")}>
                  <span className="tabular">
                    {formatDateTime(device.revokedAt)}
                  </span>
                </Row>
              )}
              <Row label={t("deviceRegistry.detail.station")}>
                {device.stationId ? (
                  <span className="tabular">{device.stationId}</span>
                ) : (
                  t("deviceRegistry.detail.noStation")
                )}
              </Row>
              <Row label={t("deviceRegistry.detail.capabilities")}>
                {device.capabilities.length === 0 ? (
                  t("deviceRegistry.detail.noCapabilities")
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {device.capabilities.map((c) => (
                      <Badge key={c}>{c}</Badge>
                    ))}
                  </span>
                )}
              </Row>
              <Row label={t("deviceRegistry.detail.id")}>
                <span className="text-xs tabular">{device.id}</span>
              </Row>
            </dl>
            <section
              aria-label={t("deviceRegistry.training.title")}
              className="grid gap-2"
            >
              <h3 className="text-sm font-semibold">
                {t("deviceRegistry.training.title")}
              </h3>
              <TrainingSwitch
                device={device}
                canManage={canManage}
                online={online}
              />
              <TrainingExplanation />
            </section>
            {device.status === "active" && (
              <Button
                variant="destructive"
                disabled={!canRevoke || !online}
                onClick={() => onRevoke(device)}
              >
                {t("deviceRegistry.revoke.action")}
              </Button>
            )}
            {device.status === "active" && !canRevoke && (
              <p className="text-xs text-muted-foreground">
                {t("deviceRegistry.revoke.needsPermission")}
              </p>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
