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

import { and, eq, gt, ne } from "drizzle-orm";
import {
  assertLoginMessageRateLimit,
  LOGIN_MESSAGE_RATE_WINDOW_MINUTES,
  loginCodeFromMessage,
  MINUTE_MS,
  normalizeWhatsAppNumber,
} from "@starter/shared/identity";
import { CoreError, z } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db";
import { loginChallenges, tenants, waInboundMessages } from "../db/schema";
import { withTenant } from "../db/tenant";
import { loginCodeDigest, whatsAppDigest } from "../lib/identity-digest";
import { resolveWhatsAppAccount } from "./identity-account.service";
import { resolveWhatsAppChannel } from "./identity-login.service";

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

export type ProcessInboundDeps = {
  readonly now?: Date;
  /** Test seam; production resolves the identity graph row. */
  readonly resolveAccount?: typeof resolveWhatsAppAccount;
};

/** Records the outcome of a claimed message; the claim itself is the dedupe. */
async function finish(
  id: string,
  values: {
    kind: InboundKind;
    tenantId?: string | null;
    challengeId?: string | null;
  },
): Promise<void> {
  await db
    .update(waInboundMessages)
    .set({
      kind: values.kind,
      tenantId: values.tenantId ?? null,
      challengeId: values.challengeId ?? null,
    })
    .where(eq(waInboundMessages.id, id));
}

/** AUTH-04: at most 10 login messages per number per hour. */
async function underPerNumberLimit(
  fromHash: string,
  now: Date,
): Promise<boolean> {
  const windowStart = new Date(
    now.getTime() - LOGIN_MESSAGE_RATE_WINDOW_MINUTES * MINUTE_MS,
  );
  const rows = await db
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
  const now = deps.now ?? new Date();
  const fromHash = await whatsAppDigest(message.sender);

  // Claim the provider message id. A duplicate delivery conflicts and stops
  // here; nothing below can run twice for the same message.
  const claimed = await db
    .insert(waInboundMessages)
    .values({
      providerMessageId: message.eventId,
      receivingNumber: message.receivingNumber,
      fromHash,
      kind: "unknown",
      processedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing({ target: waInboundMessages.providerMessageId })
    .returning({ id: waInboundMessages.id });
  const claim = claimed[0];
  if (!claim) return { eventId: message.eventId, duplicate: true, kind: null };

  const code = loginCodeFromMessage(message.text);
  if (code === null) {
    // Not a login message: recorded, no reply, no quota use.
    return { eventId: message.eventId, duplicate: false, kind: "unknown" };
  }

  if (!(await underPerNumberLimit(fromHash, now))) {
    await finish(claim.id, { kind: "rate_limited" });
    return { eventId: message.eventId, duplicate: false, kind: "rate_limited" };
  }

  const challenge = await pendingChallengeFor(
    code,
    message.receivingNumber,
    now,
  );
  if (challenge.kind !== "found") {
    await finish(claim.id, { kind: "rejected" });
    return { eventId: message.eventId, duplicate: false, kind: "rejected" };
  }

  // The number is proven; resolve or create the account it belongs to.
  const account = await (deps.resolveAccount ?? resolveWhatsAppAccount)(
    message.sender,
    now,
  );

  const completed = await completeChallenge({
    challengeId: challenge.id,
    tenantId: challenge.tenantId,
    brandId: challenge.brandId,
    receivingNumber: message.receivingNumber,
    userId: account.userId,
    now,
  });
  const kind: InboundKind = completed ? "login" : "rejected";
  await finish(claim.id, {
    kind,
    tenantId: challenge.tenantId,
    challengeId: challenge.id,
  });
  return { eventId: message.eventId, duplicate: false, kind };
}

type ChallengeMatch =
  | { kind: "found"; id: string; tenantId: string; brandId: string | null }
  | { kind: "none" };

/**
 * The pending challenge a code belongs to. Codes are 40-bit random values, but
 * a colliding pair is refused rather than guessed (fail closed), and an expired
 * pending row is swept while we are here.
 */
async function pendingChallengeFor(
  code: string,
  receivingNumber: string,
  now: Date,
): Promise<ChallengeMatch> {
  const rows = await db
    .select({
      id: loginChallenges.id,
      tenantId: loginChallenges.tenantId,
      brandId: loginChallenges.brandId,
      status: loginChallenges.status,
      expiresAt: loginChallenges.expiresAt,
      receivingNumber: loginChallenges.receivingNumber,
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
    await db
      .update(loginChallenges)
      .set({ status: "expired" })
      .where(
        and(
          eq(loginChallenges.id, row.id),
          eq(loginChallenges.status, "pending"),
        ),
      );
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
  };
}

/**
 * Completes the challenge inside the tenant's transaction: the tenant must
 * still be active and must still route this receiving number to itself. The
 * conditional UPDATE is what makes completion single-use.
 */
async function completeChallenge(input: {
  challengeId: string;
  tenantId: string;
  brandId: string | null;
  receivingNumber: string;
  userId: string;
  now: Date;
}): Promise<boolean> {
  const tenant = establishTenantContext({
    tenantId: input.tenantId,
    brandId: input.brandId,
    source: "webhook",
  });
  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  return withTenant(db, context, async (tx) => {
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
        if (error instanceof CoreError && error.code === "SERVICE_UNAVAILABLE")
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
    return updated.length === 1;
  });
}
