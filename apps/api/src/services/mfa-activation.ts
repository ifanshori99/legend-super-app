// Activation-time guard for second factors (AUTH-05). Starting an enrollment
// (enrollMfaFactor) checks that the caller may add a factor, but a pending
// factor can be finished much later, after another factor became verified in
// the meantime. Every path that sets `verifiedAt` on a pending factor (TOTP
// code in identity-mfa.service.ts, passkey attestation in
// identity-passkey.service.ts) therefore re-runs the check here, inside the
// activating transaction, under a per-user advisory lock so two activations
// cannot both pass as "first factor".

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import {
  AccessError,
  ROLE_GRANT_REAUTH_MAX_AGE_MS,
} from "@starter/shared/access";
import { CoreError } from "@starter/shared/core";
import { db } from "../db";
import { mfaFactors, session } from "../db/schema";
import { MAX_VERIFIED_FACTORS } from "../lib/mfa-policy";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serializes factor activations per user. Take it BEFORE locking the factor
 * row (advisory first, row second) so no two paths lock in opposite order. The
 * key differs from the 'mfa-recovery:' lock used by deleteMfaFactor on purpose,
 * so the two never wait on each other.
 */
export async function lockUserFactorActivation(
  tx: Transaction,
  userId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mfa-activate:${userId}`}, 0))`,
  );
}

/**
 * Throws unless this session may activate `factorId` now. The user's first
 * verified factor needs nothing; any further one needs a session that proved a
 * factor recently (same age rule as enrollMfaFactor and the role-grant path).
 * Call after lockUserFactorActivation, in the same transaction.
 */
export async function assertFactorActivationAllowed(
  tx: Transaction,
  input: {
    readonly userId: string;
    readonly factorId: string;
    readonly sessionId: string;
    readonly now: Date;
  },
): Promise<void> {
  const others = await tx
    .select({ id: mfaFactors.id })
    .from(mfaFactors)
    .where(
      and(
        eq(mfaFactors.userId, input.userId),
        ne(mfaFactors.id, input.factorId),
        isNotNull(mfaFactors.verifiedAt),
      ),
    );
  if (others.length > 0) {
    const [row] = await tx
      .select({ mfaVerifiedAt: session.mfaVerifiedAt })
      .from(session)
      .where(
        and(eq(session.id, input.sessionId), eq(session.userId, input.userId)),
      )
      .limit(1);
    const verifiedAt = row?.mfaVerifiedAt ?? null;
    if (verifiedAt === null) throw new AccessError("MFA_REQUIRED");
    const age = input.now.getTime() - verifiedAt.getTime();
    if (!(age >= 0 && age <= ROLE_GRANT_REAUTH_MAX_AGE_MS))
      throw new AccessError("REAUTH_REQUIRED");
  }
  if (others.length >= MAX_VERIFIED_FACTORS)
    throw new CoreError(
      "CONFLICT",
      "Jumlah faktor kedua sudah mencapai batas. Hapus salah satu terlebih dahulu.",
    );
}
