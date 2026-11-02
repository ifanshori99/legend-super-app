// Gateway routing per method (PRD §3 F13 "Routing per Metode"): the tenant
// default applies to every outlet; an outlet can override it without a
// redeploy. One row per online method, each saved on its own so two changes
// never overwrite each other.
import * as React from "react";
import { useAttemptKey } from "../use-attempt-key";
import { Check } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import type {
  PaymentProvider,
  PaymentRoute,
  PaymentRoutingView,
} from "@starter/shared/payment/admin";
import { methodLabelKey } from "../format";
import { usePaymentRouting, useUpdatePaymentRoute } from "../hooks";

const NO_FALLBACK = "none";

export function RoutingPanel() {
  const t = useT();
  const [outletId, setOutletId] = React.useState<string | null>(null);
  // The tenant query also supplies the outlet list for the scope selector.
  const tenant = usePaymentRouting(null);
  const scoped = usePaymentRouting(outletId);
  const current = outletId === null ? tenant : scoped;

  if (tenant.isPending && current.data === undefined)
    return <RoutingSkeleton />;
  if (current.isError) {
    return (
      <div className="rounded-container border-(length:--border-w) bg-card">
        <ErrorState
          title={t("paymentAdmin.loadErrorTitle")}
          description={t("paymentAdmin.loadErrorHint")}
          onRetry={() => void current.refetch()}
        />
      </div>
    );
  }

  const view = current.data?.data;
  if (!view) return <RoutingSkeleton />;
  const outlets = tenant.data?.data.outlets ?? view.outlets;

  return (
    <section
      aria-labelledby="routing-title"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"
    >
      <div className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
        <div className="grid min-w-0 gap-1">
          <h2 id="routing-title" className="type-title">
            {t("paymentAdmin.tabs.routing")}
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("paymentAdmin.routing.intro")}
          </p>
        </div>
        <div className="grid gap-3 sm:flex sm:flex-wrap sm:items-end">
          <div className="grid gap-1.5">
            <span className="text-sm leading-5 font-semibold">
              {t("paymentAdmin.routing.scope")}
            </span>
            <SegmentedControl
              value={outletId === null ? "tenant" : "outlet"}
              label={t("paymentAdmin.routing.scope")}
              onValueChange={(next) =>
                setOutletId(next === "tenant" ? null : (outlets[0]?.id ?? ""))
              }
              options={[
                {
                  value: "tenant",
                  label: t("paymentAdmin.routing.scopeTenant"),
                },
                {
                  value: "outlet",
                  label: t("paymentAdmin.routing.scopeOutlet"),
                },
              ]}
            />
          </div>
          {outletId !== null && (
            <FormField
              label={t("paymentAdmin.routing.outlet")}
              required
              className="sm:w-72"
            >
              <Select value={outletId} onValueChange={setOutletId}>
                <SelectTrigger
                  className="w-full"
                  aria-label={t("paymentAdmin.routing.outlet")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {outlets.map((outlet) => (
                    <SelectItem key={outlet.id} value={outlet.id}>
                      {outlet.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
        </div>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("paymentAdmin.routing.fallbackHint")}
        </p>
      </div>

      {view.routes.length === 0 ? (
        <div className="rounded-container border-(length:--border-w) bg-card">
          <EmptyState
            title={t("paymentAdmin.routing.emptyTitle")}
            description={t("paymentAdmin.routing.emptyHint")}
          />
        </div>
      ) : (
        <>
          <div
            aria-hidden="true"
            className="hidden gap-3 rounded-container border-(length:--border-w) bg-surface-2 p-card lg:grid lg:grid-cols-[minmax(12rem,1fr)_minmax(10rem,1fr)_minmax(10rem,1fr)_auto_auto] lg:items-center"
          >
            <span className="text-sm leading-5 font-semibold">
              {t("paymentAdmin.routing.method")}
            </span>
            <span className="text-sm leading-5 font-semibold">
              {t("paymentAdmin.routing.provider")}
            </span>
            <span className="text-sm leading-5 font-semibold">
              {t("paymentAdmin.routing.fallback")}
            </span>
            <span className="text-sm leading-5 font-semibold">
              {t("paymentAdmin.routing.enabled")}
            </span>
            <span className="w-20" />
          </div>
          <ul className="grid gap-2">
            {view.routes.map((route) => (
              <li
                key={`${route.id}:${route.updatedAt}:${outletId ?? "tenant"}`}
              >
                <RouteRow
                  route={route}
                  providers={view.providers}
                  scope={view}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RouteRow({
  route,
  providers,
  scope,
}: {
  route: PaymentRoute;
  providers: readonly PaymentProvider[];
  scope: PaymentRoutingView;
}) {
  const t = useT();
  const toast = useToast();
  const update = useUpdatePaymentRoute();
  const attempt = useAttemptKey();
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const [provider, setProvider] = React.useState(route.provider);
  const [fallback, setFallback] = React.useState(
    route.fallbackProvider ?? NO_FALLBACK,
  );
  const [enabled, setEnabled] = React.useState(route.enabled);

  const changed =
    provider !== route.provider ||
    fallback !== (route.fallbackProvider ?? NO_FALLBACK) ||
    enabled !== route.enabled;
  const dirty = changed && !update.isPending;

  const save = () => {
    const input = {
      method: route.method,
      body: {
        outletId: scope.outletId,
        provider,
        fallbackProvider: fallback === NO_FALLBACK ? null : fallback,
        enabled,
      },
    };
    update.mutate(
      { ...input, idempotencyKey: attempt.keyFor(input) },
      {
        onSuccess: () => {
          attempt.settle();
          toast({
            title: t("paymentAdmin.routing.saved", {
              method: t(methodLabelKey(route.method)),
            }),
          });
        },
        onError: (error) => {
          toast({
            title: error.message,
            tone: "danger",
          });
        },
      },
    );
  };

  return (
    <div className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline lg:grid-cols-[minmax(12rem,1fr)_minmax(10rem,1fr)_minmax(10rem,1fr)_auto_auto] lg:items-center">
      <div className="grid min-w-0 gap-0.5">
        <p className="font-semibold">{t(methodLabelKey(route.method))}</p>
        {scope.scope === "outlet" && (
          <p className="text-sm leading-5 text-muted-foreground">
            {route.outletId === null
              ? t("paymentAdmin.routing.inherited")
              : t("paymentAdmin.routing.overridden")}
          </p>
        )}
      </div>

      <FormField
        label={t("paymentAdmin.routing.provider")}
        required
        className="lg:[&>label]:sr-only"
      >
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger
            className="w-full"
            aria-label={t("paymentAdmin.routing.provider")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {enabledProviders.map((entry) => (
              <SelectItem key={entry.code} value={entry.code}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField
        label={t("paymentAdmin.routing.fallback")}
        required
        className="lg:[&>label]:sr-only"
      >
        <Select value={fallback} onValueChange={setFallback}>
          <SelectTrigger
            className="w-full"
            aria-label={t("paymentAdmin.routing.fallback")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_FALLBACK}>
              {t("paymentAdmin.routing.noFallback")}
            </SelectItem>
            {enabledProviders
              .filter((entry) => entry.code !== provider)
              .map((entry) => (
                <SelectItem key={entry.code} value={entry.code}>
                  {entry.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </FormField>

      <label className="flex min-h-control items-center gap-2 text-sm leading-5 font-semibold">
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("paymentAdmin.routing.enabled", {
            method: t(methodLabelKey(route.method)),
          })}
        />
        <span className="lg:sr-only">{t("paymentAdmin.routing.enabled")}</span>
      </label>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={save}
        disabled={!dirty}
        loading={update.isPending}
      >
        {changed && !update.isPending ? <Check aria-hidden="true" /> : null}
        {t("common.save")}
      </Button>
    </div>
  );
}

function RoutingSkeleton() {
  return (
    <div className="grid gap-2" aria-busy="true">
      <Skeleton className="h-24" />
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
    </div>
  );
}
