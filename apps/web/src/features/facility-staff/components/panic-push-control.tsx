import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
  // Silently re-save the existing browser subscription with the outlet; the
  // registration is an idempotent upsert.
  const resavedFor = useRef<string | null>(null);
  const outletId = outlet?.id;
  // A registered device is scoped by its token; the server uses the device's
  // own outlet, so no outlet is sent then.
  const sentOutletId = () => (getDeviceToken() === null ? outletId : undefined);
  useEffect(() => {
    if (state !== "active" || !outletId || resavedFor.current === outletId)
      return;
    resavedFor.current = outletId;
    void (async () => {
      try {
        const key = await tenantKey();
        const saved = await save.mutateAsync(
          await subscribeThisBrowser(key, sentOutletId()),
        );
        rememberSubscriptionId(saved.data.id);
        rememberMockSubscriptionId(saved.data.id);
      } catch {
        // Best effort: the control stays "active" and a later visit retries.
        resavedFor.current = null;
      }
    })();
    // tenantKey and save are stable for this purpose; re-run on state/outlet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, outletId]);

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
      const saved = await save.mutateAsync(
        await subscribeThisBrowser(await tenantKey(), sentOutletId()),
      );
      rememberSubscriptionId(saved.data.id);
      rememberMockSubscriptionId(saved.data.id);
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
      {state === "active" && (
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
