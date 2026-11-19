import { createECDH } from "node:crypto";
import { z } from "zod";
import {
  DEPLOYMENT_POLICY_MESSAGE,
  assertDataImportAllowed as assertSharedDataImportAllowed,
  deploymentEnvShape,
  deploymentPolicyCheck,
} from "@starter/shared/env";
import { isPublicHttpsUrl } from "@starter/shared/adapters";
import { hostnameSchema, normalizeHostname } from "@starter/shared/platform";
import { parseEdgeRuntimeConfig } from "../edge/config.ts";
import { unsafeAiUrlReason } from "../lib/ai/url-guard.ts";
import {
  DATA_ENCRYPTION_MAX_KEY_VERSION,
  assertDataEncryptionActiveVersion,
  parseDataEncryptionKeys,
} from "../lib/data-encryption-keys.ts";
import {
  HRIS_PII_MAX_KEY_VERSION,
  assertHrisPiiActiveVersion,
  parseHrisPiiKeys,
} from "../lib/hris-pii-keys.ts";
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
    // Payout step grant login (legend-911): legend_grant_<16 hex>, member of
    // legend_payout_grantor, runs only app.payout_grant_issue. Required in
    // production (legend-786te, see the refine below); development and test
    // may leave it unset and fall back to SET LOCAL ROLE (db/grantor.ts).
    PAYOUT_GRANTOR_DATABASE_URL: blankToUndefined(postgresUrl).optional(),
    // Frozen-column re-seal login (legend-qwm9r): legend_reseal_<16 hex>, the
    // only member of legend_sealed_reseal (INHERIT, no SET), runs only
    // app.reseal_frozen_sealed. Optional, worker only: without it the re-seal
    // job skips the frozen pass and the retirement of the old key stays held.
    RESEAL_DATABASE_URL: blankToUndefined(postgresUrl).optional(),
    // Only read to tell the worker process from the api (legend-786te): the
    // worker imports this schema too but never receives the grantor login.
    WORKER_DATABASE_URL: z.string().optional(),
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
    // Data key rotation (legend-dheu, lib/secrets.ts). Extra keys as
    // `<version>:<base64 32 bytes>` entries, comma separated, versions 2..255
    // (version 1 is DATA_ENCRYPTION_KEY; the version is the envelope's first
    // byte). The active version is the one new seals use; it must be 1 or
    // listed in DATA_ENCRYPTION_KEYS.
    DATA_ENCRYPTION_KEYS: z.string().optional(),
    DATA_ENCRYPTION_ACTIVE_KEY_VERSION: z.coerce
      .number()
      .int()
      .min(1)
      .max(DATA_ENCRYPTION_MAX_KEY_VERSION)
      .default(1),
    // HRIS PII key rotation (legend-33mj, lib/hris-pii.ts). Extra data keys as
    // `<version>:<base64 32 bytes>` entries, comma separated, versions >= 2
    // (version 1 is DATA_ENCRYPTION_KEY). The active version is the one new
    // seals use; it must be 1 or listed in HRIS_PII_KEYS.
    HRIS_PII_KEYS: z.string().optional(),
    HRIS_PII_ACTIVE_KEY_VERSION: z.coerce
      .number()
      .int()
      .min(1)
      .max(HRIS_PII_MAX_KEY_VERSION)
      .default(1),
    // Blind-index key version (legend-n039, lib/blind-index.ts): 1 = legacy
    // HMAC under the raw data key, 2 = HKDF subkey. New writes use this one.
    // Default 1 (legend-488): during a rolling deploy an old pod cannot read v2
    // digests. Set 2 by hand only after every pod runs this build
    // (docs/deployment.md); setting 1 again is the rollback lever.
    BLIND_INDEX_ACTIVE_VERSION: z.coerce
      .number()
      .int()
      .min(1)
      .max(2)
      .default(1),
    BETTER_AUTH_URL: origin(
      "Use the API's origin, e.g. http://localhost:4000.",
    ).default("http://localhost:4000"),
    WEB_URL: origin(
      "Use the web app's origin, e.g. http://localhost:3000.",
    ).default("http://localhost:3000"),
    // Filled by managed synthetic setup for the public localhost preview.
    // Ignored outside a development runtime; never used as an auth source.
    DEV_PUBLIC_SITE_HOST: hostnameSchema.optional(),
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
    // Shared rate-limit window across API instances (legend-bpvf). Unset = each
    // instance counts in its own memory, as on a single VM. Redis errors fall
    // back to the in-process counter, never to a 5xx.
    REDIS_URL: z.string().url().optional(),
    // Secret the web server sends with the visitor IP it forwards (legend-moe5).
    // The same value in web and API; unset = the forwarded IP is ignored and
    // SSR calls keep skipping the per-IP bucket (PUBLIC_RATE_LIMIT_INTERNAL_IPS).
    SSR_SHARED_SECRET: z.string().min(32).optional(),
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
    // Gate for the DOIT recurring billing back office, /api/payments/recurring
    // (legend-6c6). Off by default: the adapter calls /v1/recurring/*, but the
    // DOIT docs publish /v1/billing/*, so a live call would hit a path DOIT does
    // not document. While off, every request answers 503 before any DOIT call or
    // database write, except pause and cancel (a stop only limits payment, 1164),
    // which reach auth and the service. Webhook ingest and the worker are not
    // gated. Turn on only
    // once the adapter paths are verified against DOIT.
    DOIT_RECURRING_ENABLED: z
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
    // Gate for supplier invoice posting (ws/purchasing-apar, K5). Off by
    // default. One switch for the whole chain (legend-29vw): ON also journals
    // every goods receipt (Dr inventory / Cr GRNI, auto-journal consumer), and
    // an invoice or a return of the uninvoiced part is refused 409
    // GOODS_RECEIPT_NOT_JOURNALED until its receipt journal exists. While off,
    // a match that would book the payable (create, re-match, release) answers
    // 409 SUPPLIER_INVOICE_POSTING_DISABLED and writes nothing; a held invoice
    // is still stored, and goods receipt events are ignored. Turn it on only
    // after the money tests are green and finance made the cutover journals.
    SUPPLIER_INVOICE_POSTING_ENABLED: z
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
    // KirimDev API key for outbound WhatsApp (legend-w8dfz). Optional: unset
    // keeps outbound off. The message never echoes the value.
    KIRIM_API_KEY: blankToUndefined(
      z
        .string()
        .regex(
          /^kdv_live_[A-Za-z0-9_-]{24}$/,
          "Use a KirimDev API key (kdv_live_ followed by 24 characters).",
        )
        .optional(),
    ),
    // KirimDev API base URL override. Public https origin only (no path,
    // query or fragment); default is https://api.kirimdev.com.
    KIRIM_API_BASE_URL: blankToUndefined(
      z
        .url()
        .refine(
          isPublicHttpsUrl,
          "Use a public https URL (no localhost or IP address).",
        )
        .refine((value) => {
          const url = new URL(value);
          return url.pathname === "/" && url.search === "" && url.hash === "";
        }, "Use the origin only, without a path, query or fragment.")
        .optional(),
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
    // Pepper generation new staff pins are hashed under (cloud only). Version
    // 2 and up is per outlet (legend-jmsdx); 1 is the old per-tenant one, only
    // for older dev data. Raise it to rotate: older generations stay derivable
    // so existing pins verify (a cloud verify rehashes them), and every edge
    // fetches its outlet's new pepper on its next sync (docs/deployment.md
    // "Staff device pins").
    STAFF_PIN_PEPPER_CURRENT_VERSION: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(2),
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
    // EDC agent on the primary edge node (legend-kwy6d): off by default. Turn
    // on only on the one node that holds the outlet's terminals, with a
    // supervisor that restarts it (deploy/edge/legend-edge.service).
    EDC_AGENT_ENABLED: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((value) => value === "true" || value === "1"),
    // Edge selfie store: sealed LSS1 files wait here until the cloud takes
    // them. EDGE_SELFIE_MAX_BYTES caps the bytes of files not yet uploaded.
    EDGE_SELFIE_DIR: z.string().min(1).default("/var/lib/legend/edge-selfies"),
    // Edge local state files (catalog owner-alarm queue, 533 A5): kept apart
    // from the selfie store, whose sweeps and volume checks own that tree.
    EDGE_STATE_DIR: z.string().min(1).default("/var/lib/legend/edge-state"),
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
    // Cloud "edge offline" alarm (legend-5ab0l, edge-status-cloud D9): sweep
    // interval and how many open minutes without a heartbeat raise it.
    EDGE_OFFLINE_SWEEP_SECONDS: z.coerce
      .number()
      .int()
      .min(5)
      .max(3_600)
      .default(60),
    EDGE_OFFLINE_ALARM_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(1_440)
      .default(30),
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
    // Global emergency switch; connections remain opt-in per tenant.
    AI_CHATGPT_ENABLED: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((value) => value === "true" || value === "1"),
    // Used only for a first device connection; reconnects preserve the tenant's model.
    AI_CHATGPT_MODEL: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[\w.:/@+-]+$/)
      .default("gpt-6.1-sol"),
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
    // ClamAV daemon (legend-w9hwh): the malware scanner for uploads. Empty
    // CLAMD_HOST means no scanner (production then refuses PDF uploads).
    CLAMD_HOST: blankToUndefined(z.string().trim().min(1).optional()),
    CLAMD_PORT: blankToUndefined(
      z.coerce.number().int().min(1).max(65_535).default(3310),
    ),
    CLAMD_TIMEOUT_MS: blankToUndefined(
      z.coerce.number().int().min(1000).max(60_000).default(15_000),
    ),
    // Scan concurrency caps (legend-1rtm1): beyond them uploads wait in a small
    // queue, then are refused with 503 SCANNER_OVERLOADED.
    CLAMD_MAX_CONCURRENT: blankToUndefined(
      z.coerce.number().int().min(1).max(64).default(4),
    ),
    CLAMD_MAX_PER_TENANT: blankToUndefined(
      z.coerce.number().int().min(1).max(32).default(2),
    ),
    CLAMD_MAX_QUEUED: blankToUndefined(
      z.coerce.number().int().min(0).max(256).default(8),
    ),
    // Google sign-in for customers (legend-k2l, AUTH-05). Both or neither: with
    // neither set Google sign-in is OFF (no provider is registered in
    // lib/auth.ts); one without the other refuses to boot (below).
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    // Member email sign-in over SMTP (legend-k2l, e.g. SumoPod: port 465,
    // implicit TLS). HOST, USER, PASS and EMAIL_FROM all set or all unset; with
    // none set email sign-in is OFF and answers EMAIL_NOT_CONFIGURED in
    // production (the worker's NOTIFICATION_* settings are separate).
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(465),
    SMTP_SECURE: z
      .enum(["true", "false", "1", "0"])
      .default("true")
      .transform((value) => value === "true" || value === "1"),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    EMAIL_FROM: z.email().optional(),
    // Lifetime of an MCP access token (seconds).
    MCP_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(3600),
    // S3-compatible object storage for generated documents, today the profit
    // share statement PDFs (legend-33im6). All optional: with none set the
    // statement issuer stays unconfigured (503, key stays null) and the API
    // logs one warning at startup. Setting any of them requires the others
    // (the endpoint stays optional, for AWS itself). Never logged.
    OBJECT_STORAGE_REGION: z.string().trim().min(1).optional(),
    OBJECT_STORAGE_ENDPOINT: z.url().optional(),
    OBJECT_STORAGE_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
    OBJECT_STORAGE_PRIVATE_BUCKET: z.string().trim().min(1).optional(),
    OBJECT_STORAGE_PUBLIC_BUCKET: z.string().trim().min(1).optional(),
    OBJECT_STORAGE_PUBLIC_BASE_URL: z.url().optional(),
    // Browser web push for the panic alarm (legend-ofq4f). The API only serves
    // the public key; the worker signs and sends (its own NOTIFICATION_* checks
    // stay). With web_push all three VAPID values are required. Never logged:
    // the messages below name the key, never its value.
    NOTIFICATION_PUSH_PROVIDER: blankToUndefined(
      z.enum(["disabled", "web_push"]).default("disabled"),
    ),
    VAPID_PUBLIC_KEY: blankToUndefined(z.string().trim().optional()),
    VAPID_PRIVATE_KEY: blankToUndefined(z.string().trim().optional()),
    VAPID_SUBJECT: blankToUndefined(z.string().trim().optional()),
  })
  .superRefine((values, ctx) => {
    if (values.NOTIFICATION_PUSH_PROVIDER !== "web_push") return;
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    for (const key of [
      "VAPID_PUBLIC_KEY",
      "VAPID_PRIVATE_KEY",
      "VAPID_SUBJECT",
    ] as const)
      if (values[key] === undefined)
        issue(
          key,
          `${key} is required when NOTIFICATION_PUSH_PROVIDER is web_push.`,
        );
    const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } =
      values;
    // Public key: 65-byte uncompressed P-256 point (0x04 prefix), base64url.
    if (publicKey !== undefined) {
      const bytes = /^[A-Za-z0-9_-]+$/.test(publicKey)
        ? Buffer.from(publicKey, "base64url")
        : Buffer.alloc(0);
      if (
        !/^[A-Za-z0-9_-]{87}$/.test(publicKey) ||
        bytes.length !== 65 ||
        bytes[0] !== 0x04
      )
        issue(
          "VAPID_PUBLIC_KEY",
          "VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 public key (65 bytes).",
        );
    }
    if (
      privateKey !== undefined &&
      (!/^[A-Za-z0-9_-]{43}$/.test(privateKey) ||
        Buffer.from(privateKey, "base64url").length !== 32)
    )
      issue(
        "VAPID_PRIVATE_KEY",
        "VAPID_PRIVATE_KEY must be a base64url P-256 private key (32 bytes).",
      );
    // The pair must match, otherwise every push is signed for nobody.
    if (
      publicKey !== undefined &&
      privateKey !== undefined &&
      /^[A-Za-z0-9_-]{87}$/.test(publicKey) &&
      /^[A-Za-z0-9_-]{43}$/.test(privateKey)
    ) {
      try {
        const key = createECDH("prime256v1");
        key.setPrivateKey(Buffer.from(privateKey, "base64url"));
        if (!key.getPublicKey().equals(Buffer.from(publicKey, "base64url")))
          issue(
            "VAPID_PUBLIC_KEY",
            "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be a matching key pair.",
          );
      } catch {
        // Shape problems are already reported above.
      }
    }
    const subject = values.VAPID_SUBJECT;
    if (
      subject !== undefined &&
      !(
        (subject.startsWith("mailto:") &&
          z.email().safeParse(subject.slice(7)).success) ||
        (subject.startsWith("https://") && z.url().safeParse(subject).success)
      )
    )
      issue(
        "VAPID_SUBJECT",
        "VAPID_SUBJECT must be a mailto: address or an https:// URL.",
      );
  })
  .superRefine((values, ctx) => {
    const required = [
      "OBJECT_STORAGE_REGION",
      "OBJECT_STORAGE_ACCESS_KEY_ID",
      "OBJECT_STORAGE_SECRET_ACCESS_KEY",
      "OBJECT_STORAGE_PRIVATE_BUCKET",
      "OBJECT_STORAGE_PUBLIC_BUCKET",
      "OBJECT_STORAGE_PUBLIC_BASE_URL",
    ] as const;
    const anySet =
      required.some((key) => values[key] !== undefined) ||
      values.OBJECT_STORAGE_ENDPOINT !== undefined;
    if (!anySet) return;
    for (const key of required)
      if (values[key] === undefined)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Required once any OBJECT_STORAGE_* setting is set.",
        });
    // S3ObjectStorage refuses these too; failing here names the key at boot.
    if (
      values.OBJECT_STORAGE_PRIVATE_BUCKET !== undefined &&
      values.OBJECT_STORAGE_PRIVATE_BUCKET ===
        values.OBJECT_STORAGE_PUBLIC_BUCKET
    )
      ctx.addIssue({
        code: "custom",
        path: ["OBJECT_STORAGE_PUBLIC_BUCKET"],
        message: "The public and private buckets must differ.",
      });
    if (
      values.OBJECT_STORAGE_PUBLIC_BASE_URL !== undefined &&
      !values.OBJECT_STORAGE_PUBLIC_BASE_URL.startsWith("https://")
    )
      ctx.addIssue({
        code: "custom",
        path: ["OBJECT_STORAGE_PUBLIC_BASE_URL"],
        message: "Use an https:// URL.",
      });
  })
  .superRefine((values, ctx) => {
    // Messages name the problem only, never the key material.
    try {
      assertDataEncryptionActiveVersion(
        values.DATA_ENCRYPTION_ACTIVE_KEY_VERSION,
        parseDataEncryptionKeys(values.DATA_ENCRYPTION_KEYS),
      );
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: [
          error instanceof Error &&
          error.message.startsWith("DATA_ENCRYPTION_ACTIVE")
            ? "DATA_ENCRYPTION_ACTIVE_KEY_VERSION"
            : "DATA_ENCRYPTION_KEYS",
        ],
        message: error instanceof Error ? error.message : "Invalid value.",
      });
    }
    try {
      assertHrisPiiActiveVersion(
        values.HRIS_PII_ACTIVE_KEY_VERSION,
        parseHrisPiiKeys(values.HRIS_PII_KEYS),
      );
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: [
          error instanceof Error && error.message.startsWith("HRIS_PII_ACTIVE")
            ? "HRIS_PII_ACTIVE_KEY_VERSION"
            : "HRIS_PII_KEYS",
        ],
        message: error instanceof Error ? error.message : "Invalid value.",
      });
    }
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
  // legend-k2l: Google needs both halves; SMTP needs all four settings or none.
  .superRefine((values, ctx) => {
    const hasId = values.GOOGLE_CLIENT_ID !== undefined;
    const hasSecret = values.GOOGLE_CLIENT_SECRET !== undefined;
    if (hasId !== hasSecret)
      ctx.addIssue({
        code: "custom",
        path: [hasId ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID"],
        message:
          "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET together, or neither.",
      });
    const smtpKeys = [
      "SMTP_HOST",
      "SMTP_USER",
      "SMTP_PASS",
      "EMAIL_FROM",
    ] as const;
    const missing = smtpKeys.filter((key) => values[key] === undefined);
    if (missing.length > 0 && missing.length < smtpKeys.length)
      for (const key of missing)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required: set SMTP_HOST, SMTP_USER, SMTP_PASS and EMAIL_FROM together, or none.`,
        });
  })
  .superRefine((values, ctx) => {
    // Version 1 is the old tenant-wide pepper; only dev data may stay on it.
    if (
      values.NODE_ENV === "production" &&
      values.STAFF_PIN_PEPPER_CURRENT_VERSION < 2
    )
      ctx.addIssue({
        code: "custom",
        path: ["STAFF_PIN_PEPPER_CURRENT_VERSION"],
        message:
          "STAFF_PIN_PEPPER_CURRENT_VERSION must be 2 or higher in production.",
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
    // An edge node seals selfies to the cloud's PUBLIC key, which arrives in
    // the people snapshot. The private keys stay on the cloud: a stolen edge
    // must not be able to open sealed selfies (design hris-edge-replication 7).
    if (!values.EDGE_MODE) return;
    for (const path of [
      "ATTENDANCE_SELFIE_SEAL_KEYS",
      "ATTENDANCE_SELFIE_SEAL_ACTIVE_KID",
    ] as const)
      if (values[path] !== undefined)
        ctx.addIssue({
          code: "custom",
          path: [path],
          message: `An edge node must not hold ${path}: the seal private keys stay on the cloud.`,
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
      values.NODE_ENV !== "production" ||
      values.EDGE_MODE ||
      Boolean(values.STAFF_PIN_PEPPER),
    {
      path: ["STAFF_PIN_PEPPER"],
      message:
        "Set STAFF_PIN_PEPPER in production so a BETTER_AUTH_SECRET rotation does not wipe staff pins.",
    },
  )
  .refine(
    (values) => !values.EDGE_MODE || values.STAFF_PIN_PEPPER === undefined,
    {
      // legend-ideif: an edge node holds only the outlet-derived peppers the
      // cloud sends it. The root secret on an edge box would let a stolen box derive
      // every tenant's pepper, so the node refuses to boot with it (fail closed).
      path: ["STAFF_PIN_PEPPER"],
      message:
        "STAFF_PIN_PEPPER (the root pepper) must not be set on an edge node: remove it from the edge environment; the cloud delivers the outlet pepper over the sync.",
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
      values.NODE_ENV !== "production" ||
      values.EDGE_MODE ||
      (globalThis as { __LEGEND_PROCESS_ROLE?: string })
        .__LEGEND_PROCESS_ROLE === "worker" ||
      Boolean(values.PAYOUT_GRANTOR_DATABASE_URL),
    {
      // legend-786te: without the grantor login every trusted payout step
      // answers 503, so the production api refuses to start instead. Two
      // processes never serve payout steps and never receive the login
      // (check-compose-env.mjs forbids it): the worker, which marks itself
      // in code (legend-9n1mu: src/role-worker.ts, first import of
      // worker-main.ts; an env var such as WORKER_DATABASE_URL never
      // exempts the api), and an outlet edge node (payroll routes are not in
      // its route list). Edge has no separate entrypoint, so it is still
      // exempt through EDGE_MODE.
      path: ["PAYOUT_GRANTOR_DATABASE_URL"],
      message:
        "Set PAYOUT_GRANTOR_DATABASE_URL to the payout grantor login (legend_grant_*) in production.",
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
  // legend-k2l: Google sign-in is on only with both credentials (the schema
  // refuses one without the other).
  googleEnabled:
    values.GOOGLE_CLIENT_ID !== undefined &&
    values.GOOGLE_CLIENT_SECRET !== undefined,
  // legend-k2l: member email sign-in is on only with the full SMTP set (the
  // schema refuses a partial one).
  smtpEnabled:
    values.SMTP_HOST !== undefined &&
    values.SMTP_USER !== undefined &&
    values.SMTP_PASS !== undefined &&
    values.EMAIL_FROM !== undefined,
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
