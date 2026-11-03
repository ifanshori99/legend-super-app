// Countdown banner for the tenant layout while a support session is running
// (PRD v1.7 §3 F4 "Support Access"; TEN-04). The LEAD mounts it once at the
// top of the tenant (kelola/owner/ops...) layout:
//
//   <SupportSessionBanner />                      // Super Admin: can end it
//   <SupportSessionBanner source="org" />         // tenant users: notice only
//
// It renders nothing without an active session, while loading, on error and
// during SSR, so it is safe to mount everywhere. `tenantId` limits a Super
// Admin banner to the tenant currently on screen.
import * as React from "react";
import { LifeBuoy, Power } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { SupportAccessGrant } from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { useToast } from "@/components/ui/toast";
import { supportErrorMessage } from "../errors.ts";
import {
  useEndSupportAccess,
  useOrgGrants,
  usePlatformGrants,
} from "../hooks.ts";
import {
  findActiveGrant,
  formatCountdown,
  isExpiringSoon,
  remainingMs,
} from "../logic.ts";
import { supportAccessKeys } from "../queries.ts";
import { useSecondClock } from "../use-now.ts";
import { formatInstant } from "./shared.tsx";

export type SupportSessionBannerProps = {
  /** "platform" (default): the Super Admin's own sessions, with an end
   * button. "org": the tenant's sessions, read-only notice. */
  source?: "platform" | "org";
  tenantId?: string;
  className?: string;
};

function BannerBody({
  grant,
  nowMs,
  canEnd,
  className,
}: {
  grant: SupportAccessGrant;
  nowMs: number;
  canEnd: boolean;
  className?: string;
}) {
  const t = useT();
  const toast = useToast();
  const end = useEndSupportAccess();
  const left = remainingMs(grant.expiresAt, nowMs, grant.durationMinutes);
  const soon = isExpiringSoon(grant.expiresAt, nowMs);
  const time = formatCountdown(left);
  const readOnly = grant.accessMode === "read_only";
  const labelId = React.useId();

  // Not dismissible while active (PRD §3 F4: the session is always visible).
  // The countdown is role="timer" (implicit aria-live="off"), so screen
  // readers are not spammed every second; they read it when they reach it.
  return (
    <section
      aria-labelledby={labelId}
      data-slot="support-session-banner"
      data-expiring={soon || undefined}
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 border-b-(length:--border-w) px-4 py-2 text-sm",
        soon
          ? "bg-danger text-danger-foreground"
          : "bg-warning-subtle text-warning",
        className,
      )}
    >
      <p id={labelId} className="inline-flex items-center gap-2 font-semibold">
        <LifeBuoy className="size-4 shrink-0" aria-hidden="true" />
        {t("supportAccess.banner.label")}
      </p>
      <p className="font-semibold">
        {t("supportAccess.banner.who")}
        {" · "}
        {t(
          readOnly
            ? "supportAccess.banner.readOnly"
            : "supportAccess.banner.readWrite",
        )}
      </p>
      <p
        className="line-clamp-2 min-w-0 basis-full sm:flex-1 sm:basis-auto sm:truncate"
        title={grant.reason}
      >
        {t("supportAccess.banner.reason", { reason: grant.reason })}
      </p>
      <p className="inline-flex items-center gap-2 font-semibold">
        <span>
          {t("supportAccess.banner.until", {
            time: formatInstant(grant.expiresAt),
          })}
        </span>
        <span aria-hidden="true">·</span>
        <span>{t("supportAccess.banner.remaining")}</span>
        <span
          role="timer"
          aria-label={t("supportAccess.banner.remainingAria", { time })}
          className="tabular"
        >
          {time}
        </span>
      </p>
      {canEnd && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={end.isPending}
          onClick={() =>
            end.mutate(grant.id, {
              onError: (failure) =>
                toast({
                  title: supportErrorMessage(failure, t),
                  tone: "danger",
                }),
            })
          }
        >
          <Power aria-hidden="true" />
          {end.isPending
            ? t("supportAccess.banner.ending")
            : t("supportAccess.banner.end")}
        </Button>
      )}
    </section>
  );
}

function PlatformSource(props: SupportSessionBannerProps) {
  const grants = usePlatformGrants();
  return <Resolved {...props} rows={grants.data?.data} canEnd />;
}

function OrgSource(props: SupportSessionBannerProps) {
  const grants = useOrgGrants();
  return <Resolved {...props} rows={grants.data?.data} canEnd={false} />;
}

function Resolved({
  rows,
  tenantId,
  canEnd,
  className,
}: SupportSessionBannerProps & {
  rows: readonly SupportAccessGrant[] | undefined;
  canEnd: boolean;
}) {
  const nowMs = useSecondClock();
  const queryClient = useQueryClient();
  const scoped =
    rows && tenantId ? rows.filter((row) => row.tenantId === tenantId) : rows;
  const active =
    scoped && nowMs !== null ? findActiveGrant(scoped, nowMs) : null;
  const activeId = active?.id ?? null;
  const shownId = React.useRef<string | null>(null);

  // When the client clock passes the expiry, ask the server again instead of
  // waiting for the next poll, so a server-ended or clock-skewed
  // session resolves to the server's truth quickly.
  React.useEffect(() => {
    if (shownId.current !== null && activeId === null)
      void queryClient.invalidateQueries({ queryKey: supportAccessKeys.all });
    shownId.current = activeId;
  }, [activeId, queryClient]);

  if (!active || nowMs === null) return null;
  return (
    <BannerBody
      grant={active}
      nowMs={nowMs}
      canEnd={canEnd}
      className={className}
    />
  );
}

export function SupportSessionBanner(props: SupportSessionBannerProps) {
  return props.source === "org" ? (
    <OrgSource {...props} />
  ) : (
    <PlatformSource {...props} />
  );
}
