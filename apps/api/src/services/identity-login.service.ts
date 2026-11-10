// WhatsApp reverse-OTP login, browser side (PRD v1.7 §3 F6 "Pelanggan —
// WhatsApp Reverse OTP", flow §4 C; AUTH-01, AUTH-04).
//
// The guest asks for a code in the browser, the API issues a challenge bound to
// that browser, the guest sends "MASUK <BRAND> <kode>" to the tenant's WhatsApp
// number, the KirimDev webhook completes the challenge
// (identity-wa-inbound.service.ts), and the polling browser collects the
// session exactly once. No message is ever sent to the guest (AUTH-03).
//
// Everything the contract fixes lives in @starter/shared/identity: the code
// (8 Crockford symbols = 40 bits), its 5-minute window, the message parser, the
// wa.me deep link, the rate-limit helpers and the state checks. This service
// owns the rows, the keyed digests and the per-tenant number.
//
// The per-tenant number comes from the tenant's `whatsapp` integration
// (`tenant_integrations`, PRD §3 F4 "Integrasi per Tenant"):
// - `receivingNumber` (digits) is the number the guest messages and the one the
//   wa.me deep link opens — required;
// - `phoneNumberId` is the value KirimDev puts in `phone_number_id`, i.e. Meta's
//   phone number id; when a deployment's provider forwards the MSISDN instead,
//   this stays unset and the receiving number is the routing key;
// - `loginKeyword` is the brand's login command ("MASUK LEGEND"); PRD §3 F6
//   fixes the MASUK prefix, so anything else falls back to the default.
//
// A challenge records the routing key it may be completed by, so a message
// arriving on another tenant's number is rejected instead of completing it:
// tenant scoping of these global tables lives here, not in RLS (coordinator
// decision, docs/plan/contracts.md `login_challenges`).

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  assertChallengeRateLimit,
  assertLoginChallengeSessionClaimable,
  cancelChallenge,
  expireLoginChallenge,
  formatLoginCode,
  generateLoginCode,
  loginChallengeSchema,
  loginChallengeViewSchema,
  LOGIN_CODE_TTL_MINUTES,
  MINUTE_MS,
  normalizeWhatsAppNumber,
  whatsAppLoginDeepLink,
  IdentityError,
  type LoginChallenge,
  type LoginChallengeIssued,
  type LoginChallengeView,
} from "@starter/shared/identity";
import { CoreError, type TenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db";
import { loginChallenges, tenants, tenantIntegrations } from "../db/schema";
import { withTenant } from "../db/tenant";
import { clientIpDigest, loginCodeDigest } from "../lib/identity-digest";
import { logger } from "../lib/logger";
import { bindingDigestOf } from "../lib/login-binding";
import {
  createCustomerSession,
  type IssuedSession,
} from "../lib/identity-session";

import { recordLoginAudit } from "./identity-wa-audit.ts";
import { loadSessionRow } from "./identity-session.service";

type ChallengeRow = typeof loginChallenges.$inferSelect;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** How the tenant's WhatsApp number is addressed (see the file comment). */
export type WhatsAppChannel = {
  /** Value matched against the webhook's `phone_number_id`. */
  readonly routingNumber: string;
  /** Digits used in the wa.me deep link (`628…`). */
  readonly receivingNumber: string;
  /** Brand login command, always starting with MASUK. */
  readonly keyword: string;
};

const DEFAULT_LOGIN_KEYWORD = "MASUK LEGEND";
/** CHALLENGE_RATE_WINDOW_MINUTES in the identity contract (AUTH-04). */
const CHALLENGE_WINDOW_MINUTES = 15;

function configText(
  config: Record<string, string | number | boolean | null>,
  key: string,
): string | null {
  const value = config[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Reads the tenant's active `whatsapp` integration. A tenant without a usable
 * receiving number cannot offer WhatsApp login: fail closed with
 * SERVICE_UNAVAILABLE (the login screen offers the other sign-in methods).
 */
export async function resolveWhatsAppChannel(
  tx: Transaction,
  context: ScopedTenantContext,
): Promise<WhatsAppChannel> {
  const rows = await tx
    .select({ config: tenantIntegrations.config })
    .from(tenantIntegrations)
    .where(
      and(
        eq(tenantIntegrations.tenantId, context.tenant.tenantId),
        eq(tenantIntegrations.provider, "whatsapp"),
        eq(tenantIntegrations.status, "active"),
        isNull(tenantIntegrations.outletId),
      ),
    )
    .limit(1);
  const config = rows[0]?.config;
  if (!config)
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Masuk dengan WhatsApp belum tersedia untuk tenant ini.",
    );
  const receivingNumber = normalizeWhatsAppNumber(
    configText(config, "receivingNumber"),
  );
  if (receivingNumber === null)
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Nomor WhatsApp tenant belum diatur.",
    );
  // Meta's phone_number_id is not the MSISDN. Match it when configured, and
  // otherwise compare against the receiving number (adapted AUTH-02: KirimDev's
  // delivery carries `phone_number_id`).
  const routingNumber = configText(config, "phoneNumberId") ?? receivingNumber;
  const rawKeyword = configText(config, "loginKeyword")?.toUpperCase();
  const keyword =
    rawKeyword && /^MASUK(\s+\S+)*$/.test(rawKeyword)
      ? rawKeyword
      : DEFAULT_LOGIN_KEYWORD;
  return { routingNumber, receivingNumber, keyword };
}

function toChallenge(row: ChallengeRow): LoginChallenge {
  return loginChallengeSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    brandId: row.brandId,
    channel: row.channel,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    matchedUserId: row.matchedUserId,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * The tenant scope a stored challenge belongs to, for its audit rows. A row
 * with no tenant has nowhere to write an audit row (login_challenges.tenant_id
 * is nullable), so it is not audited.
 */
function challengeContext(row: ChallengeRow): ScopedTenantContext | null {
  if (row.tenantId === null) return null;
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: row.tenantId,
      brandId: row.brandId,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** A tenant that is not active cannot hand out sessions (fail closed). */
async function assertTenantActive(
  tx: Transaction,
  context: ScopedTenantContext,
): Promise<void> {
  const rows = await tx
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, context.tenant.tenantId))
    .limit(1);
  if (rows[0]?.status !== "active")
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Tenant ini sedang tidak aktif.",
    );
}

