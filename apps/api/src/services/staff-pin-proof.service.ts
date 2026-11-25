// One-time PIN proofs and the per-device PIN throttle (bead legend-u7g9w; K).
//
// A staff member types their PIN on a registered outlet device; when the
// verify asks for `purpose: "attendance_clock"` the answer carries an opaque
// proof (`pp_` + 32 random bytes, base64url). Only sha256(token) is stored.
// The proof is bound to tenant, outlet, device, staff member and purpose, lives
// 120 s, is consumed once by the outlet-clock route, and is never a session.
// A new proof for the same device ends the previous unused one, so a device
// holds at most one live proof.
//
// Throttle: every wrong PIN on `/api/staff-pins/verify` counts against the
// DEVICE in a fixed 5 minute window (guess-spraying across staff would dodge
// the per-staff lockout). A request reserves a slot atomically before its PIN
// is checked; the 11th request inside a window answers 429 without touching
// `staff_pins.failed_attempts`.
//
// `verifyStaffPinOnDevice` / `attemptStaffPin` (device-pin.service.ts) are
// wrapped, never changed.
//
// Never log a token, pin or hash. Audit and alert payloads carry ids only.

import { createHash, randomBytes } from "node:crypto";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { IdentityError, type StaffPinSwitch } from "@starter/shared/identity";
import { and, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  devicePinThrottle,
  staffPinProofs,
  userPinThrottle,
} from "../db/schema/staff-pin-proof";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import { toLoggableError } from "../lib/safe-error";
import { recordAudit } from "./audit-writer";
import {
  assertPinAttemptOk,
  attemptStaffPin,
  PinNewlyLockedError,
  resolveDeviceOutlet,
  verifyStaffPinOnDevice,
  verifyStaffPinOnDeviceVersioned,
  type PinAttemptOutcome,
} from "./device-pin.service";
import { outletContext } from "./device-pin-support";
import { assertEdgeIdentityFresh } from "../edge/identity-freshness";
import { getEdgeRuntimeState } from "../edge/runtime";
import { enqueueEdgeEvent } from "./edge-queue.service";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert";
import { assertAttendanceClockAllowed } from "./hris-attendance-eligibility";
import type { Tx } from "./permission-resolver";

export const PIN_PROOF_HEADER = "X-Pin-Proof";
export const PIN_PROOF_TTL_MS = 120_000;
export const PIN_PROOF_PURPOSE = "attendance_clock";
export const PIN_PROOF_TOKEN_PREFIX = "pp_";

/** Wrong PINs one device may make inside one window. */
export const PIN_DEVICE_MAX_FAILURES = 10;
export const PIN_DEVICE_WINDOW_MS = 5 * 60_000;
/** Seconds-per-window literal for SQL: keep in step with the constant above. */
const WINDOW_INTERVAL = sql.raw("interval '5 minutes'");

