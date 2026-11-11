// Staff MFA recovery codes (AUTH-05): a set of ten single-use codes that lets a
// user who lost their authenticator mark a session MFA-verified once.
//
// Rules live in docs/briefs/sub-omp4-mfa-recovery.md. The short version: only
// keyed digests are stored (lib/mfa-recovery-code.ts), regenerating replaces the
// whole set, five wrong codes lock the set for fifteen minutes (same numbers as
// a TOTP factor), a code never works without a verified factor, and every
// outcome is written to the append-only audit log of the session's tenant.
// Neither the code nor its digest ever reaches the audit log or the logger.

import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { maskAuditChanges } from "@starter/shared/audit";
import { AccessError } from "@starter/shared/access";
import {
  createUlid,
  CoreError,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  MFA_RECOVERY_CODE_COUNT,
  mfaRecoveryCodesSchema,
  mfaRecoveryStatusSchema,
  mfaRecoveryVerificationResultSchema,
  type MfaRecoveryCodes,
  type MfaRecoveryStatus,
  type MfaRecoveryVerificationResult,
} from "@starter/shared/identity";
import { db } from "../db";
import {
  mfaFactors,
  mfaRecoveryCodes,
  mfaRecoveryCodeSets,
  session,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeHash,
  recoveryCodeHashCandidates,
} from "../lib/mfa-recovery-code";
import { MAX_MFA_ATTEMPTS, MFA_LOCK_MINUTES } from "../lib/mfa-policy";
import { recordAudit } from "./core-audit";

const recoveryLog = logger.child({ module: "identity-mfa-recovery" });

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type AuditAction =
  | "mfa_recovery_codes.generated"
  | "mfa_recovery_code.used"
  | "mfa_recovery_code.rejected"
  | "mfa_recovery_codes.revoked";

function lockedError(): CoreError {
  return new CoreError(
    "RATE_LIMITED",
    "Terlalu banyak kode salah. Coba lagi dalam 15 menit.",
  );
}

function invalidError(): HttpError {
  return new HttpError(
    401,
    "MFA_RECOVERY_CODE_INVALID",
    "Kode cadangan salah atau sudah dipakai.",
  );
}

/** Verified factors only: an unverified row must never satisfy AUTH-05. */
async function hasVerifiedFactor(
  tx: Transaction,
  userId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: mfaFactors.id })
    .from(mfaFactors)
    .where(and(eq(mfaFactors.userId, userId), isNotNull(mfaFactors.verifiedAt)))
    .limit(1);
  return rows.length > 0;
}

async function countUnused(tx: Transaction, setId: string): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(mfaRecoveryCodes)
    .where(
      and(eq(mfaRecoveryCodes.setId, setId), isNull(mfaRecoveryCodes.usedAt)),
    );
  return row?.total ?? 0;
}

/** The tenant the session is signed in to, or null (no audit row possible). */
async function sessionTenantId(
  tx: Transaction,
  input: { sessionId: string; userId: string },
): Promise<string | null> {
  const [row] = await tx
    .select({ tenantId: session.tenantId })
    .from(session)
    .where(
      and(eq(session.id, input.sessionId), eq(session.userId, input.userId)),
    )
    .limit(1);
  return row?.tenantId ?? null;
}

function sessionContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

/**
 * Appends one audit row in the session tenant's own transaction. Called after
 * the state transaction commits, so a rejection is audited even though its
 * transaction returned an error. A session without a tenant has nowhere to
 * write: only a log line (same precedent as login rejections).
 */
export async function auditRecoveryEvent(input: {
  readonly tenantId: string | null;
  readonly userId: string;
  readonly setId: string | null;
  readonly action: AuditAction;
  readonly after: Readonly<Record<string, string | number | boolean>>;
  readonly now?: Date;
}): Promise<void> {
  if (input.tenantId === null) {
    recoveryLog.info(
      { userId: input.userId, action: input.action, ...input.after },
      "mfa recovery event (no tenant, not audited)",
    );
    return;
  }
  const now = input.now ?? new Date();
  const context = sessionContext(input.tenantId);
  const safeFields = Object.keys(input.after);
  try {
    await withTenant(db, context, (tx) =>
      recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId: input.tenantId,
          outletId: null,
          actorType: "user",
          actorId: input.userId,
          deviceId: null,
          action: input.action,
          objectType: "mfa_recovery_code_set",
          objectId: input.setId,
          reason: null,
          maskedChanges: {
            before: null,
            after: maskAuditChanges(input.after, safeFields),
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: now.toISOString(),
        },
        safeFields,
      ),
    );
  } catch {
    // Committed state must stand: a failed audit write never becomes a 500.
    recoveryLog.warn(
      { userId: input.userId, action: input.action },
      "failed to audit an mfa recovery event",
    );
  }
}

