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
//   challenge); the employee then sets a new one. A WhatsApp one-time code is
//   the self-service way back in (port `PayslipPinOtpSender`; no sender = 503).
// Never log, audit, store in an idempotency response, or emit a PIN, hash or
// code. Audit rows carry ids, status and lock time only.
import {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  CoreError,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  PAYSLIP_PIN_LOCK_MINUTES,
  PAYSLIP_PIN_MAX_ATTEMPTS,
  PAYSLIP_PIN_OTP_LENGTH,
  PAYSLIP_PIN_OTP_MAX_ATTEMPTS,
  PAYSLIP_PIN_OTP_TTL_MINUTES,
  PayrollError,
  type PayslipPinResetOtpRequested,
  type PayslipPinStatus,
  type RequestPayslipPinResetOtpInput,
  type ResetPayslipPinInput,
  type SetMyPayslipPinInput,
  type VerifyPayslipPinResetOtpInput,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { userIdentities } from "../db/schema/identity.ts";
import {
  payslipPinResetChallenges,
  payslipPins,
} from "../db/schema/payslip-pin.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { openSecret } from "../lib/secrets.ts";
import { recordAudit } from "./core-audit.ts";
import {
  burnStaffPinCheck,
  hashStaffPin,
  STAFF_PIN_KDF,
  verifyStaffPinHash,
  type StaffPinBinding,
} from "./device-pin-hash.ts";
import {
  currentStaffPinPepperVersion,
  payslipPinPepper,
} from "./device-pin-pepper.ts";
import {
  auditOutletFor,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
} from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import type { Tx } from "./permission-resolver.ts";

export const PAYSLIP_SELF_CODE = "self.payslip.view" as const;
const MINUTE_MS = 60_000;

/** Audit `after` field names that are safe to show: ids, status, lock time. */
export const PAYSLIP_PIN_AUDIT_SAFE_FIELDS = [
  "status",
  "lockedUntil",
  "failedAttempts",
  "payslipId",
  "runId",
  "employeeId",
  "expiresAt",
] as const;

// ------------------------------------------------------------------- port

/** Delivers the one-time code by WhatsApp; never logs or stores the code. */
export type PayslipPinOtpSender = {
  send(
    context: ScopedTenantContext,
    message: {
      readonly employeeId: string;
      /** The outlet the message is sent under: the home outlet when the caller's scope reaches it, else the first outlet it does reach. */
      readonly outletId: string;
      /** The reset challenge row id; the delivery reference (idempotency). */
      readonly challengeId: string;
      readonly phoneE164: string;
      readonly code: string;
    },
  ): Promise<void>;
};

// ----------------------------------------------------------------- helpers

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

const OTP_REQUEST_CAP = 3;
const HOUR_MS = 60 * MINUTE_MS;
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
  now: Date = new Date(),
): Promise<PayslipPinStatus> {
  const { idempotencyKey, ...request } = input;
  const outcome = await withTenant(db, context, async (tx) => {
    const self = await loadPayslipSelf(tx, context, actorUserId, now);
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
  now: Date = new Date(),
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
      .select({ id: employees.id, homeOutletId: employees.homeOutletId })
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
        if (row) await tx.delete(payslipPins).where(eq(payslipPins.id, row.id));
        // An open reset code must not outlive the reset.
        await tx
          .update(payslipPinResetChallenges)
          .set({ consumedAt: now })
          .where(
            and(
              eq(payslipPinResetChallenges.tenantId, context.tenant.tenantId),
              eq(payslipPinResetChallenges.employeeId, employee.id),
              isNull(payslipPinResetChallenges.consumedAt),
            ),
          );
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

// ------------------------------------------------------- WhatsApp reset OTP

function codeHash(
  pepper: Buffer,
  tenantId: string,
  employeeId: string,
  challengeId: string,
  code: string,
): string {
  return createHmac("sha256", pepper)
    .update(
      [
        "legend:payslip-pin-otp:v1",
        tenantId.toLowerCase(),
        employeeId.toLowerCase(),
        challengeId.toLowerCase(),
        code,
      ].join("\u0000"),
      "utf8",
    )
    .digest("hex");
}

/** The employee's verified WhatsApp number (login identity), or null. */
async function ownWhatsappNumber(
  tx: Tx,
  actorUserId: string,
): Promise<string | null> {
  const [identity] = await tx
    .select({
      valueHash: userIdentities.valueHash,
      valueEncrypted: userIdentities.valueEncrypted,
    })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.userId, actorUserId),
        eq(userIdentities.type, "whatsapp"),
        sql`${userIdentities.verifiedAt} IS NOT NULL`,
      ),
    )
    .limit(1);
  if (!identity?.valueEncrypted) return null;
  try {
    const raw = openSecret(
      identity.valueEncrypted,
      `user_identity:whatsapp:${identity.valueHash}`,
    );
    return `+${raw.replace(/\D/g, "")}`;
  } catch {
    return null;
  }
}

