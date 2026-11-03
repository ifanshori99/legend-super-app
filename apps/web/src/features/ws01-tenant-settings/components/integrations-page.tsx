// Integrations (PRD v1.7 §3 F4 "Integrasi per Tenant"): DOIT, WhatsApp number,
// email sender and ojol accounts, per tenant or per outlet. Credentials are
// shown masked and never read back (PAY-06): a card only says which fields are
// set; "Atur" opens a form whose credential inputs replace them.
import * as React from "react";
import { CircleCheck, Info, KeyRound, Settings2 } from "lucide-react";
import type { TenantIntegration } from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { settingsErrorMessage } from "../errors";
import { useIntegrations, useOutlets, useSetIntegrationStatus } from "../hooks";
import {
  CREDENTIAL_MASK,
  PROVIDER_DEFINITIONS,
  PROVIDER_GROUPS,
  inheritedRow,
  integrationView,
  rowForScope,
  statusActions,
  storedCredentialFields,
  type IntegrationScope,
  type IntegrationView,
  type ProviderDefinition,
} from "../integrations-lib";
import { IntegrationDialog } from "./integration-dialog";
import { CardSkeletons, QueryFailure } from "./query-states";
import { SettingsPage } from "./settings-shell";

const TENANT_SCOPE = "tenant";

const VIEW_TONE = {
  not_configured: "neutral",
  draft: "info",
  active: "success",
  disabled: "neutral",
  error: "danger",
} as const satisfies Record<IntegrationView, string>;

const DATE_TIME = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Jakarta",
});

