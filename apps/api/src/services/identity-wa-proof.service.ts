// WhatsApp inbound proof for purposes other than sign-in (bead legend-lgfru,
// design docs/design/whatsapp-inbound-verification.md D-WA1..D-WA3, §3, §6.1).
//
// A signed-in user proves they hold their own WhatsApp number by sending
// `RESET PIN <code>` to the tenant's number. The proof reuses `login_challenges`
// (one global table, the code index the webhook already searches), the signed
// KirimDev webhook, its dedupe and its per-number limit. What differs:
//
// - the row has `purpose = 'payslip_pin_reset'`, is bound to the requesting
//   user, session and browser, and names the sender digest that must send it
//   (`expected_sender_hash`); the CHECKs in migration 0250 keep it free of any
//   login result (no matched user, no session);
// - the webhook completes it here (`completeProof`) and nothing else: no
//   account resolution, no link, no merge, no session, no WhatsApp reply;
// - the HRIS step that uses it calls `consumeWhatsAppProof` once, inside a
//   10-minute grant window, with every binding checked in one UPDATE.
//
// `login_challenges` has no RLS, so every query here filters `tenant_id`
// explicitly even when it runs inside a tenant transaction (design §5.3).

import { and, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  generateLoginCode,
  formatLoginCode,
  MINUTE_MS,
  DAY_MS,
  PAYSLIP_PIN_PROOF_GRANT_MINUTES,
  PAYSLIP_PIN_PROOF_PER_USER_PER_HOUR,
  WA_PROOF_IDENTITY_MIN_AGE_DAYS,
  WA_PROOF_TTL_MINUTES,
  whatsAppProofDeepLink,
} from "@starter/shared/identity";
import {
  CoreError,
  createUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { db } from "../db";
import { loginChallenges, tenants, userIdentities } from "../db/schema";
import { loginCodeDigest, whatsAppDigest } from "../lib/identity-digest";
import { logger } from "../lib/logger";
import { openSecret } from "../lib/secrets";
import { recordAudit } from "./core-audit.ts";
import {
  assertTenantActive,
  assertWhatsAppWebhookConfigured,
  resolveWhatsAppChannel,
} from "./identity-login.service";
import { maskSenderForAudit } from "./identity-wa-audit.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Sign-in stays in identity-login.service; this service owns the others. */
export type WhatsAppProofPurpose = "payslip_pin_reset";

export type WhatsAppProofStatus =
  "pending" | "verified" | "used" | "expired" | "cancelled";

export type WhatsAppProofBinding = {
  readonly challengeId: string;
  readonly purpose: WhatsAppProofPurpose;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly bindingHash: string;
  readonly now: Date;
};

/** The only `after` keys a proof audit row keeps; anything else is redacted. */
const PROOF_AUDIT_SAFE_FIELDS = [
  "purpose",
  "status",
  "cause",
  "senderMasked",
] as const;

async function auditProof(
  tx: Transaction,
  context: ScopedTenantContext,
  input: {
    action: string;
    challengeId: string;
    actorUserId: string | null;
    details: Record<string, string | null>;
    now: Date;
  },
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(input.now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: input.actorUserId ? "user" : "system",
      actorId: input.actorUserId,
      deviceId: null,
      action: input.action,
      objectType: "login_challenge",
      objectId: input.challengeId,
      reason: null,
      maskedChanges: { before: null, after: input.details },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: input.now.toISOString(),
    },
    PROOF_AUDIT_SAFE_FIELDS,
  );
}

/**
 * Opens a proof. Refuses with SERVICE_UNAVAILABLE (503) when the webhook has no
 * secret or the tenant has no active `whatsapp` integration, and RATE_LIMITED
 * after `PAYSLIP_PIN_PROOF_PER_USER_PER_HOUR` proofs in an hour (per user, not
 * per IP). A new proof cancels the user's pending one (design D-WA6). The code
 * is returned once and never stored.
 */
