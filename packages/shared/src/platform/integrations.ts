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

/**
 * 1272 K1 (design duitku-fee-passthrough §1): the guest service fee of one
 * Duitku channel, `ceil(amount * bps / 10000) + flatIdr` on the charged amount.
 * Kept in the integration config as `guestFees: { <channel code>: rate }`. The
 * server reads a rate only when it is within the method's C4a cap
 * (`maxFeeBps_<method>`, `maxFeeFlatIdr_<method>`); any other value hides the
 * channel. bps stays under 10000 so the gross-up exists.
 */
export const duitkuGuestFeeRateSchema = z.strictObject({
  bps: z.number().int().min(0).max(9_999),
  flatIdr: z.number().int().min(0).max(1_000_000),
});
export type DuitkuGuestFeeRate = z.infer<typeof duitkuGuestFeeRateSchema>;
export const duitkuGuestFeesSchema = z.record(
  z.string().regex(/^[A-Z0-9]{1,40}$/),
  duitkuGuestFeeRateSchema,
);

/**
 * Duitku channel codes by method category (docs "Payment methods"). One list
 * for the API's category lookup and for the guest fee rules below.
 */
export const DUITKU_METHOD_CATEGORY_CODES = {
  card: ["VC"],
  va: [
    "BC",
    "M2",
    "VA",
    "I1",
    "B1",
    "BT",
    "A1",
    "AG",
    "NC",
    "BR",
    "S1",
    "DM",
    "BV",
  ],
  retail: ["FT", "IR"],
  ewallet: ["OV", "SA", "LF", "LA", "DA", "SL", "OL"],
  qris: ["SP", "NQ", "SQ"],
  paylater: ["DN", "AT"],
} as const satisfies Record<string, readonly string[]>;

/** Methods a guest fee may apply to; QRIS never carries one. */
export const DUITKU_GUEST_FEE_METHODS = ["va", "ewallet", "card"] as const;
export type DuitkuGuestFeeMethod = (typeof DUITKU_GUEST_FEE_METHODS)[number];

/** The fee method of a channel code, null for QRIS, retail, paylater, unknown. */
export function duitkuGuestFeeMethodOf(
  code: string,
): DuitkuGuestFeeMethod | null {
  for (const method of DUITKU_GUEST_FEE_METHODS)
    if (
      (DUITKU_METHOD_CATEGORY_CODES[method] as readonly string[]).includes(code)
    )
      return method;
  return null;
}

function wholeUpTo(value: unknown, max: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
    ? value
    : null;
}

/**
 * The C4a fee cap of a fee method in one Duitku config: `maxFeeBps_<method>`
 * (basis points) and `maxFeeFlatIdr_<method>` (rupiah, default 0). Null when
 * the method has neither number or a number is not a plausible whole value.
 * The one reader of these keys for guest fee rates, on the API and in the form.
 */
export function duitkuGuestFeeCap(
  config: Readonly<Record<string, unknown>>,
  method: string,
): { readonly bps: number; readonly flatIdr: number } | null {
  const bpsRaw = config[`maxFeeBps_${method}`];
  const flatRaw = config[`maxFeeFlatIdr_${method}`];
  if (bpsRaw === undefined && flatRaw === undefined) return null;
  const bps = bpsRaw === undefined ? 0 : wholeUpTo(bpsRaw, 10_000);
  const flatIdr = flatRaw === undefined ? 0 : wholeUpTo(flatRaw, 1_000_000_000);
  return bps === null || flatIdr === null ? null : { bps, flatIdr };
}

/** Is this rate allowed for the channel code under the config's caps? */
export function duitkuGuestFeeWithinCap(
  config: Readonly<Record<string, unknown>>,
  code: string,
  rate: DuitkuGuestFeeRate,
): boolean {
  const method = duitkuGuestFeeMethodOf(code);
  if (method === null) return false;
  const cap = duitkuGuestFeeCap(config, method);
  return cap !== null && rate.bps <= cap.bps && rate.flatIdr <= cap.flatIdr;
}

/** Channel codes of `config.guestFees` that are not a fee method or beyond their cap. */
export function duitkuGuestFeeIssueCodes(
  config: Readonly<Record<string, unknown>>,
): string[] {
  const parsed = duitkuGuestFeesSchema.safeParse(config.guestFees ?? {});
  if (!parsed.success) return ["guestFees"];
  return Object.entries(parsed.data)
    .filter(([code, rate]) => !duitkuGuestFeeWithinCap(config, code, rate))
    .map(([code]) => code)
    .sort();
}

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
  .record(fieldName, z.union([configValue, duitkuGuestFeesSchema]))
  .refine((config) => Object.keys(config).length <= 30, {
    message: "At most 30 config keys",
  })
  .refine(
    (config) =>
      Object.entries(config).every(
        ([key, value]) =>
          key === "guestFees" || value === null || typeof value !== "object",
      ),
    { message: "Only guestFees may hold nested values" },
  )
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

