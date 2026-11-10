// Second-factor storage and verification for staff accounts (PRD v1.7 §3 F6
// "Staf — Login Web": management, finance, HR, owner, shareholder and Super
// Admin roles must use MFA; AUTH-05). Rows are `mfa_factors` (§6 B, global).
//
// Wire shapes come from @starter/shared/identity; the rules are the contract's:
// a factor grants nothing until `verifiedAt` is set, the enrollment response is
// the only time the base32 secret is shown, and every code is single-use. The
// secret is sealed with lib/secrets.ts bound to its factor + user.
//
// PRD-silent defaults (reported): five verified factors, fifteen-minute
// enrollment window for a pending factor, five wrong codes lock the factor for
// fifteen minutes (mirrors the staff-pin rule in §3 F6). Recovery codes and
// WebAuthn assertions are not in the wire contract yet; passkey enrollment
// answers 501 instead of pretending to work (see the report).

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  mfaFactorIdSchema,
  totpEnrollmentSchema,
  mfaFactorSchema,
  type MfaEnrollment,
  type MfaFactor,
  type MfaFactorType,
  type MfaVerificationResult,
} from "@starter/shared/identity";
import { AccessError } from "@starter/shared/access";
import { CoreError } from "@starter/shared/core";
import { db } from "../db";
import { mfaFactors, session } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import { MAX_MFA_ATTEMPTS, MFA_LOCK_MINUTES } from "../lib/mfa-policy";
import { openSecret, sealSecret } from "../lib/secrets";
import {
  auditRecoveryEvent,
  revokeMfaRecoveryCodes,
} from "./identity-mfa-recovery.service";
import {
  generateTotpSecret,
  totpOtpauthUri,
  verifyTotpCode,
} from "../lib/totp";

/** PRD is silent; five known authenticators is enough for one person. */
export const MAX_VERIFIED_FACTORS = 5;
/** PRD is silent; a pending factor cannot be scanned after this window. */
export const MFA_ENROLLMENT_TTL_MINUTES = 15;
export { MAX_MFA_ATTEMPTS, MFA_LOCK_MINUTES };

const mfaLog = logger.child({ module: "identity-mfa" });

type FactorRow = typeof mfaFactors.$inferSelect;

function aad(factorId: string, userId: string): string {
  return `mfa-factor:${factorId}:${userId.toLowerCase()}`;
}

function iso(at: Date): string {
  return at.toISOString();
}

function toWireFactor(row: FactorRow): MfaFactor {
  return mfaFactorSchema.parse({
    id: row.id,
    userId: row.userId,
    type: row.type,
    createdAt: iso(row.createdAt),
  });
}

function lockedError(): CoreError {
  return new CoreError(
    "RATE_LIMITED",
    "Terlalu banyak kode salah. Coba lagi dalam 15 menit.",
  );
}

function isLocked(row: FactorRow, now: Date): boolean {
  return row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime();
}

/** Verified factors only: an unverified row must never satisfy AUTH-05. */
export async function listMfaFactors(userId: string): Promise<MfaFactor[]> {
  const rows = await db
    .select()
    .from(mfaFactors)
    .where(eq(mfaFactors.userId, userId))
    .orderBy(asc(mfaFactors.createdAt));
  return rows.filter((row) => row.verifiedAt !== null).map(toWireFactor);
}

/** The factor a session may verify against right now (verified, not locked). */
export async function firstVerifiedTotpFactor(
  userId: string,
): Promise<FactorRow | null> {
  const rows = await db
    .select()
    .from(mfaFactors)
    .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.type, "totp")))
    .orderBy(asc(mfaFactors.createdAt));
  return rows.find((row) => row.verifiedAt !== null) ?? null;
}

/**
 * Starts enrollment. A fresh secret is returned once; repeating enrollment
 * drops the caller's previous *pending* factor, so an abandoned attempt never
 * piles up. Verified factors are untouched.
 */
