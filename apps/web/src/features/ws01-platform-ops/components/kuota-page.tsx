// /platform/kuota — quotas, monthly cost caps and available gateways per
// tenant (PRD v1.7 §3 F4 "Kuota & Plafon", §2 Biaya operasional, A17, R18,
// D27). Usage vs limit comes from getTenantUsage; the form validates with the
// contract's own tenantLimitsSchema (logic.ts parseLimitsDraft).
import * as React from "react";
import { LEGEND_MIN_ACTIVE_EMPLOYEES } from "@starter/shared/platform";
import type {
  IntegrationProvider,
  PlatformPackage,
  Tenant,
  TenantLimits,
  TenantUsage,
} from "@starter/shared/platform";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { usePackages, useTenant, useUsage } from "../hooks";
import {
  LIMIT_FIELDS,
  diffList,
  draftFromLimits,
  limitWarnings,
  limitsChanged,
  nextProviders,
  parseLimitsDraft,
  providersByCategory,
  quotaState,
  usagePercent,
  type LimitsDraft,
} from "../logic";
import { ChangeDialog, DiffSummary } from "./change-dialog";
import {
  OpsPage,
  Section,
  SectionError,
  SectionLoading,
  TenantPicker,
  UsageBar,
  useSelectedTenant,
} from "./ops-shell";
import { useConfirmedSave } from "./use-save";

export function KuotaPage({
  canManage,
  canManageGateways,
}: {
  canManage: boolean;
  canManageGateways: boolean;
}) {
  const t = useT();
  const { tenants, rows, tenantId, setTenantId } = useSelectedTenant();
  const tenant = useTenant(tenantId);
  const usage = useUsage(tenantId);
  const packages = usePackages();

  const loading =
    tenants.isPending ||
    (tenantId !== null && (tenant.isPending || usage.isPending));
  const failed = tenants.isError || tenant.isError || usage.isError;
  const retry = () => {
    void tenants.refetch();
    void tenant.refetch();
    void usage.refetch();
  };
  const toolbar = (
    <TenantPicker rows={rows} value={tenantId} onChange={setTenantId} />
  );

  if (loading)
    return (
      <OpsPage toolbar={toolbar}>
        <Section title={t("platformOps.quota.title")}>
          <SectionLoading />
        </Section>
      </OpsPage>
    );
  if (failed)
    return (
      <OpsPage toolbar={toolbar}>
        <Section title={t("platformOps.quota.title")}>
          <SectionError onRetry={retry} />
        </Section>
      </OpsPage>
    );
  if (rows.length === 0 || !tenant.data || !usage.data)
    return (
      <OpsPage>
        <Section title={t("platformOps.quota.title")}>
          <EmptyState
            title={t("platformOps.noTenantsTitle")}
            description={t("platformOps.noTenantsHint")}
          />
        </Section>
      </OpsPage>
    );

  const view = usage.data.data;
  const row = tenant.data.data;
  const plan = packages.data?.data.find((pkg) => pkg.key === row.plan);

  return (
    <OpsPage toolbar={toolbar}>
      <Section
        title={t("platformOps.quota.title")}
        description={t("platformOps.quota.description", {
          month: view.usage.month,
        })}
      >
        <div className="grid gap-5">
          {view.quotas.map((quota) => {
            const state = quotaState(quota.used, quota.limit);
            return (
              <UsageBar
                key={quota.quota}
                label={t(`platformOps.quotaNames.${quota.quota}`)}
                detail={t("platformOps.quota.ratio", {
                  used: formatNumber(quota.used),
                  limit: formatNumber(quota.limit),
                })}
                percent={usagePercent(quota.used, quota.limit)}
                state={state}
                stateLabel={t(`platformOps.state.${state}`)}
                note={
                  quota.limit === 0
                    ? t("platformOps.quota.zeroLimit")
                    : undefined
                }
              />
            );
          })}
        </div>
      </Section>

      <Section
        title={t("platformOps.caps.title")}
        description={t("platformOps.caps.description")}
      >
        <div className="grid gap-5">
          {view.costCaps.map((cap) => {
            const off = cap.capIdr === 0;
            return (
              <UsageBar
                key={cap.cap}
                label={t(`platformOps.capNames.${cap.cap}`)}
                detail={t("platformOps.caps.ratio", {
                  spent: formatRupiah(cap.spentIdr),
                  cap: formatRupiah(cap.capIdr),
                })}
                percent={usagePercent(cap.spentIdr, cap.capIdr)}
                state={cap.state}
                off={off}
                stateLabel={t(
                  off
                    ? "platformOps.state.off"
                    : `platformOps.state.${cap.state}`,
                )}
                note={off ? t("platformOps.caps.offNote") : undefined}
              />
            );
          })}
        </div>
      </Section>

      <LimitsEditor
        key={JSON.stringify(row.limits)}
        tenant={row}
        usage={view.usage}
        plan={plan}
        canManage={canManage}
      />
      <GatewayEditor
        key={row.featureFlags.integrationProviders.join(",")}
        tenant={row}
        canManage={canManageGateways}
      />
    </OpsPage>
  );
}

