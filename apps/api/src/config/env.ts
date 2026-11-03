import { z } from "zod";
import {
  DEPLOYMENT_POLICY_MESSAGE,
  assertDataImportAllowed as assertSharedDataImportAllowed,
  deploymentEnvShape,
  deploymentPolicyCheck,
} from "@starter/shared/env";

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

const postgresUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["postgres:", "postgresql:"].includes(url.protocol) &&
    Boolean(url.hostname) &&
    url.pathname.length > 1 &&
    !url.hash
  );
}, "Use a PostgreSQL connection string.");

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
