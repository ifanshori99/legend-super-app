// Staff device pins (bead legend-dxb; PRD v1.7 §3 F6 "Staf — PIN Perangkat":
// "staf berganti pengguna dengan PIN pribadi 6 digit pada perangkat
// terdaftar. PIN dikunci setelah 5 kali salah"; §6 B staff_pins "(T, E)").
//
// - Set: a staff member sets their own pin at an outlet they belong to, or a
//   holder of `device.registry.manage` on the outlet sets it for a member of
//   that outlet (identity endpoints contract). A trivial pin is refused
//   (WEAK_STAFF_PIN). Setting clears the counter and any lock.
// - Verify: one staff_pins row is locked FOR UPDATE for the whole attempt, so
//   concurrent guesses are counted one after the other and can never exceed
//   the limit; the counter commits in its own transaction even though the
//   caller then answers PIN_INVALID / PIN_LOCKED. The fifth consecutive miss
//   locks for STAFF_PIN_LOCK_MINUTES (shared machine); a correct pin resets.
//   A locked row is refused without checking the pin (no oracle while
//   locked). An unknown user or missing row costs the same scrypt and answers
//   the same PIN_INVALID.
// - Edge: `exportStaffPinRecords` is the replication shape (hash only).
//
// Never log, audit or emit a pin. Audit and events carry ids only.

import {
  type StaffPinEdgeRecord,
  staffPinEdgeRecordSchema,
  STAFF_PIN_HASH_ALGORITHM,
  staffPinLockedEvent,
  staffPinSetEvent,
} from "@starter/shared/access/override";
import { AccessError } from "@starter/shared/access";
import {
  CoreError,
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  assertStrongStaffPin,
  IdentityError,
  isStaffPinLocked,
  recordStaffPinAttempt,
  staffPinSwitchSchema,
  type StaffPinSwitch,
} from "@starter/shared/identity";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { getEdgeRuntimeState } from "../edge/runtime";
import { withoutSecretErrorDetail } from "../edge/envelope-secrets";
import { staffPins } from "../db/schema/device-pin";
import { user } from "../db/schema/user";
import { withTenant } from "../db/tenant";
import { recordAudit } from "./audit-writer";
import {
  burnStaffPinCheck,
  hashStaffPin,
  verifyStaffPinHash,
  type StaffPinBinding,
} from "./device-pin-hash";
import { STAFF_PIN_PEPPER_VERSION, staffPinPepper } from "./device-pin-pepper";
import {
  appendDevicePinEvent,
  isOutletMember,
  outletContext,
  outletTarget,
} from "./device-pin-support";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver";

type PinRow = typeof staffPins.$inferSelect;

// ------------------------------------------------- device → outlet (WS-02)

/**
 * Resolves the outlet a registered device belongs to. Device registration
 * lives in WS-02 (legend-165), which installs the real resolver. Until then
 * the default answers null and every device pin verify is refused (fail
 * closed): a signed token alone never names an outlet.
 */
export type DeviceOutletResolver = (input: {
  readonly tenantId: string;
  readonly deviceId: string;
}) => Promise<string | null>;

const denyAllDevices: DeviceOutletResolver = async () => null;
let deviceOutletResolver: DeviceOutletResolver = denyAllDevices;

export function setDeviceOutletResolver(
  next: DeviceOutletResolver | null,
): void {
  deviceOutletResolver = next ?? denyAllDevices;
}

/** The outlet a registered device belongs to, or null (fail closed). */
export function resolveDeviceOutlet(
  tenantId: string,
  deviceId: string,
): Promise<string | null> {
  return deviceOutletResolver({ tenantId, deviceId });
}

// ------------------------------------------------------------------ helpers

function bindingOf(row: Pick<PinRow, "tenantId" | "outletId" | "userId">) {
  return {
    tenantId: row.tenantId,
    outletId: row.outletId,
    userId: row.userId,
  } satisfies StaffPinBinding;
}

function storedHashOf(row: PinRow) {
  return {
    salt: row.pinSalt,
    pinHash: row.pinHash,
    params: { N: row.kdfN, r: row.kdfR, p: row.kdfP, keyLength: 32 as const },
  };
}