/**
 * AUTH-04: at most 5 active challenges per device or IP in 15 minutes. Counts
 * every challenge opened in the window — the stricter reading, so cancelling a
 * challenge cannot buy more attempts — and matches either pivot: the browser's
 * binding digest (this device) or the keyed client IP.
 */
async function assertPerDeviceLimit(
  tx: Transaction,
  input: { bindingHash: string; ipHash: string | null; now: Date },
): Promise<void> {
  const windowStart = new Date(
    input.now.getTime() - CHALLENGE_WINDOW_MINUTES * MINUTE_MS,
  );
  const rows = await tx
    .select({ createdAt: loginChallenges.createdAt })
    .from(loginChallenges)
    .where(
      and(
        eq(loginChallenges.channel, "whatsapp_inbound"),
        gt(loginChallenges.createdAt, windowStart),
        input.ipHash
          ? or(
              eq(loginChallenges.browserBindingHash, input.bindingHash),
              eq(loginChallenges.ipHash, input.ipHash),
            )
          : eq(loginChallenges.browserBindingHash, input.bindingHash),
      ),
    );
  assertChallengeRateLimit({
    openChallengeOpenedAt: rows.map((row) => row.createdAt),
    now: input.now,
  });
}

export type IssueChallengeDeps = {
  /** Test clock; production uses the wall clock. */
  readonly now?: Date;
  /** Test seam for a deterministic code; production uses the CSPRNG. */
  readonly generateCode?: () => string;
};

/**
 * Issues a challenge for `tenant` and the browser that holds `bindingNonce`.
 * The code and deep link are returned exactly once (AUTH-01).
 */
