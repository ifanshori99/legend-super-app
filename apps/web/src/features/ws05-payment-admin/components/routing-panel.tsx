// Gateway routing per method (PRD §3 F13 "Routing per Metode"): the tenant
// default applies to every outlet; an outlet can override it without a
// redeploy. One row per online method, each saved on its own so two changes
// never overwrite each other.
import * as React from "react";
import { useRouteContext } from "@tanstack/react-router";
import { useAttemptKey } from "../use-attempt-key";
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
import { holdsAny } from "@/lib/areas/guard";
import { ANONYMOUS_ACCESS, type AreaAccess } from "@/lib/areas/access";
import { methodLabelKey } from "../format";
import { usePaymentRouting, useUpdatePaymentRoute } from "../hooks";
import {
  ROUTING_MANAGE_PERMISSION,
  fallbackProviderOptions,
  routingSaveErrorKey,
} from "../lib";
import type { MessageKey } from "@starter/shared/i18n";

const NO_FALLBACK = "none";
// Header and rows share these columns so the labels stay above their controls.
const ROW_GRID =
  "lg:grid-cols-[minmax(12rem,1fr)_minmax(10rem,1fr)_minmax(10rem,1fr)_5rem_5rem]";

/** Presentation only: the API re-checks org.settings.manage on every write. */
function useCanManageRouting(): boolean {
  const context = useRouteContext({ strict: false }) as {
    readonly access?: AreaAccess;
  };
  // Fail closed: no access context means no routing change.
  return holdsAny(context.access ?? ANONYMOUS_ACCESS, [
    ROUTING_MANAGE_PERMISSION,
  ]);
}

export function RoutingPanel() {
  const t = useT();
  const canManage = useCanManageRouting();
  const [outletId, setOutletId] = React.useState<string | null>(null);
  // The tenant query also supplies the outlet list for the scope selector.
  const tenant = usePaymentRouting(null);
  const scoped = usePaymentRouting(outletId);
  const current = outletId === null ? tenant : scoped;
  const outlets = tenant.data?.data.outlets ?? [];
  // Never select an outlet before the list is known: there is nothing to pick.
  const outletsReady = outlets.length > 0;
  const view = current.data?.data;
  // keepPreviousData shows the old scope's rows while the new one loads; they
  // must not be saved as if they belonged to the new scope.
  const stale = current.isPlaceholderData === true;

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
              onValueChange={(next) => {
                if (next === "tenant") return setOutletId(null);
                const first = outlets[0]?.id;
                if (first !== undefined) setOutletId(first);
              }}
              options={[
                {
                  value: "tenant",
                  label: t("paymentAdmin.routing.scopeTenant"),
                },
                {
                  value: "outlet",
                  label: t("paymentAdmin.routing.scopeOutlet"),
                  disabled: !outletsReady,
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
        {tenant.isPending && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("paymentAdmin.routing.outletsLoading")}
          </p>
        )}
        <p className="text-sm leading-5 text-muted-foreground">
          {t("paymentAdmin.routing.fallbackHint")}
        </p>
      </div>

      {current.isError ? (
        <div className="rounded-container border-(length:--border-w) bg-card">
          <ErrorState
            title={t("paymentAdmin.loadErrorTitle")}
            description={t("paymentAdmin.loadErrorHint")}
            onRetry={() => void current.refetch()}
          />
        </div>
      ) : !view ? (
        <RoutingSkeleton />
      ) : view.routes.length === 0 ? (
        <div className="rounded-container border-(length:--border-w) bg-card">
          <EmptyState
            title={t("paymentAdmin.routing.emptyTitle")}
            description={t("paymentAdmin.routing.emptyHint")}
          />
        </div>
      ) : (
        <div className="grid gap-2" aria-busy={stale || undefined}>
          <div
            aria-hidden="true"
            className={`hidden gap-3 rounded-container border-(length:--border-w) bg-surface-2 p-card lg:grid ${ROW_GRID} lg:items-center`}
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
            <span />
          </div>
          <ul className={stale ? "grid gap-2 opacity-60" : "grid gap-2"}>
            {view.routes.map((route) => (
              <li
                key={`${route.id}:${route.updatedAt}:${outletId ?? "tenant"}`}
              >
                <RouteRow
                  route={route}
                  providers={view.providers}
                  scope={view}
                  canManage={canManage && !stale}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RouteRow({
  route,
  providers,
  scope,
  canManage,
}: {
  route: PaymentRoute;
  providers: readonly PaymentProvider[];
  scope: PaymentRoutingView;
  canManage: boolean;
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
  const [saveError, setSaveError] = React.useState<MessageKey | null>(null);

  const changed =
    provider !== route.provider ||
    fallback !== (route.fallbackProvider ?? NO_FALLBACK) ||
    enabled !== route.enabled;
  const dirty = canManage && changed && !update.isPending;
  const fallbackOptions = fallbackProviderOptions(providers, provider);
  // A saved gateway that was switched off still has to show in its Select, but
  // cannot be picked again.
  const inactiveProvider = providers.find(
    (entry) => entry.code === provider && !entry.enabled,
  );
  const inactiveFallback = providers.find(
    (entry) => entry.code === fallback && !entry.enabled,
  );

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
    setSaveError(null);
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
        onError: (error) => setSaveError(routingSaveErrorKey(error)),
      },
    );
  };

  return (
    <div
      className={`grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline ${ROW_GRID} lg:items-center`}
    >
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
        <Select
          value={provider}
          disabled={!canManage}
          onValueChange={(next) => {
            setProvider(next);
            // The backup can never equal the primary gateway.
            if (next === fallback) setFallback(NO_FALLBACK);
          }}
        >
          <SelectTrigger
            className="w-full"
            aria-label={t("paymentAdmin.routing.provider")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {inactiveProvider && (
              <SelectItem value={inactiveProvider.code} disabled>
                {t("paymentAdmin.routing.inactiveProvider", {
                  name: inactiveProvider.name,
                })}
              </SelectItem>
            )}
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
        className="lg:[&>label]:sr-only"
      >
        <Select
          value={fallback}
          disabled={!canManage}
          onValueChange={setFallback}
        >
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
            {inactiveFallback && (
              <SelectItem value={inactiveFallback.code} disabled>
                {t("paymentAdmin.routing.inactiveProvider", {
                  name: inactiveFallback.name,
                })}
              </SelectItem>
            )}
            {fallbackOptions.map((entry) => (
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
          disabled={!canManage}
          aria-label={t("paymentAdmin.routing.enableMethod", {
            method: t(methodLabelKey(route.method)),
          })}
        />
        <span className="lg:sr-only">{t("paymentAdmin.routing.enabled")}</span>
      </label>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-20"
        onClick={save}
        disabled={!dirty}
        loading={update.isPending}
      >
        {t("common.save")}
      </Button>

      {saveError && (
        <p
          role="alert"
          className="text-sm leading-5 font-medium text-danger lg:col-span-full"
        >
          {t(saveError)}
        </p>
      )}
    </div>
  );
}

function RoutingSkeleton() {
  const t = useT();
  return (
    <div className="grid gap-2" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      <Skeleton className="h-24" />
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
    </div>
  );
}
