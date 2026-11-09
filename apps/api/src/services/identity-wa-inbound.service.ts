// KirimDev inbound WhatsApp webhook (PRD v1.7 §3 F6 "Pesan Gagal Login",
// AUTH-02, AUTH-03; adapted from Meta's `X-Hub-Signature-256` to KirimDev's
// `X-Kirim-Signature` by the owner decision in docs/plan/providers.md).
//
// The route verifies the signature over the exact bytes
// (`verifyKirimWebhook`, shared adapters contract), parses the Meta-shaped
// `message.received` envelope (KirimDev documents exactly that envelope:
// `messages[].id`, `messages[].from`, `messages[].text.body`,
// `value.metadata.phone_number_id`), and hands each message here.
//
// The guarantees this service owns:
//
// - AUTH-02 idempotent per message ID. The first delivery claims the row in
//   `wa_inbound_messages` (unique `provider_message_id`); a replay finds the
//   claim and is answered as a duplicate, so it can never create a second
//   completion or a second session. A forged message fails the signature check
//   before this code runs.
// - Single use. The challenge is completed by a conditional UPDATE
//   (`status = 'pending'`), so two different messages carrying the same code
//   cannot both win.
// - Tenant scoping without RLS (coordinator decision, docs/plan/contracts.md):
//   the tenant comes from the challenge, and the message is only accepted on
//   the receiving number that tenant's active `whatsapp` integration still
//   maps. A message received on another tenant's number is rejected and the
//   challenge stays pending.
// - AUTH-03: nothing is ever sent back. There is no reply path here at all —
//   the confirmation appears in the guest's browser.
// - "Pesan dari nomor yang tidak cocok dengan challenge ditolak tanpa membuka
//   informasi akun" (§3 F6): an unknown, expired or already used code answers
//   exactly like any other failed attempt, and the response never says whether
//   a number or an account exists.
//
// The raw message body is never stored (§6 B `wa_inbound_messages`: "log
// webhook pesan masuk tanpa isi pesan"); only the provider id, the keyed sender
// digest and the outcome.

import { and, eq, gt, ne, isNull, sql } from "drizzle-orm";
import {
  assertLoginMessageRateLimit,
  LOGIN_MESSAGE_RATE_WINDOW_MINUTES,
  loginCodeFromMessage,
  MINUTE_MS,
  normalizeWhatsAppNumber,
  maskWhatsAppNumber,
  identityLinkedEvent,
} from "@starter/shared/identity";
import { CoreError, createUlid, z } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db";
import {
  loginChallenges,
  tenants,
  waInboundMessages,
  userIdentities,
  session,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  identityDigest,
  loginCodeDigest,
  whatsAppDigest,
} from "../lib/identity-digest.ts";
import { sealSecret } from "../lib/secrets.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import { resolveWhatsAppAccount } from "./identity-account.service";
import { resolveWhatsAppChannel } from "./identity-login.service";
import {
  recordLoginAudit,
  type LoginAuditAction,
} from "./identity-wa-audit.ts";

/** One inbound text message, already reduced to the fields the flow needs. */
export type InboundWhatsAppMessage = {
  /** Provider message id (`messages[0].id`): the AUTH-02 idempotency key. */
  readonly eventId: string;
  /** The provider-received number (`value.metadata.phone_number_id`). */
  readonly receivingNumber: string;
  /** Sender digits, normalized (`628…`). */
  readonly sender: string;
  readonly text: string;
};

export type InboundKind = "login" | "unknown" | "rejected" | "rate_limited";

export type InboundOutcome = {
  readonly eventId: string;
  readonly duplicate: boolean;
  readonly kind: InboundKind | null;
};

/**
 * Meta's envelope, stripped to what the login reads. `z.object` (not strict)
 * because the provider adds fields this bead does not use; unknown keys are
 * dropped, never trusted.
 */
const kirimdevPayloadSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.literal("messages"),
              value: z.object({
                metadata: z.object({
                  phone_number_id: z.string().min(1).max(64),
                }),
                messages: z
                  .array(
                    z.object({
                      id: z.string().min(1).max(255),
                      from: z.string().min(8).max(20),
                      type: z.string().min(1).max(32),
                      text: z
                        .object({ body: z.string().max(4096) })
                        .partial()
                        .optional(),
                    }),
                  )
                  .max(50)
                  .optional(),
              }),
            }),
          )
          .max(20),
      }),
    )
    .max(20),
});

/**
 * Flattens a signed delivery into messages. Non-text messages (images, status
 * reports) and senders that are not WhatsApp numbers are skipped: they cannot
 * be a login attempt and there is nothing to log for them.
 */
export function parseKirimdevPayload(
  payload: unknown,
): InboundWhatsAppMessage[] {
  const parsed = kirimdevPayloadSchema.safeParse(payload);
  if (!parsed.success)
    throw new CoreError("VALIDATION_ERROR", "Payload webhook tidak dikenali.");
  const messages: InboundWhatsAppMessage[] = [];
  for (const entry of parsed.data.entry)
    for (const change of entry.changes) {
      const receivingNumber = change.value.metadata.phone_number_id;
      for (const message of change.value.messages ?? []) {
        if (message.type !== "text") continue;
        const body = message.text?.body;
        if (body === undefined) continue;
        const sender = normalizeWhatsAppNumber(message.from);
        if (sender === null) continue;
        messages.push({
          eventId: message.id,
          receivingNumber,
          sender,
          text: body,
        });
      }
    }
  return messages;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Keep connections available for the existing Better Auth account resolver.
// Waiting webhook requests hold no database connection.
const MAX_INBOUND_TRANSACTIONS = 4;
let inboundTransactions = 0;
const inboundWaiters: Array<() => void> = [];
async function withInboundSlot<T>(run: () => Promise<T>): Promise<T> {
  if (inboundTransactions < MAX_INBOUND_TRANSACTIONS) inboundTransactions++;
  else await new Promise<void>((resolve) => inboundWaiters.push(resolve));
  try {
    return await run();
  } finally {
    const next = inboundWaiters.shift();
    if (next) next();
    else inboundTransactions--;
  }
}

export type ProcessInboundDeps = {
  readonly now?: Date;
  /** Test seam; production resolves the identity graph row. */
  readonly resolveAccount?: typeof resolveWhatsAppAccount;
  /** Test seam to verify link, audit, outbox and claim roll back together. */
  readonly afterLinkWrite?: () => Promise<void>;
};

/** Records the outcome of a claimed message; the claim itself is the dedupe. */
async function finish(
  tx: Transaction,
  id: string,
  values: {
    kind: InboundKind;
    tenantId?: string | null;
    challengeId?: string | null;
  },
): Promise<void> {
  await tx
    .update(waInboundMessages)
    .set({
      kind: values.kind,
      tenantId: values.tenantId ?? null,
      challengeId: values.challengeId ?? null,
    })
    .where(eq(waInboundMessages.id, id));
}

function webhookContext(tenantId: string, brandId: string | null) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId, source: "webhook" }),
    { kind: "tenant" },
  );
}

/**
 * legend-wq3f: audit row for a challenge milestone reached through the webhook,
 * on the same transaction as the state change. Only the masked sender is kept.
 */
async function auditChallenge(
  transaction: Transaction,
  input: {
    action: LoginAuditAction;
    challengeId: string;
    tenantId: string;
    brandId: string | null;
    actorUserId?: string | null;
    details: Parameters<typeof recordLoginAudit>[2]["details"];
    now: Date;
  },
): Promise<void> {
  const context = webhookContext(input.tenantId, input.brandId);
  await withTenant(transaction as unknown as typeof db, context, (tx) =>
    recordLoginAudit(tx, context, {
      action: input.action,
      challengeId: input.challengeId,
      actorUserId: input.actorUserId,
      details: input.details,
      now: input.now,
    }),
  );
}

