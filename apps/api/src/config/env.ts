import { z } from "zod";
import {
  DEPLOYMENT_POLICY_MESSAGE,
  assertDataImportAllowed as assertSharedDataImportAllowed,
  deploymentEnvShape,
  deploymentPolicyCheck,
} from "@starter/shared/env";
import { normalizeHostname } from "@starter/shared/platform";
import { parseEdgeRuntimeConfig } from "../edge/config.ts";
import { unsafeAiUrlReason } from "../lib/ai/url-guard.ts";
import { sealKeyConfigProblems } from "../lib/selfie-seal.ts";

// Environment values are loaded by Node (`--env-file-if-exists` in the package
// scripts) from the repository root's .env.local and .env. Values already in the
// process environment win, so a supplied DATABASE_URL is never overridden.

const origin = (message: string) =>
  z.url().refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  }, message);

/** Comma-separated secrets (rotation); unset becomes an empty list. */
const secretList = () =>
  z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );

const postgresUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["postgres:", "postgresql:"].includes(url.protocol) &&
    Boolean(url.hostname) &&
    url.pathname.length > 1 &&
    !url.hash
  );
}, "Use a PostgreSQL connection string.");

/** An empty variable (`NAME=`) counts as unset. */
const blankToUndefined = <T extends z.ZodType>(inner: T) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    inner,
  );

