// Payslip PIN (bead legend-2ap3; PRD v1.7 §3 D.30 "Slip Gaji": a payslip opens
// only with the employee's own PIN). Contract: `@starter/shared/hris/payroll`.
//
// - One PIN per employee (`payslip_pins`). The hash reuses the staff device pin
//   construction (device-pin-hash.ts: scrypt over a tenant-pepper HMAC) with a
//   binding of the `payslip` domain + tenant + employee, so a staff pin hash
//   never verifies as a payslip PIN and the other way round.
// - Attempts follow the device-pin semantics: the row is locked FOR UPDATE, a
//   miss counts, the fifth locks for PAYSLIP_PIN_LOCK_MINUTES (that attempt
//   already answers 423), a locked row is refused without looking at the guess,
//   a correct PIN resets the counter. The counter commits in the same
//   transaction as the idempotency record; the route error is thrown only after
//   the transaction committed, so a miss is never rolled back. A retry with the
//   same idempotency key replays the stored outcome without a second attempt.
// - HR never sees or sets a PIN: HR reset deletes the row (and any open reset
//   WhatsApp proof); the employee then sets a new one. The self-service way
//   back in is an INBOUND WhatsApp message from the employee's own long-linked
//   number (legend-9h2oj; proof engine in identity-wa-proof.service, nothing is
//   ever sent out).
// Never log, audit, store in an idempotency response, or emit a PIN, hash or
// code. Audit rows carry ids, status and lock time only.
import { createHash, createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  CoreError,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  PAYSLIP_PIN_LOCK_MINUTES,
  PAYSLIP_PIN_MAX_ATTEMPTS,
  PayrollError,
  type CompletePayslipPinResetWaInput,
  type PayslipPinResetWaIssued,
  type PayslipPinResetWaStatus,
  type PayslipPinStatus,
  type ResetPayslipPinInput,
  type SetMyPayslipPinInput,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { loginChallenges } from "../db/schema/identity.ts";
import { payslipPins } from "../db/schema/payslip-pin.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  hashStaffPin,
  STAFF_PIN_KDF,
  verifyStaffPinHash,
  type StaffPinBinding,
} from "./device-pin-hash.ts";
import {
  currentStaffPinPepperVersion,
  payslipPinPepper,
} from "./device-pin-pepper.ts";
import { hrisAuditEntry, loadHrisAccess, notFound } from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import {
  cancelOpenWhatsAppProofs,
  cancelWhatsAppProof,
  consumeWhatsAppProof,
  diagnoseWhatsAppProofIdentity,
  findWhatsAppProofSender,
  issueWhatsAppProof,
  readWhatsAppProof,
} from "./identity-wa-proof.service.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import type { Tx } from "./permission-resolver.ts";

export const PAYSLIP_SELF_CODE = "self.payslip.view" as const;
const MINUTE_MS = 60_000;

/**
 * Audit `after` field names that are safe to show: ids, status, lock time.
 * `loginId` is the sha256 hex of the login session id behind `payslip.viewed`
 * (see `payslipLoginIdOf`; the name avoids the audit deny list, which redacts
 * "session").
 */
export const PAYSLIP_PIN_AUDIT_SAFE_FIELDS = [
  "status",
  "lockedUntil",
  "failedAttempts",
  "payslipId",
  "runId",
  "loginId",
  "employeeId",
  "expiresAt",
] as const;

// ----------------------------------------------------------------- helpers

/**
 * Value stored as audit `loginId` and compared by TL-09: sha256 hex of the
 * login session id, so the audit log never holds a live session id.
 */
