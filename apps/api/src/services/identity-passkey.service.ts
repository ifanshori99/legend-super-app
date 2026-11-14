// Staff passkey (WebAuthn) second factor (legend-jemg; PRD v1.7 §3 F6 "Staf —
// Login Web": MFA by TOTP or passkey; §6 B `mfa_factors.public_key`).
//
// Enrollment: a pending `passkey` factor + a `register` challenge bound to the
// requesting session; the browser's attestation finishes it and the credential id
// and public key are stored on the factor. Sign-in: `POST .../challenge` issues
// an `authenticate` challenge, the assertion verifies the session.
//
// Rules (AUTH-05): the relying party id and origin come from `WEB_URL`, never
// from the client; a challenge is random, bound to (factor, session), expires,
// is replaced by a newer request and is deleted before its response is checked
// (single use); the signature counter must rise while either side is above zero
// (a cloned authenticator signal); the factor row is locked for the whole check
// so racing requests are serialized. Wrong signatures count toward the same
// five-miss lock as TOTP codes. The library does the cryptography
// (@simplewebauthn/server, pinned in apps/api/package.json).

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  mfaChallengeSchema,
  mfaFactorIdSchema,
  passkeyEnrollmentSchema,
  type MfaChallenge,
  type MfaVerificationResult,
  type PasskeyAssertion,
  type PasskeyAttestation,
  type PasskeyEnrollment,
} from "@starter/shared/identity";
import { CoreError } from "@starter/shared/core";
import { env } from "../config/env";
import { db } from "../db";
import { mfaFactors, mfaPasskeyChallenges, session } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import {
  MAX_MFA_ATTEMPTS,
  MFA_ENROLLMENT_TTL_MINUTES,
  MFA_LOCK_MINUTES,
  MFA_PASSKEY_CHALLENGE_TTL_MINUTES,
} from "../lib/mfa-policy";
import {
  assertFactorActivationAllowed,
  lockUserFactorActivation,
} from "./mfa-activation";
import { challengeStampValue } from "./identity-step-up-stamp";

const passkeyLog = logger.child({ module: "identity-passkey" });

/** Product name shown in the browser's passkey dialog. */
const RP_NAME = "Legend";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type FactorRow = typeof mfaFactors.$inferSelect;
type Purpose = "register" | "authenticate";

/** What the factor's `public_key` column holds for a passkey. */
type StoredPasskey = {
  credentialId: string;
  /** COSE public key, base64url. */
  publicKey: string;
  transports?: string[];
};

/** Relying party from config (WEB_URL); the client never supplies either. */
function relyingParty(): { rpID: string; origin: string } {
  const url = new URL(env.WEB_URL);
  return { rpID: url.hostname, origin: url.origin };
}

function iso(at: Date): string {
  return at.toISOString();
}

function lockedError(): CoreError {
  return new CoreError(
    "RATE_LIMITED",
    "Terlalu banyak percobaan passkey yang gagal. Coba lagi dalam 15 menit.",
  );
}

const notFound = () =>
  new HttpError(404, "NOT_FOUND", "Faktor kedua tidak ditemukan.");

function invalidChallenge(): HttpError {
  return new HttpError(
    401,
    "MFA_PASSKEY_CHALLENGE_INVALID",
    "Tantangan passkey tidak berlaku atau sudah dipakai. Minta yang baru.",
  );
}

function invalidPasskey(): HttpError {
  return new HttpError(
    401,
    "MFA_PASSKEY_INVALID",
    "Passkey tidak dapat diverifikasi.",
  );
}

function readStored(factor: FactorRow): StoredPasskey | null {
  const value = factor.publicKey;
  if (
    value &&
    typeof value.credentialId === "string" &&
    typeof value.publicKey === "string"
  )
    return value as unknown as StoredPasskey;
  return null;
}

async function lockFactor(
  tx: Transaction,
  userId: string,
  factorId: string,
): Promise<FactorRow | null> {
  const [factor] = await tx
    .select()
    .from(mfaFactors)
    .where(and(eq(mfaFactors.id, factorId), eq(mfaFactors.userId, userId)))
    .limit(1)
    .for("update");
  return factor ?? null;
}

