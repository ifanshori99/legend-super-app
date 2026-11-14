// Card 2 "Model kustom": base URL, API key and model name, saved and then
// tested in one press (useSaveProvider, then useTestProvider). Below it the
// detected capabilities and the admin override. The API key is never shown
// back: only its last 4 characters.
import * as React from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { cn } from "cn";
import type { MessageKey } from "@starter/shared/i18n";
import { formatNumber } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { fieldClass, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AdminCard,
  isOfflineError,
  saveErrorText,
  serverFieldErrors,
} from "@/features/ws12-ai-admin/components/shared";
import type {
  AiModelCapabilities,
  AiModelCapabilityOverrides,
  AiProviderConfig,
  AiProviderTestErrorCode,
  UpsertAiProviderConfigInput,
} from "@starter/shared/ai";
import {
  usePatchProviderCapabilities,
  useChatgptLogin,
  useProvider,
  useSaveProvider,
  useTestProvider,
} from "../hooks";

type Field = "baseUrl" | "apiKey" | "model";
type FieldErrors = Partial<Record<Field, MessageKey>>;
type Draft = Record<Field, string>;

const CONTEXT_MIN = 1024;
const CONTEXT_MAX = 2_000_000;
const OUTPUT_MIN = 1;
const OUTPUT_MAX = 200_000;
const KEY_MIN = 16;
const MODEL_PATTERN = /^[\w.:/@+-]+$/;
const WHOLE_NUMBER = /^\d{1,15}$/;
const CONTEXT_FIELD_ID = "ai-caps-context";

function isHttpsUrl(text: string): boolean {
  if (text.length > 500) return false;
  try {
    return new URL(text).protocol === "https:";
  } catch {
    return false;
  }
}

/** Same rules as upsertAiProviderConfigInputSchema; the API checks again. */
function validateFields(
  draft: Draft,
  saved: AiProviderConfig | null,
): FieldErrors {
  const errors: FieldErrors = {};
  const url = draft.baseUrl.trim();
  const key = draft.apiKey.trim();
  const model = draft.model.trim();
  const urlOk = isHttpsUrl(url);
  if (!urlOk) errors.baseUrl = "aiSettingsCustom.custom.urlError";
  // The stored key can only stay while the address is unchanged.
  const needsKey = saved === null || !saved.hasKey || url !== saved.baseUrl;
  if (key === "") {
    if (needsKey)
      errors.apiKey =
        saved?.hasKey && urlOk
          ? "aiSettingsCustom.custom.keyChanged"
          : "aiSettingsCustom.custom.keyRequired";
  } else if (key.length < KEY_MIN || key.length > 500 || /\s/.test(key)) {
    errors.apiKey = "aiSettingsCustom.custom.keyInvalid";
  }
  if (model === "") errors.model = "aiSettingsCustom.custom.modelRequired";
  else if (model.length > 200 || !MODEL_PATTERN.test(model))
    errors.model = "aiSettingsCustom.custom.modelInvalid";
  return errors;
}

type Outcome =
  | { kind: "ok" }
  | { kind: "failed"; code: AiProviderTestErrorCode | null }
  | { kind: "save"; error: unknown }
  | { kind: "unreachable" };

export function CustomModelPanel({ locked = false }: { locked?: boolean }) {
  const t = useT();
  const provider = useProvider();

  if (provider.isPending) return <PanelSkeleton />;
  if (!provider.data) {
    const offline = isOfflineError(provider.error);
    return (
      <AdminCard aria-labelledby="ai-custom-title">
        <h2 id="ai-custom-title" className="type-title">
          {t("aiSettingsCustom.custom.title")}
        </h2>
        <ErrorState
          error={provider.error}
          title={t(
            offline
              ? "aiAdmin.error.offlineTitle"
              : "aiSettingsCustom.custom.errorTitle",
          )}
          description={t(
            offline
              ? "aiAdmin.error.offlineHint"
              : "aiSettingsCustom.custom.errorHint",
          )}
          onRetry={() => void provider.refetch()}
        />
      </AdminCard>
    );
  }

  const stored = provider.data.data.config;
  // The ChatGPT login is its own card; only an API-key setup is "custom".
  const config = stored?.connectionType === "api_key" ? stored : null;
  return (
    <CustomCard
      config={config}
      refreshFailed={provider.isError}
      locked={locked}
    />
  );
}