export function payslipLoginIdOf(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

type PinRow = typeof payslipPins.$inferSelect;

export type PinAttemptState = {
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
};

/** `payslip` domain + tenant + employee; fixed label keeps it apart from staff pins. */
export function payslipPinBinding(
  tenantId: string,
  employeeId: string,
): StaffPinBinding {
  return { tenantId, outletId: "payslip", userId: employeeId };
}

function isLocked(state: PinAttemptState, now: Date): boolean {
  return (
    state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime()
  );
}

/** Device-pin counter rules with the payslip constants. Caller checked the lock. */
function nextState(
  state: PinAttemptState,
  correct: boolean,
  now: Date,
): PinAttemptState {
  if (correct) return { failedAttempts: 0, lockedUntil: null };
  const lockRanOut =
    state.lockedUntil !== null && state.lockedUntil.getTime() <= now.getTime();
  const failedAttempts = (lockRanOut ? 0 : state.failedAttempts) + 1;
  if (failedAttempts >= PAYSLIP_PIN_MAX_ATTEMPTS)
    return {
      failedAttempts: PAYSLIP_PIN_MAX_ATTEMPTS,
      lockedUntil: new Date(
        now.getTime() + PAYSLIP_PIN_LOCK_MINUTES * MINUTE_MS,
      ),
    };
  return { failedAttempts, lockedUntil: null };
}

export function pinStatusOf(
  row: Pick<PinRow, "lockedUntil"> | null,
  now: Date,
): PayslipPinStatus {
  if (!row) return { status: "not_set", lockedUntil: null };
  if (row.lockedUntil && row.lockedUntil.getTime() > now.getTime())
    return { status: "locked", lockedUntil: row.lockedUntil.toISOString() };
  return { status: "active", lockedUntil: null };
}

export type PinSelf = {
  readonly actor: string;
  readonly employeeId: string;
  readonly homeOutletId: string;
};

/** The caller's own employee row for a `self.payslip.view` route (HR-01). */
export async function loadPayslipSelf(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  now: Date = new Date(),
): Promise<PinSelf> {
  const access = await loadHrisAccess(tx, context, actorUserId, now);
  if (!access.snapshot.permissions.includes(PAYSLIP_SELF_CODE))
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Your account cannot perform this action in this tenant.",
    );
  if (!access.own) throw notFound();
  return {
    actor: access.actorUserId,
    employeeId: access.own.id,
    homeOutletId: access.own.homeOutletId,
  };
}

const SECRET_REQUEST_FIELDS = ["pin", "currentPin", "code"] as const;

/**
 * Idempotency fingerprint input with the PIN / current PIN / code replaced by
 * an HMAC under the staff PIN pepper (a separate secret from the HRIS key, and
 * domain-separated). The stored fingerprint is kept forever and is a fast HMAC
 * of the request, so a 6-digit secret inside it would be brute-forceable.
 */
export function payslipFingerprintRequest(
  tenantId: string,
  request: Record<string, unknown>,
): Record<string, unknown> {
  const pepper = pepperFor(tenantId, currentStaffPinPepperVersion());
  const out: Record<string, unknown> = { ...request };
  for (const field of SECRET_REQUEST_FIELDS) {
    const value = out[field];
    if (typeof value !== "string") continue;
    out[field] = createHmac("sha256", pepper)
      .update(
        ["payslip-fp", tenantId.toLowerCase(), field, value].join("\u0000"),
        "utf8",
      )
      .digest("hex");
  }
  return out;
}

/** Serialises every PIN mutation of one employee (also the first insert). */
export async function lockPayslipPin(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
): Promise<PinRow | null> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payslip-pin:${tenantId}:${employeeId}`}, 0))`,
  );
  const [row] = await tx
    .select()
    .from(payslipPins)
    .where(
      and(
        eq(payslipPins.tenantId, tenantId),
        eq(payslipPins.employeeId, employeeId),
      ),
    )
    .for("update");
  return row ?? null;
}

function pepperFor(tenantId: string, version: number): Buffer {
  return payslipPinPepper(tenantId, version);
}

async function auditPin(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  entry: {
    readonly outletId: string;
    readonly action: string;
    readonly objectId: string;
    readonly after: Record<string, unknown>;
    readonly sensitiveReason?: string;
  },
): Promise<void> {
  await recordAudit(
    tx,
    context,
    hrisAuditEntry(context, actor, now, {
      ...entry,
      objectType: "payslip_pin",
    }),
    PAYSLIP_PIN_AUDIT_SAFE_FIELDS,
  );
}

export type PinCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "invalid"; readonly remainingAttempts: number }
  | { readonly kind: "locked"; readonly lockedUntil: string };

/**
 * One counted attempt against a locked row (caller holds `lockPayslipPin`). Writes the
 * new counter; the miss that reaches the limit also audits `payslip_pin.locked`.
 */