export type StaffPinProofRow = {
  id: string;
  tenantId: string;
  outletId: string;
  deviceId: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

/** 429 PIN_DEVICE_THROTTLED; the route sends `Retry-After: retryAfterSeconds`. */
export class PinDeviceThrottledError extends HttpError {
  constructor(
    readonly retryAfterSeconds: number,
    message = "Terlalu banyak PIN salah dari perangkat ini. Coba lagi nanti.",
  ) {
    super(429, "PIN_DEVICE_THROTTLED", message);
    this.name = "PinDeviceThrottledError";
  }
}

/**
 * Same answer (429 PIN_DEVICE_THROTTLED, `Retry-After`) for the per-requester
 * window of approver PINs (bead legend-vfj7z), so a route that handles the
 * device error handles this one too.
 */
export class PinRequesterThrottledError extends PinDeviceThrottledError {
  constructor(retryAfterSeconds: number) {
    super(
      retryAfterSeconds,
      "Terlalu banyak PIN penyetuju yang salah dari akun ini. Coba lagi nanti.",
    );
    this.name = "PinRequesterThrottledError";
  }
}

function invalidProof(): HttpError {
  return new HttpError(
    401,
    "PIN_PROOF_INVALID",
    "Bukti PIN tidak berlaku. Masukkan PIN lagi.",
  );
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

const proofColumns = {
  id: staffPinProofs.id,
  tenantId: staffPinProofs.tenantId,
  outletId: staffPinProofs.outletId,
  deviceId: staffPinProofs.deviceId,
  userId: staffPinProofs.userId,
  expiresAt: staffPinProofs.expiresAt,
  consumedAt: staffPinProofs.consumedAt,
};

// ------------------------------------------------------------------ proofs
// The three functions below run inside the caller's transaction, which must be
// scoped to the device's outlet (staff_pin_proofs has tenant + outlet RLS).

/** Any state (used, expired, superseded). null = unknown token or other device. */
export async function findPinProof(
  tx: Tx,
  input: { tenantId: string; deviceId: string; token: string },
): Promise<StaffPinProofRow | null> {
  const [row] = await tx
    .select(proofColumns)
    .from(staffPinProofs)
    .where(
      and(
        eq(staffPinProofs.tenantId, tenantIdSchema.parse(input.tenantId)),
        eq(staffPinProofs.deviceId, input.deviceId),
        eq(staffPinProofs.tokenHash, hashToken(input.token)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Marks a live proof used. null = not consumable (unknown, used, expired, superseded, other device). */
export async function consumePinProof(
  tx: Tx,
  input: { tenantId: string; deviceId: string; token: string; now: Date },
): Promise<StaffPinProofRow | null> {
  const [row] = await tx
    .update(staffPinProofs)
    .set({ consumedAt: input.now })
    .where(
      and(
        eq(staffPinProofs.tenantId, tenantIdSchema.parse(input.tenantId)),
        eq(staffPinProofs.deviceId, input.deviceId),
        eq(staffPinProofs.tokenHash, hashToken(input.token)),
        isNull(staffPinProofs.consumedAt),
        gt(staffPinProofs.expiresAt, input.now),
      ),
    )
    .returning(proofColumns);
  return row ?? null;
}

/** Same conditions as consume, read-only. 401 PIN_PROOF_INVALID when not live (also when already used). */
export async function assertLivePinProof(
  tx: Tx,
  input: { tenantId: string; deviceId: string; token: string; now: Date },
): Promise<StaffPinProofRow> {
  const row = await findPinProof(tx, input);
  if (
    row === null ||
    row.consumedAt !== null ||
    row.expiresAt.getTime() <= input.now.getTime()
  )
    throw invalidProof();
  return row;
}

async function issuePinProof(
  tx: Tx,
  input: {
    tenantId: string;
    outletId: string;
    deviceId: string;
    userId: string;
    now: Date;
  },
): Promise<{ token: string; expiresAt: Date }> {
  // Two verifies at once on one device must not leave two live proofs: lock
  // per device; the second waits, then sees the first proof and ends it.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`staff-pin-proof:${input.tenantId}:${input.deviceId}`}, 0))`,
  );
  // One live proof per device: end the previous unused one first.
  await tx
    .update(staffPinProofs)
    .set({ expiresAt: input.now })
    .where(
      and(
        eq(staffPinProofs.tenantId, tenantIdSchema.parse(input.tenantId)),
        eq(staffPinProofs.deviceId, input.deviceId),
        isNull(staffPinProofs.consumedAt),
        gt(staffPinProofs.expiresAt, input.now),
      ),
    );
  const token = `${PIN_PROOF_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(input.now.getTime() + PIN_PROOF_TTL_MS);
  await tx.insert(staffPinProofs).values({
    tenantId: tenantIdSchema.parse(input.tenantId),
    outletId: outletIdSchema.parse(input.outletId),
    deviceId: input.deviceId,
    userId: input.userId,
    purpose: PIN_PROOF_PURPOSE,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

// ---------------------------------------------------------------- throttle
// Atomic slot reservation (legend-u7g9w): a request takes one of the window's
// 10 slots BEFORE its PIN is checked, in its own committed transaction, so
// parallel guesses cannot all pass a stale count. A correct PIN or any error
// other than `PIN_INVALID` gives the slot back; `PIN_INVALID` and the guess
// that newly locks a staff PIN (`PinNewlyLockedError`) keep it.

/**
 * Takes one slot (upsert: an ended window restarts at 1, otherwise +1). Over
 * the limit the slot is returned and the answer is 429. Returns the window the
 * slot belongs to, for `releaseDeviceSlot` and the alert.
 */
async function reserveDeviceSlot(
  context: ScopedTenantContext,
  deviceId: string,
  now: Date,
): Promise<Date> {
  const stamp = sql`${now.toISOString()}::timestamptz`;
  const expired = sql`${devicePinThrottle.windowStartedAt} + ${WINDOW_INTERVAL} <= ${stamp}`;
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .insert(devicePinThrottle)
      .values({
        tenantId: context.tenant.tenantId,
        deviceId,
        windowStartedAt: now,
        failures: 1,
      })
      .onConflictDoUpdate({
        target: [devicePinThrottle.tenantId, devicePinThrottle.deviceId],
        set: {
          failures: sql`CASE WHEN ${expired} THEN 1 ELSE ${devicePinThrottle.failures} + 1 END`,
          windowStartedAt: sql`CASE WHEN ${expired} THEN ${stamp} ELSE ${devicePinThrottle.windowStartedAt} END`,
        },
      })
      .returning({
        failures: devicePinThrottle.failures,
        windowStartedAt: devicePinThrottle.windowStartedAt,
      });
    if (!row) throw new Error("device pin throttle reservation failed");
    if (row.failures > PIN_DEVICE_MAX_FAILURES) {
      await releaseSlot(tx, context, deviceId, row.windowStartedAt);
      const windowEnds = row.windowStartedAt.getTime() + PIN_DEVICE_WINDOW_MS;
      throw new PinDeviceThrottledError(
        Math.max(1, Math.ceil((windowEnds - now.getTime()) / 1000)),
      );
    }
    return row.windowStartedAt;
  });
}

async function releaseSlot(
  tx: Tx,
  context: ScopedTenantContext,
  deviceId: string,
  windowStartedAt: Date,
): Promise<void> {
  await tx
    .update(devicePinThrottle)
    .set({ failures: sql`GREATEST(${devicePinThrottle.failures} - 1, 0)` })
    .where(
      and(
        eq(devicePinThrottle.tenantId, context.tenant.tenantId),
        eq(devicePinThrottle.deviceId, deviceId),
        eq(devicePinThrottle.windowStartedAt, windowStartedAt),
      ),
    );
}

/** Gives a reserved slot back (own transaction). Logs and swallows a failure so the real answer stands. */
async function releaseDeviceSlot(
  context: ScopedTenantContext,
  deviceId: string,
  windowStartedAt: Date,
): Promise<void> {
  try {
    await withTenant(db, context, (tx) =>
      releaseSlot(tx, context, deviceId, windowStartedAt),
    );
  } catch (error) {
    logger.error(
      { err: toLoggableError(error), deviceId },
      "staff pin throttle slot release failed",
    );
  }
}

/**
 * After a confirmed wrong PIN: the first miss to see the window at 10 or more
 * claims the window's alert (`alerted_window_started_at`) and writes one audit
 * row and one supervisor alert, in its own transaction. A failure here is
 * logged and never changes the client's answer (still 401 PIN_INVALID, or
 * 423 PIN_LOCKED for the guess that locked the staff PIN).
 */
async function alertDeviceThrottled(
  context: ScopedTenantContext,
  outletId: string,
  deviceId: string,
  windowStartedAt: Date,
  now: Date,
): Promise<void> {
  try {
    await withTenant(db, context, async (tx) => {
      const [claimed] = await tx
        .update(devicePinThrottle)
        .set({ alertedWindowStartedAt: windowStartedAt })
        .where(
          and(
            eq(devicePinThrottle.tenantId, context.tenant.tenantId),
            eq(devicePinThrottle.deviceId, deviceId),
            eq(devicePinThrottle.windowStartedAt, windowStartedAt),
            gte(devicePinThrottle.failures, PIN_DEVICE_MAX_FAILURES),
            sql`${devicePinThrottle.alertedWindowStartedAt} IS DISTINCT FROM ${devicePinThrottle.windowStartedAt}`,
          ),
        )
        .returning({ deviceId: devicePinThrottle.deviceId });
      if (!claimed) return;
      await recordAudit(
        {
          tenantId: context.tenant.tenantId,
          outletId,
          actorType: "device",
          actorId: deviceId,
          deviceId,
          action: "staff_pin.device_throttled",
          objectType: "device",
          objectId: deviceId,
          reason: null,
          before: null,
          after: {
            failures: PIN_DEVICE_MAX_FAILURES,
            windowSeconds: PIN_DEVICE_WINDOW_MS / 1000,
          },
          sensitiveAccess: false,
        },
        { tx, context },
      );
      const id = createUlid(now.getTime());
      // legend-62jtd: on an edge node the supervisors live in the cloud. Queue
      // the alert for the up-sync (device id only, no PIN or secret) instead
      // of writing a notification nobody reads in the edge database.
      const runtime = getEdgeRuntimeState();
      const edgeIdentity = runtime.edgeMode ? runtime.identity : null;
      if (edgeIdentity) {
        // The audit above is already written: a failed enqueue undoes only
        // its own savepoint, so the audit row is never lost with it.
        try {
          await tx.transaction(async (savepoint) => {
            await enqueueEdgeEvent(savepoint, context, {
              edgeNodeId: edgeIdentity.scope.edgeNodeId,
              direction: "edge_to_cloud",
              kind: "transaction_event",
              event: {
                id,
                tenantId: context.tenant.tenantId,
                outletId: outletIdSchema.parse(outletId),
                name: "staff_pin.device_throttled",
                version: 1,
                aggregateType: "staff_pin",
                aggregateId: id,
                sequence: 1,
                occurredAt: now.toISOString(),
                actor: { type: "system" },
                deviceId: null,
                idempotencyKey: `staff_pin.device_throttled:${id}`,
                payloadSchemaRef: "staff_pin.device_throttled.v1",
                payload: { deviceId },
              },
            });
          });
        } catch (error) {
          logger.error(
            { err: toLoggableError(error), deviceId },
            "staff pin device throttle event not queued",
          );
        }
        return;
      }
      await notifyOutletSupervisors(
        tx,
        context,
        {
          tenantId: context.tenant.tenantId,
          outletId: outletIdSchema.parse(outletId),
          id,
          eventName: "staff_pin.device_throttled",
          // The event name's first segment must equal the aggregate type
          // (checkEnvelopeRules).
          aggregateType: "staff_pin",
          aggregateId: id,
          payload: { deviceId },
          title: "Perangkat outlet dibatasi karena PIN salah",
          body: "Satu perangkat outlet salah memasukkan PIN 10 kali dalam 5 menit dan dibatasi sementara. Periksa perangkat itu; cabut tokennya bila mencurigakan.",
        },
        now,
      );
    });
  } catch (error) {
    logger.error(
      { err: toLoggableError(error), deviceId },
      "staff pin device throttle alert failed",
    );
  }
}

/**
 * After a failed verify: a guess that itself locked the staff PIN is still a
 * wrong guess, so keep its slot and alert (legend-sp9vq). A pin locked before
 * never looked at the guess, so that one (and any other error) gives the slot
 * back.
 */
async function settleFailedDeviceSlot(
  error: unknown,
  context: ScopedTenantContext,
  outletId: string,
  deviceId: string,
  windowStartedAt: Date,
  now: Date,
): Promise<void> {
  if (
    (error instanceof IdentityError && error.code === "PIN_INVALID") ||
    error instanceof PinNewlyLockedError
  )
    await alertDeviceThrottled(
      context,
      outletId,
      deviceId,
      windowStartedAt,
      now,
    );
  else await releaseDeviceSlot(context, deviceId, windowStartedAt);
}

// ------------------------------------------------------------------ verify

export type VerifyWithProofInput = {
  readonly deviceId: string;
  readonly userId: string;
  readonly pin: string;
  readonly purpose?: typeof PIN_PROOF_PURPOSE;
  readonly now?: Date;
};

/**
 * POST /api/staff-pins/verify, wrapping `verifyStaffPinOnDevice`:
 * 1. reserve one of the device's window slots (429 before anything else, staff
 *    counters untouched);
 * 2. with a purpose: the staff member may clock (403 before the PIN is checked);
 * 3. the existing verify; a wrong PIN (`PIN_INVALID`) and the guess that newly
 *    locks the staff PIN (`PinNewlyLockedError`) keep the slot, a correct PIN
 *    or any other error (including an already locked PIN) gives it back;
 * 4. with a purpose and a correct PIN: a new proof in the answer.
 * Without a purpose the answer is exactly the old one.
 */
export async function verifyStaffPinWithProof(
  tenant: TenantContext,
  input: VerifyWithProofInput,
): Promise<StaffPinSwitch> {
  const now = input.now ?? new Date();
  const verifyInput = {
    deviceId: input.deviceId,
    userId: input.userId,
    pin: input.pin,
    ...(input.now ? { now: input.now } : {}),
  };
  const outletId = await resolveDeviceOutlet(tenant.tenantId, input.deviceId);
  // Unregistered device: the existing verify refuses it (fail closed).
  if (outletId === null) return verifyStaffPinOnDevice(tenant, verifyInput);
  const context = outletContext(tenant, outletId);
  const windowStartedAt = await reserveDeviceSlot(context, input.deviceId, now);
  let result: StaffPinSwitch;
  try {
    if (input.purpose !== undefined)
      await withTenant(db, context, (tx) =>
        assertAttendanceClockAllowed(tx, context, input.userId, outletId, now),
      );
    result = await verifyStaffPinOnDevice(tenant, verifyInput);
  } catch (error) {
    await settleFailedDeviceSlot(
      error,
      context,
      outletId,
      input.deviceId,
      windowStartedAt,
      now,
    );
    throw error;
  }
  await releaseDeviceSlot(context, input.deviceId, windowStartedAt);
  if (input.purpose === undefined) return result;
  const proof = await withTenant(db, context, (tx) =>
    issuePinProof(tx, {
      tenantId: tenant.tenantId,
      outletId,
      deviceId: input.deviceId,
      userId: result.user.id,
      now,
    }),
  );
  return {
    ...result,
    proof: { token: proof.token, expiresAt: proof.expiresAt.toISOString() },
  };
}

export type ReceiverPinVerification = {
  readonly user: StaffPinSwitch["user"];
  /** The PIN generation the correct guess was checked against. */
  readonly pinGenerationAt: Date;
};

/**
 * The PIN check of an emergency receiver session (design edge-emergency D-03):
 * the same throttle slot, hash, pepper and staff lock as
 * `verifyStaffPinWithProof`, but it NEVER writes a `staff_pin_proofs` row: a
 * proof of any purpose would end the device's live attendance proof and could
 * clock attendance. The caller resolved the device's outlet and type first (an
 * unknown device never reaches a PIN check) and decides duty and permission
 * after a correct PIN. Returns the user and the PIN generation checked, so the
 * session can end when the PIN changes.
 */
export async function verifyStaffPinForReceiverSession(
  tenant: TenantContext,
  input: {
    readonly deviceId: string;
    readonly outletId: string;
    readonly userId: string;
    readonly pin: string;
    readonly now?: Date;
  },
): Promise<ReceiverPinVerification> {
  const now = input.now ?? new Date();
  const outletId = outletIdSchema.parse(input.outletId);
  const context = outletContext(tenant, outletId);
  const windowStartedAt = await reserveDeviceSlot(context, input.deviceId, now);
  let verified: Awaited<ReturnType<typeof verifyStaffPinOnDeviceVersioned>>;
  try {
    verified = await verifyStaffPinOnDeviceVersioned(tenant, {
      deviceId: input.deviceId,
      userId: input.userId,
      pin: input.pin,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    await settleFailedDeviceSlot(
      error,
      context,
      outletId,
      input.deviceId,
      windowStartedAt,
      now,
    );
    throw error;
  }
  await releaseDeviceSlot(context, input.deviceId, windowStartedAt);
  return {
    user: verified.switch.user,
    pinGenerationAt: verified.pinVersion.pinGenerationAt,
  };
}

// ------------------------------------------------- approver PIN (legend-vfj7z)
// The approver PIN checks of the supervisor override and open bill run under
// one fixed window (10 wrong PINs / 5 minutes), taken before the PIN is
// checked: per authenticated requester always, and per verified device as well
// when the request has one (a client cannot drop the requester key, and
// rotating devices cannot dodge it).

/** Takes one of the requester's window slots; over the limit: 429 and returned. */
async function reserveRequesterSlot(
  context: ScopedTenantContext,
  requesterUserId: string,
  now: Date,
): Promise<Date> {
  const stamp = sql`${now.toISOString()}::timestamptz`;
  const expired = sql`${userPinThrottle.windowStartedAt} + ${WINDOW_INTERVAL} <= ${stamp}`;
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .insert(userPinThrottle)
      .values({
        tenantId: context.tenant.tenantId,
        userId: requesterUserId,
        windowStartedAt: now,
        failures: 1,
      })
      .onConflictDoUpdate({
        target: [userPinThrottle.tenantId, userPinThrottle.userId],
        set: {
          failures: sql`CASE WHEN ${expired} THEN 1 ELSE ${userPinThrottle.failures} + 1 END`,
          windowStartedAt: sql`CASE WHEN ${expired} THEN ${stamp} ELSE ${userPinThrottle.windowStartedAt} END`,
        },
      })
      .returning({
        failures: userPinThrottle.failures,
        windowStartedAt: userPinThrottle.windowStartedAt,
      });
    if (!row) throw new Error("requester pin throttle reservation failed");
    if (row.failures > PIN_DEVICE_MAX_FAILURES) {
      await releaseRequesterSlotInTx(
        tx,
        context,
        requesterUserId,
        row.windowStartedAt,
      );
      const windowEnds = row.windowStartedAt.getTime() + PIN_DEVICE_WINDOW_MS;
      throw new PinRequesterThrottledError(
        Math.max(1, Math.ceil((windowEnds - now.getTime()) / 1000)),
      );
    }
    return row.windowStartedAt;
  });
}

async function releaseRequesterSlotInTx(
  tx: Tx,
  context: ScopedTenantContext,
  requesterUserId: string,
  windowStartedAt: Date,
): Promise<void> {
  await tx
    .update(userPinThrottle)
    .set({ failures: sql`GREATEST(${userPinThrottle.failures} - 1, 0)` })
    .where(
      and(
        eq(userPinThrottle.tenantId, context.tenant.tenantId),
        eq(userPinThrottle.userId, requesterUserId),
        eq(userPinThrottle.windowStartedAt, windowStartedAt),
      ),
    );
}

/** Gives a requester slot back (own transaction); a failure is logged and swallowed. */
async function releaseRequesterSlot(
  context: ScopedTenantContext,
  requesterUserId: string,
  windowStartedAt: Date,
): Promise<void> {
  try {
    await withTenant(db, context, (tx) =>
      releaseRequesterSlotInTx(tx, context, requesterUserId, windowStartedAt),
    );
  } catch (error) {
    logger.error(
      { err: toLoggableError(error), requesterUserId },
      "staff pin requester slot release failed",
    );
  }
}

/**
 * After a counted miss: the first one to see the requester's window at 10 or
 * more claims the window's alert and writes one audit row and one supervisor
 * alert. A failure is logged and never changes the answer.
 */
async function alertRequesterThrottled(
  context: ScopedTenantContext,
  outletId: string,
  requesterUserId: string,
  windowStartedAt: Date,
  now: Date,
): Promise<void> {
  try {
    await withTenant(db, context, async (tx) => {
      const [claimed] = await tx
        .update(userPinThrottle)
        .set({ alertedWindowStartedAt: windowStartedAt })
        .where(
          and(
            eq(userPinThrottle.tenantId, context.tenant.tenantId),
            eq(userPinThrottle.userId, requesterUserId),
            eq(userPinThrottle.windowStartedAt, windowStartedAt),
            gte(userPinThrottle.failures, PIN_DEVICE_MAX_FAILURES),
            sql`${userPinThrottle.alertedWindowStartedAt} IS DISTINCT FROM ${userPinThrottle.windowStartedAt}`,
          ),
        )
        .returning({ userId: userPinThrottle.userId });
      if (!claimed) return;
      await recordAudit(
        {
          tenantId: context.tenant.tenantId,
          outletId,
          actorType: "user",
          actorId: requesterUserId,
          deviceId: null,
          action: "staff_pin.requester_throttled",
          objectType: "user",
          objectId: requesterUserId,
          reason: null,
          before: null,
          after: {
            failures: PIN_DEVICE_MAX_FAILURES,
            windowSeconds: PIN_DEVICE_WINDOW_MS / 1000,
          },
          sensitiveAccess: false,
        },
        { tx, context },
      );
      const id = createUlid(now.getTime());
      await notifyOutletSupervisors(
        tx,
        context,
        {
          tenantId: context.tenant.tenantId,
          outletId: outletIdSchema.parse(outletId),
          id,
          eventName: "staff_pin.requester_throttled",
          aggregateType: "staff_pin",
          aggregateId: id,
          payload: { userId: requesterUserId },
          title: "Akun staf dibatasi karena PIN penyetuju salah",
          body: "Satu akun staf memasukkan PIN penyetuju yang salah 10 kali dalam 5 menit dan dibatasi sementara. Periksa akun itu.",
        },
        now,
      );
    });
  } catch (error) {
    logger.error(
      { err: toLoggableError(error), requesterUserId },
      "staff pin requester throttle alert failed",
    );
  }
}

/**
 * An approver's PIN on the supervisor override and open-bill paths, under fixed
 * windows of 10 wrong PINs / 5 minutes, applied together:
 * - the per-requester window of the authenticated account, always (a client
 *   that drops X-Device-Token, or rotates devices, still meets a limit);
 * - the per-device window as well, when the request has a verified device id.
 * Each slot is taken before the PIN is checked. A wrong guess and the guess that
 * newly locks the approver's PIN keep both (and can raise the window alerts); a
 * correct PIN, an already locked PIN and any other answer give both back. Over
 * either window full the answer is 429 before the approver's counter moves. Throws what
 * `assertPinAttemptOk` throws.
 */
export async function attemptApproverPin(
  tenant: TenantContext,
  input: {
    readonly outletId: string;
    readonly approverUserId: string;
    readonly requesterUserId: string;
    readonly pin: string;
    readonly deviceId: string | null;
    readonly now: Date;
  },
): Promise<void> {
  // E2 (brief 1269): no override on an edge past 72 h without a sync.
  await assertEdgeIdentityFresh();
  const outletId = outletIdSchema.parse(input.outletId);
  const context = outletContext(tenant, outletId);
  const { deviceId, now } = input;
  // One key per account, whatever the caller's case (a window split in two
  // would double the limit).
  const requesterUserId = input.requesterUserId.toLowerCase();
  // The requester window always applies; a verified device adds its own. Both
  // are checked before the approver's counter moves: either one full is 429.
  let deviceStart: Date | null = null;
  if (deviceId !== null)
    deviceStart = await reserveDeviceSlot(context, deviceId, now);
  let requesterStart: Date;
  try {
    requesterStart = await reserveRequesterSlot(context, requesterUserId, now);
  } catch (error) {
    if (deviceId !== null && deviceStart !== null)
      await releaseDeviceSlot(context, deviceId, deviceStart);
    throw error;
  }
  const window = {
    release: async () => {
      if (deviceId !== null && deviceStart !== null)
        await releaseDeviceSlot(context, deviceId, deviceStart);
      await releaseRequesterSlot(context, requesterUserId, requesterStart);
    },
    alert: async () => {
      if (deviceId !== null && deviceStart !== null)
        await alertDeviceThrottled(
          context,
          outletId,
          deviceId,
          deviceStart,
          now,
        );
      await alertRequesterThrottled(
        context,
        outletId,
        requesterUserId,
        requesterStart,
        now,
      );
    },
  };
  let outcome: PinAttemptOutcome;
  try {
    outcome = await attemptStaffPin(tenant, {
      outletId,
      userId: input.approverUserId,
      pin: input.pin,
      deviceId,
      now,
    });
  } catch (error) {
    await window.release();
    throw error;
  }
  if (
    outcome.kind === "invalid" ||
    (outcome.kind === "locked" && outcome.fresh === true)
  )
    await window.alert();
  else await window.release();
  assertPinAttemptOk(outcome);
}