function CustomCard({
  config,
  refreshFailed,
  locked,
}: {
  config: AiProviderConfig | null;
  refreshFailed: boolean;
  locked: boolean;
}) {
  const t = useT();
  const save = useSaveProvider();
  const test = useTestProvider();
  const chatgptConnected = useChatgptLogin().data?.data.state === "connected";
  const formRef = React.useRef<HTMLFormElement>(null);
  const [draft, setDraft] = React.useState<Draft>({
    baseUrl: config?.baseUrl ?? "",
    apiKey: "",
    model: config?.defaultModel ?? "",
  });
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [serverErrors, setServerErrors] = React.useState<
    Partial<Record<Field, string>>
  >({});
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  const busy = save.isPending || test.isPending;

  const set =
    (field: Field) => (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = { ...draft, [field]: event.target.value };
      setDraft(next);
      setOutcome(null);
      // The "address changed" key error goes away once the address is restored.
      if (field === "baseUrl" && errors.apiKey !== undefined) {
        const kind = validateFields(next, config).apiKey;
        setErrors((current) => {
          const rest = { ...current };
          if (kind === undefined) delete rest.apiKey;
          else rest.apiKey = kind;
          return rest;
        });
      }
    };

  // Blur checks one field. Focus moving to a button skips it: a new error line
  // would push the button away before the click lands (submit checks all).
  const blur =
    (field: Field) => (event: React.FocusEvent<HTMLInputElement>) => {
      if (event.relatedTarget instanceof HTMLButtonElement) return;
      const found = validateFields(
        { ...draft, [field]: event.target.value },
        config,
      );
      const kind = found[field];
      setErrors((current) => {
        const next = { ...current };
        if (kind === undefined) delete next[field];
        else next[field] = kind;
        return next;
      });
    };

  const fieldProps = (field: Field) => ({
    name: field,
    value: draft[field],
    onChange: set(field),
    onBlur: blur(field),
    spellCheck: false,
    disabled: locked,
  });

  const message = (field: Field): string | undefined => {
    const kind = errors[field];
    return kind === undefined ? serverErrors[field] : t(kind);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || locked) return;
    setServerErrors({});
    setOutcome(null);
    const found = validateFields(draft, config);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      const first = (["baseUrl", "apiKey", "model"] as const).find(
        (field) => found[field],
      );
      const control = first && formRef.current?.elements.namedItem(first);
      if (control instanceof HTMLElement) control.focus();
      return;
    }
    setErrors({});
    const key = draft.apiKey.trim();
    const body: UpsertAiProviderConfigInput = {
      connectionType: "api_key",
      baseUrl: draft.baseUrl.trim(),
      defaultModel: draft.model.trim(),
      ...(key === "" ? {} : { apiKey: key }),
    };
    try {
      await save.mutateAsync(body);
      save.reset();
    } catch (error) {
      const fields = serverFieldErrors(error);
      setServerErrors({
        baseUrl: fields.baseUrl,
        apiKey: fields.apiKey,
        model: fields.defaultModel,
      });
      setOutcome({ kind: "save", error });
      return;
    }
    // The key now lives on the server; do not keep it in the browser.
    setDraft((current) => ({ ...current, apiKey: "" }));
    try {
      const result = (await test.mutateAsync()).data;
      setOutcome(
        result.status === "ok"
          ? { kind: "ok" }
          : { kind: "failed", code: result.errorCode },
      );
    } catch {
      setOutcome({ kind: "unreachable" });
    }
  };

  const last = config?.lastTest ?? null;
  const shown: Outcome | null =
    outcome ??
    (last === null
      ? null
      : last.status === "ok"
        ? { kind: "ok" }
        : { kind: "failed", code: last.errorCode });
  const tested = last?.status === "ok";
  const failedBefore = last?.status === "failed";

  return (
    <AdminCard aria-labelledby="ai-custom-title" aria-busy={busy || undefined}>
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="type-eyebrow text-muted-foreground">
            {t("aiSettingsCustom.custom.eyebrow")}
          </p>
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="grid size-7 shrink-0 place-items-center rounded-control border-(length:--border-w) border-border text-sm font-semibold"
            >
              {t("aiSettingsCustom.custom.step")}
            </span>
            <h2 id="ai-custom-title" className="type-title">
              {t("aiSettingsCustom.custom.title")}
            </h2>
          </div>
        </div>
        {tested ? (
          <Badge tone="success">
            <CircleCheck aria-hidden="true" />
            {t("aiSettingsCustom.custom.badgeTested")}
          </Badge>
        ) : failedBefore ? (
          <Badge tone="danger">
            <CircleAlert aria-hidden="true" />
            {t("aiSettingsCustom.custom.badgeFailed")}
          </Badge>
        ) : (
          <Badge>{t("aiSettingsCustom.custom.badgeNotSet")}</Badge>
        )}
      </div>

      <div className="grid min-w-0 gap-4">
        <p className="text-base leading-6 text-muted-foreground">
          {t("aiSettingsCustom.custom.description")}
        </p>
        {refreshFailed && (
          <p
            role="status"
            className="text-sm leading-5 font-medium text-warning"
          >
            {t("aiSettingsCustom.custom.refreshError")}
          </p>
        )}

        <form
          ref={formRef}
          onSubmit={(event) => void submit(event)}
          noValidate
          className="grid gap-4 [&_[id$='-hint']]:text-xs [&_[id$='-hint']]:leading-4 [&_label]:font-semibold"
        >
          <FormField
            label={t("aiSettingsCustom.custom.urlLabel")}
            hint={t("aiSettingsCustom.custom.urlHint")}
            error={message("baseUrl")}
            required
          >
            <Input
              {...fieldProps("baseUrl")}
              type="url"
              autoComplete="off"
              inputMode="url"
              placeholder={t("aiSettingsCustom.custom.urlPlaceholder")}
            />
          </FormField>

          <div className="grid gap-1.5">
            <FormField
              label={t("aiSettingsCustom.custom.keyLabel")}
              hint={t("aiSettingsCustom.custom.keyHint")}
              error={message("apiKey")}
              required={!config?.hasKey}
            >
              <Input
                {...fieldProps("apiKey")}
                type="password"
                autoComplete="new-password"
                placeholder={t(
                  config?.hasKey
                    ? "aiSettingsCustom.custom.keyPlaceholderSaved"
                    : "aiSettingsCustom.custom.keyPlaceholderNew",
                )}
              />
            </FormField>
            {config?.hasKey && config.keyLast4 !== null && (
              <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm leading-5 text-muted-foreground">
                <span>{t("aiSettingsCustom.custom.keySaved")}</span>
                <strong className="font-mono font-semibold text-foreground">
                  <span aria-hidden="true">••••</span> {config.keyLast4}
                </strong>
                <span>{t("aiSettingsCustom.custom.keySavedHint")}</span>
              </p>
            )}
          </div>

          <FormField
            label={t("aiSettingsCustom.custom.modelLabel")}
            error={message("model")}
            required
          >
            <Input
              {...fieldProps("model")}
              autoComplete="off"
              placeholder={t("aiSettingsCustom.custom.modelPlaceholder")}
            />
          </FormField>

          <div className="grid gap-1.5">
            <Button
              type="submit"
              variant={
                locked ? "secondary" : chatgptConnected ? "default" : "outline"
              }
              loading={busy}
              disabled={locked}
              className="w-full sm:w-auto"
            >
              {busy
                ? t("aiSettingsCustom.custom.testing")
                : t(
                    last === null
                      ? "aiSettingsCustom.custom.test"
                      : "aiSettingsCustom.custom.retest",
                  )}
            </Button>
            <p className="text-xs leading-4 text-muted-foreground">
              {t("aiSettingsCustom.custom.testNote")}
            </p>
          </div>
          <div role="status" aria-live="polite">
            {!busy && shown?.kind === "ok" && <Feedback outcome={shown} />}
          </div>
          {!busy && shown !== null && shown.kind !== "ok" && (
            <Feedback outcome={shown} />
          )}
        </form>

        {config !== null && (
          <CapabilitiesBlock config={config} locked={locked} />
        )}
      </div>
    </AdminCard>
  );
}