export async function checkPayslipPin(
  tx: Tx,
  context: ScopedTenantContext,
  self: PinSelf,
  row: PinRow,
  pin: string,
  now: Date,
): Promise<PinCheck> {
  const state: PinAttemptState = {
    failedAttempts: row.failedAttempts,
    lockedUntil: row.lockedUntil,
  };
  // A locked PIN is refused without looking at the guess (no oracle).
  if (isLocked(state, now))
    return { kind: "locked", lockedUntil: row.lockedUntil!.toISOString() };
  const correct = await verifyStaffPinHash({
    pepper: pepperFor(context.tenant.tenantId, row.pepperVersion),
    binding: payslipPinBinding(context.tenant.tenantId, self.employeeId),
    pin,
    stored: {
      salt: row.pinSalt,
      pinHash: row.pinHash,
      params: { N: row.kdfN, r: row.kdfR, p: row.kdfP, keyLength: 32 },
    },
  });
  const next = nextState(state, correct, now);
  await tx
    .update(payslipPins)
    .set({
      failedAttempts: next.failedAttempts,
      lockedUntil: next.lockedUntil,
      updatedAt: now,
    })
    .where(eq(payslipPins.id, row.id));
  if (correct) return { kind: "ok" };
  if (next.lockedUntil === null)
    return {
      kind: "invalid",
      remainingAttempts: PAYSLIP_PIN_MAX_ATTEMPTS - next.failedAttempts,
    };
  await auditPin(tx, context, self.actor, now, {
    outletId: self.homeOutletId,
    action: "payslip_pin.locked",
    objectId: row.id,
    after: {
      employeeId: self.employeeId,
      failedAttempts: next.failedAttempts,
      lockedUntil: next.lockedUntil.toISOString(),
    },
  });
  return { kind: "locked", lockedUntil: next.lockedUntil.toISOString() };
}

/** Maps a failed check to the contract error, after the transaction committed. */
export function assertPinCheckOk(outcome: {
  readonly kind: string;
  readonly remainingAttempts?: number;
  readonly lockedUntil?: string;
}): asserts outcome is { kind: "ok" } {
  if (outcome.kind === "locked")
    throw new PayrollError(
      "PAYSLIP_PIN_LOCKED",
      undefined,
      outcome.lockedUntil !== undefined
        ? { lockedUntil: outcome.lockedUntil }
        : {},
    );
  if (outcome.kind === "not_set") throw new PayrollError("PAYSLIP_PIN_NOT_SET");
  if (outcome.kind !== "ok")
    throw new PayrollError(
      "PAYSLIP_PIN_INVALID",
      undefined,
      outcome.remainingAttempts !== undefined
        ? { remainingAttempts: outcome.remainingAttempts }
        : {},
    );
}

async function storePin(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
  existing: PinRow | null,
  pin: string,
  now: Date,
): Promise<PinRow> {
  const version = currentStaffPinPepperVersion();
  const hashed = await hashStaffPin({
    pepper: pepperFor(context.tenant.tenantId, version),
    binding: payslipPinBinding(context.tenant.tenantId, employeeId),
    pin,
    params: STAFF_PIN_KDF,
  });
  const material = {
    pinSalt: hashed.salt,
    pinHash: hashed.pinHash,
    kdfN: hashed.params.N,
    kdfR: hashed.params.r,
    kdfP: hashed.params.p,
    pepperVersion: version,
    failedAttempts: 0,
    lockedUntil: null,
    setAt: now,
    updatedAt: now,
  };
  const [row] = existing
    ? await tx
        .update(payslipPins)
        .set(material)
        .where(eq(payslipPins.id, existing.id))
        .returning()
    : await tx
        .insert(payslipPins)
        .values({
          tenantId: context.tenant.tenantId,
          employeeId,
          ...material,
        })
        .returning();
  if (!row) throw new Error("Payslip PIN was not stored");
  return row;
}

// ------------------------------------------------------------------ status

/** GET /api/hris/me/payslip-pin. */
export async function getMyPayslipPinStatus(
  context: ScopedTenantContext,
  actorUserId: string,
  now: Date = new Date(),
): Promise<PayslipPinStatus> {
  return withTenant(db, context, async (tx) => {
    const self = await loadPayslipSelf(tx, context, actorUserId, now);
    const [row] = await tx
      .select({ lockedUntil: payslipPins.lockedUntil })
      .from(payslipPins)
      .where(
        and(
          eq(payslipPins.tenantId, context.tenant.tenantId),
          eq(payslipPins.employeeId, self.employeeId),
        ),
      )
      .limit(1);
    return pinStatusOf(row ?? null, now);
  });
}

// --------------------------------------------------------------------- set