function otpUnavailable(): CoreError {
  return new CoreError(
    "SERVICE_UNAVAILABLE",
    "Kode verifikasi WhatsApp belum tersedia. Hubungi HR untuk reset PIN.",
  );
}

/**
 * POST /api/hris/me/payslip-pin/reset-otp. Sends a 6-digit code (5 min, single
 * use, 5 tries) to the employee's own WhatsApp number through the port. No
 * sender, or no verified number, answers 503. An older open code is voided.
 */
export async function requestPayslipPinResetOtp(
  context: ScopedTenantContext,
  actorUserId: string,
  input: RequestPayslipPinResetOtpInput,
  sender: PayslipPinOtpSender | null,
  now: Date = new Date(),
): Promise<PayslipPinResetOtpRequested> {
  if (sender === null) throw otpUnavailable();
  const { idempotencyKey } = input;
  return withTenant(db, context, async (tx) => {
    const self = await loadPayslipSelf(tx, context, actorUserId, now);
    return idempotentHrisWrite<PayslipPinResetOtpRequested>(
      tx,
      context,
      idempotencyKey,
      "payslip_pin.otp_request",
      { actor: self.actor, employeeId: self.employeeId },
      async () => {
        const phone = await ownWhatsappNumber(tx, self.actor);
        if (phone === null) throw otpUnavailable();
        await lockPayslipPin(tx, context.tenant.tenantId, self.employeeId);
        // Every request is a fresh code with its own tries: cap them, or the
        // 5-try limit per code is no limit at all.
        const [recent] = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(payslipPinResetChallenges)
          .where(
            and(
              eq(payslipPinResetChallenges.tenantId, context.tenant.tenantId),
              eq(payslipPinResetChallenges.employeeId, self.employeeId),
              gte(
                payslipPinResetChallenges.createdAt,
                new Date(now.getTime() - HOUR_MS),
              ),
            ),
          );
        if ((recent?.total ?? 0) >= OTP_REQUEST_CAP)
          throw new HttpError(
            429,
            "RATE_LIMITED",
            "Terlalu banyak permintaan kode. Coba lagi dalam satu jam atau hubungi HR.",
          );
        await tx
          .update(payslipPinResetChallenges)
          .set({ consumedAt: now })
          .where(
            and(
              eq(payslipPinResetChallenges.tenantId, context.tenant.tenantId),
              eq(payslipPinResetChallenges.employeeId, self.employeeId),
              isNull(payslipPinResetChallenges.consumedAt),
            ),
          );
        const code = String(
          randomInt(0, 10 ** PAYSLIP_PIN_OTP_LENGTH),
        ).padStart(PAYSLIP_PIN_OTP_LENGTH, "0");
        const id = randomUUID();
        const version = currentStaffPinPepperVersion();
        const expiresAt = new Date(
          now.getTime() + PAYSLIP_PIN_OTP_TTL_MINUTES * MINUTE_MS,
        );
        await tx.insert(payslipPinResetChallenges).values({
          id,
          tenantId: context.tenant.tenantId,
          employeeId: self.employeeId,
          codeHash: codeHash(
            pepperFor(context.tenant.tenantId, version),
            context.tenant.tenantId,
            self.employeeId,
            id,
            code,
          ),
          pepperVersion: version,
          expiresAt,
          createdAt: now,
        });
        try {
          await sender.send(context, {
            employeeId: self.employeeId,
            outletId: auditOutletFor(context, self.homeOutletId),
            challengeId: id,
            phoneE164: phone,
            code,
          });
        } catch {
          // Undelivered code: roll the challenge back, say nothing more.
          throw otpUnavailable();
        }
        await auditPin(tx, context, self.actor, now, {
          outletId: self.homeOutletId,
          action: "payslip_pin.otp_requested",
          objectId: id,
          after: {
            employeeId: self.employeeId,
            expiresAt: expiresAt.toISOString(),
          },
        });
        return { expiresAt: expiresAt.toISOString() };
      },
    );
  });
}

type VerifyOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "invalid" }
  | { readonly kind: "locked"; readonly lockedUntil: string };

/**
 * POST /api/hris/me/payslip-pin/reset-otp/verify. A correct, unexpired,
 * unused code sets the new PIN (clearing the lock) and is consumed. A wrong
 * code counts; the fifth wrong one answers 423. Unknown, expired and used
 * codes answer like a wrong code (403) without counting.
 */
export async function verifyPayslipPinResetOtp(
  context: ScopedTenantContext,
  actorUserId: string,
  input: VerifyPayslipPinResetOtpInput,
  now: Date = new Date(),
): Promise<PayslipPinStatus> {
  const { idempotencyKey, ...request } = input;
  const outcome = await withTenant(db, context, async (tx) => {
    const self = await loadPayslipSelf(tx, context, actorUserId, now);
    return idempotentHrisWrite<VerifyOutcome>(
      tx,
      context,
      idempotencyKey,
      "payslip_pin.otp_verify",
      payslipFingerprintRequest(context.tenant.tenantId, {
        actor: self.actor,
        employeeId: self.employeeId,
        ...request,
      }),
      async () => {
        const pinRow = await lockPayslipPin(
          tx,
          context.tenant.tenantId,
          self.employeeId,
        );
        const [challenge] = await tx
          .select()
          .from(payslipPinResetChallenges)
          .where(
            and(
              eq(payslipPinResetChallenges.tenantId, context.tenant.tenantId),
              eq(payslipPinResetChallenges.employeeId, self.employeeId),
              isNull(payslipPinResetChallenges.consumedAt),
            ),
          )
          .orderBy(desc(payslipPinResetChallenges.createdAt))
          .limit(1)
          .for("update");
        if (!challenge) {
          await burnStaffPinCheck(
            pepperFor(context.tenant.tenantId, currentStaffPinPepperVersion()),
          );
          return { kind: "invalid" };
        }
        if (challenge.expiresAt.getTime() <= now.getTime())
          return { kind: "invalid" };
        if (challenge.attempts >= PAYSLIP_PIN_OTP_MAX_ATTEMPTS)
          return {
            kind: "locked",
            lockedUntil: challenge.expiresAt.toISOString(),
          };
        const expected = Buffer.from(challenge.codeHash, "hex");
        const actual = Buffer.from(
          codeHash(
            pepperFor(context.tenant.tenantId, challenge.pepperVersion),
            context.tenant.tenantId,
            self.employeeId,
            challenge.id,
            request.code,
          ),
          "hex",
        );
        const correct =
          actual.length === expected.length &&
          timingSafeEqual(actual, expected);
        if (!correct) {
          const attempts = challenge.attempts + 1;
          await tx
            .update(payslipPinResetChallenges)
            .set({ attempts })
            .where(eq(payslipPinResetChallenges.id, challenge.id));
          return attempts >= PAYSLIP_PIN_OTP_MAX_ATTEMPTS
            ? { kind: "locked", lockedUntil: challenge.expiresAt.toISOString() }
            : { kind: "invalid" };
        }
        await tx
          .update(payslipPinResetChallenges)
          .set({ consumedAt: now })
          .where(eq(payslipPinResetChallenges.id, challenge.id));
        const stored = await storePin(
          tx,
          context,
          self.employeeId,
          pinRow,
          request.pin,
          now,
        );
        await auditPin(tx, context, self.actor, now, {
          outletId: self.homeOutletId,
          action: "payslip_pin.otp_reset",
          objectId: stored.id,
          after: { employeeId: self.employeeId, status: "active" },
        });
        return { kind: "ok" };
      },
    );
  });
  assertPinCheckOk(outcome);
  return { status: "active", lockedUntil: null };
}