/** How many codes are left and when the set was made. Never the codes. */
export async function getMfaRecoveryStatus(input: {
  readonly userId: string;
}): Promise<MfaRecoveryStatus> {
  return db.transaction(async (tx) => {
    const [set] = await tx
      .select()
      .from(mfaRecoveryCodeSets)
      .where(eq(mfaRecoveryCodeSets.userId, input.userId))
      .limit(1);
    if (!set)
      return mfaRecoveryStatusSchema.parse({
        remaining: 0,
        generatedAt: null,
      });
    return mfaRecoveryStatusSchema.parse({
      remaining: await countUnused(tx, set.id),
      generatedAt: set.createdAt.toISOString(),
    });
  });
}

/**
 * Creates a fresh set of ten codes, replacing (and invalidating) any earlier
 * set. The plaintext is returned here once and never stored.
 */
export async function generateMfaRecoveryCodes(input: {
  readonly userId: string;
  readonly sessionId: string;
  /** Whether the caller's session already verified a second factor. */
  readonly sessionMfaVerified: boolean;
  readonly now?: Date;
}): Promise<MfaRecoveryCodes> {
  // Step-up (AUTH-05): a stolen password alone must not mint working codes.
  if (!input.sessionMfaVerified) throw new AccessError("MFA_REQUIRED");
  const now = input.now ?? new Date();
  const codes = Array.from({ length: MFA_RECOVERY_CODE_COUNT }, () =>
    generateRecoveryCode(),
  );

  const result = await db.transaction(async (tx) => {
    // Serializes parallel regenerations of one user (unique user_id).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mfa-recovery:${input.userId}`}, 0))`,
    );
    if (!(await hasVerifiedFactor(tx, input.userId)))
      throw new CoreError(
        "CONFLICT",
        "Daftarkan faktor kedua terlebih dahulu sebelum membuat kode cadangan.",
      );
    const removed = await tx
      .delete(mfaRecoveryCodeSets)
      .where(eq(mfaRecoveryCodeSets.userId, input.userId))
      .returning({ id: mfaRecoveryCodeSets.id });
    const setId = randomUUID();
    await tx.insert(mfaRecoveryCodeSets).values({
      id: setId,
      userId: input.userId,
      createdAt: now,
    });
    await tx.insert(mfaRecoveryCodes).values(
      codes.map((code) => ({
        id: randomUUID(),
        setId,
        codeHash: recoveryCodeHash(input.userId, normalizeRecoveryCode(code)),
        createdAt: now,
      })),
    );
    return {
      setId,
      regenerated: removed.length > 0,
      tenantId: await sessionTenantId(tx, input),
    };
  });

  await auditRecoveryEvent({
    tenantId: result.tenantId,
    userId: input.userId,
    setId: result.setId,
    action: "mfa_recovery_codes.generated",
    after: { count: MFA_RECOVERY_CODE_COUNT, regenerated: result.regenerated },
    now,
  });
  recoveryLog.info(
    { userId: input.userId, regenerated: result.regenerated },
    "mfa recovery codes generated",
  );
  return mfaRecoveryCodesSchema.parse({
    codes,
    generatedAt: now.toISOString(),
  });
}

type ConsumeOutcome =
  | { kind: "ok"; setId: string; remaining: number; tenantId: string | null }
  | {
      kind: "invalid" | "locked";
      setId: string | null;
      tenantId: string | null;
    };

/**
 * Spends one recovery code for this session and marks it MFA-verified. A
 * missing set, no verified factor, a wrong code and a spent code all answer
 * the same 401 (no oracle). Five misses lock the set for fifteen minutes.
 */
