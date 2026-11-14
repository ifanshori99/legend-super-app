import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { BellRing, CircleCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { getDeviceToken } from "@/lib/device-token-store";
import { useTenantContext } from "@/lib/tenant-context";
import type { MessageKey } from "@starter/shared/i18n";
import { useSavePushSubscription } from "@/features/ws05-notifications/hooks";
import { pushPublicKeyQuery } from "@/features/ws05-notifications/queries";
import {
  detectPushState,
  rememberMockSubscriptionId,
  rememberSubscriptionId,
  requestPushPermission,
  subscribeThisBrowser,
  type PushState,
} from "@/features/ws05-notifications/push";

// One line per push state that cannot be fixed with a button here.
const HINT: Partial<Record<PushState, MessageKey>> = {
  blocked: "facilityStaff.alarmPush.blocked",
  unsupported: "facilityStaff.alarmPush.unsupported",
  "ios-outdated": "facilityStaff.alarmPush.unsupported",
  unavailable: "facilityStaff.alarmPush.unavailable",
  "ios-install": "facilityStaff.alarmPush.iosInstall",
};

/**
 * Compact opt-in for panic alarm push on the facility screens (bead
 * legend-ofq4f). Uses the same push.ts steps as the notification center, but
 * registers the subscription for the active outlet so the API can route that
 * outlet's alarms here. Renders nothing while the browser is being checked.
 */
export function PanicPushControl() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const save = useSavePushSubscription();
  const { outlet } = useTenantContext();
  const session = useRouteContext({ strict: false, select: (c) => c.session });
  const [state, setState] = useState<PushState>("checking");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // A failed key lookup reads as "not enabled": never offer a subscribe that
  // cannot finish.
  const tenantKey = async (): Promise<string | null> => {
    try {
      return (await queryClient.fetchQuery(pushPublicKeyQuery())).data
        .vapidPublicKey;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      const next = await detectPushState(await tenantKey());
      if (active) setState(next);
    })();
    return () => {
      active = false;
    };
    // tenantKey only closes over the stable query client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient]);

  // A subscription made before the outlet was known (or from the plain
  // notification center) carries no outlet, so it would miss panic alarms.
  // Re-save the existing browser subscription with the outlet; the
  // registration is an idempotent upsert. The "active" label is shown only
  // after the server confirmed the save for the current outlet (boundOutlet);
  // a failed save reads as "unbound" with a retry, never as active.
  const outletId = outlet?.id;
  const userId = session?.user.id;
  // A bind is confirmed per outlet and login: a password change revokes every
  // session (and its push rows), so a new login binds again.
  const bindKey = outletId ? `${outletId}:${session?.session?.id ?? ""}` : null;
  const [boundOutlet, setBoundOutlet] = useState<string | null>(null);
  // The outlet whose last bind failed: a new outlet (or a remount) starts
  // fresh, so it binds at once instead of waiting for a retry.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const unbound = !!outletId && failedFor === outletId;
  const inFlight = useRef(false);
  // A registered device is scoped by its token; the server uses the device's
  // own outlet, so no outlet is sent then.
  const sentOutletId = () => (getDeviceToken() === null ? outletId : undefined);
  const bind = async () => {
    if (!outletId || inFlight.current) return;
    inFlight.current = true;
    try {
      if (!userId) throw new Error("no session user");
      const key = await tenantKey();
      // Back to "connecting" while this try runs (never synchronously in
      // the effect that started it).
      setFailedFor(null);
      const input = await subscribeThisBrowser(key, sentOutletId(), userId);
      const saved = await save.mutateAsync(input);
      rememberSubscriptionId(saved.data.id, userId, input.endpoint);
      rememberMockSubscriptionId(saved.data.id);
      setBoundOutlet(bindKey);
    } catch {
      setBoundOutlet(null);
      setFailedFor(outletId);
    } finally {
      inFlight.current = false;
    }
  };
  const bindNow = useEffectEvent(() => void bind());
  const needsBind = state === "active" && !!outletId && boundOutlet !== bindKey;

  useEffect(() => {
    if (!needsBind || unbound) return;
    // Right after this effect, not inside its body: the bind sets state.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) bindNow();
    });
    return () => {
      cancelled = true;
    };
  }, [needsBind, unbound, outletId, userId]);

  // Retry on its own when the network or the tab comes back.
  useEffect(() => {
    if (!needsBind || !unbound) return;
    const retry = () => {
      if (document.visibilityState === "visible") bindNow();
    };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [needsBind, unbound]);

  const enable = async () => {
    setFailed(false);
    setBusy(true);
    try {
      if (Notification.permission !== "granted") {
        const permission = await requestPushPermission();
        if (permission !== "granted") {
          setState(await detectPushState(await tenantKey()));
          return;
        }
      }
      if (!userId) throw new Error("no session user");
      const input = await subscribeThisBrowser(
        await tenantKey(),
        sentOutletId(),
        userId,
      );
      const saved = await save.mutateAsync(input);
      rememberSubscriptionId(saved.data.id, userId, input.endpoint);
      rememberMockSubscriptionId(saved.data.id);
      setBoundOutlet(bindKey);
      setFailedFor(null);
      setState("active");
      toast({ title: t("facilityStaff.alarmPush.enabled"), tone: "success" });
    } catch {
      setFailed(true);
      setState(await detectPushState(await tenantKey()));
    } finally {
      setBusy(false);
    }
  };

  if (state === "checking") return null;

  const hintKey = HINT[state];
  return (
    <section
      aria-label={t("facilityStaff.alarmPush.label")}
      className="flex flex-wrap items-center gap-3 rounded-container border-(length:--border-w) bg-card p-3"
    >
      {state === "inactive" && (
        <>
          <p className="min-w-0 flex-1 basis-60 text-sm leading-5 text-muted-foreground">
            {t("facilityStaff.alarmPush.enableHint")}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={enable}
            loading={busy}
          >
            <BellRing aria-hidden="true" />
            {t("facilityStaff.alarmPush.enable")}
          </Button>
        </>
      )}
      {state === "active" && needsBind && !unbound && (
        <p role="status" className="text-sm leading-5 text-muted-foreground">
          {t("facilityStaff.alarmPush.binding")}
        </p>
      )}
      {state === "active" && needsBind && unbound && (
        <>
          <p
            role="alert"
            className="min-w-0 flex-1 basis-60 text-sm leading-5 font-medium text-danger"
          >
            {t("facilityStaff.alarmPush.unbound")}
          </p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => void bind()}
          >
            <BellRing aria-hidden="true" />
            {t("facilityStaff.alarmPush.retry")}
          </Button>
        </>
      )}
      {state === "active" && !needsBind && (
        <p className="flex items-center gap-2 text-sm leading-5">
          <CircleCheck
            className="size-4 shrink-0 text-success"
            aria-hidden="true"
          />
          {t("facilityStaff.alarmPush.enabled")}
        </p>
      )}
      {hintKey && (
        <p className="text-sm leading-5 text-muted-foreground">{t(hintKey)}</p>
      )}
      {failed && (
        <p
          role="alert"
          className="w-full text-sm leading-5 font-medium text-danger"
        >
          {t("facilityStaff.alarmPush.enableError")}
        </p>
      )}
    </section>
  );
}