const schema = z
  .object({
    // Deployment mode, edge topology, and data classification are shared with
    // the web, worker, and edge runtimes (@starter/shared/env).
    ...deploymentEnvShape,
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    // Defaults to BETTER_AUTH_URL's port (4000 when it has none).
    PORT: z.coerce.number().int().min(1).max(65535).optional(),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.url().refine((value) => {
      const url = new URL(value);
      return (
        ["postgres:", "postgresql:"].includes(url.protocol) &&
        Boolean(url.hostname) &&
        url.pathname.length > 1 &&
        !url.hash
      );
    }, "Set DATABASE_URL to a PostgreSQL connection string or run pnpm run setup."),
    APP_DATABASE_URL: postgresUrl.optional(),
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, "Run pnpm run setup to generate a secret."),
    // AES-256-GCM key for write-only data (integration credentials, NPWP):
    // base64 of exactly 32 bytes. Development falls back to a scrypt of
    // BETTER_AUTH_SECRET; production must set it (lib/secrets.ts).
    DATA_ENCRYPTION_KEY: z
      .string()
      .refine(
        (value) => Buffer.from(value, "base64").length === 32,
        "Use base64 of 32 bytes.",
      )
      .optional(),
    BETTER_AUTH_URL: origin(
      "Use the API's origin, e.g. http://localhost:4000.",
    ).default("http://localhost:4000"),
    WEB_URL: origin(
      "Use the web app's origin, e.g. http://localhost:3000.",
    ).default("http://localhost:3000"),
    TRUSTED_ORIGINS: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .pipe(
        z.array(origin("TRUSTED_ORIGINS must be comma-separated origins.")),
      ),
    COOKIE_DOMAIN: z
      .string()
      .regex(/^\.?[a-z0-9.-]+$/i, "Use a parent domain such as .example.com.")
      .optional(),
    // Hostname tenants' default subdomains live under (`<slug>.<platform
    // domain>`). It and everything under it is reserved: no tenant may claim
    // it as a custom domain (legend-t57t).
    PLATFORM_DOMAIN: z
      .string()
      .trim()
      .transform((value, ctx) => {
        const host = normalizeHostname(value);
        if (host === null) {
          ctx.addIssue({
            code: "custom",
            message: "Use a public hostname such as example.com.",
          });
          return z.NEVER;
        }
        return host;
      })
      .optional(),
    // A hop count or subnet list. `true` would trust any X-Forwarded-For a
    // client sends, letting it pick the IP that rate limits are counted by.
    TRUST_PROXY: z
      .string()
      .refine(
        (value) => value !== "true",
        "Use a hop count (e.g. 1) or a subnet list such as loopback; true trusts any client-supplied X-Forwarded-For.",
      )
      .optional(),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .optional(),
    // Public, session-free reads (guest QR scan/menu, brand website, SSR brand
    // context, payment links) share one in-memory fixed window (legend-wd4b):
    // a bucket per client IP and a bucket per resolved tenant. The defaults
    // leave room for a venue full of guests behind one NAT address and for the
    // web server's SSR traffic; tune them per deployment (docs/deployment.md).
    PUBLIC_RATE_LIMIT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(600),
    PUBLIC_RATE_LIMIT_TENANT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000_000)
      .default(6000),
    // Guest table-session routes (cart, quote, bill, payments, polls) count
    // against their own tenant bucket, so a polling dining room cannot spend
    // the budget of the public reads (or the reverse). It is per tenant, so it
    // covers every outlet: size it for all venues polling at once.
    PUBLIC_RATE_LIMIT_GUEST_TENANT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000_000)
      .default(60_000),
    // The web server's address(es) as the API sees them (comma-separated). Its
    // SSR calls carry no visitor IP, so they skip the per-IP public bucket and
    // only count against the tenant bucket. Loopback by default (web and API
    // on one VM); add the web container's address when they run in Docker.
    PUBLIC_RATE_LIMIT_INTERNAL_IPS: z
      .string()
      .default("127.0.0.1,::1,::ffff:127.0.0.1")
      .transform((value) =>
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    LOG_SQL: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((value) => value === "true" || value === "1"),
    // Kill switch for DOIT refund payouts (legend-0ogy). Off by default: the
    // refund port stays fail-closed, so approved refunds wait instead of
    // moving money. Turn on only once the DOIT refund flow is verified live.
    DOIT_REFUNDS_ENABLED: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((value) => value === "true" || value === "1"),
    // Duitku (sub-302): the public origin Duitku posts callbacks to and the
    // page it sends a customer back to. https in production. Unset = the Duitku
    // adapter stays unregistered. Sandbox or production Duitku comes from the
    // integration's config; merchant code and API key are entered in the app.
    DUITKU_CALLBACK_BASE_URL: origin(
      "Use the API's public origin, e.g. https://api.example.com.",
    ).optional(),
    DUITKU_RETURN_URL: z.url().max(255).optional(),
    // Gate for supplier return posting (legend-65mgw). Off by default: a
    // return moves stock out without a journal until the goods receipt journal
    // (legend-29vw) runs, which would split the GL from the stock ledger. That
    // work turns it on.
    PURCHASE_RETURN_POSTING_ENABLED: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((value) => value === "true" || value === "1"),
    // Keyed-digest secret for contact values (WhatsApp numbers, emails) that
    // must link across modules — identity rows, reservations, CRM (AUTH-01/07).
    // Optional so existing deployments start; it falls back to
    // BETTER_AUTH_SECRET, and production should set a dedicated value so a
    // Better Auth secret rotation does not orphan every contact digest.
    CONTACT_HASH_SECRET: z.string().min(16).optional(),
    // KirimDev webhook signing secrets (AUTH-02). Comma-separated while a
    // secret rotates: any listed secret may sign. Without it the WhatsApp
    // webhook answers 503 and processes nothing.
    KIRIM_WEBHOOK_SECRET: z
      .string()
      .optional()
      .transform((value) =>
        (value ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    // Delivery platform webhook signing secrets (legend-5bn3). Comma-separated
    // while a secret rotates. A platform without a secret is disabled: its
    // webhook answers 503 and processes nothing.
    DELIVERY_GOFOOD_WEBHOOK_SECRET: secretList(),
    DELIVERY_GRABFOOD_WEBHOOK_SECRET: secretList(),
    DELIVERY_SHOPEEFOOD_WEBHOOK_SECRET: secretList(),
    // Shared secret Caddy sends with its on-demand TLS ask (X-Tls-Ask-Token).
    // Unset in local development; set it wherever a public proxy calls the ask.
    TLS_ASK_TOKEN: z.string().min(16).max(200).optional(),
    // Root secret of the staff device pin pepper (services/device-pin-pepper.ts).
    // It is deliberately NOT derived from BETTER_AUTH_SECRET: rotating the auth
    // secret must not invalidate every stored pin. Production must set it;
    // development and tests use a fixed, non-secret fallback. Rotating this
    // value invalidates every stored pin, so staff must set a new one.
    STAFF_PIN_PEPPER: z
      .string()
      .min(32, "Use at least 32 random characters.")
      .optional(),
    // Edge node settings (legend-2pi, edge/config.ts). Required only with
    // EDGE_MODE=true; the cloud ignores them. EDGE_NODE_CREDENTIAL is the
    // secret shown once at registration: never logged, never committed.
    EDGE_CLOUD_URL: z.string().optional(),
    EDGE_NODE_CREDENTIAL: z.string().optional(),
    EDGE_NODE_ROLE: z.enum(["primary", "standby"]).default("primary"),
    EDGE_NODE_VERSION: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\w.+-]+$/)
      .default("dev"),
    // Edge selfie store: sealed LSS1 files wait here until the cloud takes
    // them. EDGE_SELFIE_MAX_BYTES caps the bytes of files not yet uploaded.
    EDGE_SELFIE_DIR: z.string().min(1).default("/var/lib/legend/edge-selfies"),
    EDGE_SELFIE_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(2_147_483_648),
    // Edge selfie worker (legend-hubzo): upload interval, and how long a
    // pending file may wait before it expires on this disk.
    EDGE_SELFIE_UPLOAD_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(30_000),
    EDGE_SELFIE_MAX_AGE_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30),
    // Attendance selfie seal (design hris-edge-replication 5): the cloud's
    // private keys (JSON {kid: PKCS#8 PEM}, RSA >= 3072 bit) and the kid
    // edges seal to. Production secrets: never logged, never committed. Keep
    // an old kid 90 days after a switch. Checked at boot below.
    ATTENDANCE_SELFIE_SEAL_KEYS: blankToUndefined(z.string().min(1).optional()),
    ATTENDANCE_SELFIE_SEAL_ACTIVE_KID: blankToUndefined(
      z.string().min(1).optional(),
    ),
    // QR day keys the cloud sends each edge ahead of today (0..14, default 3).
    EDGE_QR_KEY_DAYS_AHEAD: blankToUndefined(
      z.coerce.number().int().min(0).max(14).optional(),
    ),
    // AI gateway (WS-12). All optional: with no key configured AI is OFF and
    // every AI call answers AI_PROVIDER_UNAVAILABLE (lib/ai/provider-factory.ts).
    AI_PROVIDER: z
      .enum(["anthropic", "openai-compatible", "fake"])
      .default("anthropic"),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    AI_MODEL: z.string().min(1).max(200).default("claude-opus-5-5"),
    AI_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
    // openai-compatible only; SSRF-checked below (https public host in production).
    AI_BASE_URL: z.string().min(1).optional(),
    AI_API_KEY: z.string().min(1).optional(),
    AI_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(300_000)
      .default(30_000),
    // Lifetime of an MCP access token (seconds).
    MCP_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(3600),
  })
  .superRefine((values, ctx) => {
    if (values.AI_BASE_URL !== undefined) {
      const reason = unsafeAiUrlReason(
        values.AI_BASE_URL,
        values.NODE_ENV === "production",
      );
      if (reason)
        ctx.addIssue({
          code: "custom",
          path: ["AI_BASE_URL"],
          message: reason,
        });
    }
    for (const key of [
      "DUITKU_CALLBACK_BASE_URL",
      "DUITKU_RETURN_URL",
    ] as const) {
      const value = values[key];
      if (
        values.NODE_ENV === "production" &&
        value !== undefined &&
        !value.startsWith("https://")
      )
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Use an https URL in production.",
        });
    }
    if (values.NODE_ENV === "production" && values.AI_PROVIDER === "fake")
      ctx.addIssue({
        code: "custom",
        path: ["AI_PROVIDER"],
        message: "The fake AI provider is not allowed in production.",
      });
  })
  .superRefine((values, ctx) => {
    for (const problem of sealKeyConfigProblems(
      values.ATTENDANCE_SELFIE_SEAL_KEYS,
      values.ATTENDANCE_SELFIE_SEAL_ACTIVE_KID,
    ))
      ctx.addIssue({
        code: "custom",
        path: [problem.path],
        message: problem.message,
      });
  })
  .superRefine((values, ctx) => {
    // Same rule the edge runtime boots with (wss:// link URL, well-formed
    // credential), so a misconfigured edge node refuses to start here.
    const edge = parseEdgeRuntimeConfig({
      DEPLOYMENT_MODE: values.DEPLOYMENT_MODE,
      EDGE_MODE: String(values.EDGE_MODE),
      EDGE_CLOUD_URL: values.EDGE_CLOUD_URL,
      EDGE_NODE_CREDENTIAL: values.EDGE_NODE_CREDENTIAL,
      EDGE_NODE_ROLE: values.EDGE_NODE_ROLE,
      EDGE_NODE_VERSION: values.EDGE_NODE_VERSION,
    });
    if (!edge.ok)
      for (const problem of edge.problems) {
        const [path, ...message] = problem.split(": ");
        ctx.addIssue({
          code: "custom",
          path: [path ?? "EDGE_MODE"],
          message: message.join(": "),
        });
      }
  })
  .refine(
    (values) =>
      values.NODE_ENV !== "production" || Boolean(values.STAFF_PIN_PEPPER),
    {
      path: ["STAFF_PIN_PEPPER"],
      message:
        "Set STAFF_PIN_PEPPER in production so a BETTER_AUTH_SECRET rotation does not wipe staff pins.",
    },
  )
  .refine(
    (values) =>
      values.STAFF_PIN_PEPPER === undefined ||
      values.STAFF_PIN_PEPPER !== values.BETTER_AUTH_SECRET,
    {
      path: ["STAFF_PIN_PEPPER"],
      message:
        "STAFF_PIN_PEPPER must be its own secret, not BETTER_AUTH_SECRET.",
    },
  )
  .refine(
    (values) =>
      values.DEPLOYMENT_MODE === "development" ||
      Boolean(values.APP_DATABASE_URL),
    {
      path: ["APP_DATABASE_URL"],
      // TEN-02: the API must run as the restricted, RLS-bound login, never the owner.
      message:
        "Set APP_DATABASE_URL to the restricted application login outside development.",
    },
  )
  .refine(deploymentPolicyCheck, {
    path: ["DATA_CLASSIFICATION"],
    message: DEPLOYMENT_POLICY_MESSAGE,
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Field names and messages only: never print the values themselves.
  const problems = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  console.error(`Invalid API environment:\n${problems}`);
  process.exit(1);
}

const values = parsed.data;

export const env = {
  ...values,
  PORT: values.PORT ?? (Number(new URL(values.BETTER_AUTH_URL).port) || 4000),
  isProduction: values.NODE_ENV === "production",
  isTest: values.NODE_ENV === "test",
  // Hostnames tenants may not claim as custom domains: the platform domain and
  // the cookie parent domain (without its leading dot), whichever are set.
  reservedDomains: [
    ...new Set(
      [values.PLATFORM_DOMAIN, values.COOKIE_DOMAIN?.replace(/^\./, "")]
        .map((value) => (value ? normalizeHostname(value) : null))
        .filter((value): value is string => value !== null),
    ),
  ],
  // Browser origins allowed to call the API with cookies.
  trustedOrigins: [
    ...new Set([
      new URL(values.WEB_URL).origin,
      ...values.TRUSTED_ORIGINS.map((value) => new URL(value).origin),
    ]),
  ],
  logLevel:
    values.LOG_LEVEL ??
    (values.NODE_ENV === "production"
      ? "info"
      : values.NODE_ENV === "test"
        ? "silent"
        : "debug"),
};

// Express "trust proxy": off, a hop count, or a list of subnets.
export function trustProxySetting(value = env.TRUST_PROXY) {
  if (value === undefined || value === "" || value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

// Importers must classify each input explicitly before persisting any records.
// The rule itself is shared with every other runtime (@starter/shared/env).
export function assertDataImportAllowed(classification: unknown): void {
  assertSharedDataImportAllowed(env, classification);
}