export async function verifyMfaRecoveryCode(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly code: string;
  readonly now?: Date;
}): Promise<MfaRecoveryVerificationResult> {
  const now = input.now ?? new Date();
  // Both blind index versions: a code issued before a cutover still verifies.
  // The two digests of one code differ, so at most one row matches and the
  // single-use update below still spends it once.
  const hashes = recoveryCodeHashCandidates(
    input.userId,
    normalizeRecoveryCode(input.code),
  );

  // The set row is locked (SELECT … FOR UPDATE): parallel guesses are
  // serialized, so the lock counts every miss and a code cannot be spent twice.
  // A miss must still commit its counter, so the outcome is returned and the
  // error thrown only after the transaction commits.
  const outcome = await db.transaction(async (tx): Promise<ConsumeOutcome> => {
    const tenantId = await sessionTenantId(tx, input);
    if (!(await hasVerifiedFactor(tx, input.userId)))
      return { kind: "invalid", setId: null, tenantId };
    const [set] = await tx
      .select()
      .from(mfaRecoveryCodeSets)
      .where(eq(mfaRecoveryCodeSets.userId, input.userId))
      .limit(1)
      .for("update");
    if (!set) return { kind: "invalid", setId: null, tenantId };
    if (set.lockedUntil !== null && set.lockedUntil.getTime() > now.getTime())
      return { kind: "locked", setId: set.id, tenantId };

    const spent = await tx
      .update(mfaRecoveryCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(mfaRecoveryCodes.setId, set.id),
          inArray(mfaRecoveryCodes.codeHash, hashes),
          isNull(mfaRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: mfaRecoveryCodes.id });

    if (spent.length === 0) {
      const failedAttempts = set.failedAttempts + 1;
      const locked = failedAttempts >= MAX_MFA_ATTEMPTS;
      await tx
        .update(mfaRecoveryCodeSets)
        .set({
          // Never reset by a lock: once it expires, the next miss relocks.
          failedAttempts,
          lockedUntil: locked
            ? new Date(now.getTime() + MFA_LOCK_MINUTES * 60_000)
            : set.lockedUntil,
        })
        .where(eq(mfaRecoveryCodeSets.id, set.id));
      return { kind: locked ? "locked" : "invalid", setId: set.id, tenantId };
    }

    await tx
      .update(mfaRecoveryCodeSets)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(mfaRecoveryCodeSets.id, set.id));
    // The session row is global; scope by user so a leaked session id cannot
    // be marked verified for someone else.
    const marked = await tx
      .update(session)
      .set({ mfaVerifiedAt: now })
      .where(
        and(
          eq(session.id, input.sessionId),
          eq(session.userId, input.userId),
          isNull(session.revokedAt),
        ),
      )
      .returning({ id: session.id });
    // Revoked or gone between requireAuth and here: roll back so the code is
    // not spent on a session that cannot use it.
    if (marked.length === 0) {
      tx.rollback();
    }
    return {
      kind: "ok",
      setId: set.id,
      remaining: await countUnused(tx, set.id),
      tenantId,
    };
  });

  if (outcome.kind === "ok") {
    await auditRecoveryEvent({
      tenantId: outcome.tenantId,
      userId: input.userId,
      setId: outcome.setId,
      action: "mfa_recovery_code.used",
      after: { remaining: outcome.remaining },
      now,
    });
    return mfaRecoveryVerificationResultSchema.parse({
      verifiedAt: now.toISOString(),
      remaining: outcome.remaining,
    });
  }
  await auditRecoveryEvent({
    tenantId: outcome.tenantId,
    userId: input.userId,
    setId: outcome.setId,
    action: "mfa_recovery_code.rejected",
    after: { cause: outcome.kind },
    now,
  });
  throw outcome.kind === "locked" ? lockedError() : invalidError();
}

/**
 * Deletes the user's recovery set (codes cascade). Called by deleteMfaFactor
 * in the same transaction when the last verified factor goes: a code must never
 * satisfy MFA with no factor. Returns the removed set id, or null if none.
 */
export async function revokeMfaRecoveryCodes(
  tx: Transaction,
  input: { readonly userId: string },
): Promise<string | null> {
  const removed = await tx
    .delete(mfaRecoveryCodeSets)
    .where(eq(mfaRecoveryCodeSets.userId, input.userId))
    .returning({ id: mfaRecoveryCodeSets.id });
  return removed[0]?.id ?? null;
}