async function saveChallenge(
  tx: Transaction,
  input: {
    factorId: string;
    sessionId: string;
    purpose: Purpose;
    challenge: string;
    expiresAt: Date;
  },
): Promise<void> {
  await tx
    .insert(mfaPasskeyChallenges)
    .values({ id: randomUUID(), ...input })
    .onConflictDoUpdate({
      target: [
        mfaPasskeyChallenges.factorId,
        mfaPasskeyChallenges.sessionId,
        mfaPasskeyChallenges.purpose,
      ],
      set: {
        challenge: input.challenge,
        expiresAt: input.expiresAt,
        createdAt: sql`now()`,
      },
    });
}

/** The challenge the browser signed, read from clientDataJSON (not trusted yet). */
function clientChallenge(clientDataJSON: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(clientDataJSON, "base64url").toString("utf8"),
    );
    if (parsed && typeof parsed === "object" && "challenge" in parsed)
      return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    // Not JSON: treated as a challenge that was never issued.
  }
  return null;
}

/**
 * Deletes the pending challenge when the client's challenge equals it and it is
 * still valid, and returns it. A stale or forged challenge consumes nothing, so
 * it cannot burn the live one. The factor row is locked, so the check and the
 * delete cannot interleave with another attempt.
 */
async function consumeChallenge(
  tx: Transaction,
  input: {
    factorId: string;
    sessionId: string;
    purpose: Purpose;
    presented: string | null;
    now: Date;
  },
): Promise<string | null> {
  if (input.presented === null) return null;
  const [row] = await tx
    .delete(mfaPasskeyChallenges)
    .where(
      and(
        eq(mfaPasskeyChallenges.factorId, input.factorId),
        eq(mfaPasskeyChallenges.sessionId, input.sessionId),
        eq(mfaPasskeyChallenges.purpose, input.purpose),
        eq(mfaPasskeyChallenges.challenge, input.presented),
      ),
    )
    .returning();
  if (!row || row.expiresAt.getTime() <= input.now.getTime()) return null;
  return row.challenge;
}

/** Counts a wrong proof toward the five-miss lock; the caller returns the error. */
async function recordFailure(
  tx: Transaction,
  factor: FactorRow,
  now: Date,
): Promise<HttpError | CoreError> {
  const failedAttempts = factor.failedAttempts + 1;
  const locked = failedAttempts >= MAX_MFA_ATTEMPTS;
  await tx
    .update(mfaFactors)
    .set({
      failedAttempts,
      lockedUntil: locked
        ? new Date(now.getTime() + MFA_LOCK_MINUTES * 60_000)
        : factor.lockedUntil,
    })
    .where(eq(mfaFactors.id, factor.id));
  return locked ? lockedError() : invalidPasskey();
}

/**
 * Starts passkey enrollment: a pending factor and WebAuthn creation options.
 * Called from enrollMfaFactor after its step-up and limit checks.
 */
export async function beginPasskeyEnrollment(input: {
  readonly userId: string;
  readonly accountName: string;
  readonly sessionId: string;
  readonly now?: Date;
}): Promise<PasskeyEnrollment> {
  const now = input.now ?? new Date();
  const { rpID } = relyingParty();
  const existing = await db
    .select()
    .from(mfaFactors)
    .where(
      and(
        eq(mfaFactors.userId, input.userId),
        eq(mfaFactors.type, "passkey"),
        isNotNull(mfaFactors.verifiedAt),
      ),
    )
    .orderBy(asc(mfaFactors.createdAt));
  const excludeCredentials = existing.flatMap((factor) => {
    const stored = readStored(factor);
    return stored
      ? [{ id: stored.credentialId, transports: stored.transports }]
      : [];
  });

  const factorId = randomUUID();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: input.accountName,
    userID: new TextEncoder().encode(input.userId),
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    timeout: MFA_ENROLLMENT_TTL_MINUTES * 60_000,
  });
  await db.transaction(async (tx) => {
    await tx
      .insert(mfaFactors)
      .values({ id: factorId, userId: input.userId, type: "passkey" });
    await saveChallenge(tx, {
      factorId,
      sessionId: input.sessionId,
      purpose: "register",
      challenge: options.challenge,
      expiresAt: new Date(now.getTime() + MFA_ENROLLMENT_TTL_MINUTES * 60_000),
    });
  });
  passkeyLog.info(
    { factorId, userId: input.userId },
    "passkey enrollment started",
  );
  return passkeyEnrollmentSchema.parse({
    type: "passkey",
    factorId,
    publicKeyOptions: options,
  });
}