function Feedback({ outcome }: { outcome: Outcome }) {
  const t = useT();
  if (outcome.kind === "save")
    return (
      <p role="alert" className="text-sm leading-5 font-medium text-danger">
        {saveErrorText(t, outcome.error)}
      </p>
    );
  if (outcome.kind === "ok")
    return (
      <p className="flex items-start gap-1.5 text-sm leading-5 font-medium text-success">
        <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("aiSettingsCustom.custom.testOk")}
      </p>
    );
  const text =
    outcome.kind === "unreachable"
      ? t("aiSettingsCustom.custom.testUnreachable")
      : outcome.code === null
        ? t("aiSettingsCustom.custom.testFailedNoReason")
        : t("aiSettingsCustom.custom.testFailed", {
            reason: t(
              `aiSettingsCustom.testError.${outcome.code}` as MessageKey,
            ),
          });
  return (
    <p
      role="alert"
      className="flex items-start gap-1.5 text-sm leading-5 font-medium text-danger"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {text}
    </p>
  );
}

function CapabilitiesBlock({
  config,
  locked,
}: {
  config: AiProviderConfig;
  locked: boolean;
}) {
  const t = useT();
  const caps: AiModelCapabilities = config.capabilities;
  const yesNo = (value: boolean) =>
    t(
      value
        ? "aiSettingsCustom.caps.supported"
        : "aiSettingsCustom.caps.unsupported",
    );
  return (
    <section
      aria-labelledby="ai-caps-title"
      className="grid gap-3 border-t border-border pt-4"
    >
      <h3 id="ai-caps-title" className="text-base leading-6 font-semibold">
        {t("aiSettingsCustom.caps.title")}
      </h3>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("aiSettingsCustom.caps.description")}
      </p>
      {config.capabilityOverrides !== null && (
        <p className="text-sm leading-5 font-medium">
          {t("aiSettingsCustom.caps.edited")}
        </p>
      )}
      <dl className="grid gap-x-6 sm:grid-cols-2">
        <Capability label={t("aiSettingsCustom.caps.context")}>
          {formatNumber(caps.contextWindow)}{" "}
          <small className="text-sm font-normal">
            {t("aiSettingsCustom.caps.tokenUnit")}
          </small>
        </Capability>
        <Capability label={t("aiSettingsCustom.caps.output")}>
          {formatNumber(caps.maxOutputTokens)}{" "}
          <small className="text-sm font-normal">
            {t("aiSettingsCustom.caps.tokenUnit")}
          </small>
        </Capability>
        <Capability label={t("aiSettingsCustom.caps.tools")}>
          {yesNo(caps.supportsTools)}
        </Capability>
        <Capability label={t("aiSettingsCustom.caps.reasoning")}>
          {yesNo(caps.supportsReasoning)}
        </Capability>
      </dl>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("aiSettingsCustom.caps.note")}
      </p>
      <CapabilityEditor config={config} locked={locked} />
    </section>
  );
}

