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
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  mfaFactorIdSchema,
  totpEnrollmentSchema,
  mfaFactorSchema,
  type MfaEnrollment,
  type MfaFactor,
  type MfaFactorType,
  type MfaVerificationResult,
} from "@starter/shared/identity";
import { CoreError } from "@starter/shared/core";
import { db } from "../db";
import { mfaFactors, session } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import { openSecret, sealSecret } from "../lib/secrets";
import {
  generateTotpSecret,
  totpOtpauthUri,
  verifyTotpCode,
} from "../lib/totp";

/** PRD is silent; five known authenticators is enough for one person. */
export const MAX_VERIFIED_FACTORS = 5;
/** PRD is silent; a pending factor cannot be scanned after this window. */
export const MFA_ENROLLMENT_TTL_MINUTES = 15;
/** §3 F6 locks a device pin after five misses; the second factor matches it. */
export const MAX_MFA_ATTEMPTS = 5;
export const MFA_LOCK_MINUTES = 15;

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
  const [factor] = await db
    .select()
    .from(mfaFactors)
    .where(
      and(
        eq(mfaFactors.id, input.factorId),
        eq(mfaFactors.userId, input.userId),
      ),
    )
    .limit(1);
  // A factor of another user is indistinguishable from a missing one.
  if (!factor)
    throw new HttpError(404, "NOT_FOUND", "Faktor kedua tidak ditemukan.");
  if (factor.type !== "totp" || factor.secretEncrypted === null)
    throw new HttpError(
      409,
      "MFA_FACTOR_UNSUPPORTED",
      "Faktor ini tidak mendukung verifikasi kode.",
    );
  // The enrollment DTO promises a window; a pending secret older than it must
  // be reissued instead of verified (the response is the only copy).
  if (
    factor.verifiedAt === null &&
    now.getTime() >=
      factor.createdAt.getTime() + MFA_ENROLLMENT_TTL_MINUTES * 60_000
  )
    throw new CoreError(
      "CONFLICT",
      "Pendaftaran faktor ini kedaluwarsa. Daftarkan ulang.",
    );
  if (isLocked(factor, now))
    throw new CoreError(
      "RATE_LIMITED",
      "Terlalu banyak kode salah. Coba lagi dalam 15 menit.",
    );

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
    await db
      .update(mfaFactors)
      .set({
        failedAttempts,
        lockedUntil: locked
          ? new Date(now.getTime() + MFA_LOCK_MINUTES * 60_000)
          : factor.lockedUntil,
      })
      .where(
        and(eq(mfaFactors.id, factor.id), eq(mfaFactors.userId, input.userId)),
      );
    if (locked)
      throw new CoreError(
        "RATE_LIMITED",
        "Terlalu banyak kode salah. Coba lagi dalam 15 menit.",
      );
    throw new HttpError(
      401,
      "MFA_CODE_INVALID",
      "Kode faktor kedua salah atau sudah dipakai.",
    );
  }

  await db.transaction(async (tx) => {
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
  });
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
 * of guarded surfaces until they enroll again (fail closed, AUTH-05). */
export async function deleteMfaFactor(input: {
  readonly userId: string;
  readonly factorId: string;
}): Promise<void> {
  const deleted = await db
    .delete(mfaFactors)
    .where(
      and(
        eq(mfaFactors.id, input.factorId),
        eq(mfaFactors.userId, input.userId),
      ),
    )
    .returning({ id: mfaFactors.id });
  if (!deleted.length)
    throw new HttpError(404, "NOT_FOUND", "Faktor kedua tidak ditemukan.");
}