/** AUTH-04: at most 10 login messages per number per hour. */
async function underPerNumberLimit(
  tx: Transaction,
  fromHash: string,
  now: Date,
): Promise<boolean> {
  const windowStart = new Date(
    now.getTime() - LOGIN_MESSAGE_RATE_WINDOW_MINUTES * MINUTE_MS,
  );
  const rows = await tx
    .select({ processedAt: waInboundMessages.processedAt })
    .from(waInboundMessages)
    .where(
      and(
        eq(waInboundMessages.fromHash, fromHash),
        gt(waInboundMessages.processedAt, windowStart),
        // Only login attempts count: a plain "halo" must not burn the quota.
        ne(waInboundMessages.kind, "unknown"),
      ),
    );
  try {
    assertLoginMessageRateLimit({
      messagesReceivedAt: rows.map((row) => row.processedAt),
      now,
    });
    return true;
  } catch (error) {
    if (error instanceof CoreError && error.code === "RATE_LIMITED")
      return false;
    throw error;
  }
}

/**
 * Processes one inbound message. Returns the outcome; duplicates are reported
 * without doing any work (AUTH-02).
 */
export async function processInboundWhatsApp(
  message: InboundWhatsAppMessage,
  deps: ProcessInboundDeps = {},
): Promise<InboundOutcome> {
  const fromHash = await whatsAppDigest(message.sender);
  const requestHash = identityDigest(
    "inbound-request",
    JSON.stringify([message.receivingNumber, message.sender, message.text]),
  );

  return withInboundSlot(() =>
    db.transaction(async (tx) => {
      // AUTH-04 serializes the quota check and insertion for each sender.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${fromHash}, 0))`,
      );
      const now = deps.now ?? new Date();

      // Claim the provider message id. A duplicate delivery conflicts and stops
      // here; nothing below can run twice for the same message.
      const claimed = await tx
        .insert(waInboundMessages)
        .values({
          providerMessageId: message.eventId,
          requestHash,
          receivingNumber: message.receivingNumber,
          fromHash,
          kind: "unknown",
          processedAt: now,
          createdAt: now,
        })
        .onConflictDoNothing({ target: waInboundMessages.providerMessageId })
        .returning({ id: waInboundMessages.id });
      const claim = claimed[0];
      if (!claim) {
        const [previous] = await tx
          .select({ requestHash: waInboundMessages.requestHash })
          .from(waInboundMessages)
          .where(eq(waInboundMessages.providerMessageId, message.eventId));
        // Rows claimed before migration 0029 carry no fingerprint; a redelivery
        // of one is a plain duplicate, not a conflict the provider retries forever.
        if (
          previous?.requestHash !== null &&
          previous?.requestHash !== requestHash
        )
          throw new CoreError(
            "CONFLICT",
            "Pesan webhook tidak cocok dengan percobaan sebelumnya.",
          );
        return { eventId: message.eventId, duplicate: true, kind: null };
      }

      const code = loginCodeFromMessage(message.text);
      if (code === null) {
        // Not a login message: recorded, no reply, no quota use.
        return { eventId: message.eventId, duplicate: false, kind: "unknown" };
      }

      if (!(await underPerNumberLimit(tx, fromHash, now))) {
        await finish(tx, claim.id, { kind: "rate_limited" });
        return {
          eventId: message.eventId,
          duplicate: false,
          kind: "rate_limited",
        };
      }

      const challenge = await pendingChallengeFor(
        tx,
        code,
        message.receivingNumber,
        now,
      );
      if (challenge.kind !== "found") {
        await finish(tx, claim.id, { kind: "rejected" });
        return { eventId: message.eventId, duplicate: false, kind: "rejected" };
      }

      if (challenge.linkUserId !== null) {
        const completed = await completeLink(
          tx,
          {
            ...challenge,
            receivingNumber: message.receivingNumber,
            sender: message.sender,
            now,
          },
          deps.afterLinkWrite,
        );
        const kind: InboundKind = completed ? "login" : "rejected";
        if (!completed)
          await auditRejected(tx, challenge, message.sender, now, true);
        await finish(tx, claim.id, {
          kind,
          tenantId: challenge.tenantId,
          challengeId: challenge.id,
        });
        return { eventId: message.eventId, duplicate: false, kind };
      }

      // The number is proven; resolve or create the account it belongs to.
      const account = await (deps.resolveAccount ?? resolveWhatsAppAccount)(
        message.sender,
        now,
      );

      const completed = await completeChallenge(tx, {
        challengeId: challenge.id,
        tenantId: challenge.tenantId,
        brandId: challenge.brandId,
        receivingNumber: message.receivingNumber,
        userId: account.userId,
        senderMasked: maskWhatsAppNumber(message.sender),
        now,
      });
      const kind: InboundKind = completed ? "login" : "rejected";
      if (!completed)
        await auditRejected(tx, challenge, message.sender, now, false);
      await finish(tx, claim.id, {
        kind,
        tenantId: challenge.tenantId,
        challengeId: challenge.id,
      });
      return { eventId: message.eventId, duplicate: false, kind };
    }),
  );
}