export async function issueWhatsAppChallenge(
  tenant: TenantContext,
  request: {
    bindingNonce: string;
    link?: { userId: string; sessionId: string } | null;
    ip: string | null;
    userAgent: string | null;
  },
  deps: IssueChallengeDeps = {},
): Promise<LoginChallengeIssued> {
  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  const now = deps.now ?? new Date();
  const code = (deps.generateCode ?? generateLoginCode)();
  const bindingHash = bindingDigestOf(request.bindingNonce);
  const ipHash = request.ip ? clientIpDigest(request.ip) : null;

  // legend-k2l: a session that signed in on another device may not link a
  // number (design ws08 M2); the owner proves the phone again first.
  if (request.link) {
    const linking = await loadSessionRow(request.link.sessionId);
    if (linking?.authCrossDevice === true)
      throw new IdentityError("IDENTITY_LINK_REAUTH_REQUIRED");
  }

  const issued = await withTenant(db, context, async (tx) => {
    await assertTenantActive(tx, context);
    const channel = await resolveWhatsAppChannel(tx, context);
    for (const key of [bindingHash, ipHash]
      .filter((value): value is string => value !== null)
      .sort())
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
    await assertPerDeviceLimit(tx, { bindingHash, ipHash, now });
    const [row] = await tx
      .insert(loginChallenges)
      .values({
        tenantId: tenant.tenantId,
        brandId: tenant.brandId,
        channel: "whatsapp_inbound",
        codeHash: loginCodeDigest(code),
        browserBindingHash: bindingHash,
        linkUserId: request.link?.userId ?? null,
        linkSessionId: request.link?.sessionId ?? null,
        receivingNumber: channel.routingNumber,
        status: "pending",
        expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_MINUTES * MINUTE_MS),
        ipHash,
        userAgent: request.userAgent?.slice(0, 255) ?? null,
        createdAt: now,
      })
      .returning();
    if (!row) throw new Error("The login challenge was not stored");
    // legend-wq3f: the issuance row commits with the challenge it describes.
    await recordLoginAudit(tx, context, {
      action: "login_challenge.created",
      challengeId: row.id,
      details: {
        channel: "whatsapp_inbound",
        status: "pending",
        expiresAt: row.expiresAt.toISOString(),
        linking: row.linkUserId !== null,
      },
      now,
      ipHash,
    });
    return { row, channel };
  }).catch(async (error: unknown) => {
    // AUTH-04: the refused request rolled its transaction back, so the audit
    // row for the refusal is written on its own. Best effort: a failing audit
    // write must not turn a 429 into a 503 or hide the original error.
    if (error instanceof CoreError && error.code === "RATE_LIMITED")
      await auditRateLimited(context, {
        ipHash,
        pivot: ipHash ?? bindingHash,
        now,
      });
    throw error;
  });

  return {
    challenge: toChallenge(issued.row),
    code,
    codeFormatted: formatLoginCode(code),
    whatsAppDeepLink: whatsAppLoginDeepLink({
      numberDigits: issued.channel.receivingNumber,
      code,
      keyword: issued.channel.keyword,
    }),
  };
}

/**
 * The endpoint has no HTTP rate limit of its own, and audit_logs is append-only
 * (2 years), so an anonymous flood of refused requests must not become a flood
 * of audit rows: one rate_limited row per tenant and device/IP pivot per
 * AUTH-04 window. Process-local and bounded; a second API instance may add one
 * more row per window, which is still bounded.
 */
const RATE_AUDIT_MAX_KEYS = 5000;
const rateAuditWindowStart = new Map<string, number>();

function shouldAuditRateLimit(
  tenantId: string,
  pivot: string,
  now: Date,
): boolean {
  const windowMs = CHALLENGE_WINDOW_MINUTES * MINUTE_MS;
  const at = now.getTime();
  if (rateAuditWindowStart.size >= RATE_AUDIT_MAX_KEYS)
    for (const [key, started] of rateAuditWindowStart)
      if (at - started >= windowMs) rateAuditWindowStart.delete(key);
  // Still full of live windows: skip the row rather than grow without bound.
  if (rateAuditWindowStart.size >= RATE_AUDIT_MAX_KEYS) return false;
  const key = `${tenantId}\u0000${pivot}`;
  const started = rateAuditWindowStart.get(key);
  if (started !== undefined && at - started < windowMs) return false;
  rateAuditWindowStart.set(key, at);
  return true;
}

async function auditRateLimited(
  context: ScopedTenantContext,
  input: { ipHash: string | null; pivot: string; now: Date },
): Promise<void> {
  if (!shouldAuditRateLimit(context.tenant.tenantId, input.pivot, input.now))
    return;
  try {
    await withTenant(db, context, (tx) =>
      recordLoginAudit(tx, context, {
        action: "login_challenge.rate_limited",
        challengeId: null,
        details: { channel: "whatsapp_inbound", cause: "per_device_limit" },
        now: input.now,
        ipHash: input.ipHash,
      }),
    );
  } catch (error) {
    logger.warn(
      { err: error, tenantId: context.tenant.tenantId },
      "failed to audit a rate-limited login challenge",
    );
  }
}

/** Best effort: the session error is the one the caller must see. */
async function auditClaimFailed(
  context: ScopedTenantContext | null,
  row: ChallengeRow,
  now: Date,
  ipHash: string | null,
): Promise<void> {
  if (context === null) return;
  try {
    await withTenant(db, context, (tx) =>
      recordLoginAudit(tx, context, {
        action: "login_challenge.claim_failed",
        challengeId: row.id,
        actorUserId: row.matchedUserId,
        details: {
          channel: "whatsapp_inbound",
          status: "completed",
          cause: "session_not_created",
        },
        now,
        ipHash,
      }),
    );
  } catch (error) {
    logger.warn(
      { err: error, tenantId: row.tenantId },
      "failed to audit a login session claim failure",
    );
  }
}