function formatLimit(kind: "count" | "idr", value: number): string {
  return kind === "idr" ? formatRupiah(value) : formatNumber(value);
}

function LimitsEditor({
  tenant,
  usage,
  plan,
  canManage,
}: {
  tenant: Tenant;
  usage: TenantUsage;
  plan: PlatformPackage | undefined;
  canManage: boolean;
}) {
  const t = useT();
  const [draft, setDraft] = React.useState<LimitsDraft>(() =>
    draftFromLimits(tenant.limits),
  );
  const flow = useConfirmedSave(tenant.id, t("platformOps.limitsForm.saved"));
  const parsed = parseLimitsDraft(draft);
  const next: TenantLimits | null = parsed.limits;
  const changed = next ? limitsChanged(tenant.limits, next) : [];
  const warnings = next ? limitWarnings(next, usage) : {};
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(draftFromLimits(tenant.limits));

  const summaryRows = next
    ? LIMIT_FIELDS.filter((field) => changed.includes(field.key)).map(
        (field) => ({
          label: t(`platformOps.limits.${field.key}`),
          value: `${formatLimit(field.kind, tenant.limits[field.key])} → ${formatLimit(field.kind, next[field.key])}`,
        }),
      )
    : [];

  return (
    <Section
      title={t("platformOps.limitsForm.title")}
      description={t("platformOps.limitsForm.description")}
    >
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed.ok && changed.length > 0) flow.open();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {LIMIT_FIELDS.map((field) => {
            const error = parsed.errors[field.key];
            const warning = warnings[field.key];
            return (
              <FormField
                key={field.key}
                label={t(`platformOps.limits.${field.key}`)}
                required
                hint={
                  warning
                    ? t(`platformOps.limitWarnings.${warning}`, {
                        min: LEGEND_MIN_ACTIVE_EMPLOYEES,
                      })
                    : field.key === "maxActiveEmployees"
                      ? t("platformOps.limitsForm.employeesHint", {
                          min: LEGEND_MIN_ACTIVE_EMPLOYEES,
                        })
                      : field.kind === "idr"
                        ? t("platformOps.limitsForm.idrHint")
                        : undefined
                }
                error={
                  error ? t(`platformOps.limitErrors.${error}`) : undefined
                }
              >
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  value={draft[field.key]}
                  disabled={!canManage}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [field.key]: event.target.value,
                    }))
                  }
                />
              </FormField>
            );
          })}
        </div>

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={!parsed.ok || changed.length === 0}>
              {t("platformOps.limitsForm.review")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!dirty}
              onClick={() => setDraft(draftFromLimits(tenant.limits))}
            >
              {t("platformOps.reset")}
            </Button>
            {plan && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDraft(draftFromLimits(plan.defaultLimits))}
              >
                {t("platformOps.limitsForm.useDefaults", { plan: plan.name })}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("platformOps.readOnly")}
          </p>
        )}
      </form>

      <ChangeDialog
        open={flow.confirming}
        onOpenChange={flow.setConfirming}
        title={t("platformOps.limitsForm.confirmTitle", {
          tenant: tenant.name,
        })}
        description={t("platformOps.limitsForm.confirmDescription")}
        summary={<DiffSummary rows={summaryRows} />}
        pending={flow.pending}
        error={flow.error}
        onConfirm={(reason) =>
          next &&
          flow.run({
            plan: tenant.plan,
            featureFlags: tenant.featureFlags,
            limits: next,
            reason,
          })
        }
      />
    </Section>
  );
}

