// Duitku credentials per brand or outlet (sub-302 D15-D16, bead legend-vntqt).
// Credentials are WRITE-ONLY: the screen only learns "saved" and "last tested",
// never a value. What the user types goes straight into a one-shot buffer and
// the inputs are emptied before the request leaves (same rule as
// ws01-tenant-settings/components/integration-dialog.tsx, PAY-06).
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  LockKeyhole,
  PlugZap,
} from "lucide-react";
import type { TenantIntegration } from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBand } from "@/components/ui/status-band";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { retryOnceOnServerError } from "@/lib/api/retry";
import { integrationsQuery } from "../../ws01-tenant-settings/queries";
import {
  useOutlets,
  useSaveIntegration,
  useSetIntegrationStatus,
} from "../../ws01-tenant-settings/hooks";
import { createSecretBuffer } from "../../ws01-tenant-settings/secret-buffer";
import {
  DUITKU_CREDENTIAL_FIELDS,
  DUITKU_ENVIRONMENTS,
  VA_NAME_MAX,
  buildDuitkuUpsertInput,
  duitkuActivation,
  duitkuConfigDraft,
  duitkuFieldId,
  duitkuFormKey,
  duitkuMethodLabelKey,
  duitkuNeedsActivation,
  duitkuOutletsState,
  duitkuRowForScope,
  duitkuStatusView,
  duitkuTestFailureKeys,
  duitkuTypedCredentials,
  firstDuitkuErrorField,
  validateDuitkuDraft,
  validateDuitkuField,
  type DuitkuConfigDraft,
  type DuitkuCredentialField,
  type DuitkuErrors,
  type DuitkuScope,
} from "../duitku-credentials-lib";
import { formatMoment } from "../format";
import { useTestIntegrationConnection } from "../hooks";

const CREDENTIAL_MASK = "••••••••";

/** Never echoes `error.message`: a server message could quote a request field. */
function duitkuErrorMessage(
  error: unknown,
  t: ReturnType<typeof useT>,
): string {
  if (!(error instanceof ApiError))
    return t("paymentAdmin.duitku.errors.generic");
  switch (error.code) {
    case "VALIDATION_ERROR":
      return t("paymentAdmin.duitku.errors.invalid");
    case "FORBIDDEN":
      return t("paymentAdmin.duitku.errors.forbidden");
    case "NOT_FOUND":
      return t("paymentAdmin.duitku.errors.notFound");
    case "NOT_SUPPORTED":
      return t("paymentAdmin.duitku.errors.notSupported");
    case "NETWORK_ERROR":
      return t("paymentAdmin.duitku.errors.offline");
    case "INVALID_TRANSITION":
      return t("paymentAdmin.duitku.errors.invalidTransition");
    case "INTEGRATION_PROVIDER_NOT_AVAILABLE":
      return t("paymentAdmin.duitku.errors.providerUnavailable");
    default:
      return t("paymentAdmin.duitku.errors.generic");
  }
}