type SetOutcome =
  | { readonly kind: "ok"; readonly status: PayslipPinStatus }
  | { readonly kind: "invalid"; readonly remainingAttempts?: number }
  | { readonly kind: "locked"; readonly lockedUntil: string }
  | { readonly kind: "current_required" };

/**
 * PUT /api/hris/me/payslip-pin. First set needs no `currentPin`; a change needs
 * it, and a wrong one counts as a failed attempt (locked → 423).
 */
export async function setMyPayslipPin(
  context: ScopedTenantContext,
  actorUserId: string,
  input: SetMyPayslipPinInput,
  nowOverride?: Date,
): Promise<PayslipPinStatus> {
  const { idempotencyKey, ...request } = input;
  const outcome = await withTenant(db, context, async (tx) => {
    const self = await loadPayslipSelf(
      tx,
      context,
      actorUserId,
      nowOverride ?? new Date(),
    );
    return idempotentHrisWrite<SetOutcome>(
      tx,
      context,
      idempotencyKey,
      "payslip_pin.set",
      payslipFingerprintRequest(context.tenant.tenantId, {
        actor: self.actor,
        employeeId: self.employeeId,
        ...request,
      }),
      async () => {
        const row = await lockPayslipPin(
          tx,
          context.tenant.tenantId,
          self.employeeId,
        );
        // Clock read AFTER the lock (lock expiry and counters judge this).
        const now = nowOverride ?? new Date();
        if (row) {
          if (request.currentPin === undefined)
            return { kind: "current_required" };
          const check = await checkPayslipPin(
            tx,
            context,
            self,
            row,
            request.currentPin,
            now,
          );
          if (check.kind !== "ok") return check;
        }
        const stored = await storePin(
          tx,
          context,
          self.employeeId,
          row,
          request.pin,
          now,
        );
        await auditPin(tx, context, self.actor, now, {
          outletId: self.homeOutletId,
          action: row ? "payslip_pin.changed" : "payslip_pin.set",
          objectId: stored.id,
          after: { employeeId: self.employeeId, status: "active" },
        });
        return { kind: "ok", status: { status: "active", lockedUntil: null } };
      },
    );
  });
  if (outcome.kind === "current_required")
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "PIN saat ini wajib diisi untuk mengganti PIN slip gaji.",
    );
  assertPinCheckOk(outcome);
  return (outcome as Extract<SetOutcome, { kind: "ok" }>).status;
}

// ---------------------------------------------------------------- HR reset

/**
 * POST /api/hris/employees/:employeeId/payslip-pin/reset (payroll.run, tenant
 * wide). Deletes the hash and clears the lock; HR never sees or sets the PIN.
 */
export async function resetEmployeePayslipPin(
  context: ScopedTenantContext,
  actorUserId: string,
  employeeId: string,
  input: ResetPayslipPinInput,
  nowOverride?: Date,
): Promise<PayslipPinStatus> {
  const { idempotencyKey, reason } = input;
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      "payroll.run",
    );
    const [employee] = await tx
      .select({
        id: employees.id,
        userId: employees.userId,
        homeOutletId: employees.homeOutletId,
      })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, context.tenant.tenantId),
          eq(employees.id, employeeId),
        ),
      )
      .limit(1);
    if (!employee) throw notFound();
    return idempotentHrisWrite<PayslipPinStatus>(
      tx,
      context,
      idempotencyKey,
      "payslip_pin.reset",
      { actor, employeeId: employee.id, reason },
      async () => {
        const row = await lockPayslipPin(
          tx,
          context.tenant.tenantId,
          employee.id,
        );
        // Clock read AFTER the lock: a reset that waited for the lock must not
        // stamp a stale `now`.
        const now = nowOverride ?? new Date();
        if (row) await tx.delete(payslipPins).where(eq(payslipPins.id, row.id));
        // An open WhatsApp proof (pending, or verified and unused) must not
        // outlive the reset: it would set a PIN after HR cleared it.
        const cancelled =
          employee.userId === null
            ? 0
            : await cancelOpenWhatsAppProofs(tx, {
                purpose: "payslip_pin_reset",
                tenantId: context.tenant.tenantId,
                userId: employee.userId,
                now,
              });
        if (cancelled > 0)
          await auditPin(tx, context, actor, now, {
            outletId: employee.homeOutletId,
            action: "payslip_pin.wa_proof_cancelled",
            objectId: employee.id,
            after: { employeeId: employee.id, status: "cancelled" },
          });
        await auditPin(tx, context, actor, now, {
          outletId: employee.homeOutletId,
          action: "payslip_pin.reset",
          objectId: row?.id ?? employee.id,
          after: { employeeId: employee.id, status: "not_set" },
          sensitiveReason: reason,
        });
        return { status: "not_set", lockedUntil: null };
      },
    );
  });
}

