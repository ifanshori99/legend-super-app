// Pure rules of the integrations page (PRD v1.7 §3 F4 "Integrasi per Tenant",
// §6 A `tenant_integrations`; PAY-06). Credentials are write-only: a stored
// row only says WHICH fields are set, a replacement is typed fresh and never
// read back. Kept free of React and of the `@/` alias so root tests load it
// with Node type stripping.
import type { MessageKey } from "@starter/shared/i18n";
import {
  canTransitionIntegration,
  type IntegrationProvider,
  type IntegrationStatus,
  type TenantIntegration,
  type UpsertIntegrationInput,
} from "@starter/shared/platform";

/** Providers this page manages: DOIT, WhatsApp, email sender, ojol accounts. */
export const SETTINGS_PROVIDERS = [
  "doit",
  "whatsapp",
  "email",
  "gofood",
  "grabfood",
  "shopeefood",
] as const satisfies readonly IntegrationProvider[];
export type SettingsProvider = (typeof SETTINGS_PROVIDERS)[number];

export const PROVIDER_GROUPS = [
  {
    key: "payment",
    label: "tenantSettings.integrations.groups.payment",
    providers: ["doit"],
  },
  {
    key: "messaging",
    label: "tenantSettings.integrations.groups.messaging",
    providers: ["whatsapp", "email"],
  },
  {
    key: "ojol",
    label: "tenantSettings.integrations.groups.ojol",
    providers: ["gofood", "grabfood", "shopeefood"],
  },
] as const satisfies readonly {
  key: string;
  label: MessageKey;
  providers: readonly SettingsProvider[];
}[];

export type FieldKind = "text" | "select" | "whatsapp" | "email";

export type ConfigField = {
  name: string;
  label: MessageKey;
  kind: FieldKind;
  required: boolean;
  hint?: MessageKey;
  placeholder?: MessageKey;
  options?: readonly { value: string; label: MessageKey }[];
  defaultValue?: string;
};

export type CredentialField = { name: string; label: MessageKey };

export type ProviderDefinition = {
  provider: SettingsProvider;
  name: MessageKey;
  description: MessageKey;
  config: readonly ConfigField[];
  credentials: readonly CredentialField[];
};

const OJOL_CONFIG: readonly ConfigField[] = [
  {
    name: "storeId",
    label: "tenantSettings.integrations.fields.storeId",
    kind: "text",
    required: true,
    hint: "tenantSettings.integrations.fields.storeIdHint",
  },
  {
    name: "accountLabel",
    label: "tenantSettings.integrations.fields.accountLabel",
    kind: "text",
    required: false,
  },
];
const OJOL_CREDENTIALS: readonly CredentialField[] = [
  {
    name: "clientId",
    label: "tenantSettings.integrations.credentials.clientId",
  },
  {
    name: "clientSecret",
    label: "tenantSettings.integrations.credentials.clientSecret",
  },
];

export const PROVIDER_DEFINITIONS: Record<
  SettingsProvider,
  ProviderDefinition