export function DuitkuCredentialsPanel() {
  const t = useT();
  const [outletId, setOutletId] = React.useState<string | null>(null);
  // One quick retry: a failing list reaches the error state in about a second.
  const integrations = useQuery({
    ...integrationsQuery(),
    retry: retryOnceOnServerError,
  });
  const outlets = useOutlets();
  const outletList = outlets.data?.data ?? [];
  const outletsState = duitkuOutletsState(outlets);
  const outletsReady = outletsState === "ready";
  // Outlet scope only exists while the list is usable.
  const activeOutletId = outletsReady ? outletId : null;
  const scope: DuitkuScope = { outletId: activeOutletId };

  if (integrations.isPending) return <DuitkuSkeleton />;
  if (integrations.isError) {
    return (
      <div className="rounded-container border-(length:--border-w) bg-card">
        <ErrorState
          title={t("paymentAdmin.duitku.loadErrorTitle")}
          description={t("paymentAdmin.duitku.loadErrorHint")}
          onRetry={() => void integrations.refetch()}
        />
      </div>
    );
  }

  const rows = integrations.data.data;
  const row = duitkuRowForScope(rows, scope);
  const inherited =
    activeOutletId !== null && row === null
      ? duitkuRowForScope(rows, { outletId: null })
      : null;

  return (
    <section
      aria-labelledby="duitku-title"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"
    >
      <div className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
        <div className="grid min-w-0 gap-1">
          <h2 id="duitku-title" className="type-title">
            {t("paymentAdmin.duitku.title")}
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("paymentAdmin.duitku.intro")}
          </p>
        </div>
        <div className="grid gap-3 sm:flex sm:flex-wrap sm:items-end">
          <div className="grid gap-1.5">
            <span className="text-sm leading-5 font-semibold">
              {t("paymentAdmin.duitku.scope")}
            </span>
            {/* Only the outlet option is disabled until outlets are ready. */}
            <SegmentedControl
              value={activeOutletId === null ? "brand" : "outlet"}
              label={t("paymentAdmin.duitku.scope")}
              onValueChange={(next) => {
                if (next === "brand") setOutletId(null);
                else if (outletsReady) setOutletId(outletList[0]?.id ?? null);
              }}
              options={[
                {
                  value: "brand",
                  label: t("paymentAdmin.duitku.scopeBrand"),
                },
                {
                  value: "outlet",
                  label: t("paymentAdmin.duitku.scopeOutlet"),
                  disabled: !outletsReady,
                },
              ]}
            />
          </div>
          {activeOutletId !== null && (
            <FormField
              label={t("paymentAdmin.duitku.outlet")}
              required
              className="sm:w-72"
            >
              <Select value={activeOutletId} onValueChange={setOutletId}>
                <SelectTrigger
                  className="w-full"
                  aria-label={t("paymentAdmin.duitku.outlet")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {outletList.map((outlet) => (
                    <SelectItem key={outlet.id} value={outlet.id}>
                      {outlet.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
        </div>
        {outletsState === "loading" && (
          <p role="status" className="text-sm leading-5 text-muted-foreground">
            {t("paymentAdmin.duitku.outletsLoading")}
          </p>
        )}
        {outletsState === "empty" && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("paymentAdmin.duitku.noOutlets")}
          </p>
        )}
        {outletsState === "error" && (
          <div className="flex flex-wrap items-center gap-2">
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {t("paymentAdmin.duitku.outletsError")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void outlets.refetch()}
            >
              {t("paymentAdmin.duitku.outletsRetry")}
            </Button>
          </div>
        )}
        {inherited && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("paymentAdmin.duitku.inherited")}
          </p>
        )}
      </div>

      {/* Remount per scope, row and credential generation so typed values never
          carry over. Not per `updatedAt`: a connection test stamps the row and
          must not wipe its own result or the user's input. */}
      <DuitkuForm key={duitkuFormKey(scope, row)} scope={scope} row={row} />
    </section>
  );
}

function DuitkuForm({
  scope,
  row,
}: {
  scope: DuitkuScope;
  row: TenantIntegration | null;
}) {
  const t = useT();
  const toast = useToast();
  const save = useSaveIntegration();
  const test = useTestIntegrationConnection();
  const activate = useSetIntegrationStatus();
  const buffer = React.useRef(createSecretBuffer());
  const [config, setConfig] = React.useState<DuitkuConfigDraft>(() =>
    duitkuConfigDraft(row),
  );
  // Credentials typed this session. Emptied on submit.
  const [typed, setTyped] = React.useState<
    Partial<Record<DuitkuCredentialField, string>>
  >({});
  const [errors, setErrors] = React.useState<DuitkuErrors>({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  // True when a failed save already emptied what the user typed.
  const [cleared, setCleared] = React.useState(false);
  const stored = row?.credentials !== null && row?.credentials !== undefined;

  const focusField = (name: string) => {
    if (typeof document === "undefined") return;
    document.getElementById(duitkuFieldId(name))?.focus();
  };
  /** Validate one field against the latest values (blur and live correction). */
  const checkField = (
    name: string,
    nextConfig: DuitkuConfigDraft,
    nextTyped: Partial<Record<DuitkuCredentialField, string>>,
  ) => {
    const found = validateDuitkuField(name, nextConfig, nextTyped, stored);
    setErrors((current) => {
      const next = { ...current };
      if (found) next[name] = found;
      else delete next[name];
      return next;
    });
  };
  const changeConfig = (patch: Partial<DuitkuConfigDraft>, name: string) => {
    const next = { ...config, ...patch };
    setConfig(next);
    if (errors[name]) checkField(name, next, typed);
  };
  const changeTyped = (name: DuitkuCredentialField, value: string) => {
    const next = { ...typed, [name]: value };
    setTyped(next);
    for (const field of DUITKU_CREDENTIAL_FIELDS) {
      const key = `credential:${field}`;
      if (errors[key]) checkField(key, config, next);
    }
  };

  // Leaving the form forgets anything typed or buffered.
  React.useEffect(() => {
    const held = buffer.current;
    return () => {
      held.take();
    };
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateDuitkuDraft(config, typed, stored);
    setErrors(found);
    const firstError = firstDuitkuErrorField(found);
    if (firstError) {
      focusField(firstError);
      return;
    }
    setServerError(null);
    setCleared(false);
    const secrets = duitkuTypedCredentials(typed);
    if (secrets) buffer.current.put(secrets);
    // Wipe the inputs before the request leaves.
    setTyped({});
    save.mutate(
      {
        input: buildDuitkuUpsertInput(scope, config),
        secrets: buffer.current,
      },
      {
        onSuccess: () =>
          toast({
            tone: "success",
            title: t("paymentAdmin.duitku.saved"),
          }),
        onError: (failure) => {
          setServerError(duitkuErrorMessage(failure, t));
          // The inputs were wiped before sending: say so, and put the cursor
          // on the first credential field to type them again.
          if (secrets) {
            setCleared(true);
            focusField(`credential:${DUITKU_CREDENTIAL_FIELDS[0]}`);
          }
        },
      },
    );
  };

  const runTest = () => {
    if (!row) return;
    test.reset();
    test.mutate(row.id);
  };

  const runActivate = () => {
    if (!row) return;
    activate.reset();
    activate.mutate({ integrationId: row.id, status: "active" });
  };

  const credentialLabel = (name: DuitkuCredentialField) =>
    t(
      name === "merchantCode"
        ? "paymentAdmin.duitku.fields.merchantCode"
        : "paymentAdmin.duitku.fields.apiKey",
    );
  const err = (name: string) => {
    const key = errors[name];
    return key ? t(key) : undefined;
  };

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <form
        className="grid min-w-0 content-start gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline"
        onSubmit={submit}
        noValidate
        aria-label={t("paymentAdmin.duitku.title")}
      >
        <FormField
          id={duitkuFieldId("environment")}
          label={t("paymentAdmin.duitku.fields.environment")}
          error={err("environment")}
          required
        >
          <Select
            value={config.environment}
            onValueChange={(value) =>
              changeConfig(
                { environment: value as DuitkuConfigDraft["environment"] },
                "environment",
              )
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue
                placeholder={t(
                  "paymentAdmin.duitku.fields.environmentPlaceholder",
                )}
              />
            </SelectTrigger>
            <SelectContent>
              {DUITKU_ENVIRONMENTS.map((environment) => (
                <SelectItem key={environment} value={environment}>
                  {t(
                    environment === "sandbox"
                      ? "paymentAdmin.duitku.fields.environmentSandbox"
                      : "paymentAdmin.duitku.fields.environmentProduction",
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField
          id={duitkuFieldId("notificationEmail")}
          label={t("paymentAdmin.duitku.fields.notificationEmail")}
          hint={t("paymentAdmin.duitku.fields.notificationEmailHint")}
          error={err("notificationEmail")}
          required
        >
          <Input
            type="email"
            inputMode="email"
            autoComplete="off"
            maxLength={254}
            value={config.notificationEmail}
            onChange={(event) =>
              changeConfig(
                { notificationEmail: event.target.value },
                "notificationEmail",
              )
            }
            onBlur={() => checkField("notificationEmail", config, typed)}
          />
        </FormField>
        <FormField
          id={duitkuFieldId("vaName")}
          label={t("paymentAdmin.duitku.fields.vaName")}
          hint={t("paymentAdmin.duitku.fields.vaNameHint")}
          error={err("vaName")}
        >
          <Input
            autoComplete="off"
            maxLength={VA_NAME_MAX}
            value={config.vaName}
            onChange={(event) =>
              changeConfig({ vaName: event.target.value }, "vaName")
            }
            onBlur={() => checkField("vaName", config, typed)}
          />
        </FormField>

        <fieldset className="grid gap-3 rounded-container border-(length:--border-w) bg-surface-2 p-card">
          <legend className="flex items-center gap-1.5 px-1 text-sm font-semibold">
            <LockKeyhole className="size-4" aria-hidden="true" />
            {t("paymentAdmin.duitku.credentials.title")}
          </legend>
          <p className="text-sm leading-5 text-muted-foreground">
            {stored
              ? t("paymentAdmin.duitku.credentials.storedHint")
              : t("paymentAdmin.duitku.credentials.newHint")}
          </p>
          {stored && (
            <ul className="flex flex-wrap gap-2">
              {DUITKU_CREDENTIAL_FIELDS.map((name) => (
                <li key={name}>
                  <Badge tone="success">
                    {credentialLabel(name)}
                    <span aria-hidden="true">{CREDENTIAL_MASK}</span>
                    <span className="sr-only">
                      {t("paymentAdmin.duitku.credentials.storedSr")}
                    </span>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {DUITKU_CREDENTIAL_FIELDS.map((name) => (
            <FormField
              key={name}
              id={duitkuFieldId(`credential:${name}`)}
              label={
                stored
                  ? t("paymentAdmin.duitku.credentials.replaceLabel", {
                      field: credentialLabel(name),
                    })
                  : credentialLabel(name)
              }
              error={err(`credential:${name}`)}
              required={!stored}
            >
              <Input
                type="password"
                name={`credential-${name}`}
                value={typed[name] ?? ""}
                onChange={(event) => changeTyped(name, event.target.value)}
                onBlur={() => checkField(`credential:${name}`, config, typed)}
                autoComplete="new-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={stored ? CREDENTIAL_MASK : undefined}
                maxLength={4096}
              />
            </FormField>
          ))}
        </fieldset>

        {serverError && (
          <div
            role="alert"
            className="grid gap-1 text-sm leading-5 font-medium text-danger"
          >
            <p>{serverError}</p>
            {cleared && <p>{t("paymentAdmin.duitku.saveClearedNotice")}</p>}
          </div>
        )}
        <Button
          type="submit"
          loading={save.isPending}
          className="w-full sm:w-fit"
        >
          {t("paymentAdmin.duitku.save")}
        </Button>
      </form>

      <div className="grid min-w-0 content-start gap-4">
        <StatusCard row={row} />
        {duitkuNeedsActivation(row) ? (
          <ActivationNote
            row={row}
            activate={activate}
            onActivate={runActivate}
          />
        ) : (
          <ActiveCard activate={activate} />
        )}
        <TestCard row={row} test={test} onRun={runTest} />
      </div>
    </div>
  );
}

function StatusCard({ row }: { row: TenantIntegration | null }) {
  const t = useT();
  const view = duitkuStatusView(row);
  const band = {
    not_configured: {
      tone: "neutral",
      icon: CircleDashed,
      label: t("paymentAdmin.duitku.status.notConfigured"),
    },
    saved: {
      tone: "info",
      icon: LockKeyhole,
      label: t("paymentAdmin.duitku.status.saved"),
    },
    tested_ok: {
      tone: "success",
      icon: CircleCheck,
      label: t("paymentAdmin.duitku.status.testedOk"),
    },
    tested_error: {
      tone: "danger",
      icon: CircleAlert,
      label: t("paymentAdmin.duitku.status.testedError"),
    },
  } as const;
  const current = band[view];
  return (
    <div className="overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
      <StatusBand
        tone={current.tone}
        icon={current.icon}
        label={current.label}
        aside={
          <span className="text-xs leading-5">
            {t("paymentAdmin.duitku.status.label")}
          </span>
        }
      >
        <p className="type-title" translate="no">
          {t("paymentAdmin.duitku.providerName")}
        </p>
      </StatusBand>
      {row?.lastCheckedAt && (
        <div className="grid gap-1 p-card text-sm leading-5">
          <p>
            {t("paymentAdmin.duitku.status.lastTested", {
              time: formatMoment(row.lastCheckedAt),
            })}
          </p>
          {row.lastErrorCode && (
            <p className="text-danger">
              {t("paymentAdmin.duitku.status.lastError", {
                code: row.lastErrorCode,
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TestCard({
  row,
  test,
  onRun,
}: {
  row: TenantIntegration | null;
  test: ReturnType<typeof useTestIntegrationConnection>;
  onRun: () => void;
}) {
  const t = useT();
  const result = test.data?.data;
  const methodLabel = (code: string) => {
    const key = duitkuMethodLabelKey(code);
    return key ? t(key) : code;
  };
  const failure =
    result && !result.ok ? duitkuTestFailureKeys(result.errorCode) : null;
  return (
    <div className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
      <Button
        type="button"
        variant="outline"
        onClick={onRun}
        disabled={row === null}
        loading={test.isPending}
        className="w-full sm:w-fit"
      >
        <PlugZap aria-hidden="true" />
        {t("paymentAdmin.duitku.test.action")}
      </Button>
      {row === null && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("paymentAdmin.duitku.test.needSave")}
        </p>
      )}
      <div aria-live="polite" className="grid gap-3">
        {test.isPending && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("paymentAdmin.duitku.test.running")}
          </p>
        )}
        {test.isError && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {duitkuErrorMessage(test.error, t)}
          </p>
        )}
        {result && (
          <div className="grid gap-2">
            <p
              className={
                result.ok
                  ? "flex items-center gap-1.5 text-sm font-semibold text-success"
                  : "flex items-center gap-1.5 text-sm font-semibold text-danger"
              }
            >
              {result.ok ? (
                <CircleCheck className="size-4" aria-hidden="true" />
              ) : (
                <CircleAlert className="size-4" aria-hidden="true" />
              )}
              {result.ok
                ? t("paymentAdmin.duitku.test.ok")
                : t("paymentAdmin.duitku.test.failed")}
            </p>
            {failure && (
              <div className="grid gap-1 text-sm leading-5">
                <p className="font-medium">{t(failure.cause)}</p>
                <p className="text-muted-foreground">{t(failure.advice)}</p>
              </div>
            )}
            {result.errorCode && (
              <p className="text-sm leading-5">
                {t("paymentAdmin.duitku.test.errorCode", {
                  code: result.errorCode,
                })}
              </p>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              {t("paymentAdmin.duitku.test.checkedAt", {
                time: formatMoment(result.checkedAt),
              })}
            </p>
            <h3 className="text-sm leading-5 font-semibold">
              {t("paymentAdmin.duitku.test.methodsTitle")}
            </h3>
            {result.methods.length === 0 ? (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("paymentAdmin.duitku.test.methodsEmpty")}
              </p>
            ) : (
              <ul className="grid gap-1.5">
                {result.methods.map((method) => (
                  <li
                    key={method.method}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm leading-5"
                  >
                    <span className="min-w-0 break-words">
                      {methodLabel(method.method)}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {t("paymentAdmin.duitku.test.channelCount", {
                          count: method.channelCount,
                        })}
                      </span>
                      <Badge tone={method.enabled ? "success" : "neutral"}>
                        {method.enabled
                          ? t("paymentAdmin.duitku.test.methodEnabled")
                          : t("paymentAdmin.duitku.test.methodDisabled")}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A row routing cannot use yet is draft: activate it here once a test passed. */
function ActivationNote({
  row,
  activate,
  onActivate,
}: {
  row: TenantIntegration | null;
  activate: ReturnType<typeof useSetIntegrationStatus>;
  onActivate: () => void;
}) {
  const t = useT();
  const state = duitkuActivation(row);
  const blockedKey =
    state.kind === "blocked"
      ? state.reason === "notTested"
        ? "paymentAdmin.duitku.activation.needTest"
        : "paymentAdmin.duitku.activation.testFailed"
      : null;
  return (
    <div className="grid gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-card text-sm leading-5">
      <p>
        {row === null
          ? t("paymentAdmin.duitku.activation.newHint")
          : t("paymentAdmin.duitku.activation.pendingHint")}
      </p>
      {state.kind !== "none" && (
        <div className="grid gap-2">
          <Button
            type="button"
            onClick={onActivate}
            disabled={state.kind !== "ready"}
            loading={activate.isPending}
            className="w-full sm:w-fit"
          >
            {t("paymentAdmin.duitku.activation.action")}
          </Button>
          {blockedKey && (
            <p className="text-muted-foreground">{t(blockedKey)}</p>
          )}
          {state.kind === "ready" && !activate.isPending && (
            <p className="text-muted-foreground">
              {t("paymentAdmin.duitku.activation.readyHint")}
            </p>
          )}
        </div>
      )}
      <div aria-live="polite">
        {activate.isPending && (
          <p className="text-muted-foreground">
            {t("paymentAdmin.duitku.activation.running")}
          </p>
        )}
        {activate.isError && (
          <p role="alert" className="font-medium text-danger">
            {duitkuErrorMessage(activate.error, t)}
          </p>
        )}
      </div>
      <a
        href="/kelola/pengaturan/integrasi"
        className="w-fit font-semibold text-primary underline underline-offset-2"
      >
        {t("paymentAdmin.duitku.activation.link")}
      </a>
    </div>
  );
}

/** Shown once the row is active: replaces the draft hint. */
function ActiveCard({
  activate,
}: {
  activate: ReturnType<typeof useSetIntegrationStatus>;
}) {
  const t = useT();
  return (
    <div className="grid gap-2 rounded-container border-(length:--border-w) bg-surface-2 p-card text-sm leading-5">
      <div className="flex items-center gap-2">
        <Badge tone="success">
          {t("paymentAdmin.duitku.activation.activeLabel")}
        </Badge>
      </div>
      <p role={activate.isSuccess ? "status" : undefined}>
        {t("paymentAdmin.duitku.activation.done")}
      </p>
    </div>
  );
}

/** Shaped like the loaded screen (header card ~196px mobile, ~156px desktop): form fields, status and test. */
function DuitkuSkeleton() {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-4" aria-busy="true">
      <span role="status" className="sr-only">
        {t("paymentAdmin.duitku.loading")}
      </span>
      <Skeleton className="h-49 sm:h-39" />
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-4 rounded-container border-(length:--border-w) bg-card p-card">
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
          <Skeleton className="h-36" />
          <Skeleton className="h-10 w-40" />
        </div>
        <div className="grid content-start gap-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-32" />
        </div>
      </div>
    </div>
  );
}