export async function issueWhatsAppProof(
  tx: Transaction,
  context: ScopedTenantContext,
  input: {
    readonly purpose: WhatsAppProofPurpose;
    readonly userId: string;
    readonly sessionId: string;
    readonly bindingHash: string;
    readonly expectedSenderHash: string;
    readonly ipHash: string | null;
    readonly userAgent: string | null;
    readonly now: Date;
    /** Defaults to KIRIM_WEBHOOK_SECRET; routes pass createApp's override. */
    readonly webhookSecrets?: readonly string[];
    /** Test seam for a deterministic code; production uses the CSPRNG. */
    readonly generateCode?: () => string;
  },
): Promise<{
  challengeId: string;
  code: string;
  waLink: string;
  expiresAt: Date;
}> {
  assertWhatsAppWebhookConfigured(input.webhookSecrets);
  // Same gate as the sign-in path: a suspended tenant issues nothing.
  await assertTenantActive(tx, context);
  const tenantId = context.tenant.tenantId;
  const channel = await resolveWhatsAppChannel(tx, context);

  // Serialize the limit check and the insert for this user and purpose.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wa-proof:${input.purpose}:${input.userId}`}, 0))`,
  );
  const windowStart = new Date(input.now.getTime() - 60 * MINUTE_MS);
  // Every proof opened in the hour counts, cancelled ones included, so
  // cancelling cannot buy more attempts.
  const recent = await tx
    .select({ id: loginChallenges.id, createdAt: loginChallenges.createdAt })
    .from(loginChallenges)
    .where(
      and(
        eq(loginChallenges.purpose, input.purpose),
        eq(loginChallenges.linkUserId, input.userId),
        gt(loginChallenges.createdAt, windowStart),
        lte(loginChallenges.createdAt, input.now),
      ),
    );
  if (recent.length >= PAYSLIP_PIN_PROOF_PER_USER_PER_HOUR) {
    // The oldest proof in the window leaves it 60 minutes after its creation;
    // the limit lifts then (rounded up, at least 1 second).
    const oldest = Math.min(...recent.map((row) => row.createdAt.getTime()));
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + 60 * MINUTE_MS - input.now.getTime()) / 1000),
    );
    throw new CoreError(
      "RATE_LIMITED",
      "Terlalu banyak permintaan. Coba lagi nanti.",
      { retryAfterSeconds },
    );
  }

  await tx
    .update(loginChallenges)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(loginChallenges.purpose, input.purpose),
        eq(loginChallenges.tenantId, tenantId),
        eq(loginChallenges.linkUserId, input.userId),
        eq(loginChallenges.status, "pending"),
      ),
    );

  const code = (input.generateCode ?? generateLoginCode)();
  const [row] = await tx
    .insert(loginChallenges)
    .values({
      tenantId,
      brandId: context.tenant.brandId,
      channel: "whatsapp_inbound",
      purpose: input.purpose,
      codeHash: loginCodeDigest(code),
      browserBindingHash: input.bindingHash,
      expectedSenderHash: input.expectedSenderHash,
      linkUserId: input.userId,
      linkSessionId: input.sessionId,
      receivingNumber: channel.routingNumber,
      status: "pending",
      expiresAt: new Date(
        input.now.getTime() + WA_PROOF_TTL_MINUTES * MINUTE_MS,
      ),
      ipHash: input.ipHash,
      userAgent: input.userAgent?.slice(0, 255) ?? null,
      createdAt: input.now,
    })
    .returning({
      id: loginChallenges.id,
      expiresAt: loginChallenges.expiresAt,
    });
  if (!row) throw new Error("The WhatsApp proof was not stored");
  return {
    challengeId: row.id,
    code: formatLoginCode(code),
    waLink: whatsAppProofDeepLink({
      numberDigits: channel.receivingNumber,
      code,
    }),
    expiresAt: row.expiresAt,
  };
}