async function loadChallenge(
  challengeId: string,
): Promise<ChallengeRow | null> {
  const [row] = await db
    .select()
    .from(loginChallenges)
    .where(eq(loginChallenges.id, challengeId))
    .limit(1);
  return row ?? null;
}

/** Refuses a browser that is not the one that asked (AUTH-01). */
function assertBinding(row: ChallengeRow, bindingNonce: string | null): void {
  if (
    bindingNonce === null ||
    bindingDigestOf(bindingNonce) !== row.browserBindingHash
  )
    throw new IdentityError("CHALLENGE_BROWSER_MISMATCH");
}

export type ChallengePollDeps = {
  readonly now?: Date;
  /** Test seam; production uses lib/identity-session.ts. */
  readonly createSession?: typeof createCustomerSession;
};

export type PolledChallenge = {
  /** The contract's poll DTO (no secret material). */
  readonly view: LoginChallengeView;
  /** The session to set as a cookie, when this poll claimed it. */
  readonly session: IssuedSession | null;
};

function pendingView(challenge: LoginChallenge): LoginChallengeView {
  return {
    challenge,
    session: null,
    mfaRequired: false,
    mfaEnrollmentRequired: false,
  };
}

/**
 * The polling browser's view of its challenge. Once the webhook completed it,
 * the first poll from the bound browser claims the session (AUTH-01 single
 * use); later polls answer CHALLENGE_NOT_PENDING.
 */