// ----------------------------------------------------- payment gateways

/** True for a provider of the `payment_gateway` category. */
export function isGatewayProvider(provider: IntegrationProvider): boolean {
  return integrationCategoryOf[provider] === "payment_gateway";
}

/**
 * Per-gateway credential contract (sub-302 D15). `credentials: null` keeps
 * the DOIT body as it is today (free-form field names); `rotating` lists the
 * fields whose replacement keeps the old value for a grace window (D17) and
 * `previous` names the key that holds each old value inside the sealed blob.
 */
export const GATEWAY_CREDENTIAL_SPECS = {
  doit: {
    credentials: null,
    config: null,
    rotating: ["webhookSecret"],
    previous: { webhookSecret: "previousWebhookSecret" },
  },
  duitku: {
    credentials: ["merchantCode", "apiKey"],
    config: {
      environment: ["sandbox", "production"],
      notificationEmail: "email",
      vaName: { optional: true, maxLength: 20 },
    },
    rotating: ["apiKey", "merchantCode"],
    previous: {
      merchantCode: "previousMerchantCode",
      apiKey: "previousApiKey",
    },
  },
} as const satisfies Record<
  "doit" | "duitku",
  {
    credentials: readonly string[] | null;
    config: unknown;
    rotating: readonly string[];
    previous: Record<string, string>;
  }
>;

/** Server-written keys inside a gateway's sealed credentials; a client never sends them. */
export const GATEWAY_PREVIOUS_VALID_UNTIL = "previousValidUntil";
export function isGatewayPreviousKey(key: string): boolean {
  return key.startsWith("previous");
}

const duitkuConfigSchema = z.object({
  environment: z.enum(GATEWAY_CREDENTIAL_SPECS.duitku.config.environment),
  notificationEmail: z.email().max(254),
  vaName: z.union([z.string().max(20), z.null()]).optional(),
  guestFees: duitkuGuestFeesSchema.optional(),
});

/**
 * Names of the fields an upsert body gets wrong for a payment gateway
 * (never values: a rejected body must not echo a secret). Empty = acceptable.
 * `credentials` undefined = "keep the stored secret".
 */
export function gatewayCredentialIssues(
  provider: IntegrationProvider,
  config: IntegrationConfig,
  credentials: Record<string, string> | undefined,
): string[] {
  // 1272 K5: the guest service fee is a Duitku setting, no other provider's.
  if (provider !== "duitku" && "guestFees" in config) {
    return isGatewayProvider(provider)
      ? [...gatewayIssues(provider, config, credentials), "guestFees"].sort()
      : ["guestFees"];
  }
  return gatewayIssues(provider, config, credentials);
}

function gatewayIssues(
  provider: IntegrationProvider,
  config: IntegrationConfig,
  credentials: Record<string, string> | undefined,
): string[] {
  if (!isGatewayProvider(provider)) return [];
  const issues = new Set<string>();
  if (credentials)
    for (const key of Object.keys(credentials))
      if (isGatewayPreviousKey(key)) issues.add(key);
  if (provider === "duitku") {
    const parsed = duitkuConfigSchema.safeParse(config);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        issues.add(String(issue.path[0] ?? "config"));
    // 1272 K5: a guest fee above the C4a cap (or on QRIS) is never saved.
    if (parsed.success && duitkuGuestFeeIssueCodes(config).length > 0)
      issues.add("guestFees");
    if (credentials) {
      const allowed: readonly string[] =
        GATEWAY_CREDENTIAL_SPECS.duitku.credentials;
      for (const key of allowed) if (!credentials[key]) issues.add(key);
      for (const key of Object.keys(credentials))
        if (!allowed.includes(key)) issues.add(key);
    }
  }
  return [...issues].sort();
}

/** Result of POST /api/org/integrations/:integrationId/test (sub-302 D16). */
export const integrationConnectionTestSchema = z.strictObject({
  ok: z.boolean(),
  checkedAt: isoDateTimeSchema,
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
    .nullable(),
  methods: z.array(
    z.strictObject({
      method: z.string().min(1).max(30),
      enabled: z.boolean(),
      channelCount: z.number().int().nonnegative(),
    }),
  ),
});
export type IntegrationConnectionTest = z.infer<
  typeof integrationConnectionTestSchema
>;

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