/** A found challenge whose completion was refused (inactive tenant, number
 * mismatch, lost race, stale link session). */
async function auditRejected(
  tx: Transaction,
  challenge: { id: string; tenantId: string; brandId: string | null },
  sender: string,
  now: Date,
  linking: boolean,
): Promise<void> {
  await auditChallenge(tx, {
    action: "login_challenge.rejected",
    challengeId: challenge.id,
    tenantId: challenge.tenantId,
    brandId: challenge.brandId,
    details: {
      channel: "whatsapp_inbound",
      cause: "completion_refused",
      linking,
      senderMasked: maskWhatsAppNumber(sender),
    },
    now,
  });
}

type ChallengeMatch =
  | {
      kind: "found";
      id: string;
      tenantId: string;
      brandId: string | null;
      linkUserId: string | null;
      linkSessionId: string | null;
    }
  | { kind: "none" };

/**
 * The pending challenge a code belongs to. Codes are 40-bit random values, but
 * a colliding pair is refused rather than guessed (fail closed), and an expired
 * pending row is swept while we are here.
 */
async function pendingChallengeFor(
  tx: Transaction,
  code: string,
  receivingNumber: string,
  now: Date,
): Promise<ChallengeMatch> {
  const rows = await tx
    .select({
      id: loginChallenges.id,
      tenantId: loginChallenges.tenantId,
      brandId: loginChallenges.brandId,
      status: loginChallenges.status,
      expiresAt: loginChallenges.expiresAt,
      receivingNumber: loginChallenges.receivingNumber,
      linkUserId: loginChallenges.linkUserId,
      linkSessionId: loginChallenges.linkSessionId,
    })
    .from(loginChallenges)
    .where(
      and(
        eq(loginChallenges.channel, "whatsapp_inbound"),
        eq(loginChallenges.codeHash, loginCodeDigest(code)),
      ),
    )
    .limit(2);
  if (rows.length !== 1) return { kind: "none" };
  const row = rows[0];
  if (!row || row.status !== "pending") return { kind: "none" };
  if (row.expiresAt.getTime() <= now.getTime()) {
    const flipped = await tx
      .update(loginChallenges)
      .set({ status: "expired" })
      .where(
        and(
          eq(loginChallenges.id, row.id),
          eq(loginChallenges.status, "pending"),
        ),
      )
      .returning({ id: loginChallenges.id });
    if (flipped.length === 1 && row.tenantId !== null)
      await auditChallenge(tx, {
        action: "login_challenge.expired",
        challengeId: row.id,
        tenantId: row.tenantId,
        brandId: row.brandId,
        details: {
          channel: "whatsapp_inbound",
          status: "expired",
          cause: "ttl_elapsed",
          linking: row.linkUserId !== null,
        },
        now,
      });
    return { kind: "none" };
  }
  if (row.tenantId === null) return { kind: "none" };
  // The receiving number recorded at issuance must match the one that received
  // the message, so a code issued by one tenant is never completed on another
  // tenant's number — before any account work happens. `completeChallenge`
  // re-checks it against the tenant's live integration.
  if (row.receivingNumber !== receivingNumber) return { kind: "none" };
  return {
    kind: "found",
    id: row.id,
    tenantId: row.tenantId,
    brandId: row.brandId,
    linkUserId: row.linkUserId,
    linkSessionId: row.linkSessionId,
  };
}

