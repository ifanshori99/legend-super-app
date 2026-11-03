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
import { LifeBuoy, Power } from "lucide-react";
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
import { useSecondClock } from "../use-now.ts";

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
  const left = remainingMs(grant.expiresAt, nowMs);
  const soon = isExpiringSoon(grant.expiresAt, nowMs);
  const time = formatCountdown(left);
  const readOnly = grant.accessMode === "read_only";

  return (
    <section
      aria-label={t("supportAccess.banner.label")}
      data-slot="support-session-banner"
      data-expiring={soon || undefined}
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 border-b-(length:--border-w) px-4 py-2 text-sm",
        soon
          ? "bg-danger text-danger-foreground"
          : "bg-warning-subtle text-warning",
        className,
      )}
    >
      <p className="inline-flex items-center gap-2 font-semibold">
        <LifeBuoy className="size-4 shrink-0" aria-hidden="true" />
        {t("supportAccess.banner.label")}
      </p>
      <p className="font-semibold">
        {t(
          readOnly
            ? "supportAccess.banner.readOnly"
            : "supportAccess.banner.readWrite",
        )}
      </p>
      <p className="min-w-0 flex-1 truncate" title={grant.reason}>
        {t("supportAccess.banner.reason", { reason: grant.reason })}
      </p>
      <p className="inline-flex items-center gap-2 font-semibold">
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
  if (!rows || nowMs === null) return null;
  const scoped = tenantId
    ? rows.filter((row) => row.tenantId === tenantId)
    : rows;
  const active = findActiveGrant(scoped, nowMs);
  if (!active) return null;
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