export async function enrollMfaFactor(input: {
  readonly userId: string;
  readonly accountName: string;
  readonly type: MfaFactorType;
  readonly issuer: string;
  /** Whether the caller's session already verified a second factor. */
  readonly sessionMfaVerified: boolean;
  readonly now?: Date;
}): Promise<MfaEnrollment> {
  if (input.type === "passkey")
    throw new HttpError(
      501,
      "MFA_PASSKEY_UNSUPPORTED",
      "Pendaftaran passkey belum tersedia. Gunakan aplikasi autentikator (TOTP).",
    );
  const now = input.now ?? new Date();
  const verified = await listMfaFactors(input.userId);
  // Step-up (AUTH-05): once a user has a factor, adding another needs a
  // session that already proved one. Otherwise a stolen password alone could
  // enroll the attacker's authenticator and mark the session MFA-verified.
  if (verified.length > 0 && !input.sessionMfaVerified)
    throw new AccessError("MFA_REQUIRED");
  if (verified.length >= MAX_VERIFIED_FACTORS)
    throw new CoreError(
      "CONFLICT",
      "Jumlah faktor kedua sudah mencapai batas. Hapus salah satu terlebih dahulu.",
    );

  await db
    .delete(mfaFactors)
    .where(
      and(
        eq(mfaFactors.userId, input.userId),
        eq(mfaFactors.type, "totp"),
        isNull(mfaFactors.verifiedAt),
      ),
    );

  const factorId = randomUUID();
  const secretBase32 = generateTotpSecret();
  await db.insert(mfaFactors).values({
    id: factorId,
    userId: input.userId,
    type: "totp",
    secretEncrypted: sealSecret(secretBase32, aad(factorId, input.userId)),
  });
  mfaLog.info({ factorId, userId: input.userId }, "mfa enrollment started");
  return totpEnrollmentSchema.parse({
    type: "totp",
    factorId,
    secretBase32,
    otpauthUri: totpOtpauthUri({
      secretBase32,
      accountName: input.accountName,
      issuer: input.issuer,
    }),
    expiresAt: iso(
      new Date(now.getTime() + MFA_ENROLLMENT_TTL_MINUTES * 60_000),
    ),
  });
}

/**
 * Verifies a six-digit TOTP code for this session (AUTH-05) or finishes an
 * enrollment. Success marks the factor verified (first time), records the time
 * step so the code cannot be replayed, and marks the session as MFA-verified.
 * Wrong codes are counted; five in a row lock the factor for fifteen minutes.
 */