/**
 * Finishes enrollment from the browser's attestation: checks the challenge,
 * origin and relying party, stores the credential id + public key and marks the
 * factor (and this session, like a TOTP enrollment) verified.
 */
export async function finishPasskeyEnrollment(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly factorId: string;
  readonly attestation: PasskeyAttestation;
  readonly now?: Date;
}): Promise<MfaVerificationResult> {
  const now = input.now ?? new Date();
  const { rpID, origin } = relyingParty();
  const outcome = await db.transaction(async (tx) => {
    // Per-user activation lock first, factor row second (same order as
    // verifyMfaFactor), so two activations for one user never interleave.
    await lockUserFactorActivation(tx, input.userId);
    const factor = await lockFactor(tx, input.userId, input.factorId);
    if (!factor) return { error: notFound() };
    if (factor.type !== "passkey")
      return {
        error: new HttpError(
          409,
          "MFA_FACTOR_UNSUPPORTED",
          "Faktor ini bukan passkey.",
        ),
      };
    if (factor.verifiedAt !== null)
      return {
        error: new CoreError("CONFLICT", "Passkey ini sudah terdaftar."),
      };
    if (
      now.getTime() >=
      factor.createdAt.getTime() + MFA_ENROLLMENT_TTL_MINUTES * 60_000
    )
      return {
        error: new CoreError(
          "CONFLICT",
          "Pendaftaran faktor ini kedaluwarsa. Daftarkan ulang.",
        ),
      };
    if (factor.lockedUntil && factor.lockedUntil.getTime() > now.getTime())
      return { error: lockedError() };
    // Re-check the step-up rule enrollMfaFactor applied at the start: another
    // factor may have become verified since. Before the challenge is consumed,
    // so a session without the right keeps its challenge; nothing was written
    // yet, so throwing just rolls back.
    await assertFactorActivationAllowed(tx, {
      userId: input.userId,
      factorId: factor.id,
      sessionId: input.sessionId,
      now,
    });

    const expectedChallenge = await consumeChallenge(tx, {
      factorId: factor.id,
      sessionId: input.sessionId,
      purpose: "register",
      presented: clientChallenge(input.attestation.response.clientDataJSON),
      now,
    });
    if (expectedChallenge === null) return { error: invalidChallenge() };

    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: input.attestation as unknown as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch {
      return { error: await recordFailure(tx, factor, now) };
    }
    if (!verified.verified)
      return { error: await recordFailure(tx, factor, now) };

    const { credential } = verified.registrationInfo;
    const stored: StoredPasskey = {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      transports: credential.transports,
    };
    await tx
      .update(mfaFactors)
      .set({
        publicKey: stored,
        signCount: credential.counter,
        verifiedAt: now,
        failedAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(mfaFactors.id, factor.id));
    // Enrollment only fills an empty stamp: it must not refresh a proof the
    // user did not just make with a signature, or a hijacked session could
    // mint a fresh re-auth by adding its own passkey.
    await tx
      .update(session)
      .set({ mfaVerifiedAt: now })
      .where(
        and(
          eq(session.id, input.sessionId),
          eq(session.userId, input.userId),
          isNull(session.mfaVerifiedAt),
        ),
      );
    return { factor };
  });
  if ("error" in outcome) throw outcome.error;
  return {
    factorId: mfaFactorIdSchema.parse(outcome.factor.id),
    verifiedAt: iso(now),
  };
}

/**
 * Issues passkey authentication options for this session. Replaces any earlier
 * challenge for the same (factor, session), so only the newest one verifies.
 */
export async function issuePasskeyChallenge(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly factorId: string;
  readonly now?: Date;
}): Promise<MfaChallenge> {
  const now = input.now ?? new Date();
  const { rpID } = relyingParty();
  const outcome = await db.transaction(async (tx) => {
    const factor = await lockFactor(tx, input.userId, input.factorId);
    if (!factor) return { error: notFound() };
    const stored = readStored(factor);
    if (factor.type !== "passkey" || factor.verifiedAt === null || !stored)
      return {
        error: new HttpError(
          409,
          "MFA_FACTOR_UNSUPPORTED",
          "Faktor ini bukan passkey yang sudah terdaftar.",
        ),
      };
    if (factor.lockedUntil && factor.lockedUntil.getTime() > now.getTime())
      return { error: lockedError() };
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: [
        { id: stored.credentialId, transports: stored.transports },
      ],
      userVerification: "required",
      timeout: MFA_PASSKEY_CHALLENGE_TTL_MINUTES * 60_000,
    });
    await saveChallenge(tx, {
      factorId: factor.id,
      sessionId: input.sessionId,
      purpose: "authenticate",
      challenge: options.challenge,
      expiresAt: new Date(
        now.getTime() + MFA_PASSKEY_CHALLENGE_TTL_MINUTES * 60_000,
      ),
    });
    return { options };
  });
  if ("error" in outcome) throw outcome.error;
  return mfaChallengeSchema.parse({
    factorId: input.factorId,
    // JSON round trip drops `undefined` members (e.g. a missing `transports`),
    // which `z.json()` would refuse.
    publicKeyOptions: JSON.parse(JSON.stringify(outcome.options)),
  });
}

