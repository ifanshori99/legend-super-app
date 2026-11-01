// Resolving a sending WhatsApp number to an account (PRD v1.7 §3 F6 "Graf
// Identitas Pelanggan", AUTH-01/07).
//
// `user_identities` is the §6 B global identity graph and its WhatsApp row is
// keyed by the keyed number digest, so the same number always resolves to the
// same account — and the same digest that reservations and CRM store, which is
// what lets a guest's history link across modules.
//
// Scope of this bead: find the account for a verified number, or create one.
// Merging two accounts that share a number, WhatsApp linking for an
// email/Google account and provider subjects belong to legend-k2l, which
// extends this table rather than replacing it.
//
// A WhatsApp-only customer has no email, but Better Auth's `user.email` is
// NOT NULL UNIQUE. The account gets the deterministic reserved-domain address
// `<digest>@wa.invalid` (RFC 2606: never routable, never emailed). Once the
// identity-graph bead adds email identities, the first verified email replaces
// it; nothing keys off the placeholder.

import { and, eq } from "drizzle-orm";
import { maskWhatsAppNumber } from "@starter/shared/identity";
import { auth } from "../lib/auth";
import { sealSecret } from "../lib/secrets";
import { whatsAppDigest } from "../lib/identity-digest";
import { db } from "../db";
import { user, userIdentities } from "../db/schema";

export type WhatsAppAccount = {
  readonly userId: string;
  readonly created: boolean;
};

/** PostgreSQL unique violation, directly or wrapped by a driver cause chain. */
function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

function placeholderEmail(digest: string): string {
  return `${digest}@wa.invalid`;
}

/**
 * The account a verified number belongs to, created on first sight.
 *
 * `number` must already be normalized (`normalizeWhatsAppNumber`). A banned or
 * missing account throws: a login never issues a session for it (fail closed).
 */
export async function resolveWhatsAppAccount(
  number: string,
  now: Date,
): Promise<WhatsAppAccount> {
  const digest = await whatsAppDigest(number);
  const context = await auth.$context;

  const existing = await findIdentity(digest);
  if (existing)
    return { userId: await activeUserId(existing.userId), created: false };

  const user = await context.internalAdapter.createUser(
    {
      email: placeholderEmail(digest),
      name: `Pelanggan ${maskWhatsAppNumber(number) ?? number}`,
      emailVerified: false,
    },
    // Not a Better Auth sign-in route: this account was provisioned by a
    // verified WhatsApp message.
    { method: "whatsapp-inbound" },
  );
  try {
    await db.insert(userIdentities).values({
      userId: user.id,
      type: "whatsapp",
      valueHash: digest,
      valueEncrypted: sealSecret(number, `user_identity:whatsapp:${digest}`),
      verifiedAt: now,
      isPrimary: true,
    });
  } catch (error) {
    // A racing webhook created the same identity first: use that account and
    // drop the duplicate user we just made, so one number maps to one account.
    if (!uniqueViolation(error)) throw error;
    const winner = await findIdentity(digest);
    if (!winner) throw error;
    await context.internalAdapter.deleteUser(user.id).catch(() => undefined);
    return { userId: await activeUserId(winner.userId), created: false };
  }
  return { userId: user.id, created: true };
}

async function findIdentity(
  digest: string,
): Promise<{ userId: string } | null> {
  const [row] = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.type, "whatsapp"),
        eq(userIdentities.valueHash, digest),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The account exists and is allowed to sign in; anything else is refused. */
async function activeUserId(userId: string): Promise<string> {
  const context = await auth.$context;
  const found = await context.internalAdapter.findUserById(userId);
  if (!found) throw new Error("Account cannot sign in");
  // `banned` comes from the admin plugin, which the adapter's inferred user
  // type does not carry; read it from the auth table we own.
  const [row] = await db
    .select({ banned: user.banned })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row || row.banned) throw new Error("Account cannot sign in");
  return found.id;
}
