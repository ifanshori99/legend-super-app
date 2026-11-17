// Pure rules of the Duitku credentials form (sub-302 D15-D16). Credentials are
// write-only: a stored row says WHICH fields are set, never their values, and
// a replacement is all-or-nothing (merchantCode + apiKey) because the API
// replaces the sealed blob as a whole. Free of React and the `@/` alias so root
// tests load it with Node type stripping.
import type { MessageKey } from "@starter/shared/i18n";
import {
  GATEWAY_CREDENTIAL_SPECS,
  type IntegrationConnectionTest,
  type TenantIntegration,
  type UpsertIntegrationInput,
} from "@starter/shared/platform";
import { paymentMethodSchema } from "@starter/shared/payment";
import { rowForScope } from "../ws01-tenant-settings/integrations-lib.ts";
import { methodLabelKey } from "./format.ts";

export const DUITKU_ENVIRONMENTS =
  GATEWAY_CREDENTIAL_SPECS.duitku.config.environment;
export type DuitkuEnvironment = (typeof DUITKU_ENVIRONMENTS)[number];

/** Only these two names may ever be typed into the secret buffer. */
export const DUITKU_CREDENTIAL_FIELDS =
  GATEWAY_CREDENTIAL_SPECS.duitku.credentials;
export type DuitkuCredentialField = (typeof DUITKU_CREDENTIAL_FIELDS)[number];

export const VA_NAME_MAX =
  GATEWAY_CREDENTIAL_SPECS.duitku.config.vaName.maxLength;
const EMAIL_MAX = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type DuitkuScope = { outletId: string | null };

export type DuitkuConfigDraft = {
  environment: DuitkuEnvironment | "";
  notificationEmail: string;
  vaName: string;
};

export type DuitkuErrors = Record<string, MessageKey>;

/** The stored Duitku row for exactly this scope (brand-wide or one outlet). */
export function duitkuRowForScope(
  rows: readonly TenantIntegration[],
  scope: DuitkuScope,
): TenantIntegration | null {
  return rowForScope(rows, "duitku", scope);
}

/** Form values: the stored row's public config, else empty (no default env). */
export function duitkuConfigDraft(
  row: TenantIntegration | null,
): DuitkuConfigDraft {
  const environment = row?.config.environment;
  const email = row?.config.notificationEmail;
  const vaName = row?.config.vaName;
  return {
    environment:
      environment === "sandbox" || environment === "production"
        ? environment
        : "",
    notificationEmail: typeof email === "string" ? email : "",
    vaName: typeof vaName === "string" ? vaName : "",
  };
}

/**
 * Field-level validation. `typed` is what the user typed this session; with a
 * stored credential set the credentials may stay blank (keep), otherwise both
 * are required, and typing one demands the other.
 */
export function validateDuitkuDraft(
  config: DuitkuConfigDraft,
  typed: Partial<Record<DuitkuCredentialField, string>>,
  hasStoredCredentials: boolean,
): DuitkuErrors {
  const errors: DuitkuErrors = {};
  if (!config.environment)
    errors.environment = "paymentAdmin.duitku.errors.required";
  const email = config.notificationEmail.trim();
  if (!email) errors.notificationEmail = "paymentAdmin.duitku.errors.required";
  else if (email.length > EMAIL_MAX || !EMAIL.test(email))
    errors.notificationEmail = "paymentAdmin.duitku.errors.email";
  if (config.vaName.trim().length > VA_NAME_MAX)
    errors.vaName = "paymentAdmin.duitku.errors.vaNameLong";
  const filled = DUITKU_CREDENTIAL_FIELDS.filter(
    (name) => (typed[name] ?? "").trim() !== "",
  );
  if (!hasStoredCredentials || filled.length > 0)
    for (const name of DUITKU_CREDENTIAL_FIELDS)
      if ((typed[name] ?? "").trim() === "")
        errors[`credential:${name}`] = hasStoredCredentials
          ? "paymentAdmin.duitku.errors.credentialsIncomplete"
          : "paymentAdmin.duitku.errors.required";
  return errors;
}

