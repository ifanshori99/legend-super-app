// Heartbeat age + state (stale / offline) for one device. Time-dependent text
// is skipped until hydration (now === null) so SSR and client agree.
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  Ban,
} from "lucide-react";
import type { Device } from "@starter/shared/edge";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  HEARTBEAT_LABEL,
  heartbeatAgeMs,
  heartbeatState,
  splitAge,
  type HeartbeatState,
} from "../logic.ts";

const TONE = {
  online: "success",
  stale: "warning",
  offline: "danger",
  never: "neutral",
  revoked: "neutral",
} as const;
const ICON = {
  online: CircleCheck,
  stale: Clock,
  offline: CircleAlert,
  never: CircleSlash,
  revoked: Ban,
} as const;

export function useAgeText(device: Device, nowMs: number | null) {
  const t = useT();
  if (nowMs === null) return null;
  const age = heartbeatAgeMs(device, nowMs);
  if (age === null) return t("deviceRegistry.heartbeat.noValue");
  const parts = splitAge(age);
  return parts.key === "justNow"
    ? t("deviceRegistry.heartbeat.justNow")
    : t(`deviceRegistry.heartbeat.${parts.key}`, { count: parts.count });
}

export function HeartbeatBadge({ state }: { state: HeartbeatState }) {
  const t = useT();
  const Icon = ICON[state];
  return (
    <Badge tone={TONE[state]} data-heartbeat={state}>
      <Icon aria-hidden="true" />
      {t(HEARTBEAT_LABEL[state])}
    </Badge>
  );
}

export function HeartbeatCell({
  device,
  nowMs,
}: {
  device: Device;
  nowMs: number | null;
}) {
  const age = useAgeText(device, nowMs);
  const state = nowMs === null ? null : heartbeatState(device, nowMs);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {state && <HeartbeatBadge state={state} />}
      {age && (
        <span className="text-sm text-muted-foreground tabular">{age}</span>
      )}
    </div>
  );
}