/**
 * Verifies a passkey assertion for this session (AUTH-05): marks the session
 * MFA-verified and stores the new signature counter. The challenge is deleted
 * first, so a captured assertion cannot be replayed in this or any other session.
 */
export async function verifyPasskeyAssertion(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly factorId: string;
  readonly assertion: PasskeyAssertion;
  readonly now?: Date;
}): Promise<MfaVerificationResult> {
  const now = input.now ?? new Date();
  const { rpID, origin } = relyingParty();
  // A wrong proof must still commit its failure counter and the consumed
  // challenge, so the outcome is returned and thrown after the commit.
  const outcome = await db.transaction(async (tx) => {
    const factor = await lockFactor(tx, input.userId, input.factorId);
    if (!factor) return { error: notFound() };
    const stored = readStored(factor);
    if (factor.type !== "passkey" || factor.verifiedAt === null || !stored)
      return {
        error: new HttpError(
          409,
          "MFA_FACTOR_UNSUPPORTED",
          "Faktor ini bukan passkey yang sudah terdaftar.",
        ),
      };
    if (factor.lockedUntil && factor.lockedUntil.getTime() > now.getTime())
      return { error: lockedError() };

    const expectedChallenge = await consumeChallenge(tx, {
      factorId: factor.id,
      sessionId: input.sessionId,
      purpose: "authenticate",
      presented: clientChallenge(input.assertion.response.clientDataJSON),
      now,
    });
    if (expectedChallenge === null) return { error: invalidChallenge() };
    // The credential must be the one enrolled on this factor.
    if (input.assertion.id !== stored.credentialId)
      return { error: await recordFailure(tx, factor, now) };

    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response: input.assertion as unknown as AuthenticationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: stored.credentialId,
          publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
          counter: factor.signCount,
          transports: stored.transports,
        },
      });
    } catch {
      return { error: await recordFailure(tx, factor, now) };
    }
    const { newCounter } = verified.authenticationInfo;
    // Cloned-authenticator signal: a counter that does not rise (library check
    // repeated here so the rule holds even if its behavior changes).
    if (
      !verified.verified ||
      ((newCounter > 0 || factor.signCount > 0) &&
        newCounter <= factor.signCount)
    )
      return { error: await recordFailure(tx, factor, now) };

    await tx
      .update(mfaFactors)
      .set({ signCount: newCounter, failedAttempts: 0, lockedUntil: null })
      .where(eq(mfaFactors.id, factor.id));
    // The session row is global; scope by user so a leaked session id cannot
    // be marked verified for someone else.
    await tx
      .update(session)
      .set({
        mfaVerifiedAt: now,
        mfaChallengeVerifiedAt: challengeStampValue(
          factor.verifiedAt ?? factor.createdAt,
          now,
        ),
      })
      .where(
        and(eq(session.id, input.sessionId), eq(session.userId, input.userId)),
      );
    return { factor };
  });
  if ("error" in outcome) throw outcome.error;
  return {
    factorId: mfaFactorIdSchema.parse(outcome.factor.id),
    verifiedAt: iso(now),
  };
}
