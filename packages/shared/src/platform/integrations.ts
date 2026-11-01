// Per-tenant integrations (PRD v1.7 §3 F4 "Integrasi per Tenant", §6 A
// `tenant_integrations`). Credentials are stored encrypted per tenant or per
// outlet and are WRITE-ONLY on the wire: a client may send them once, the API
// encrypts them into `credentials_encrypted` and from then on every read
// returns only a secret reference plus which fields are set. Plaintext never
// appears in a response, an event, an audit diff or a log.

import {
  clientInputSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import { AUDIT_REDACTED, isSensitiveAuditKey } from "../audit/index.ts";
import { tenantIntegrationIdSchema } from "./ids.ts";

/**
 * Providers. The first eight are PRD §6 A verbatim; `edc`, `wifi_vendor` and
 * `llm` are owner decisions (EDC banks BCA/Mandiri/BNI/BJB, guest Wi-Fi
 * vendor, OpenAI-compatible LLM endpoint configured per tenant). WhatsApp runs
 * through KirimDev (AUTH-02 adjusted): the vendor is `config.vendor`, the
 * provider stays `whatsapp` so the PRD vocabulary is kept.
 */
export const INTEGRATION_PROVIDERS = [
  "doit",
  "duitku",
  "whatsapp",
  "gofood",
  "grabfood",
  "shopeefood",
  "email",
  "lock_vendor",
  "edc",
  "wifi_vendor",
  "llm",
] as const;
export const integrationProviderSchema = z.enum(INTEGRATION_PROVIDERS);
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;

/** UI grouping on the Integrasi page. */
export const integrationCategoryOf = {
  doit: "payment_gateway",
  duitku: "payment_gateway",
  whatsapp: "messaging",
  gofood: "delivery_channel",
  grabfood: "delivery_channel",
  shopeefood: "delivery_channel",
  email: "email",
  lock_vendor: "lock",
  edc: "edc",
  wifi_vendor: "wifi",
  llm: "llm",
} as const satisfies Record<IntegrationProvider, string>;

export const integrationStatusSchema = z.enum(["draft", "active", "disabled"]);
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

/** Opaque pointer to the encrypted credential blob. Not a secret itself, but
 * never derived from the secret either. */
export const secretRefSchema = z
  .string()
  .regex(/^sec_[A-Za-z0-9_-]{16,64}$/, "Expected an opaque sec_… reference");
export type SecretRef = z.infer<typeof secretRefSchema>;

const fieldName = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]{0,63}$/, "Credential/config field name");

const configValue = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/**
 * Non-secret settings (merchant code, sender address, bank, base URL, model
 * name, receiving WhatsApp number). Keys that look like secrets are refused so
 * a credential can never land in the plaintext `config` column by mistake.
 */
export const integrationConfigSchema = z
  .record(fieldName, configValue)
  .refine((config) => Object.keys(config).length <= 30, {
    message: "At most 30 config keys",
  })
  .refine(
    (config) => Object.keys(config).every((key) => !isSecretLikeKey(key)),
    { message: "Secrets belong in credentials, not config" },
  );
export type IntegrationConfig = z.infer<typeof integrationConfigSchema>;

const SECRET_KEY = /secret|token|passw|apikey|privatekey|signingkey|pin$|^pin/i;
/** True for config keys that must be credentials instead. */
export function isSecretLikeKey(key: string): boolean {
  return SECRET_KEY.test(key.replaceAll("_", ""));
}

/** What a read returns about stored credentials: reference + field names. */
export const credentialRefSchema = z.strictObject({
  secretRef: secretRefSchema,
  fields: z.array(fieldName).min(1).max(20),
  setAt: isoDateTimeSchema,
  setBy: userIdSchema,
});
export type CredentialRef = z.infer<typeof credentialRefSchema>;

/**
 * One `tenant_integrations` row on the wire. Unique per (tenant_id,
 * outlet_id, provider); `outletId: null` is tenant-wide. An outlet row wins
 * over the tenant row for that outlet (`resolveIntegration`).
 */
export const tenantIntegrationSchema = z
  .strictObject({
    id: tenantIntegrationIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema.nullable(),
    provider: integrationProviderSchema,
    config: integrationConfigSchema,
    credentials: credentialRefSchema.nullable(),
    status: integrationStatusSchema,
    lastCheckedAt: isoDateTimeSchema.nullable(),
    lastErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .refine((row) => row.status !== "active" || row.credentials !== null, {
    path: ["credentials"],
    message: "An active integration needs stored credentials",
  });
export type TenantIntegration = z.infer<typeof tenantIntegrationSchema>;

const credentialValue = z.string().min(1).max(4096);

/** Create/update body. `credentials` is write-only: omitted keeps the stored
 * secret, present replaces it as a whole. Tenant comes from context (TEN-02). */
export const upsertIntegrationInputSchema = clientInputSchema({
  outletId: outletIdSchema.nullable(),
  provider: integrationProviderSchema,
  config: integrationConfigSchema,
  credentials: z
    .record(fieldName, credentialValue)
    .refine(
      (value) => {
        const size = Object.keys(value).length;
        return size >= 1 && size <= 20;
      },
      { message: "1-20 credential fields" },
    )
    .optional(),
});
export type UpsertIntegrationInput = z.infer<
  typeof upsertIntegrationInputSchema
>;

export const setIntegrationStatusInputSchema = clientInputSchema({
  status: z.enum(["active", "disabled"]),
});

const integrationTransitions: Record<
  IntegrationStatus,
  readonly IntegrationStatus[]
> = {
  draft: ["active", "disabled"],
  active: ["disabled"],
  disabled: ["active"],
};
export function canTransitionIntegration(
  from: IntegrationStatus,
  to: IntegrationStatus,
  hasCredentials: boolean,
): boolean {
  if (!integrationTransitions[from].includes(to)) return false;
  return to !== "active" || hasCredentials;
}

/** Log/audit-safe copy of an upsert body: every credential value redacted,
 * config passed through the audit masker rules. */
export function redactIntegrationInput(
  input: UpsertIntegrationInput,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.config))
    config[key] = isSensitiveAuditKey(key) ? AUDIT_REDACTED : value;
  return {
    outletId: input.outletId,
    provider: input.provider,
    config,
    credentials: input.credentials
      ? Object.fromEntries(
          Object.keys(input.credentials).map((key) => [key, AUDIT_REDACTED]),
        )
      : undefined,
  };
}

/** The row a service should use for an outlet: an active outlet-level row,
 * else the active tenant-level row, else null (fail closed). */
export function resolveIntegration(
  rows: readonly TenantIntegration[],
  provider: IntegrationProvider,
  outletId: string | null,
): TenantIntegration | null {
  const active = rows.filter(
    (row) => row.provider === provider && row.status === "active",
  );
  if (outletId) {
    const wanted = outletId.toLowerCase();
    const outletRow = active.find((row) => row.outletId === wanted);
    if (outletRow) return outletRow;
  }
  return active.find((row) => row.outletId === null) ?? null;
}