// ----------------------------------------------- reset by inbound WhatsApp

/** What the route knows about the asking browser (cookie, session, network). */
export type WaResetBrowser = {
  readonly sessionId: string;
  readonly bindingHash: string;
};

function proofInvalid(): PayrollError {
  return new PayrollError("PAYSLIP_PIN_RESET_PROOF_INVALID");
}

/**
 * POST /api/hris/me/payslip-pin/reset-wa. Opens a WhatsApp proof for the
 * employee: a PIN must exist (else NOT_SET), and the employee needs a verified
 * WhatsApp number linked for `WA_PROOF_IDENTITY_MIN_AGE_DAYS` (else
 * UNAVAILABLE; HR reset is then the only way). Not idempotent on purpose: the
 * response holds the code (design D-WA6). The code is never stored or audited.
 */
export async function requestPayslipPinResetWa(
  context: ScopedTenantContext,
  actorUserId: string,
  browser: WaResetBrowser & {
    readonly ipHash: string | null;
    readonly userAgent: string | null;
    /** createApp's override; default KIRIM_WEBHOOK_SECRET. */
    readonly webhookSecrets?: readonly string[];
  },
  now: Date = new Date(),
): Promise<PayslipPinResetWaIssued> {
  return withTenant(db, context, async (tx) => {
    const self = await loadPayslipSelf(tx, context, actorUserId, now);
    const pin = await lockPayslipPin(
      tx,
      context.tenant.tenantId,
      self.employeeId,
    );
    if (!pin) throw new PayrollError("PAYSLIP_PIN_NOT_SET");
    const identity = await findWhatsAppProofSender(tx, {
      userId: self.actor,
      now,
    });
    if (!identity) {
      // Only the caller's own identity is inspected; the three fixed markers
      // carry no number or personal data.
      const reason = await diagnoseWhatsAppProofIdentity(tx, {
        userId: self.actor,
        now,
      });
      throw new PayrollError(
        "PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE",
        undefined,
        {
          details: [
            {
              field: "whatsapp",
              message: reason,
            },
          ],
        },
      );
    }
    const issued = await issueWhatsAppProof(tx, context, {
      purpose: "payslip_pin_reset",
      userId: self.actor,
      sessionId: browser.sessionId,
      bindingHash: browser.bindingHash,
      expectedSenderHash: identity.senderHash,
      ipHash: browser.ipHash,
      userAgent: browser.userAgent,
      now,
      ...(browser.webhookSecrets
        ? { webhookSecrets: browser.webhookSecrets }
        : {}),
    });
    await auditPin(tx, context, self.actor, now, {
      outletId: self.homeOutletId,
      action: "payslip_pin.wa_proof_requested",
      objectId: issued.challengeId,
      after: {
        employeeId: self.employeeId,
        expiresAt: issued.expiresAt.toISOString(),
      },
    });
    return {
      challengeId: issued.challengeId,
      code: issued.code,
      waLink: issued.waLink,
      senderHint: identity.senderHint,
      expiresAt: issued.expiresAt.toISOString(),
    };
  });
}

/** GET .../reset-wa/:challengeId. 404 when nothing matches every binding. */
export async function getPayslipPinResetWa(
  context: ScopedTenantContext,
  actorUserId: string,
  challengeId: string,
  browser: WaResetBrowser,
  now: Date = new Date(),
): Promise<PayslipPinResetWaStatus> {
  return withTenant(db, context, async (tx) => {
    const self = await loadPayslipSelf(tx, context, actorUserId, now);
    const proof = await readWhatsAppProof(tx, {
      challengeId,
      purpose: "payslip_pin_reset",
      tenantId: context.tenant.tenantId,
      userId: self.actor,
      sessionId: browser.sessionId,
      bindingHash: browser.bindingHash,
      now,
    });
    if (!proof) throw notFound("Verifikasi");
    return {
      status: proof.status,
      expiresAt: proof.expiresAt.toISOString(),
      grantExpiresAt: proof.grantExpiresAt?.toISOString() ?? null,
    };
  });
}

type CompleteOutcome =
  { readonly kind: "ok" } | { readonly kind: "invalid_proof" };