export function IntegrationsPage({ access }: { access: AreaAccess }) {
  const t = useT();
  const integrations = useIntegrations();
  const outlets = useOutlets();
  const [scopeKey, setScopeKey] = React.useState(TENANT_SCOPE);
  const [editing, setEditing] = React.useState<ProviderDefinition | null>(null);
  const canManage = holdsAny(access, ["org.integration.manage"]);

  const scope: IntegrationScope = {
    outletId: scopeKey === TENANT_SCOPE ? null : scopeKey,
  };
  const outletList = outlets.data?.data ?? [];
  const scopeLabel =
    scope.outletId === null
      ? t("tenantSettings.integrations.scopeTenant")
      : (outletList.find((outlet) => outlet.id === scope.outletId)?.name ??
        t("tenantSettings.integrations.scopeOutlet"));

  const rows = integrations.data?.data ?? [];

  return (
    <SettingsPage active="integrations" access={access}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid max-w-prose gap-1">
          <h2 className="type-heading">
            {t("tenantSettings.integrations.title")}
          </h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("tenantSettings.integrations.description")}
          </p>
        </div>
        <div className="grid gap-1.5">
          <span
            id="integration-scope-label"
            className="text-sm leading-5 font-medium"
          >
            {t("tenantSettings.integrations.scopeLabel")}
          </span>
          <Select value={scopeKey} onValueChange={setScopeKey}>
            <SelectTrigger
              className="sm:w-64"
              aria-labelledby="integration-scope-label"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TENANT_SCOPE}>
                {t("tenantSettings.integrations.scopeTenant")}
              </SelectItem>
              {outletList.map((outlet) => (
                <SelectItem key={outlet.id} value={outlet.id}>
                  {outlet.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <p className="flex items-start gap-2 rounded-container border-(length:--border-w) bg-info-subtle px-3 py-2.5 text-sm leading-5 text-foreground">
        <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
        {t("tenantSettings.integrations.secretNotice")}
      </p>

      {integrations.isPending ? (
        <CardSkeletons count={6} />
      ) : integrations.isError ? (
        <QueryFailure
          error={integrations.error}
          onRetry={() => void integrations.refetch()}
        />
      ) : (
        <>
          {rows.length === 0 && (
            <p className="rounded-container border-(length:--border-w) border-dashed px-4 py-3 text-sm leading-5 text-muted-foreground">
              {t("tenantSettings.integrations.emptyHint")}
            </p>
          )}
          {PROVIDER_GROUPS.map((group) => (
            <section
              key={group.key}
              aria-labelledby={`group-${group.key}`}
              className="grid gap-3"
            >
              <h3 id={`group-${group.key}`} className="type-eyebrow">
                {t(group.label)}
              </h3>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {group.providers.map((provider) => {
                  const definition = PROVIDER_DEFINITIONS[provider];
                  return (
                    <IntegrationCard
                      key={provider}
                      definition={definition}
                      row={rowForScope(rows, provider, scope)}
                      inherited={inheritedRow(rows, provider, scope)}
                      canManage={canManage}
                      onEdit={() => setEditing(definition)}
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </>
      )}

      {editing && (
        <IntegrationDialog
          // A fresh form (and buffer) per provider and scope.
          key={`${editing.provider}:${scopeKey}`}
          definition={editing}
          row={rowForScope(rows, editing.provider, scope)}
          scope={scope}
          scopeLabel={scopeLabel}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      )}
    </SettingsPage>
  );
}

function IntegrationCard({
  definition,
  row,
  inherited,
  canManage,
  onEdit,
}: {
  definition: ProviderDefinition;
  row: TenantIntegration | null;
  inherited: TenantIntegration | null;
  canManage: boolean;
  onEdit: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const setStatus = useSetIntegrationStatus();
  const view = integrationView(row);
  const actions = statusActions(row);
  const stored = storedCredentialFields(row);
  const titleId = React.useId();

  const change = (status: "active" | "disabled") => {
    if (!row) return;
    setStatus.mutate(
      { integrationId: row.id, status },
      {
        onSuccess: () =>
          toast({
            tone: "success",
            title: t(
              status === "active"
                ? "tenantSettings.integrations.activated"
                : "tenantSettings.integrations.disabled",
              { name: t(definition.name) },
            ),
          }),
        onError: (failure) =>
          toast({
            tone: "danger",
            title: settingsErrorMessage(failure, t),
          }),
      },
    );
  };

  return (
    <Card aria-labelledby={titleId} role="group" className="min-w-0">
      <CardHeader>
        <CardTitle id={titleId}>{t(definition.name)}</CardTitle>
        <CardDescription>{t(definition.description)}</CardDescription>
        <CardAction>
          <Badge tone={VIEW_TONE[view]}>
            {t(`tenantSettings.integrations.status.${view}`)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {row ? (
          <>
            <dl className="grid gap-1.5 text-sm leading-5">
              {definition.config.map((field) => {
                const raw = row.config[field.name];
                if (raw === undefined || raw === null || raw === "")
                  return null;
                const option = field.options?.find(
                  (item) => item.value === String(raw),
                );
                const value = option
                  ? t(option.label)
                  : field.kind === "whatsapp"
                    ? `+${String(raw)}`
                    : String(raw);
                return (
                  <div key={field.name} className="grid gap-0.5">
                    <dt className="text-muted-foreground">{t(field.label)}</dt>
                    <dd className="font-medium break-words">{value}</dd>
                  </div>
                );
              })}
            </dl>
            <div className="grid gap-1.5">
              <p className="flex items-center gap-1.5 text-sm leading-5 text-muted-foreground">
                <KeyRound className="size-4" aria-hidden="true" />
                {t("tenantSettings.integrations.credentialsTitle")}
              </p>
              {stored.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {stored.map((name) => {
                    const known = definition.credentials.find(
                      (field) => field.name === name,
                    );
                    return (
                      <li key={name}>
                        <Badge tone="neutral">
                          {known ? t(known.label) : name}
                          <span aria-hidden="true">{CREDENTIAL_MASK}</span>
                          <span className="sr-only">
                            {t("tenantSettings.integrations.storedSr")}
                          </span>
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm leading-5">
                  {t("tenantSettings.integrations.noCredentials")}
                </p>
              )}
            </div>
            {row.lastErrorCode && (
              <p className="text-sm leading-5 font-medium text-danger">
                {t("tenantSettings.integrations.lastError", {
                  code: row.lastErrorCode,
                })}
              </p>
            )}
            {row.lastCheckedAt && (
              <p className="flex items-center gap-1.5 text-xs leading-4 text-muted-foreground">
                <CircleCheck className="size-3.5" aria-hidden="true" />
                {t("tenantSettings.integrations.lastChecked", {
                  time: DATE_TIME.format(new Date(row.lastCheckedAt)),
                })}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm leading-5 text-muted-foreground">
            {inherited
              ? t("tenantSettings.integrations.inherited")
              : t("tenantSettings.integrations.notConfigured")}
          </p>
        )}
        {canManage && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Settings2 aria-hidden="true" />
              {row
                ? t("tenantSettings.integrations.edit")
                : t("tenantSettings.integrations.setup")}
            </Button>
            {actions.canActivate && (
              <Button
                size="sm"
                loading={setStatus.isPending}
                onClick={() => change("active")}
              >
                {t("tenantSettings.integrations.activate")}
              </Button>
            )}
            {actions.canDisable && (
              <Button
                variant="ghost"
                size="sm"
                loading={setStatus.isPending}
                onClick={() => change("disabled")}
              >
                {t("tenantSettings.integrations.disable")}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