/** The bindings every read and consume must match (design §3). */
function boundTo(input: Omit<WhatsAppProofBinding, "now">) {
  return and(
    eq(loginChallenges.id, input.challengeId),
    eq(loginChallenges.purpose, input.purpose),
    eq(loginChallenges.tenantId, input.tenantId),
    eq(loginChallenges.linkUserId, input.userId),
    eq(loginChallenges.linkSessionId, input.sessionId),
    eq(loginChallenges.browserBindingHash, input.bindingHash),
  );
}

const GRANT_MS = PAYSLIP_PIN_PROOF_GRANT_MINUTES * MINUTE_MS;

/**
 * The polling browser's view. Null when nothing matches every binding; the
 * route answers 404 without saying which binding failed.
 */
export async function readWhatsAppProof(
  tx: Transaction,
  input: WhatsAppProofBinding,
): Promise<{
  status: WhatsAppProofStatus;
  expiresAt: Date;
  grantExpiresAt: Date | null;
} | null> {
  const [row] = await tx
    .select({
      status: loginChallenges.status,
      expiresAt: loginChallenges.expiresAt,
      completedAt: loginChallenges.completedAt,
      consumedAt: loginChallenges.consumedAt,
    })
    .from(loginChallenges)
    .where(boundTo(input))
    .limit(1);
  if (!row) return null;
  if (row.status === "pending") {
    if (row.expiresAt.getTime() > input.now.getTime())
      return {
        status: "pending",
        expiresAt: row.expiresAt,
        grantExpiresAt: null,
      };
    await tx
      .update(loginChallenges)
      .set({ status: "expired" })
      .where(
        and(
          eq(loginChallenges.id, input.challengeId),
          eq(loginChallenges.status, "pending"),
        ),
      );
    return {
      status: "expired",
      expiresAt: row.expiresAt,
      grantExpiresAt: null,
    };
  }
  if (row.status === "completed") {
    if (row.consumedAt !== null)
      return { status: "used", expiresAt: row.expiresAt, grantExpiresAt: null };
    const grantExpiresAt = new Date(
      (row.completedAt ?? row.expiresAt).getTime() + GRANT_MS,
    );
    return grantExpiresAt.getTime() > input.now.getTime()
      ? { status: "verified", expiresAt: row.expiresAt, grantExpiresAt }
      : { status: "expired", expiresAt: row.expiresAt, grantExpiresAt };
  }
  return {
    status: row.status === "cancelled" ? "cancelled" : "expired",
    expiresAt: row.expiresAt,
    grantExpiresAt: null,
  };
}

/**
 * Uses a verified proof once: one conditional UPDATE over every binding and the
 * grant window. False means the caller answers 403
 * PAYSLIP_PIN_RESET_PROOF_INVALID, one message for every cause.
 */
export async function consumeWhatsAppProof(
  tx: Transaction,
  input: WhatsAppProofBinding,
): Promise<boolean> {
  const updated = await tx
    .update(loginChallenges)
    .set({ consumedAt: input.now })
    .where(
      and(
        boundTo(input),
        eq(loginChallenges.status, "completed"),
        isNull(loginChallenges.consumedAt),
        isNotNull(loginChallenges.completedAt),
        gt(
          loginChallenges.completedAt,
          new Date(input.now.getTime() - GRANT_MS),
        ),
      ),
    )
    .returning({ id: loginChallenges.id });
  return updated.length === 1;
}

/** Proofs that may still be completed or used. */
const openProof = or(
  eq(loginChallenges.status, "pending"),
  and(
    eq(loginChallenges.status, "completed"),
    isNull(loginChallenges.consumedAt),
  ),
);

/**
 * The owner cancels their proof ("Batal"). NOT_FOUND when the id is not this
 * user's and session's in this tenant; a proof that is already final stays
 * as it is. Returns how many rows were cancelled (0 for a final proof).
 */
