/**
 * legend-658 (L5): value for `session.mfa_challenge_verified_at`.
 *
 * The payout step-up skips the password prompt only when the session holds a
 * second-factor proof that did not come from the session itself. A proof (a
 * verified factor, a passkey, a recovery code set) counts only when it already
 * existed before the session was created; otherwise a hijacked session could
 * enroll its own factor, verify it, and skip the password. When the proof is
 * newer than the session, the stamp keeps its current value.
 */
import { sql } from "drizzle-orm";

import { session } from "../db/schema";

export function challengeStampValue(proofAt: Date, now: Date) {
  return sql`CASE WHEN ${session.createdAt} > ${proofAt.toISOString()}::timestamptz THEN ${now.toISOString()}::timestamptz ELSE ${session.mfaChallengeVerifiedAt} END`;
}