> = {
  doit: {
    provider: "doit",
    name: "tenantSettings.integrations.providers.doit.name",
    description: "tenantSettings.integrations.providers.doit.description",
    config: [
      {
        name: "environment",
        label: "tenantSettings.integrations.fields.environment",
        kind: "select",
        required: true,
        defaultValue: "sandbox",
        options: [
          {
            value: "sandbox",
            label: "tenantSettings.integrations.fields.environmentSandbox",
          },
          {
            value: "production",
            label: "tenantSettings.integrations.fields.environmentProduction",
          },
        ],
      },
      {
        name: "merchantName",
        label: "tenantSettings.integrations.fields.merchantName",
        kind: "text",
        required: true,
      },
    ],
    credentials: [
      {
        name: "apiKey",
        label: "tenantSettings.integrations.credentials.apiKey",
      },
      {
        name: "webhookSecret",
        label: "tenantSettings.integrations.credentials.webhookSecret",
      },
    ],
  },
  whatsapp: {
    provider: "whatsapp",
    name: "tenantSettings.integrations.providers.whatsapp.name",
    description: "tenantSettings.integrations.providers.whatsapp.description",
    config: [
      {
        name: "vendor",
        label: "tenantSettings.integrations.fields.vendor",
        kind: "select",
        required: true,
        defaultValue: "kirimdev",
        options: [
          {
            value: "kirimdev",
            label: "tenantSettings.integrations.fields.vendorKirimdev",
          },
        ],
      },
      {
        name: "receivingNumber",
        label: "tenantSettings.integrations.fields.receivingNumber",
        kind: "whatsapp",
        required: true,
        hint: "tenantSettings.integrations.fields.receivingNumberHint",
      },
    ],
    credentials: [
      {
        name: "apiKey",
        label: "tenantSettings.integrations.credentials.apiKey",
      },
      {
        name: "webhookSecret",
        label: "tenantSettings.integrations.credentials.webhookSecret",
      },
    ],
  },
  email: {
    provider: "email",
    name: "tenantSettings.integrations.providers.email.name",
    description: "tenantSettings.integrations.providers.email.description",
    config: [
      {
        name: "senderAddress",
        label: "tenantSettings.integrations.fields.senderAddress",
        kind: "email",
        required: true,
        hint: "tenantSettings.integrations.fields.senderAddressHint",
      },
      {
        name: "senderName",
        label: "tenantSettings.integrations.fields.senderName",
        kind: "text",
        required: false,
      },
    ],
    credentials: [
      {
        name: "apiKey",
        label: "tenantSettings.integrations.credentials.apiKey",
      },
    ],
  },
  gofood: {
    provider: "gofood",
    name: "tenantSettings.integrations.providers.gofood.name",
    description: "tenantSettings.integrations.providers.ojol.description",
    config: OJOL_CONFIG,
    credentials: OJOL_CREDENTIALS,
  },
  grabfood: {
    provider: "grabfood",
    name: "tenantSettings.integrations.providers.grabfood.name",
    description: "tenantSettings.integrations.providers.ojol.description",
    config: OJOL_CONFIG,
    credentials: OJOL_CREDENTIALS,
  },
  shopeefood: {
    provider: "shopeefood",
    name: "tenantSettings.integrations.providers.shopeefood.name",
    description: "tenantSettings.integrations.providers.ojol.description",
    config: OJOL_CONFIG,
    credentials: OJOL_CREDENTIALS,
  },
};

/** What a stored credential looks like on screen: always this, never a value. */
export const CREDENTIAL_MASK = "••••••••";

export type IntegrationScope = { outletId: string | null };

/** The row stored for exactly this scope (tenant-wide or one outlet). */
export function rowForScope(
  rows: readonly TenantIntegration[],
  provider: IntegrationProvider,
  scope: IntegrationScope,
): TenantIntegration | null {
  return (
    rows.find(
      (row) =>
        row.provider === provider &&
        (row.outletId?.toLowerCase() ?? null) ===
          (scope.outletId?.toLowerCase() ?? null),
    ) ?? null
  );
}

/** For an outlet scope without its own row: the tenant row it falls back to. */
export function inheritedRow(
  rows: readonly TenantIntegration[],
  provider: IntegrationProvider,
  scope: IntegrationScope,
): TenantIntegration | null {
  if (scope.outletId === null) return null;
  if (rowForScope(rows, provider, scope)) return null;
  return rowForScope(rows, provider, { outletId: null });
}

export type IntegrationView =
  "not_configured" | "draft" | "active" | "disabled" | "error";

export function integrationView(
  row: TenantIntegration | null,
): IntegrationView {
  if (!row) return "not_configured";
  if (row.lastErrorCode) return "error";
  return row.status;
}