/**
 * Completes the challenge inside the tenant's transaction: the tenant must
 * still be active and must still route this receiving number to itself. The
 * conditional UPDATE is what makes completion single-use.
 */
async function completeChallenge(
  transaction: Transaction,
  input: {
    challengeId: string;
    tenantId: string;
    brandId: string | null;
    receivingNumber: string;
    userId: string;
    senderMasked: string | null;
    now: Date;
  },
): Promise<boolean> {
  const tenant = establishTenantContext({
    tenantId: input.tenantId,
    brandId: input.brandId,
    source: "webhook",
  });
  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  return withTenant(
    transaction as unknown as typeof db,
    context,
    async (tx) => {
      const [tenantRow] = await tx
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId))
        .limit(1);
      if (tenantRow?.status !== "active") return false;
      // Resolve the tenant from the receiving number: the tenant's own active
      // integration must still name this number, otherwise this message is not
      // theirs to complete.
      const channel = await resolveWhatsAppChannel(tx, context).catch(
        (error: unknown) => {
          if (
            error instanceof CoreError &&
            error.code === "SERVICE_UNAVAILABLE"
          )
            return null;
          throw error;
        },
      );
      if (!channel || channel.routingNumber !== input.receivingNumber)
        return false;
      const updated = await tx
        .update(loginChallenges)
        .set({
          status: "completed",
          matchedUserId: input.userId,
          completedAt: input.now,
        })
        .where(
          and(
            eq(loginChallenges.id, input.challengeId),
            eq(loginChallenges.status, "pending"),
          ),
        )
        .returning({ id: loginChallenges.id });
      if (updated.length !== 1) return false;
      await recordLoginAudit(tx, context, {
        action: "login_challenge.completed",
        challengeId: input.challengeId,
        actorUserId: input.userId,
        details: {
          channel: "whatsapp_inbound",
          status: "completed",
          matchedUserId: input.userId,
          senderMasked: input.senderMasked,
        },
        now: input.now,
      });
      return true;
    },
  );
}