/**
 * POST .../reset-wa/:challengeId/pin. Uses the verified proof once (every
 * binding in one UPDATE, inside the 10 minute grant), re-checks that the
 * employee's WhatsApp identity still qualifies and is the number that sent the
 * proof, then saves the new PIN and clears the counter and the lock. Every
 * refusal is the same 403 PAYSLIP_PIN_RESET_PROOF_INVALID.
 */
export async function completePayslipPinResetWa(
  context: ScopedTenantContext,
  actorUserId: string,
  challengeId: string,
  browser: WaResetBrowser,
  input: CompletePayslipPinResetWaInput,
  nowOverride?: Date,
): Promise<PayslipPinStatus> {
  const { idempotencyKey, ...request } = input;
  const outcome = await withTenant(db, context, async (tx) => {
    const self = await loadPayslipSelf(
      tx,
      context,
      actorUserId,
      nowOverride ?? new Date(),
    );
    return idempotentHrisWrite<CompleteOutcome>(
      tx,
      context,
      idempotencyKey,
      "payslip_pin.wa_reset",
      payslipFingerprintRequest(context.tenant.tenantId, {
        actor: self.actor,
        employeeId: self.employeeId,
        challengeId,
        ...request,
      }),
      async () => {
        const row = await lockPayslipPin(
          tx,
          context.tenant.tenantId,
          self.employeeId,
        );
        // Clock read AFTER the lock: the grant window is judged with it.
        const now = nowOverride ?? new Date();
        // The number must still qualify and still be the one the proof named
        // (a swapped number restarts the 3 day clock via `linked_at`).
        // FOR UPDATE: the identity row stays locked until the PIN is saved, so
        // a concurrent unlink or re-link cannot slip in after this check.
        const identity = await findWhatsAppProofSender(
          tx,
          { userId: self.actor, now },
          { forUpdate: true },
        );
        const [proof] = await tx
          .select({ expectedSenderHash: loginChallenges.expectedSenderHash })
          .from(loginChallenges)
          .where(
            and(
              eq(loginChallenges.id, challengeId),
              eq(loginChallenges.tenantId, context.tenant.tenantId),
              eq(loginChallenges.linkUserId, self.actor),
            ),
          )
          .limit(1);
        if (
          !identity ||
          !proof ||
          proof.expectedSenderHash !== identity.senderHash
        )
          return { kind: "invalid_proof" };
        const used = await consumeWhatsAppProof(tx, {
          challengeId,
          purpose: "payslip_pin_reset",
          tenantId: context.tenant.tenantId,
          userId: self.actor,
          sessionId: browser.sessionId,
          bindingHash: browser.bindingHash,
          now,
        });
        if (!used) return { kind: "invalid_proof" };
        const stored = await storePin(
          tx,
          context,
          self.employeeId,
          row,
          request.pin,
          now,
        );
        await auditPin(tx, context, self.actor, now, {
          outletId: self.homeOutletId,
          action: "payslip_pin.wa_reset",
          objectId: stored.id,
          after: { employeeId: self.employeeId, status: "active" },
        });
        return { kind: "ok" };
      },
    );
  });
  if (outcome.kind !== "ok") throw proofInvalid();
  return { status: "active", lockedUntil: null };
}

/** POST .../reset-wa/:challengeId/cancel. NOT_FOUND unless it is theirs. */
export async function cancelPayslipPinResetWa(
  context: ScopedTenantContext,
  actorUserId: string,
  challengeId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const self = await loadPayslipSelf(tx, context, actorUserId, now);
    let cancelled: number;
    try {
      cancelled = await cancelWhatsAppProof(tx, {
        challengeId,
        purpose: "payslip_pin_reset",
        tenantId: context.tenant.tenantId,
        userId: self.actor,
        sessionId,
        now,
      });
    } catch (error) {
      if (error instanceof CoreError && error.code === "NOT_FOUND")
        throw notFound("Verifikasi");
      throw error;
    }
    // A proof that was already used, expired or cancelled stays as it is, and
    // nothing is audited for a cancel that changed nothing.
    if (cancelled === 0) return;
    await auditPin(tx, context, self.actor, now, {
      outletId: self.homeOutletId,
      action: "payslip_pin.wa_proof_cancelled",
      objectId: challengeId,
      after: { employeeId: self.employeeId, status: "cancelled" },
    });
  });
}
