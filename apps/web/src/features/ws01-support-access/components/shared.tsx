// Pieces shared by the platform page, the tenant page and the banner.
import { CircleCheck, CircleSlash, Clock, Eye, Pencil } from "lucide-react";
import type {
  SupportAccessGrant,
  SupportAccessStatus,
} from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { displayStatus, formatCountdown, remainingMs } from "../logic.ts";
import { useSecondClock } from "../use-now.ts";

const INSTANT_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jakarta",
});

/** "1 Nov 2026, 12.00" in the outlet default zone. */
export function formatInstant(value: string): string {
  return INSTANT_FORMAT.format(new Date(value));
}

const STATUS_ICON = {
  active: CircleCheck,
  ended: CircleSlash,
  expired: Clock,
} as const;

const STATUS_TONE = {
  active: "success",
  ended: "neutral",
  expired: "neutral",
} as const;

/** `skewMs` shifts the device clock to the API clock (see `clockSkewMs`). */
export function useGrantStatus(
  grant: SupportAccessGrant,
  skewMs = 0,
): SupportAccessStatus {
  const nowMs = useSecondClock();
  // Before hydration the start instant stands in for "now" (stable SSR markup).
  return displayStatus(
    grant,
    nowMs === null ? Date.parse(grant.startedAt) : nowMs + skewMs,
  );
}

export function GrantStatusBadge({ status }: { status: SupportAccessStatus }) {
  const t = useT();
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={STATUS_TONE[status]} className="whitespace-nowrap">
      <Icon aria-hidden="true" />
      {t(`supportAccess.status.${status}`)}
    </Badge>
  );
}

export function ModeBadge({
  mode,
}: {
  mode: SupportAccessGrant["accessMode"];
}) {
  const t = useT();
  const readOnly = mode === "read_only";
  const Icon = readOnly ? Eye : Pencil;
  return (
    <Badge tone={readOnly ? "info" : "warning"} className="whitespace-nowrap">
      <Icon aria-hidden="true" />
      {t(
        readOnly ? "supportAccess.modeReadOnly" : "supportAccess.modeReadWrite",
      )}
    </Badge>
  );
}

/** Live "mm:ss" until the session expires; empty before hydration. */
export function Countdown({
  grant,
  skewMs = 0,
}: {
  grant: Pick<SupportAccessGrant, "expiresAt" | "durationMinutes">;
  skewMs?: number;
}) {
  const nowMs = useSecondClock();
  if (nowMs === null) return null;
  return (
    <span className="tabular">
      {formatCountdown(
        remainingMs(grant.expiresAt, nowMs + skewMs, grant.durationMinutes),
      )}
    </span>
  );
}