/** AUTH-07: the proof attaches only to the session that requested it. */
async function completeLink(
  transaction: Transaction,
  input: {
    id: string;
    tenantId: string;
    brandId: string | null;
    linkUserId: string | null;
    linkSessionId: string | null;
    receivingNumber: string;
    sender: string;
    now: Date;
  },
  afterLinkWrite?: () => Promise<void>,
): Promise<boolean> {
  if (!input.linkUserId || !input.linkSessionId) return false;
  const userId = input.linkUserId;
  const tenant = establishTenantContext({
    tenantId: input.tenantId,
    brandId: input.brandId,
    source: "webhook",
  });
  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  const digest = await whatsAppDigest(input.sender);
  return withTenant(
    transaction as unknown as typeof db,
    context,
    async (tx) => {
      // Serialize both the challenge and all attempts for this number.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${digest}, 0))`,
      );
      const [challenge] = await tx
        .select()
        .from(loginChallenges)
        .where(eq(loginChallenges.id, input.id))
        .for("update");
      if (
        !challenge ||
        challenge.status !== "pending" ||
        challenge.expiresAt <= input.now ||
        challenge.linkUserId !== userId ||
        challenge.linkSessionId !== input.linkSessionId
      )
        return false;
      const [active] = await tx
        .select({ id: session.id })
        .from(session)
        .where(
          and(
            eq(session.id, input.linkSessionId!),
            eq(session.userId, userId),
            isNull(session.revokedAt),
            gt(session.expiresAt, input.now),
          ),
        )
        .for("update");
      if (!active) return false;
      const [tenantRow] = await tx
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId));
      if (tenantRow?.status !== "active") return false;
      const channel = await resolveWhatsAppChannel(tx, context).catch(
        (error: unknown) => {
          if (
            error instanceof CoreError &&
            error.code === "SERVICE_UNAVAILABLE"
          )
            return null;
          throw error;
        },
      );
      if (!channel || channel.routingNumber !== input.receivingNumber)
        return false;
      const [existing] = await tx
        .select()
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.type, "whatsapp"),
            eq(userIdentities.valueHash, digest),
          ),
        );
      if (existing && existing.userId !== userId) {
        // Preserve the actual match without exposing it to the polling browser.
        // A cancelled link with a different matched user is the conflict signal.
        await tx
          .update(loginChallenges)
          .set({ status: "cancelled", matchedUserId: existing.userId })
          .where(eq(loginChallenges.id, input.id));
        return false;
      }
      let identity = existing;
      if (!identity || identity.verifiedAt === null) {
        if (identity) {
          const [verified] = await tx
            .update(userIdentities)
            .set({
              verifiedAt: input.now,
              valueEncrypted:
                identity.valueEncrypted ??
                sealSecret(input.sender, `user_identity:whatsapp:${digest}`),
            })
            .where(eq(userIdentities.id, identity.id))
            .returning();
          if (!verified) throw new Error("Identity could not be verified");
          identity = verified;
        } else {
          const [inserted] = await tx
            .insert(userIdentities)
            .values({
              userId,
              type: "whatsapp",
              valueHash: digest,
              valueEncrypted: sealSecret(
                input.sender,
                `user_identity:whatsapp:${digest}`,
              ),
              verifiedAt: input.now,
              isPrimary: false,
            })
            .onConflictDoNothing()
            .returning();
          if (!inserted) return false;
          identity = inserted;
        }
        await afterLinkWrite?.();
        const def = identityLinkedEvent;
        const event = def.envelopeSchema.parse({
          id: createUlid(),
          tenantId: input.tenantId,
          outletId: null,
          name: def.name,
          version: def.version,
          aggregateType: def.entry.aggregateType,
          aggregateId: identity.id,
          sequence: 1,
          occurredAt: input.now.toISOString(),
          actor: { type: "user", id: userId },
          deviceId: null,
          idempotencyKey: `identity.linked:${identity.id}`,
          payloadSchemaRef: def.payloadSchemaRef,
          payload: {
            identityId: identity.id,
            userId,
            type: "whatsapp",
            isPrimary: identity.isPrimary,
          },
        });
        await appendOutbox(tx, context, {
          id: createUlid(),
          event,
          destination: "cloud-sync",
          direction: null,
          peerId: null,
        });
        await recordAudit(tx, context, {
          id: createUlid(),
          tenantId: input.tenantId,
          outletId: null,
          actorType: "user",
          actorId: userId,
          deviceId: null,
          action: "identity.linked",
          objectType: "user_identity",
          objectId: identity.id,
          reason: null,
          maskedChanges: { before: null, after: { type: "whatsapp" } },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: input.now.toISOString(),
        });
      }
      await tx
        .update(loginChallenges)
        .set({
          status: "completed",
          matchedUserId: userId,
          completedAt: input.now,
        })
        .where(eq(loginChallenges.id, input.id));
      await recordLoginAudit(tx, context, {
        action: "login_challenge.completed",
        challengeId: input.id,
        actorUserId: userId,
        details: {
          channel: "whatsapp_inbound",
          status: "completed",
          linking: true,
          matchedUserId: userId,
          senderMasked: maskWhatsAppNumber(input.sender),
        },
        now: input.now,
      });
      return true;
    },
  );
}