export async function cancelWhatsAppProof(
  tx: Transaction,
  input: Omit<WhatsAppProofBinding, "bindingHash">,
): Promise<number> {
  const owned = and(
    eq(loginChallenges.id, input.challengeId),
    eq(loginChallenges.purpose, input.purpose),
    eq(loginChallenges.tenantId, input.tenantId),
    eq(loginChallenges.linkUserId, input.userId),
    eq(loginChallenges.linkSessionId, input.sessionId),
  );
  const [row] = await tx
    .select({ id: loginChallenges.id })
    .from(loginChallenges)
    .where(owned)
    .limit(1);
  if (!row) throw new CoreError("NOT_FOUND", "Verifikasi tidak ditemukan.");
  const cancelled = await tx
    .update(loginChallenges)
    .set({ status: "cancelled" })
    .where(and(owned, openProof))
    .returning({ id: loginChallenges.id });
  return cancelled.length;
}

/**
 * HR reset (design §3): cancels every proof of the user that is pending or
 * verified but not yet used. Returns how many were cancelled.
 */
export async function cancelOpenWhatsAppProofs(
  tx: Transaction,
  input: {
    readonly purpose: WhatsAppProofPurpose;
    readonly tenantId: string;
    readonly userId: string;
    readonly now: Date;
  },
): Promise<number> {
  const cancelled = await tx
    .update(loginChallenges)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(loginChallenges.purpose, input.purpose),
        eq(loginChallenges.tenantId, input.tenantId),
        eq(loginChallenges.linkUserId, input.userId),
        openProof,
      ),
    )
    .returning({ id: loginChallenges.id });
  return cancelled.length;
}

/**
 * D-WA3: the user's WhatsApp identity that may send a proof — verified, and
 * linked to this account at least `WA_PROOF_IDENTITY_MIN_AGE_DAYS` days ago
 * (`linked_at`, reset by trigger on merge or re-verification). Null otherwise;
 * the caller answers PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE.
 * `senderHint` is the last four digits of the user's own number.
 */
export async function findWhatsAppProofIdentity(
  tx: Transaction,
  input: { readonly userId: string; readonly now: Date },
): Promise<{ valueHash: string; senderHint: string } | null> {
  const found = await findWhatsAppProofSender(tx, input);
  return found && { valueHash: found.valueHash, senderHint: found.senderHint };
}

/**
 * Why `findWhatsAppProofIdentity` found nothing, for the user's OWN identity
 * only (never another account's): `identity_too_new` when a verified WhatsApp
 * identity exists but was linked less than `WA_PROOF_IDENTITY_MIN_AGE_DAYS`
 * days ago, `identity_missing` when there is none. Reads no number or hash.
 */
export async function diagnoseWhatsAppProofIdentity(
  tx: Transaction,
  input: { readonly userId: string; readonly now: Date },
): Promise<"identity_missing" | "identity_too_new"> {
  const linkedBefore = new Date(
    input.now.getTime() - WA_PROOF_IDENTITY_MIN_AGE_DAYS * DAY_MS,
  );
  const [row] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, input.userId),
        eq(userIdentities.type, "whatsapp"),
        isNotNull(userIdentities.verifiedAt),
        gt(userIdentities.linkedAt, linkedBefore),
      ),
    )
    .limit(1);
  return row ? "identity_too_new" : "identity_missing";
}

/**
 * Same rule as `findWhatsAppProofIdentity`, plus `senderHash`: the digest the
 * webhook computes for this number, i.e. the proof's `expected_sender_hash`.
 * `forUpdate` locks the qualifying identity row (see below).
 */
export async function findWhatsAppProofSender(
  tx: Transaction,
  input: { readonly userId: string; readonly now: Date },
  options: { readonly forUpdate?: boolean } = {},
): Promise<{
  valueHash: string;
  senderHash: string;
  senderHint: string;
} | null> {
  const linkedBefore = new Date(
    input.now.getTime() - WA_PROOF_IDENTITY_MIN_AGE_DAYS * DAY_MS,
  );
  const query = tx
    .select({
      valueHash: userIdentities.valueHash,
      valueEncrypted: userIdentities.valueEncrypted,
    })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, input.userId),
        eq(userIdentities.type, "whatsapp"),
        isNotNull(userIdentities.verifiedAt),
        lte(userIdentities.linkedAt, linkedBefore),
      ),
    )
    .limit(1);
  // `forUpdate`: the row stays locked until the caller's transaction ends, so a
  // concurrent unlink, move or re-link waits, and one that committed first is
  // re-checked against the WHERE (READ COMMITTED) and yields no row.
  const [row] = await (options.forUpdate ? query.for("update") : query);
  if (!row || row.valueEncrypted === null) return null;
  const number = openSecret(
    row.valueEncrypted,
    `user_identity:whatsapp:${row.valueHash}`,
  );
  return {
    valueHash: row.valueHash,
    senderHash: await whatsAppDigest(number),
    senderHint: number.slice(-4),
  };
}