/** What goes into the secret buffer: trimmed, non-empty, known fields only. */
export function duitkuTypedCredentials(
  typed: Partial<Record<DuitkuCredentialField, string>>,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of DUITKU_CREDENTIAL_FIELDS) {
    const value = typed[name]?.trim();
    if (value) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** PUT body WITHOUT credentials; the one-shot buffer joins them at send time. */
export function buildDuitkuUpsertInput(
  scope: DuitkuScope,
  config: DuitkuConfigDraft,
): UpsertIntegrationInput {
  const vaName = config.vaName.trim();
  return {
    outletId: scope.outletId,
    provider: "duitku",
    config: {
      environment: config.environment,
      notificationEmail: config.notificationEmail.trim(),
      ...(vaName ? { vaName } : {}),
    },
  } as UpsertIntegrationInput;
}

export type DuitkuStatusView =
  "not_configured" | "saved" | "tested_ok" | "tested_error";

/** One line of truth about the row: never a credential, only saved/tested. */
export function duitkuStatusView(
  row: TenantIntegration | null,
): DuitkuStatusView {
  if (!row || row.credentials === null) return "not_configured";
  if (row.lastCheckedAt === null) return "saved";
  return row.lastErrorCode ? "tested_error" : "tested_ok";
}

/** Methods the test found enabled, for the result list. */
export function enabledMethodCount(
  result: Pick<IntegrationConnectionTest, "methods">,
): number {
  return result.methods.filter((method) => method.enabled).length;
}

/** Form fields in screen order: the first one with an error takes focus. */
export const DUITKU_FIELD_ORDER = [
  "environment",
  "notificationEmail",
  "vaName",
  "credential:merchantCode",
  "credential:apiKey",
] as const;

export function firstDuitkuErrorField(errors: DuitkuErrors): string | null {
  return DUITKU_FIELD_ORDER.find((name) => errors[name] !== undefined) ?? null;
}

/** DOM id of a form control, so a handler can move focus to it. */
export function duitkuFieldId(name: string): string {
  return `duitku-field-${name.replace("credential:", "")}`;
}

/** Error of ONE field, for validation on blur and live correction. */
export function validateDuitkuField(
  name: string,
  config: DuitkuConfigDraft,
  typed: Partial<Record<DuitkuCredentialField, string>>,
  hasStoredCredentials: boolean,
): MessageKey | undefined {
  return validateDuitkuDraft(config, typed, hasStoredCredentials)[name];
}

/**
 * Remount key of the form. It changes with the scope, the row and the
 * credential generation (`setAt`), and NOT with `updatedAt`: a connection test
 * stamps the row, and remounting then would drop the test result and the
 * user's unsaved input.
 */
export function duitkuFormKey(
  scope: DuitkuScope,
  row: TenantIntegration | null,
): string {
  return `${scope.outletId ?? "brand"}:${row?.id ?? "new"}:${row?.credentials?.setAt ?? ""}`;
}

export type DuitkuOutletsState = "loading" | "error" | "empty" | "ready";

/** Real state of the outlet list; data wins over a failed background refetch. */
export function duitkuOutletsState(query: {
  isPending: boolean;
  isError: boolean;
  data?: { data: readonly unknown[] } | undefined;
}): DuitkuOutletsState {
  if (query.data) return query.data.data.length > 0 ? "ready" : "empty";
  if (query.isPending) return "loading";
  return query.isError ? "error" : "loading";
}

/** Catalog key of a method code from the connection test, null when unknown. */
export function duitkuMethodLabelKey(method: string): MessageKey | null {
  const known = paymentMethodSchema.safeParse(method);
  return known.success ? methodLabelKey(known.data) : null;
}

/** What a failed test means and what to do next, per gateway error code. */
export function duitkuTestFailureKeys(code: string | null): {
  cause: MessageKey;
  advice: MessageKey;
} {
  switch (code) {
    case "GATEWAY_AUTH_FAILED":
      return {
        cause: "paymentAdmin.duitku.test.cause.authFailed",
        advice: "paymentAdmin.duitku.test.advice.authFailed",
      };
    case "GATEWAY_REJECTED":
      return {
        cause: "paymentAdmin.duitku.test.cause.rejected",
        advice: "paymentAdmin.duitku.test.advice.rejected",
      };
    case "GATEWAY_UNREACHABLE":
      return {
        cause: "paymentAdmin.duitku.test.cause.unreachable",
        advice: "paymentAdmin.duitku.test.advice.unreachable",
      };
    default:
      return {
        cause: "paymentAdmin.duitku.test.cause.unknown",
        advice: "paymentAdmin.duitku.test.advice.unknown",
      };
  }
}

/** A row that routing cannot use yet: absent (will be draft) or not active. */
export function duitkuNeedsActivation(row: TenantIntegration | null): boolean {
  return row === null || row.status !== "active";
}

export type DuitkuActivation =
  | { kind: "none" }
  | { kind: "ready" }
  | { kind: "blocked"; reason: "notTested" | "testFailed" };

/**
 * Whether the row may be activated from here: only a draft whose last
 * connection test succeeded (a test stamps lastCheckedAt, a failure sets
 * lastErrorCode). Anything else is not offered or says why it is blocked.
 */
export function duitkuActivation(
  row: TenantIntegration | null,
): DuitkuActivation {
  if (!row || row.status !== "draft") return { kind: "none" };
  if (row.lastCheckedAt === null)
    return { kind: "blocked", reason: "notTested" };
  if (row.lastErrorCode) return { kind: "blocked", reason: "testFailed" };
  return { kind: "ready" };
}
