// Payout payment-proof binding and password step-up (bead legend-658 card
// f5n9y, L5; design docs/design/payroll-disbursement.md 9 "MFA step-up", 7.7;
// tests apps/api/src/test/payroll-payout-evidence.test.ts).
//
// - assertEvidenceKeyForBatch: a payment-proof key names an object in the
//   storage of the tenant that owns the batch, inside that batch's folder:
//   `tenants/<tenantId>/payroll-payout/<batchId>/<file>`. Anything else
//   (another tenant, another batch, "..", an encoded slash) is refused before
//   a row is written. `assertEvidenceKeyForBatch` checks the shape only (the
//   upload service uses it before the object exists);
//   `assertEvidenceKeyForBatchStored` also needs the object in the storage
//   (legend-01gg8) and is what resolve, return, confirm and the overpaid record
//   call before any money status changes.
// - assertPayoutReauth / verifyReauthPassword: when the session's
//   `mfa_verified_at` may come from the first MFA enrollment alone
//   (`mfa_challenge_verified_at` is NULL), a money action needs the account
//   password again. A user who really passed a code or passkey check is not
//   asked. Wrong guesses are counted per user and lock for a while.

import { and, eq } from "drizzle-orm";
import type { Express, Request } from "express";
import { AccessError } from "@starter/shared/access";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  CoreError,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { db } from "../db";
import { account } from "../db/schema";
import { auth } from "../lib/auth";
import { createFixedWindowCounter } from "../lib/fixed-window-counter";
import { HttpError } from "../lib/http-error";
import { loadSessionRow } from "./identity-session.service";

const EVIDENCE_ROOT = "tenants";
const EVIDENCE_FOLDER = "payroll-payout";
const EVIDENCE_KEY_MAX = 500;
// One path segment: no separators (slash or backslash), no control characters.
const FILE_SEGMENT = /^[^/\\]{1,200}$/u;
const hasControlChar = (value: string) =>
  [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
const ENCODED_DOT_OR_SLASH = /%(?:2e|2f|5c)/i;

function invalidEvidence(): HttpError {
  return new HttpError(
    422,
    "PAYOUT_EVIDENCE_INVALID",
    "Kunci bukti tidak milik batch ini.",
  );
}

/**
 * Returns the trimmed key when it lies inside this batch's folder of this
 * tenant's storage; throws 422 PAYOUT_EVIDENCE_INVALID otherwise. The tenant
 * and batch come from the verified request scope, never from the key.
 */
export function assertEvidenceKeyForBatch(
  scope: { readonly tenantId: string; readonly batchId: string },
  evidenceKey: string,
): string {
  const key = evidenceKey.trim();
  if (key.length === 0 || key.length > EVIDENCE_KEY_MAX)
    throw invalidEvidence();
  if (ENCODED_DOT_OR_SLASH.test(key) || hasControlChar(key))
    throw invalidEvidence();
  const parts = key.split("/");
  const [root, tenant, folder, batch, file, ...rest] = parts;
  if (
    parts.length !== 5 ||
    rest.length > 0 ||
    root !== EVIDENCE_ROOT ||
    folder !== EVIDENCE_FOLDER ||
    tenant?.toLowerCase() !== scope.tenantId.toLowerCase() ||
    batch?.toLowerCase() !== scope.batchId.toLowerCase() ||
    file === undefined ||
    file === "." ||
    file === ".." ||
    !FILE_SEGMENT.test(file)
  )
    throw invalidEvidence();
  return key;
}

/**
 * Where a payment proof lives: the object storage and the verified request
 * context that scopes it. A missing storage means no proof can be confirmed.
 */
export type PayoutEvidenceStore = {
  readonly storage: ObjectStorage | null | undefined;
  readonly context: ScopedTenantContext;
};

const STORAGE_LOCAL_KEY = "payoutEvidenceStorage";

/** Called once by createApp with the storage runtime's object storage (or null). */
export function setPayoutEvidenceStorage(
  app: Express,
  storage: ObjectStorage | null | undefined,
): void {
  app.locals[STORAGE_LOCAL_KEY] = storage ?? null;
}

/** The proof store of a request: the app's storage plus the request's scoped context. */
export function payoutEvidenceStoreOf(
  req: Request,
  context: ScopedTenantContext,
): PayoutEvidenceStore {
  return {
    storage:
      (req.app.locals[STORAGE_LOCAL_KEY] as ObjectStorage | null) ?? null,
    context,
  };
}

/**
 * `assertEvidenceKeyForBatch` plus proof that the object really exists in this
 * tenant's storage (a head-by-get probe): a key with the right shape that was
 * never uploaded is 422 PAYOUT_EVIDENCE_INVALID. No storage wired: 503, nothing
 * is accepted. Call it before any row is written.
 */
export async function assertEvidenceKeyForBatchStored(
  store: PayoutEvidenceStore,
  scope: { readonly tenantId: string; readonly batchId: string },
  evidenceKey: string,
): Promise<string> {
  const key = assertEvidenceKeyForBatch(scope, evidenceKey);
  if (!store.storage)
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan berkas belum tersedia.",
    );
  try {
    await store.storage.get(store.context, {
      tenantId: scope.tenantId as TenantId,
      outletId: null,
      reference: "payout-evidence-check",
      key,
      visibility: "private",
    });
  } catch (error) {
    if (error instanceof CoreError && error.code === "NOT_FOUND")
      throw invalidEvidence();
    throw error;
  }
  return key;
}