export async function pollWhatsAppChallenge(
  challengeId: string,
  request: {
    bindingNonce: string | null;
    link?: { userId: string; sessionId: string } | null;
    ip: string | null;
    userAgent: string | null;
  },
  deps: ChallengePollDeps = {},
): Promise<PolledChallenge> {
  const now = deps.now ?? new Date();
  const row = await loadChallenge(challengeId);
  if (!row) throw new CoreError("NOT_FOUND", "Kode masuk tidak ditemukan.");
  assertBinding(row, request.bindingNonce);
  // legend-k2l: a link that merged with the signed-in account U as the
  // ABSORBED one completes with the survivor as matched user, and U's sessions
  // are gone. The bound browser (checked above) then claims one session for
  // the survivor below, so the link-session check does not apply to it.
  const absorbedIntoSurvivor =
    row.linkUserId !== null &&
    row.status === "completed" &&
    row.matchedUserId !== null &&
    row.matchedUserId !== row.linkUserId;
  if (row.linkUserId !== null && !absorbedIntoSurvivor) {
    if (
      request.link?.userId !== row.linkUserId ||
      request.link?.sessionId !== row.linkSessionId
    )
      throw new CoreError("FORBIDDEN", "Sesi penautan tidak cocok.");
    // legend-k2l: a successful merge completes the challenge, so a cancel with
    // a matched user only means the link was refused.
    if (row.status === "cancelled" && row.matchedUserId !== null)
      throw new IdentityError(
        row.matchedUserId === row.linkUserId
          ? "WHATSAPP_ALREADY_ON_ACCOUNT"
          : "IDENTITY_MERGE_NEEDS_SUPPORT",
      );
  }

  if (row.status === "pending") {
    const expired = expireLoginChallenge(toChallenge(row), now);
    if (expired.status !== "expired")
      return { view: pendingView(toChallenge(row)), session: null };
    const expiredContext = challengeContext(row);
    const markExpired = async (tx: Pick<typeof db, "update">) =>
      tx
        .update(loginChallenges)
        .set({ status: "expired" })
        .where(
          and(
            eq(loginChallenges.id, row.id),
            eq(loginChallenges.status, "pending"),
          ),
        )
        .returning({ id: loginChallenges.id });
    if (expiredContext === null) await markExpired(db);
    else
      await withTenant(db, expiredContext, async (tx) => {
        // Audit only the poll that actually flipped the row (idempotent).
        const flipped = await markExpired(tx);
        if (flipped.length === 1)
          await recordLoginAudit(tx, expiredContext, {
            action: "login_challenge.expired",
            challengeId: row.id,
            details: {
              channel: "whatsapp_inbound",
              status: "expired",
              cause: "ttl_elapsed",
              linking: row.linkUserId !== null,
            },
            now,
            ipHash: row.ipHash,
          });
      });
    return { view: pendingView(expired), session: null };
  }

  if (row.linkUserId !== null && !absorbedIntoSurvivor)
    return { view: pendingView(toChallenge(row)), session: null };

  if (row.status !== "completed" || row.matchedUserId === null)
    return { view: pendingView(toChallenge(row)), session: null };

  // The contract's guard: only a completed, not-yet-claimed whatsapp challenge
  // of the bound browser may hand out a session.
  assertLoginChallengeSessionClaimable({
    challenge: toChallenge(row),
    browserBindingMatches: true,
    sessionAlreadyIssued: row.sessionIssuedAt !== null,
  });

  // Reserve the claim atomically, so two racing polls cannot both create a
  // session; the loser gets CHALLENGE_NOT_PENDING.
  // The audit row commits with the reservation, so a claim is never unrecorded.
  const claimContext = challengeContext(row);
  // The claiming request's IP, not the issuing one: a stolen binding cookie
  // used from another network must show up in the trail.
  const claimIpHash = request.ip ? clientIpDigest(request.ip) : null;
  const reserveClaim = (tx: Pick<typeof db, "update">) =>
    tx
      .update(loginChallenges)
      .set({ sessionIssuedAt: now })
      .where(
        and(
          eq(loginChallenges.id, row.id),
          isNull(loginChallenges.sessionIssuedAt),
        ),
      )
      .returning({ id: loginChallenges.id });
  const reserved =
    claimContext === null
      ? await reserveClaim(db)
      : await withTenant(db, claimContext, async (tx) => {
          const claimed = await reserveClaim(tx);
          if (claimed.length === 1)
            await recordLoginAudit(tx, claimContext, {
              action: "login_challenge.claimed",
              challengeId: row.id,
              actorUserId: row.matchedUserId,
              details: {
                channel: "whatsapp_inbound",
                status: "completed",
                matchedUserId: row.matchedUserId,
              },
              now,
              ipHash: claimIpHash,
            });
          return claimed;
        });
  if (reserved.length === 0) throw new IdentityError("CHALLENGE_NOT_PENDING");

  let session: IssuedSession;
  try {
    session = await (deps.createSession ?? createCustomerSession)({
      userId: row.matchedUserId,
      ipAddress: request.ip,
      userAgent: request.userAgent,
      now,
      authMethod: "whatsapp",
    });
  } catch (error) {
    // Release the reservation so the browser can retry; nothing was issued.
    await db
      .update(loginChallenges)
      .set({ sessionIssuedAt: null })
      .where(eq(loginChallenges.id, row.id));
    await auditClaimFailed(claimContext, row, now, claimIpHash);
    throw error;
  }
  await db
    .update(loginChallenges)
    .set({ sessionId: session.id })
    .where(eq(loginChallenges.id, row.id));

  return {
    view: loginChallengeViewSchema.parse({
      challenge: toChallenge(row),
      session: {
        id: session.id,
        userId: row.matchedUserId,
        tenantId: row.tenantId,
        kind: "customer",
        deviceLabel: (request.userAgent ?? "Perangkat ini").slice(0, 120),
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        revokedAt: null,
        mfaVerifiedAt: null,
      },
      mfaRequired: false,
      mfaEnrollmentRequired: false,
    }),
    session,
  };
}

/** "Bukan saya": the bound browser cancels its own pending challenge. */
export async function cancelWhatsAppChallenge(
  challengeId: string,
  bindingNonce: string | null,
): Promise<void> {
  const row = await loadChallenge(challengeId);
  if (!row) throw new CoreError("NOT_FOUND", "Kode masuk tidak ditemukan.");
  assertBinding(row, bindingNonce);
  const cancelled = cancelChallenge(toChallenge(row));
  if (cancelled.status === row.status) return;
  const cancelContext = challengeContext(row);
  const markCancelled = (tx: Pick<typeof db, "update">) =>
    tx
      .update(loginChallenges)
      .set({ status: cancelled.status })
      .where(
        and(
          eq(loginChallenges.id, row.id),
          eq(loginChallenges.status, "pending"),
        ),
      )
      .returning({ id: loginChallenges.id });
  if (cancelContext === null) {
    await markCancelled(db);
    return;
  }
  await withTenant(db, cancelContext, async (tx) => {
    const flipped = await markCancelled(tx);
    if (flipped.length === 1)
      await recordLoginAudit(tx, cancelContext, {
        action: "login_challenge.cancelled",
        challengeId: row.id,
        details: {
          channel: "whatsapp_inbound",
          status: cancelled.status,
          cause: "browser_cancelled",
          linking: row.linkUserId !== null,
        },
        now: new Date(),
        ipHash: row.ipHash,
      });
  });
}