/** Result of a webhook message on a proof row. */
export type ProofCompletion =
  "completed" | "sender_mismatch" | "unrouted" | "refused";

/**
 * Webhook side (called by identity-wa-inbound.service after the code matched
 * a pending, unexpired proof on this receiving number). Tenant active, the
 * tenant's integration still routes this number, the sender digest equals
 * `expected_sender_hash`, then `UPDATE ... WHERE status = 'pending'`.
 * `matched_user_id` stays null. Never links, merges, resolves an account,
 * issues a session or replies.
 */
export async function completeProof(
  tx: Transaction,
  context: ScopedTenantContext,
  input: {
    readonly challengeId: string;
    readonly linkUserId: string | null;
    readonly expectedSenderHash: string | null;
    readonly receivingNumber: string;
    readonly fromHash: string;
    readonly sender: string;
    readonly now: Date;
  },
): Promise<ProofCompletion> {
  const reject = async (cause: "sender_mismatch" | "unrouted") =>
    auditProof(tx, context, {
      action: "payslip_pin.wa_proof_rejected",
      challengeId: input.challengeId,
      actorUserId: input.linkUserId,
      details: {
        purpose: "payslip_pin_reset",
        status: "pending",
        cause,
        senderMasked: maskSenderForAudit(input.sender),
      },
      now: input.now,
    });

  const [tenantRow] = await tx
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, context.tenant.tenantId))
    .limit(1);
  const channel =
    tenantRow?.status === "active"
      ? await resolveWhatsAppChannel(tx, context).catch((error: unknown) => {
          if (
            error instanceof CoreError &&
            error.code === "SERVICE_UNAVAILABLE"
          )
            return null;
          throw error;
        })
      : null;
  if (!channel || channel.routingNumber !== input.receivingNumber) {
    logger.warn(
      {
        tenantId: context.tenant.tenantId,
        reason: channel
          ? "routing_mismatch"
          : tenantRow?.status !== "active"
            ? "tenant_inactive"
            : "channel_unavailable",
      },
      "whatsapp proof unrouted",
    );
    await reject("unrouted");
    return "unrouted";
  }
  if (
    input.expectedSenderHash === null ||
    input.expectedSenderHash !== input.fromHash
  ) {
    // Another number sent the code (a screenshot, a guess): the proof stays
    // pending for its owner, and HR can see the attempt.
    await reject("sender_mismatch");
    return "sender_mismatch";
  }
  const updated = await tx
    .update(loginChallenges)
    .set({ status: "completed", completedAt: input.now })
    .where(
      and(
        eq(loginChallenges.id, input.challengeId),
        eq(loginChallenges.purpose, "payslip_pin_reset"),
        eq(loginChallenges.tenantId, context.tenant.tenantId),
        eq(loginChallenges.status, "pending"),
        gt(loginChallenges.expiresAt, input.now),
      ),
    )
    .returning({ id: loginChallenges.id });
  if (updated.length !== 1) return "refused";
  await auditProof(tx, context, {
    action: "payslip_pin.wa_proof_verified",
    challengeId: input.challengeId,
    actorUserId: input.linkUserId,
    details: {
      purpose: "payslip_pin_reset",
      status: "completed",
      senderMasked: maskSenderForAudit(input.sender),
    },
    now: input.now,
  });
  return "completed";
}