/** Same rule for an optional key: absent or blank becomes null. */
export function assertOptionalEvidenceKeyForBatch(
  scope: { readonly tenantId: string; readonly batchId: string },
  evidenceKey: string | null | undefined,
): string | null {
  if (evidenceKey === null || evidenceKey === undefined) return null;
  if (evidenceKey.trim().length === 0) return null;
  return assertEvidenceKeyForBatch(scope, evidenceKey);
}

/** Optional key with the stored-object check; absent or blank becomes null. */
export async function assertOptionalEvidenceKeyForBatchStored(
  store: PayoutEvidenceStore,
  scope: { readonly tenantId: string; readonly batchId: string },
  evidenceKey: string | null | undefined,
): Promise<string | null> {
  if (evidenceKey === null || evidenceKey === undefined) return null;
  if (evidenceKey.trim().length === 0) return null;
  return assertEvidenceKeyForBatchStored(store, scope, evidenceKey);
}

/**
 * True when `password` is the current password of the user's credential
 * account. Uses Better Auth's own hasher (`$context.password.verify`), the
 * same call its email sign-in makes. A user without a password account never
 * verifies.
 */
export async function verifyReauthPassword(input: {
  readonly userId: string;
  readonly password: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ hash: account.password })
    .from(account)
    .where(
      and(
        eq(account.userId, input.userId),
        eq(account.providerId, "credential"),
      ),
    )
    .limit(1);
  if (!row?.hash) return false;
  const context = await auth.$context;
  return context.password.verify({
    hash: row.hash,
    password: input.password,
  });
}

/**
 * How long a second-factor proof counts for the payout step-up: the MFA gate of
 * the payout routes and the challenge stamp that skips the password use this
 * one number.
 */
export const PAYOUT_STEP_UP_MAX_AGE_MINUTES = 15;

// Five wrong passwords per user in 15 minutes. In memory, per API process (the
// same trade-off as the other fixed-window limits); Better Auth's own sign-in
// limiter stays the outer wall.
const REAUTH_PASSWORD_LIMIT = 5;
const REAUTH_PASSWORD_WINDOW_MS = 15 * 60_000;
const reauthPasswordMisses = createFixedWindowCounter({
  limit: REAUTH_PASSWORD_LIMIT,
  windowMs: REAUTH_PASSWORD_WINDOW_MS,
  capacity: 10_000,
});

/** Which branch of the step-up passed (stored on a payout grant). */
export type PayoutReauthMethod = "mfa_challenge" | "password";

/**
 * Step-up for payout confirm, resolve and cash handover, called after the
 * body is parsed. Nothing to do when the session passed a real second-factor
 * challenge no longer than PAYOUT_STEP_UP_MAX_AGE_MINUTES ago (a stamp in the
 * future counts as stale). Otherwise (the stamp comes from enrollment alone, is
 * too old, or the row is gone) the account password must come with the request:
 * - missing: 401 REAUTH_REQUIRED
 * - wrong: 403 REAUTH_PASSWORD_INVALID
 * - five wrong in 15 minutes: 429 REAUTH_PASSWORD_LOCKED
 * Returns the branch that passed: "mfa_challenge" or "password".
 * `passwordOnly` skips the challenge shortcut: the account password is always
 * verified and the branch is always "password" (the "not me" disown, whose
 * grant accepts no other method; legend-l2zru).
 */
export async function assertPayoutReauth(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly password: string | undefined;
  readonly now?: Date;
  readonly passwordOnly?: boolean;
}): Promise<PayoutReauthMethod> {
  const row = await loadSessionRow(input.sessionId);
  if (!row || row.userId !== input.userId)
    throw new HttpError(401, "UNAUTHORIZED", "Sesi berakhir. Masuk lagi.");
  const nowMs = (input.now ?? new Date()).getTime();
  if (!input.passwordOnly && row.mfaChallengeVerifiedAt !== null) {
    const ageMs = nowMs - row.mfaChallengeVerifiedAt.getTime();
    if (ageMs >= 0 && ageMs <= PAYOUT_STEP_UP_MAX_AGE_MINUTES * 60_000)
      return "mfa_challenge";
  }
  if (input.password === undefined || input.password.length === 0)
    throw new AccessError("REAUTH_REQUIRED");
  const slot = reauthPasswordMisses.reserve(input.userId, nowMs);
  if (slot.retryAfter !== null)
    throw new HttpError(
      429,
      "REAUTH_PASSWORD_LOCKED",
      "Terlalu banyak percobaan password. Coba lagi nanti.",
    );
  const ok = await verifyReauthPassword({
    userId: input.userId,
    password: input.password,
  });
  if (!ok)
    throw new HttpError(403, "REAUTH_PASSWORD_INVALID", "Password salah.");
  // A right password does not count against the limit.
  slot.release();
  return "password";
}