function Capability({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-0.5 border-b border-border py-2.5">
      <dt className="text-sm leading-5 text-muted-foreground">{label}</dt>
      <dd className="m-0 text-base leading-6 font-semibold tabular">
        {children}
      </dd>
    </div>
  );
}

type CapsDraft = {
  context: string;
  output: string;
  tools: "yes" | "no";
  reasoning: "yes" | "no";
};

function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!WHOLE_NUMBER.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function rangeOk(draft: Pick<CapsDraft, "context" | "output">): boolean {
  const context = wholeNumber(draft.context);
  const output = wholeNumber(draft.output);
  return (
    context !== null &&
    output !== null &&
    context >= CONTEXT_MIN &&
    context <= CONTEXT_MAX &&
    output >= OUTPUT_MIN &&
    output <= OUTPUT_MAX &&
    output < context
  );
}

function draftFrom(caps: AiModelCapabilities): CapsDraft {
  return {
    context: String(caps.contextWindow),
    output: String(caps.maxOutputTokens),
    tools: caps.supportsTools ? "yes" : "no",
    reasoning: caps.supportsReasoning ? "yes" : "no",
  };
}

/** "Ubah kemampuan model": PATCHes only the changed override fields; the server merges. */
function CapabilityEditor({
  config,
  locked,
}: {
  config: AiProviderConfig;
  locked: boolean;
}) {
  const t = useT();
  const save = usePatchProviderCapabilities();
  const current: AiModelCapabilities = {
    ...config.capabilities,
    ...config.capabilityOverrides,
  };
  const [draft, setDraft] = React.useState<CapsDraft>(() => draftFrom(current));
  const [dirty, setDirty] = React.useState(false);
  const [syncedAt, setSyncedAt] = React.useState(config.updatedAt);
  const [invalid, setInvalid] = React.useState(false);
  const [saved, setSaved] = React.useState<"saved" | "reset" | null>(null);
  const contextRef = React.useRef<HTMLInputElement>(null);

  // A newer server copy replaces the form only while nobody is typing in it.
  if (syncedAt !== config.updatedAt) {
    setSyncedAt(config.updatedAt);
    if (!dirty) setDraft(draftFrom(current));
  }

  const change =
    (field: keyof CapsDraft) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setSaved(null);
      setDirty(true);
      setDraft((state) => ({ ...state, [field]: event.target.value }));
    };
  const check = (event: React.FocusEvent) => {
    if (event.relatedTarget instanceof HTMLButtonElement) return;
    setInvalid(!rangeOk(draft));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (save.isPending || locked) return;
    setSaved(null);
    if (!rangeOk(draft)) {
      setInvalid(true);
      contextRef.current?.focus();
      return;
    }
    setInvalid(false);
    const next = {
      contextWindow: Number(draft.context.trim()),
      maxOutputTokens: Number(draft.output.trim()),
      supportsTools: draft.tools === "yes",
      supportsReasoning: draft.reasoning === "yes",
    };
    // Only what the admin changed against the form's shown state is sent; the
    // server merges it by field, so stale stored overrides are never re-sent.
    const changed: AiModelCapabilityOverrides = {
      ...(next.contextWindow !== current.contextWindow && {
        contextWindow: next.contextWindow,
      }),
      ...(next.maxOutputTokens !== current.maxOutputTokens && {
        maxOutputTokens: next.maxOutputTokens,
      }),
      ...(next.supportsTools !== current.supportsTools && {
        supportsTools: next.supportsTools,
      }),
      ...(next.supportsReasoning !== current.supportsReasoning && {
        supportsReasoning: next.supportsReasoning,
      }),
    };
    if (Object.keys(changed).length === 0) {
      setDirty(false);
      setSaved("saved");
      return;
    }
    try {
      await save.mutateAsync(changed);
      save.reset();
      setDirty(false);
      setSaved("saved");
    } catch {
      // The error shows from save.error below.
    }
  };

  const restore = async () => {
    if (save.isPending || locked) return;
    setSaved(null);
    setInvalid(false);
    try {
      await save.mutateAsync(null);
      save.reset();
      setDraft(draftFrom(config.capabilities));
      setDirty(false);
      setSaved("reset");
    } catch {
      // The error shows from save.error below.
    }
  };

  const rangeError = invalid
    ? t("aiSettingsCustom.caps.rangeError", {
        contextMin: formatNumber(CONTEXT_MIN),
        contextMax: formatNumber(CONTEXT_MAX),
        outputMin: formatNumber(OUTPUT_MIN),
        outputMax: formatNumber(OUTPUT_MAX),
      })
    : undefined;

  return (
    <details className="group grid gap-3">
      <summary className="inline-flex min-h-11 w-fit cursor-pointer items-center text-base leading-6 font-semibold text-primary select-none focus-visible:rounded-control focus-visible:shadow-focus focus-visible:outline-none">
        {t("aiSettingsCustom.caps.editSummary")}
      </summary>
      <form
        onSubmit={(event) => void submit(event)}
        noValidate
        className="grid gap-4 pt-1"
      >
        <p className="text-sm leading-5 text-muted-foreground">
          {t("aiSettingsCustom.caps.editHint")}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id={CONTEXT_FIELD_ID}
            label={t("aiSettingsCustom.caps.editContext")}
            error={rangeError}
            required
          >
            <Input
              ref={contextRef}
              name="context"
              inputMode="numeric"
              autoComplete="off"
              value={draft.context}
              onChange={change("context")}
              onBlur={check}
              disabled={locked}
            />
          </FormField>
          <FormField label={t("aiSettingsCustom.caps.editOutput")} required>
            <Input
              name="output"
              inputMode="numeric"
              autoComplete="off"
              value={draft.output}
              onChange={change("output")}
              onBlur={check}
              disabled={locked}
              aria-invalid={invalid || undefined}
              aria-describedby={
                invalid ? `${CONTEXT_FIELD_ID}-error` : undefined
              }
            />
          </FormField>
          <FormField label={t("aiSettingsCustom.caps.editTools")} required>
            <select
              name="tools"
              value={draft.tools}
              onChange={change("tools")}
              disabled={locked}
              className={cn(fieldClass, "h-control px-3")}
            >
              <option value="yes">
                {t("aiSettingsCustom.caps.supported")}
              </option>
              <option value="no">
                {t("aiSettingsCustom.caps.unsupported")}
              </option>
            </select>
          </FormField>
          <FormField label={t("aiSettingsCustom.caps.editReasoning")} required>
            <select
              name="reasoning"
              value={draft.reasoning}
              onChange={change("reasoning")}
              disabled={locked}
              className={cn(fieldClass, "h-control px-3")}
            >
              <option value="yes">
                {t("aiSettingsCustom.caps.supported")}
              </option>
              <option value="no">
                {t("aiSettingsCustom.caps.unsupported")}
              </option>
            </select>
          </FormField>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="outline"
            loading={save.isPending}
            disabled={locked}
          >
            {t("aiSettingsCustom.caps.save")}
          </Button>
          {config.capabilityOverrides !== null && (
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending || locked}
              onClick={() => void restore()}
            >
              {t("aiSettingsCustom.caps.reset")}
            </Button>
          )}
        </div>
        <div role="status" aria-live="polite">
          {saved !== null && (
            <p className="flex items-start gap-1.5 text-sm leading-5 font-medium text-success">
              <CircleCheck
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {t(
                saved === "reset"
                  ? "aiSettingsCustom.caps.resetDone"
                  : "aiSettingsCustom.caps.saved",
              )}
            </p>
          )}
        </div>
        {save.isError && (
          <p role="alert" className="text-sm leading-5 font-medium text-danger">
            {saveErrorText(t, save.error)}
          </p>
        )}
      </form>
    </details>
  );
}

function PanelSkeleton() {
  const t = useT();
  return (
    <AdminCard
      aria-busy="true"
      aria-label={t("aiSettingsCustom.custom.loading")}
    >
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-36" />
    </AdminCard>
  );
}
