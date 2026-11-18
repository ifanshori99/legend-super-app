// The support session bar (PRD v1.7 §3 F4 "Support Access"; TEN-04). One
// compact bar, sticky under the shell header, for both people who can see a
// running support session:
//
//   <SupportSessionBar supportSession={access.supportSession} />
//
// - Tenant users: the org grants (GET /api/org/support-access); notice only.
// - The impersonator (Super Admin under a grant): `access.supportSession`
//   (mode and expiry), plus the org grant for the reason when readable. Only
//   they get "Akhiri sesi" (stops the impersonation, reloads to `/`).
//
// It renders nothing without a session, while loading, on error and during
// SSR, so it is safe to mount everywhere the shell allows it. The reason and
// the end time sit behind a disclosure, collapsed by default.
import * as React from "react";
import { ChevronDown, LifeBuoy, Power, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { SupportAccessGrant } from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { useToast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import type { AreaAccess } from "@/lib/areas/access";
import { useOrgGrants } from "../hooks.ts";
import {
  clockSkewMs,
  findActiveGrant,
  formatCountdown,
  isExpiringSoon,
  remainingMs,
} from "../logic.ts";
import { supportAccessKeys } from "../queries.ts";
import { useSecondClock } from "../use-now.ts";
import { formatInstant } from "./shared.tsx";

export type SupportSessionBarProps = {
  /** `access.supportSession`: set only for the impersonator. */
  supportSession?: AreaAccess["supportSession"];
  className?: string;
};

type BarState = {
  expiresAt: string;
  durationMinutes?: number;
  readOnly: boolean;
  reason?: string;
  canEnd: boolean;
};

function BarBody({
  state,
  nowMs,
  className,
}: {
  state: BarState;
  nowMs: number;
  className?: string;
}) {
  const t = useT();
  const toast = useToast();
  const [pending, setPending] = React.useState(false);
  const left = remainingMs(state.expiresAt, nowMs, state.durationMinutes);
  const soon = isExpiringSoon(state.expiresAt, nowMs);
  const time = formatCountdown(left);
  const rootRef = React.useRef<HTMLDivElement>(null);

  // Publish the bar height so scroll-padding-top (globals.css) clears it.
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () =>
      root.style.setProperty("--support-bar-h", `${el.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--support-bar-h");
    };
  }, []);

  async function end() {
    setPending(true);
    try {
      const result = await authClient.admin.stopImpersonating();
      if (result.error) throw new Error("stop impersonating failed");
      // Full reload: every cached tenant read belongs to the ended session.
      window.location.assign("/");
    } catch {
      setPending(false);
      toast({
        title: t("supportAccess.readOnlyMode.endFailed"),
        tone: "danger",
      });
    }
  }

  // Not dismissible while active (PRD §3 F4: the session is always visible).
  // The countdown is role="timer" (implicit aria-live="off"), so screen
  // readers are not spammed every second; they read it when they reach it.
  return (
    <div
      ref={rootRef}
      role="status"
      data-slot="support-session-bar"
      data-expiring={soon || undefined}
      className={cn(
        "sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-1 border-b-(length:--border-w) px-4 py-2 text-sm max-sm:gap-x-3 max-sm:px-3 max-sm:py-1.5",
        soon
          ? "bg-danger text-danger-foreground"
          : "bg-warning-subtle text-warning",
        className,
      )}
    >
      <p className="inline-flex items-center gap-2 font-semibold">
        <LifeBuoy className="size-4 shrink-0" aria-hidden="true" />
        <span>
          {t("supportAccess.banner.label")}
          {" · "}
          {t(
            state.readOnly
              ? "supportAccess.banner.readOnly"
              : "supportAccess.banner.readWrite",
          )}
        </span>
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
        {soon && (
          <span className="inline-flex items-center gap-1">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            {t("supportAccess.banner.expiringSoon")}
          </span>
        )}
      </p>
      <details className="group min-w-0 open:basis-full pointer-coarse:py-2">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-semibold underline-offset-2 hover:underline pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          {t("supportAccess.banner.details")}
          <ChevronDown
            className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </summary>
        <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto pb-1">
          {state.reason !== undefined && (
            <p className="break-words">
              {t("supportAccess.banner.reason", { reason: state.reason })}
            </p>
          )}
          <p>
            {t("supportAccess.banner.until", {
              time: formatInstant(state.expiresAt),
            })}
          </p>
        </div>
      </details>
      {state.canEnd && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ms-auto pointer-coarse:min-h-11"
          loading={pending}
          onClick={() => void end()}
        >
          {!pending && <Power aria-hidden="true" />}
          {pending
            ? t("supportAccess.banner.ending")
            : t("supportAccess.banner.end")}
        </Button>
      )}
    </div>
  );
}

export function SupportSessionBar({
  supportSession,
  className,
}: SupportSessionBarProps) {
  const grants = useOrgGrants();
  const clockMs = useSecondClock();
  const queryClient = useQueryClient();
  const rows: readonly SupportAccessGrant[] | undefined = grants.data?.data;
  // Shift the device clock by its offset from the API clock at fetch time, so
  // a device running ahead does not hide the banner early.
  const skewMs = clockSkewMs(grants.data?.serverNow, grants.dataUpdatedAt);
  const nowMs = clockMs === null ? null : clockMs + skewMs;
  const grant = rows && nowMs !== null ? findActiveGrant(rows, nowMs) : null;
  const impersonating = supportSession != null;
  const shownKey = grant?.id ?? (impersonating ? "session" : null);
  const shown = React.useRef<string | null>(null);

  // When the client clock passes the expiry, ask the server again instead of
  // waiting for the next poll, so a server-ended or clock-skewed
  // session resolves to the server's truth quickly.
  React.useEffect(() => {
    if (shown.current !== null && shownKey === null)
      void queryClient.invalidateQueries({ queryKey: supportAccessKeys.all });
    shown.current = shownKey;
  }, [shownKey, queryClient]);

  if (nowMs === null) return null;
  let state: BarState | null = null;
  if (supportSession) {
    state = {
      expiresAt: supportSession.expiresAt,
      readOnly: supportSession.accessMode === "read_only",
      reason: grant?.reason,
      canEnd: true,
    };
  } else if (grant) {
    state = {
      expiresAt: grant.expiresAt,
      durationMinutes: grant.durationMinutes,
      readOnly: grant.accessMode === "read_only",
      reason: grant.reason,
      canEnd: false,
    };
  }
  if (!state) return null;
  return <BarBody state={state} nowMs={nowMs} className={className} />;
}