function GatewayEditor({
  tenant,
  canManage,
}: {
  tenant: Tenant;
  canManage: boolean;
}) {
  const t = useT();
  const saved = tenant.featureFlags.integrationProviders;
  const [providers, setProviders] =
    React.useState<IntegrationProvider[]>(saved);
  const flow = useConfirmedSave(tenant.id, t("platformOps.gateways.saved"));
  const diff = diffList(saved, providers);
  const dirty = diff.added.length + diff.removed.length > 0;
  const label = (key: IntegrationProvider) => t(`platformOps.providers.${key}`);

  const summaryRows = [
    ...(diff.added.length > 0
      ? [
          {
            label: t("platformOps.gateways.summaryOn"),
            value: diff.added.map(label).join(", "),
          },
        ]
      : []),
    ...(diff.removed.length > 0
      ? [
          {
            label: t("platformOps.gateways.summaryOff"),
            value: diff.removed.map(label).join(", "),
            tone: "remove" as const,
          },
        ]
      : []),
  ];

  return (
    <Section
      title={t("platformOps.gateways.title")}
      description={t("platformOps.gateways.description")}
    >
      <div className="grid gap-5">
        {providersByCategory().map((group) => (
          <fieldset key={group.category} className="grid gap-1.5">
            <legend className="type-eyebrow mb-1 text-muted-foreground">
              {t(`platformOps.categories.${group.category}`)}
            </legend>
            <ul className="grid divide-y rounded-control border-(length:--border-w)">
              {group.providers.map((provider) => {
                const id = `ops-provider-${provider}`;
                return (
                  <li
                    key={provider}
                    className="flex min-h-12 items-center justify-between gap-3 px-3 py-2"
                  >
                    <label htmlFor={id} className="text-sm font-semibold">
                      {label(provider)}
                    </label>
                    <Switch
                      id={id}
                      checked={providers.includes(provider)}
                      disabled={!canManage}
                      onCheckedChange={(on) =>
                        setProviders((current) =>
                          nextProviders(current, provider, on),
                        )
                      }
                      aria-label={label(provider)}
                    />
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ))}

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!dirty} onClick={flow.open}>
              {t("platformOps.gateways.review")}
            </Button>
            <Button
              variant="outline"
              disabled={!dirty}
              onClick={() => setProviders(saved)}
            >
              {t("platformOps.reset")}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("platformOps.readOnly")}
          </p>
        )}
      </div>

      <ChangeDialog
        open={flow.confirming}
        onOpenChange={flow.setConfirming}
        title={t("platformOps.gateways.confirmTitle", { tenant: tenant.name })}
        description={t("platformOps.gateways.confirmDescription")}
        summary={<DiffSummary rows={summaryRows} />}
        destructive={diff.removed.length > 0}
        pending={flow.pending}
        error={flow.error}
        onConfirm={(reason) =>
          flow.run({
            plan: tenant.plan,
            featureFlags: {
              modules: tenant.featureFlags.modules,
              integrationProviders: providers,
            },
            limits: tenant.limits,
            reason,
          })
        }
      />
    </Section>
  );
}