/** Names of credential fields that are set (labels only, never values). */
export function storedCredentialFields(
  row: TenantIntegration | null,
): readonly string[] {
  return row?.credentials?.fields ?? [];
}

export function statusActions(row: TenantIntegration | null): {
  canActivate: boolean;
  canDisable: boolean;
} {
  if (!row) return { canActivate: false, canDisable: false };
  const hasCredentials = row.credentials !== null;
  const can = (to: IntegrationStatus) =>
    canTransitionIntegration(row.status, to, hasCredentials);
  return { canActivate: can("active"), canDisable: can("disabled") };
}

export type ConfigDraft = Record<string, string>;

/** Form values for a provider: the stored row's config, else field defaults. */
export function configDraftFor(
  definition: ProviderDefinition,
  row: TenantIntegration | null,
): ConfigDraft {
  const draft: ConfigDraft = {};
  for (const field of definition.config) {
    const stored = row?.config[field.name];
    draft[field.name] =
      stored === undefined || stored === null
        ? (field.defaultValue ?? "")
        : String(stored);
  }
  return draft;
}

/** "0812-3450-0001" and "+62 812…" become "62812…" (digits, country code). */
export function normalizeWhatsappNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0")) return `62${digits.slice(1)}`;
  return digits;
}

const WHATSAPP = /^62\d{8,13}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type IntegrationErrors = Record<string, MessageKey>;

/**
 * Validation for the form. `credentials` holds only what the user typed this
 * time; an untouched set keeps the stored secret. A replacement is all-or-
 * nothing because the API replaces the credential blob as a whole.
 */
export function validateIntegrationDraft(
  definition: ProviderDefinition,
  config: ConfigDraft,
  credentials: Record<string, string>,
): IntegrationErrors {
  const errors: IntegrationErrors = {};
  for (const field of definition.config) {
    const value = (config[field.name] ?? "").trim();
    if (!value) {
      if (field.required)
        errors[field.name] = "tenantSettings.integrations.errors.required";
      continue;
    }
    if (
      field.kind === "whatsapp" &&
      !WHATSAPP.test(normalizeWhatsappNumber(value))
    )
      errors[field.name] = "tenantSettings.integrations.errors.whatsapp";
    if (field.kind === "email" && !EMAIL.test(value))
      errors[field.name] = "tenantSettings.integrations.errors.email";
  }
  const typed = definition.credentials.filter(
    (field) => (credentials[field.name] ?? "").trim() !== "",
  );
  if (typed.length > 0 && typed.length < definition.credentials.length)
    for (const field of definition.credentials)
      if ((credentials[field.name] ?? "").trim() === "")
        errors[`credential:${field.name}`] =
          "tenantSettings.integrations.errors.credentialsIncomplete";
  return errors;
}

/** True when the user typed any replacement credential. */
export function hasReplacement(credentials: Record<string, string>): boolean {
  return Object.values(credentials).some((value) => value.trim() !== "");
}

/**
 * Request body for PUT /api/org/integrations. Credentials are included only
 * when the caller passes them (taken from the SecretBuffer at send time);
 * omitted means the API keeps the stored secret.
 */
export function buildUpsertInput(
  definition: ProviderDefinition,
  scope: IntegrationScope,
  config: ConfigDraft,
  secrets: Record<string, string> | undefined,
): UpsertIntegrationInput {
  const body: Record<string, string> = {};
  for (const field of definition.config) {
    const raw = (config[field.name] ?? "").trim();
    if (!raw) continue;
    body[field.name] =
      field.kind === "whatsapp" ? normalizeWhatsappNumber(raw) : raw;
  }
  const typed: Record<string, string> = {};
  for (const field of definition.credentials) {
    const value = secrets?.[field.name]?.trim();
    if (value) typed[field.name] = value;
  }
  return {
    outletId: scope.outletId,
    provider: definition.provider,
    config: body,
    ...(Object.keys(typed).length > 0 ? { credentials: typed } : {}),
  } as UpsertIntegrationInput;
}