export async function verifyMfaFactor(input: {
  readonly userId: string;
  /** Session to mark verified; null when re-verifying outside a session. */
  readonly sessionId: string | null;
  readonly factorId: string;
  readonly code: string;
  readonly now?: Date;
}): Promise<MfaVerificationResult> {
  const now = input.now ?? new Date();
  // One transaction with the factor row locked (SELECT … FOR UPDATE): parallel
  // attempts are serialized, so the five-miss lock counts every guess and a
  // code cannot be accepted twice by racing requests (single-use step). A
  // wrong code must still commit its counter, so the outcome is returned and
  // thrown only after the transaction commits.
  const outcome = await db.transaction(async (tx) => {
    const [factor] = await tx
      .select()
      .from(mfaFactors)
      .where(
        and(
          eq(mfaFactors.id, input.factorId),
          eq(mfaFactors.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    // A factor of another user is indistinguishable from a missing one.
    if (!factor)
      return {
        error: new HttpError(404, "NOT_FOUND", "Faktor kedua tidak ditemukan."),
      };
    if (factor.type !== "totp" || factor.secretEncrypted === null)
      return {
        error: new HttpError(
          409,
          "MFA_FACTOR_UNSUPPORTED",
          "Faktor ini tidak mendukung verifikasi kode.",
        ),
      };
    // The enrollment DTO promises a window; a pending secret older than it
    // must be reissued instead of verified (the response is the only copy).
    if (
      factor.verifiedAt === null &&
      now.getTime() >=
        factor.createdAt.getTime() + MFA_ENROLLMENT_TTL_MINUTES * 60_000
    )
      return {
        error: new CoreError(
          "CONFLICT",
          "Pendaftaran faktor ini kedaluwarsa. Daftarkan ulang.",
        ),
      };
    if (isLocked(factor, now)) return { error: lockedError() };

    const secret = openSecret(
      factor.secretEncrypted,
      aad(factor.id, factor.userId),
    );
    const step = verifyTotpCode({
      secretBase32: secret,
      code: input.code,
      now,
      lastUsedStep: factor.lastUsedStep,
    });

    if (step === null) {
      const failedAttempts = factor.failedAttempts + 1;
      const locked = failedAttempts >= MAX_MFA_ATTEMPTS;
      await tx
        .update(mfaFactors)
        .set({
          // Never reset by a lock: once it expires, the next miss relocks.
          failedAttempts,
          lockedUntil: locked
            ? new Date(now.getTime() + MFA_LOCK_MINUTES * 60_000)
            : factor.lockedUntil,
        })
        .where(eq(mfaFactors.id, factor.id));
      return {
        error: locked
          ? lockedError()
          : new HttpError(
              401,
              "MFA_CODE_INVALID",
              "Kode faktor kedua salah atau sudah dipakai.",
            ),
      };
    }

    await tx
      .update(mfaFactors)
      .set({
        verifiedAt: factor.verifiedAt ?? now,
        lastUsedStep: step,
        failedAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(mfaFactors.id, factor.id));
    // The session row is global; scope by user so a leaked session id cannot
    // be marked verified for someone else.
    if (input.sessionId !== null)
      await tx
        .update(session)
        .set({ mfaVerifiedAt: now })
        .where(
          and(
            eq(session.id, input.sessionId),
            eq(session.userId, input.userId),
          ),
        );
    return { factor };
  });
  if ("error" in outcome) throw outcome.error;
  const { factor } = outcome;
  return {
    factorId: mfaFactorIdSchema.parse(factor.id),
    verifiedAt: iso(now),
  };
}

/**
 * Re-verification without a factor id (platform support access, TEN-04):
 * checks the caller's first verified TOTP factor, marks the session verified
 * and returns the instant, or null. Never throws for a wrong code.
 */
export async function verifyMfaCodeForUser(input: {
  readonly userId: string;
  readonly sessionId: string | null;
  readonly code: string;
  readonly now?: Date;
}): Promise<{ readonly factorId: string; readonly verifiedAt: string } | null> {
  const factor = await firstVerifiedTotpFactor(input.userId);
  if (!factor) return null;
  try {
    const result = await verifyMfaFactor({
      userId: input.userId,
      sessionId: input.sessionId,
      factorId: factor.id,
      code: input.code,
      now: input.now,
    });
    return { factorId: result.factorId, verifiedAt: result.verifiedAt };
  } catch {
    return null;
  }
}

/** Removes one of the caller's factors. Deleting the last one locks them out
 * of guarded surfaces until they enroll again (fail closed, AUTH-05), and
 * drops their recovery codes: a code must never satisfy MFA with no factor. */
export async function deleteMfaFactor(input: {
  readonly userId: string;
  readonly factorId: string;
  /** Whether the caller's session already verified a second factor. */
  readonly sessionMfaVerified: boolean;
  /** The caller's session, to audit a recovery-set revocation on its tenant. */
  readonly sessionId?: string;
}): Promise<void> {
  // Step-up (AUTH-05): removing a factor with only a password would let a
  // stolen password strip MFA and enroll a new authenticator.
  if (!input.sessionMfaVerified) {
    const verified = await listMfaFactors(input.userId);
    if (verified.length > 0) throw new AccessError("MFA_REQUIRED");
  }
  const outcome = await db.transaction(async (tx) => {
    // Same per-user lock as generateMfaRecoveryCodes: generate-vs-delete and
    // parallel last-factor deletes serialize, so the set never outlives the
    // last verified factor.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mfa-recovery:${input.userId}`}, 0))`,
    );
    const deleted = await tx
      .delete(mfaFactors)
      .where(
        and(
          eq(mfaFactors.id, input.factorId),
          eq(mfaFactors.userId, input.userId),
        ),
      )
      .returning({ id: mfaFactors.id });
    if (!deleted.length) return null;
    const [remaining] = await tx
      .select({ id: mfaFactors.id })
      .from(mfaFactors)
      .where(
        and(
          eq(mfaFactors.userId, input.userId),
          isNotNull(mfaFactors.verifiedAt),
        ),
      )
      .limit(1);
    if (remaining) return { revokedSetId: null, tenantId: null };
    const revokedSetId = await revokeMfaRecoveryCodes(tx, {
      userId: input.userId,
    });
    if (revokedSetId === null || input.sessionId === undefined)
      return { revokedSetId, tenantId: null };
    const [row] = await tx
      .select({ tenantId: session.tenantId })
      .from(session)
      .where(
        and(eq(session.id, input.sessionId), eq(session.userId, input.userId)),
      )
      .limit(1);
    return { revokedSetId, tenantId: row?.tenantId ?? null };
  });
  if (outcome === null)
    throw new HttpError(404, "NOT_FOUND", "Faktor kedua tidak ditemukan.");
  // auditRecoveryEvent never throws: a failed audit must not undo a delete.
  if (outcome.revokedSetId !== null)
    await auditRecoveryEvent({
      tenantId: outcome.tenantId,
      userId: input.userId,
      setId: outcome.revokedSetId,
      action: "mfa_recovery_codes.revoked",
      after: { cause: "last_factor_deleted" },
    });
}
