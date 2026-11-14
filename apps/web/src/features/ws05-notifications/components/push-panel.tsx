import { useEffect, useState } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  BellRing,
  CircleCheck,
  CircleX,
  Info,
  LoaderCircle,
  Smartphone,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import type { MessageKey } from "@starter/shared/i18n";
import { useDeletePushSubscription, useSavePushSubscription } from "../hooks";
import { pushPublicKeyQuery } from "../queries";
import {
  deviceLabel,
  detectPushState,
  forgetSubscriptionId,
  readMockSubscriptionId,
  readStoredSubscriptionId,
  rememberMockSubscriptionId,
  rememberSubscriptionId,
  requestPushPermission,
  subscribeThisBrowser,
  unsubscribeThisBrowser,
  type PushState,
} from "../push";

type StatusMeta = {
  label: MessageKey;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
};

const STATUS: Record<PushState, StatusMeta> = {
  checking: { label: "notification.push.checking", tone: "neutral" },
  inactive: { label: "notification.push.stateInactive", tone: "neutral" },
  active: { label: "notification.push.stateActive", tone: "success" },
  blocked: { label: "notification.push.stateBlocked", tone: "danger" },
  unsupported: { label: "notification.push.stateUnsupported", tone: "warning" },
  unavailable: { label: "notification.push.stateUnavailable", tone: "warning" },
  "ios-install": {
    label: "notification.push.stateIosInstall",
    tone: "warning",
  },
  "ios-outdated": {
    label: "notification.push.stateUnsupported",
    tone: "warning",
  },
};

// The tenant key comes from the API at runtime; a failed lookup reads as
// "not enabled" so the card never offers a subscribe it cannot finish.
async function loadTenantKey(queryClient: QueryClient): Promise<string | null> {
  try {
    return (await queryClient.fetchQuery(pushPublicKeyQuery())).data
      .vapidPublicKey;
  } catch {
    return null;
  }
}

/**
 * Web-push opt-in for this browser (PRD §2 PWA). The card never claims the
 * channel works when it cannot: unsupported browsers, blocked permissions,
 * a missing tenant VAPID key and iOS before "Add to Home Screen" each get
 * their own state and the fix.
 */
export function PushPanel() {
  const t = useT();
  const toast = useToast();
  const save = useSavePushSubscription();
  const remove = useDeletePushSubscription();
  const queryClient = useQueryClient();
  const tenantKey = () => loadTenantKey(queryClient);
  const [state, setState] = useState<PushState>("checking");
  const [device, setDevice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const label = deviceLabel();
      const next = await detectPushState(await loadTenantKey(queryClient));
      if (!active) return;
      setDevice(label);
      setSubscriptionId(readMockSubscriptionId() ?? readStoredSubscriptionId());
      setState(next);
    })();
    return () => {
      active = false;
    };
  }, [queryClient]);

  const enable = async () => {
    setError(null);
    setBusy(true);
    try {
      const next = await detectPushState(await tenantKey());
      if (next !== "inactive" && next !== "active") {
        setState(next);
        return;
      }
      if (next === "active") {
        setState("active");
        return;
      }
      if (Notification.permission !== "granted") {
        const permission = await requestPushPermission();
        if (permission !== "granted") {
          setState(await detectPushState(await tenantKey()));
          return;
        }
      }
      const saved = await save.mutateAsync(
        await subscribeThisBrowser(await tenantKey()),
      );
      setSubscriptionId(saved.data.id);
      rememberMockSubscriptionId(saved.data.id);
      rememberSubscriptionId(saved.data.id);
      setState("active");
      toast({
        title: t("notification.push.enabledToast"),
        description: t("notification.push.enabledBody"),
        tone: "success",
      });
    } catch {
      setError(t("notification.push.enableError"));
      setState(await detectPushState(await tenantKey()));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setError(null);
    setBusy(true);
    try {
      let id =
        subscriptionId ??
        readMockSubscriptionId() ??
        readStoredSubscriptionId();
      // Saving again returns this browser's row (upsert), which the revoke
      // call needs after a reload.
      if (!id)
        id = (
          await save.mutateAsync(await subscribeThisBrowser(await tenantKey()))
        ).data.id;
      await remove.mutateAsync(id);
      await unsubscribeThisBrowser();
      forgetSubscriptionId();
      setSubscriptionId(null);
      setState("inactive");
      toast({ title: t("notification.push.disabledToast"), tone: "success" });
    } catch {
      setError(t("notification.push.enableError"));
    } finally {
      setBusy(false);
    }
  };

  const meta = STATUS[state];
  const hint =
    state === "blocked"
      ? t("notification.push.blockedHint")
      : state === "unsupported"
        ? t("notification.push.unsupportedHint")
        : state === "unavailable"
          ? t("notification.push.unavailableHint")
          : state === "ios-outdated"
            ? t("notification.push.iosOutdatedHint")
            : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {t("notification.push.heading")}
        </CardTitle>
        <CardDescription>{t("notification.push.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {state === "checking" ? (
            <Badge tone="neutral">
              <LoaderCircle className="animate-spin" aria-hidden="true" />
              {t(meta.label)}
            </Badge>
          ) : (
            <Badge tone={meta.tone}>
              {state === "active" ? (
                <CircleCheck aria-hidden="true" />
              ) : state === "blocked" ? (
                <CircleX aria-hidden="true" />
              ) : (
                <Info aria-hidden="true" />
              )}
              {t(meta.label)}
            </Badge>
          )}
          {device && (
            <span className="text-sm leading-5 text-muted-foreground">
              {t("notification.push.device", { device })}
            </span>
          )}
        </div>

        {state === "ios-install" && (
          <div className="grid gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-3">
            <p className="flex items-center gap-2 text-sm leading-5 font-semibold">
              <Smartphone className="size-4" aria-hidden="true" />
              {t("notification.push.iosTitle")}
            </p>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("notification.push.iosHint")}
            </p>
            <ol className="grid list-decimal gap-1 pl-5 text-sm leading-5">
              <li>{t("notification.push.iosStep1")}</li>
              <li>{t("notification.push.iosStep2")}</li>
              <li>{t("notification.push.iosStep3")}</li>
            </ol>
          </div>
        )}

        {hint && (
          <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
        )}
        {error && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {error}
          </p>
        )}
      </CardContent>
      {(state === "inactive" || state === "active") && (
        <CardFooter>
          {state === "active" ? (
            <Button variant="outline" onClick={disable} loading={busy}>
              {t("notification.push.disable")}
            </Button>
          ) : (
            <Button variant="outline" onClick={enable} loading={busy}>
              <BellRing aria-hidden="true" />
              {t("notification.push.enable")}
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