async function activeUser(tx: Tx, userId: string) {
  const [row] = await tx
    .select({
      id: user.id,
      name: user.name,
      banned: user.banned,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row && row.banned !== true ? row : null;
}

// --------------------------------------------------------------------- set

export type SetStaffPinOptions = {
  readonly now?: Date;
  readonly deviceId?: string | null;
};

/**
 * `updated_at` of a staff pin row: the DATABASE clock (legend-wg5t item 5).
 * The edge down-sync no longer pages by this column: it orders by the
 * writing transaction (`sync_xid`, legend-t9ii, staff-pin-sync.ts). The
 * database clock still keeps `updated_at` and `pin_set_at` free of app clock
 * skew. An explicit `now` (tests) is used as given.
 */
function staffPinVersionStamp(explicit: Date | undefined): Date | SQL {
  return explicit ?? sql`now()`;
}

/**
 * True on an edge node (same rule as pos-receipt.service.ts): the runtime
 * flag, or the static `EDGE_MODE` setting during the boot window.
 */
function isEdgeProcess(): boolean {
  return getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true";
}

/**
 * PUT /api/staff-pins/:outletId/:userId. Self, or `device.registry.manage` on
 * the outlet for another member. The pin is hashed before the transaction and
 * never stored, logged or audited.
 */
export async function setStaffPin(
  tenant: TenantContext,
  actorUserId: string,
  target: { readonly outletId: string; readonly userId: string },
  input: { readonly pin: string },
  options: SetStaffPinOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const actorId = userIdSchema.parse(actorUserId);
  const outletId = outletIdSchema.parse(target.outletId);
  const userId = userIdSchema.parse(target.userId);
  assertStrongStaffPin(input.pin);
  const self = actorId.toLowerCase() === userId.toLowerCase();
  const context = outletContext(tenant, outletId);
  const binding: StaffPinBinding = {
    tenantId: tenant.tenantId,
    outletId,
    userId,
  };
  const hashed = await hashStaffPin({
    pepper: staffPinPepper(tenant.tenantId),
    binding,
    pin: input.pin,
  });

  await withTenant(db, context, async (tx) => {
    const actorData = await loadTenantAccessInTransaction(tx, context, actorId);
    if (self) {
      if (!isOutletMember(tenant, actorId, actorData, outletId, now))
        throw new AccessError(
          "PERMISSION_DENIED",
          "Anda tidak terdaftar di outlet ini.",
        );
    } else {
      const actor = resolveAccessSnapshot({
        tenant,
        userId: actorId,
        ...actorData,
        mfaVerified: false,
        now,
      });
      if (!actor.allows("device.registry.manage", outletTarget(outletId)))
        throw new AccessError("PERMISSION_DENIED");
      const targetData = await loadTenantAccessInTransaction(
        tx,
        context,
        userId,
      );
      if (!isOutletMember(tenant, userId, targetData, outletId, now))
        throw new CoreError("NOT_FOUND", "Staf tidak terdaftar di outlet ini.");
    }
    if (!(await activeUser(tx, userId)))
      throw new CoreError("NOT_FOUND", "Staf tidak ditemukan.");

    const [previous] = await tx
      .select({ id: staffPins.id })
      .from(staffPins)
      .where(
        and(
          eq(staffPins.tenantId, tenant.tenantId),
          eq(staffPins.outletId, outletId),
          eq(staffPins.userId, userId),
        ),
      )
      .for("update");
    const edge = isEdgeProcess();
    const values = {
      pinHash: hashed.pinHash,
      pinSalt: hashed.salt,
      kdfN: hashed.params.N,
      kdfR: hashed.params.r,
      kdfP: hashed.params.p,
      pepperVersion: STAFF_PIN_PEPPER_VERSION,
      failedAttempts: 0,
      lockedUntil: null,
      setBy: actorId,
      // legend-kyie: a new pin generation; attempts never move this.
      pinSetAt: staffPinVersionStamp(options.now),
      updatedAt: staffPinVersionStamp(options.now),
      // legend-rucdm: a local set is no edge node's set on this database, so
      // no node's later sequence may replace it by sequence alone (cloud);
      // the columns stay null on the edge.
      generationEdgeNodeId: null,
      generationEdgeSequence: null,
      generationEdgeInstanceId: null,
      // legend-7vv8h: a new pin has no cloud counter/lock history. A stale
      // baseline from the previous pin would make the edge's same-material
      // merge drop a cloud failure that equals the old baseline value.
      cloudFailedAttempts: null,
      cloudLockedUntil: null,
    };
    // Order key of the generation (Codex 160 C1), never below the current
    // one (round 3 R2): a clock stepping back still makes a newer key. The
    // edge stamps its own clock and sends the key as `material.setAt`; the
    // cloud also orders after an edge set stamped in the future.
    const generationStamp = edge
      ? staffPinVersionStamp(options.now)
      : (options.now ?? sql`clock_timestamp()`);
    const written = {
      id: staffPins.id,
      pinGenerationAt: staffPins.pinGenerationAt,
    };
    // A failed write can quote the hash and salt in a driver error's message
    // and parameters (round 3 R3): rethrown without them.
    const [row] = await withoutSecretErrorDetail(
      "Staff pin write failed",
      async () =>
        previous
          ? tx
              .update(staffPins)
              .set({
                ...values,
                // The edge caps the carried key at its clock + 5 min (the
                // cloud's skew window): a key left far ahead by a clock that
                // ran ahead would otherwise keep every later set refused on
                // the cloud after the clock is fixed. The cap starts from the
                // later of the edge clock and the last cloud key received
                // (`cloud_generation_at`, legend-t9ii review K F2): an edge
                // clock more than 5 min behind a recent cloud reset would
                // otherwise stamp before the cloud key and never be adopted.
                // Consecutive sets of one node no longer depend on this cap:
                // the cloud adopts a node's later set by its aggregate
                // sequence (legend-rucdm). The cap still protects a key that
                // ran ahead against another origin's sets.
                pinGenerationAt: edge
                  ? sql`GREATEST(${generationStamp}::timestamptz, LEAST(${staffPins.pinGenerationAt}, GREATEST(${generationStamp}::timestamptz, COALESCE(${staffPins.cloudGenerationAt}, ${generationStamp}::timestamptz)) + interval '5 minutes') + interval '1 millisecond')`
                  : sql`GREATEST(${generationStamp}::timestamptz, ${staffPins.pinGenerationAt} + interval '1 millisecond')`,
              })
              .where(eq(staffPins.id, previous.id))
              .returning(written)
          : tx
              .insert(staffPins)
              .values({
                tenantId: tenant.tenantId,
                outletId,
                userId,
                createdAt: now,
                ...values,
                pinGenerationAt: generationStamp,
              })
              .returning(written),
    );
    if (!row) throw new Error("staff pin write returned no row");

    // legend-kyie: only an edge node sends the hash material, so the cloud
    // can adopt a pin set on the edge. The cloud never does (its pins reach
    // the edge through staff-pin-sync.ts, never through an event).
    const material = edge
      ? {
          algorithm: STAFF_PIN_HASH_ALGORITHM,
          salt: hashed.salt,
          pinHash: hashed.pinHash,
          params: hashed.params,
          pepperVersion: STAFF_PIN_PEPPER_VERSION,
          setAt: row.pinGenerationAt.toISOString(),
        }
      : undefined;
    // A failed outbox write can quote the event (hash, salt) in a driver
    // error's message and parameters, which reach API logs and job output
    // (Codex 160 C2): rethrown without the original message or cause.
    await withoutSecretErrorDetail("Staff pin event write failed", () =>
      appendDevicePinEvent(tx, context, staffPinSetEvent, {
        aggregateId: row.id,
        outletId,
        actor: { type: "user", id: actorId },
        deviceId: options.deviceId ?? null,
        now,
        payload: {
          staffPinId: row.id,
          userId,
          setBy: actorId,
          self,
          ...(material ? { material } : {}),
        },
      }),
    );
    await recordAudit(
      {
        tenantId: tenant.tenantId,
        outletId,
        actorType: "user",
        actorId,
        deviceId: options.deviceId ?? null,
        action: previous ? "staff_pin.reset" : "staff_pin.set",
        objectType: "staff_pin",
        objectId: row.id,
        reason: null,
        // Never the pin or its hash.
        before: previous ? { userId } : null,
        after: { userId, failedAttempts: 0, locked: false, self },
        sensitiveAccess: false,
      },
      { tx, context },
    );
  });
}

// ------------------------------------------------------------------ verify

export type PinAttemptOutcome =
  | { readonly kind: "ok"; readonly userId: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "locked" }
  | { readonly kind: "not_member" };

/**
 * One pin attempt for (outlet, user), counted and committed on its own
 * transaction under the row lock. Returns the outcome instead of throwing so
 * the counter survives; callers map it with `assertPinAttemptOk`.
 */
export async function attemptStaffPin(
  tenant: TenantContext,
  input: {
    readonly outletId: string;
    readonly userId: string;
    readonly pin: string;
    readonly deviceId?: string | null;
    readonly now?: Date;
  },
): Promise<PinAttemptOutcome> {
  const now = input.now ?? new Date();
  const outletId = outletIdSchema.parse(input.outletId);
  const parsedUser = userIdSchema.safeParse(input.userId);
  const pepper = staffPinPepper(tenant.tenantId);
  if (!parsedUser.success) {
    await burnStaffPinCheck(pepper);
    return { kind: "invalid" };
  }
  const userId = parsedUser.data;
  const context = outletContext(tenant, outletId);
  return withTenant(db, context, async (tx): Promise<PinAttemptOutcome> => {
    const [row] = await tx
      .select()
      .from(staffPins)
      .where(
        and(
          eq(staffPins.tenantId, tenant.tenantId),
          eq(staffPins.outletId, outletId),
          eq(staffPins.userId, userId),
        ),
      )
      .for("update");
    if (!row || row.pepperVersion !== STAFF_PIN_PEPPER_VERSION) {
      await burnStaffPinCheck(pepper);
      return { kind: "invalid" };
    }
    const state = {
      failedAttempts: row.failedAttempts,
      lockedUntil: row.lockedUntil?.toISOString() ?? null,
    };
    // §3 F6: a locked pin is refused without looking at the guess.
    if (isStaffPinLocked(state, now)) return { kind: "locked" };
    const correct = await verifyStaffPinHash({
      pepper,
      binding: bindingOf(row),
      pin: input.pin,
      stored: storedHashOf(row),
    });
    const next = recordStaffPinAttempt({ state, correct, now });
    await tx
      .update(staffPins)
      .set({
        failedAttempts: next.failedAttempts,
        lockedUntil:
          next.lockedUntil === null ? null : new Date(next.lockedUntil),
        updatedAt: staffPinVersionStamp(input.now),
      })
      .where(eq(staffPins.id, row.id));
    if (!correct) {
      if (next.lockedUntil === null) return { kind: "invalid" };
      await appendDevicePinEvent(tx, context, staffPinLockedEvent, {
        aggregateId: row.id,
        outletId,
        actor: { type: "system" },
        deviceId: input.deviceId ?? null,
        now,
        payload: {
          staffPinId: row.id,
          userId: row.userId,
          lockedUntil: next.lockedUntil,
        },
      });
      await recordAudit(
        {
          tenantId: tenant.tenantId,
          outletId,
          actorType: input.deviceId ? "device" : "system",
          actorId: input.deviceId ?? null,
          deviceId: input.deviceId ?? null,
          action: "staff_pin.locked",
          objectType: "staff_pin",
          objectId: row.id,
          reason: null,
          before: { failedAttempts: row.failedAttempts },
          after: {
            userId: row.userId,
            failedAttempts: next.failedAttempts,
            lockedUntil: next.lockedUntil,
          },
          sensitiveAccess: false,
        },
        { tx, context },
      );
      return { kind: "locked" };
    }
    // A correct pin of someone who no longer works here, or a disabled
    // account, never switches in.
    const data = await loadTenantAccessInTransaction(tx, context, userId);
    if (
      !isOutletMember(tenant, userId, data, outletId, now) ||
      !(await activeUser(tx, userId))
    )
      return { kind: "not_member" };
    return { kind: "ok", userId };
  });
}

/** Maps a failed attempt to the identity error the device shows. */
export function assertPinAttemptOk(
  outcome: PinAttemptOutcome,
): asserts outcome is { kind: "ok"; userId: string } {
  if (outcome.kind === "locked") throw new IdentityError("PIN_LOCKED");
  if (outcome.kind === "not_member")
    throw new AccessError(
      "PERMISSION_DENIED",
      "Staf tidak terdaftar di outlet ini.",
    );
  if (outcome.kind !== "ok") throw new IdentityError("PIN_INVALID");
}

/**
 * POST /api/staff-pins/verify from a registered outlet device. The outlet is
 * the device's (WS-02 resolver; fail closed until it is installed).
 */
export async function verifyStaffPinOnDevice(
  tenant: TenantContext,
  input: {
    readonly deviceId: string;
    readonly userId: string;
    readonly pin: string;
    readonly now?: Date;
  },
): Promise<StaffPinSwitch> {
  const now = input.now ?? new Date();
  const resolved = await deviceOutletResolver({
    tenantId: tenant.tenantId,
    deviceId: input.deviceId,
  });
  const outlet = outletIdSchema.safeParse(resolved);
  if (resolved === null || !outlet.success)
    throw new CoreError(
      "FORBIDDEN",
      "Perangkat ini belum terdaftar di outlet mana pun.",
    );
  const outcome = await attemptStaffPin(tenant, {
    outletId: outlet.data,
    userId: input.userId,
    pin: input.pin,
    deviceId: input.deviceId,
    // Only an explicit clock: unset keeps the row version on the database
    // clock (legend-wg5t item 5).
    now: input.now,
  });
  assertPinAttemptOk(outcome);
  const context = outletContext(tenant, outlet.data);
  return withTenant(db, context, async (tx) => {
    const account = await activeUser(tx, outcome.userId);
    if (!account) throw new IdentityError("PIN_INVALID");
    const data = await loadTenantAccessInTransaction(
      tx,
      context,
      outcome.userId,
    );
    const snapshot = resolveAccessSnapshot({
      tenant,
      userId: outcome.userId,
      ...data,
      mfaVerified: false,
      now,
    });
    return staffPinSwitchSchema.parse({
      user: {
        id: account.id,
        displayName: account.name.trim().slice(0, 150) || "Staf",
        kind: "staff",
        status: "active",
        mfaRequired: snapshot.mfaRequired,
        lastLoginAt: null,
        createdAt: account.createdAt.toISOString(),
      },
      outletId: outlet.data,
      verifiedAt: now.toISOString(),
    });
  });
}

// -------------------------------------------------------------------- edge

/**
 * The replication shape for the outlet edge (§6 B staff_pins "(T, E)"): hash,
 * salt, cost and lock state, never the pin. The sync layer (WS-02) calls this
 * inside its own outlet-scoped job; the pepper travels separately
 * (`staffPinPepper`) over the edge provisioning channel.
 */
export async function exportStaffPinRecords(
  context: ScopedTenantContext,
  outletId: string,
): Promise<StaffPinEdgeRecord[]> {
  const outlet = outletIdSchema.parse(outletId);
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(staffPins)
      .where(
        and(
          eq(staffPins.tenantId, context.tenant.tenantId),
          eq(staffPins.outletId, outlet),
        ),
      )
      .orderBy(staffPins.id);
    return rows.map((row) =>
      staffPinEdgeRecordSchema.parse({
        id: row.id,
        tenantId: row.tenantId,
        outletId: row.outletId,
        userId: row.userId,
        algorithm: STAFF_PIN_HASH_ALGORITHM,
        salt: row.pinSalt,
        pinHash: row.pinHash,
        params: storedHashOf(row).params,
        pepperVersion: row.pepperVersion,
        failedAttempts: row.failedAttempts,
        lockedUntil: row.lockedUntil?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      }),
    );
  });
}
