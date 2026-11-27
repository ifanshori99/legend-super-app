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
// - Pepper (bead legend-jmsdx): versions >= 2 are per outlet. A correct pin on
//   the cloud rehashes a row of an older version to the current one in the same
//   locked transaction (generation keys untouched, so the edge applies it by
//   the same key). An edge never rehashes, and a version 1 row there answers
//   STAFF_PIN_RESET_REQUIRED without counting a failed attempt.
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
import {
  currentStaffPinPepperVersion,
  staffPinPepperOrNull,
} from "./device-pin-pepper";
import {
  appendDevicePinEvent,
  isOutletMember,
  outletContext,
  outletTarget,
} from "./device-pin-support";
import { revokeActingStaffForStaff } from "./pos-acting-staff-revoke";
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
type DeviceOutletLookup = (input: {
  readonly tenantId: string;
  readonly deviceId: string;
}) => Promise<string | null>;

export type DeviceOutletResolver = DeviceOutletLookup & {
  /**
   * Same answer, but a registry lookup error throws instead of answering null
   * (unknown device). For callers that must not read an outage as "gone".
   */
  readonly strict?: DeviceOutletLookup;
};

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

/**
 * Like `resolveDeviceOutlet`, but a failing registry lookup throws (the
 * resolver's `strict` form) instead of reading as "no such device".
 */
export function resolveDeviceOutletStrict(
  tenantId: string,
  deviceId: string,
): Promise<string | null> {
  return (deviceOutletResolver.strict ?? deviceOutletResolver)({
    tenantId,
    deviceId,
  });
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
  // legend-ideif: one generation for the hash and the stored version. An edge
  // that was never sent a pepper has no generation yet: fail closed.
  const pepperVersion = currentStaffPinPepperVersion();
  const pepperForSet = staffPinPepperOrNull(
    tenant.tenantId,
    outletId,
    pepperVersion,
  );
  if (pepperForSet === null)
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "PIN belum bisa diatur: node edge belum menerima kunci PIN dari cloud.",
    );
  const hashed = await hashStaffPin({
    pepper: pepperForSet,
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
      pepperVersion,
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
      // legend-r11j7: the cloud revision baseline belongs to the old pin too.
      cloudAttemptRevision: null,
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
    // legend-aruta: a new PIN ends every acting-cashier token of this member.
    await revokeActingStaffForStaff(tx, tenant, {
      outletId,
      staffUserId: userId,
      reason: "pin_reset",
    });

    // legend-kyie: only an edge node sends the hash material, so the cloud
    // can adopt a pin set on the edge. The cloud never does (its pins reach
    // the edge through staff-pin-sync.ts, never through an event).
    const material = edge
      ? {
          algorithm: STAFF_PIN_HASH_ALGORITHM,
          salt: hashed.salt,
          pinHash: hashed.pinHash,
          params: hashed.params,
          pepperVersion,
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
  // `fresh`: THIS guess was the one that locked the pin (a real wrong guess);
  // absent: the pin was already locked and the guess was never checked.
  | { readonly kind: "locked"; readonly fresh?: true }
  | { readonly kind: "not_member" }
  // legend-jmsdx: an edge holds no pepper for a version 1 (tenant-wide) row,
  // so the pin cannot be checked there: the pin must be set again. Not a
  // wrong guess, so it never counts and never locks.
  | { readonly kind: "reset_required" };

/**
 * The pin generation a correct attempt checked (legend-aruta): the row id, its
 * generation key and its random salt. Service layer only: never put it in a
 * response or an audit.
 */
export type VerifiedPinVersion = {
  readonly id: string;
  readonly pinGenerationAt: Date;
  readonly pinSalt: string;
};

type AttemptInput = {
  readonly outletId: string;
  readonly userId: string;
  readonly pin: string;
  readonly deviceId?: string | null;
  readonly now?: Date;
};

/**
 * One pin attempt for (outlet, user), counted and committed on its own
 * transaction under the row lock. Returns the outcome instead of throwing so
 * the counter survives; callers map it with `assertPinAttemptOk`.
 */
export async function attemptStaffPin(
  tenant: TenantContext,
  input: AttemptInput,
): Promise<PinAttemptOutcome> {
  return (await attemptStaffPinVersioned(tenant, input)).outcome;
}

/**
 * `attemptStaffPin` that also returns the pin version a correct attempt
 * checked, so the caller can prove the pin did not change before it acts on
 * the outcome (`version` is null for every other outcome).
 */
export async function attemptStaffPinVersioned(
  tenant: TenantContext,
  input: AttemptInput,
): Promise<{
  readonly outcome: PinAttemptOutcome;
  readonly version: VerifiedPinVersion | null;
}> {
  const now = input.now ?? new Date();
  const outletId = outletIdSchema.parse(input.outletId);
  const parsedUser = userIdSchema.safeParse(input.userId);
  // The burn pepper only equalises timing; an edge without a pepper uses zeros.
  const pepper =
    staffPinPepperOrNull(
      tenant.tenantId,
      outletId,
      currentStaffPinPepperVersion(),
    ) ?? Buffer.alloc(32);
  if (!parsedUser.success) {
    await burnStaffPinCheck(pepper);
    return { outcome: { kind: "invalid" }, version: null };
  }
  const userId = parsedUser.data;
  const context = outletContext(tenant, outletId);
  let version: VerifiedPinVersion | null = null;
  const outcome = await withTenant(
    db,
    context,
    async (tx): Promise<PinAttemptOutcome> => {
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
      // legend-jmsdx: a version 1 row (pepper per tenant, cloud only) cannot be
      // checked on an edge, which never holds a version 1 pepper. Answer "pin
      // must be set again" before any check: no guess, no counter, no lock.
      // The edge never rehashes (it would need a new generation key, which
      // could revive an old pin over a cloud reset that has not arrived yet).
      const edge = isEdgeProcess();
      if (row && edge && row.pepperVersion === 1)
        return { kind: "reset_required" };
      // legend-ideif: a row hashed under an older generation still verifies
      // with that generation's pepper (until its owner sets a new pin); a
      // generation this process holds no pepper for fails closed. The pepper
      // is the one of the row's own outlet (legend-jmsdx).
      const rowPepper = row
        ? staffPinPepperOrNull(tenant.tenantId, row.outletId, row.pepperVersion)
        : null;
      if (!row || rowPepper === null) {
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
        pepper: rowPepper,
        binding: bindingOf(row),
        pin: input.pin,
        stored: storedHashOf(row),
      });
      const next = recordStaffPinAttempt({ state, correct, now });
      // legend-jmsdx: a correct pin on the cloud holds the real pin for this
      // request, so a row under an older pepper version moves to the current one
      // in the same locked transaction (fresh salt). Only the hash material
      // changes: `pin_generation_at`, `pin_set_at`, the `generation_edge_*`
      // columns and `cloud_generation_at` stay, so this is no new generation.
      // The row's `sync_xid` still moves with the update, so the next edge pull
      // resends it under the same key (the edge applies a same-key record,
      // `record key >= local key`), while a newer pin set on the edge keeps a
      // larger key and wins. No rehash on an edge.
      let rehashed: Awaited<ReturnType<typeof hashStaffPin>> | null = null;
      let rehashVersion = row.pepperVersion;
      if (correct && !edge) {
        rehashVersion = currentStaffPinPepperVersion();
        const currentPepper =
          rehashVersion > row.pepperVersion
            ? staffPinPepperOrNull(tenant.tenantId, row.outletId, rehashVersion)
            : null;
        if (currentPepper !== null)
          rehashed = await hashStaffPin({
            pepper: currentPepper,
            binding: bindingOf(row),
            pin: input.pin,
          });
      }
      await tx
        .update(staffPins)
        .set({
          failedAttempts: next.failedAttempts,
          lockedUntil:
            next.lockedUntil === null ? null : new Date(next.lockedUntil),
          updatedAt: staffPinVersionStamp(input.now),
          ...(rehashed
            ? {
                pinHash: rehashed.pinHash,
                pinSalt: rehashed.salt,
                kdfN: rehashed.params.N,
                kdfR: rehashed.params.r,
                kdfP: rehashed.params.p,
                pepperVersion: rehashVersion,
              }
            : {}),
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
        return { kind: "locked", fresh: true };
      }
      // A correct pin of someone who no longer works here, or a disabled
      // account, never switches in.
      const data = await loadTenantAccessInTransaction(tx, context, userId);
      if (
        !isOutletMember(tenant, userId, data, outletId, now) ||
        !(await activeUser(tx, userId))
      )
        return { kind: "not_member" };
      version = {
        id: row.id,
        pinGenerationAt: row.pinGenerationAt,
        pinSalt: row.pinSalt,
      };
      return { kind: "ok", userId };
    },
  );
  return { outcome, version: outcome.kind === "ok" ? version : null };
}

/**
 * `PIN_LOCKED` for the guess that itself locked the pin (legend-sp9vq): still a
 * wrong guess, so the per-device throttle must keep counting it. A pin that was
 * already locked throws the plain `IdentityError`.
 */
export class PinNewlyLockedError extends IdentityError {
  constructor() {
    super("PIN_LOCKED");
    this.name = "PinNewlyLockedError";
  }
}

/** Maps a failed attempt to the identity error the device shows. */
export function assertPinAttemptOk(
  outcome: PinAttemptOutcome,
): asserts outcome is { kind: "ok"; userId: string } {
  if (outcome.kind === "locked")
    throw outcome.fresh
      ? new PinNewlyLockedError()
      : new IdentityError("PIN_LOCKED");
  if (outcome.kind === "reset_required")
    throw new IdentityError("STAFF_PIN_RESET_REQUIRED");
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
  return (await verifyStaffPinOnDeviceVersioned(tenant, input)).switch;
}

/**
 * `verifyStaffPinOnDevice` that also returns the pin version it checked
 * (legend-aruta). The version never leaves the service layer: only `switch` is
 * a response shape.
 */
export async function verifyStaffPinOnDeviceVersioned(
  tenant: TenantContext,
  input: {
    readonly deviceId: string;
    readonly userId: string;
    readonly pin: string;
    readonly now?: Date;
  },
): Promise<{
  readonly switch: StaffPinSwitch;
  readonly pinVersion: VerifiedPinVersion;
}> {
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
  const { outcome, version } = await attemptStaffPinVersioned(tenant, {
    outletId: outlet.data,
    userId: input.userId,
    pin: input.pin,
    deviceId: input.deviceId,
    // Only an explicit clock: unset keeps the row version on the database
    // clock (legend-wg5t item 5).
    now: input.now,
  });
  assertPinAttemptOk(outcome);
  if (version === null) throw new IdentityError("PIN_INVALID");
  const context = outletContext(tenant, outlet.data);
  const verifiedSwitch = await withTenant(db, context, async (tx) => {
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
  return { switch: verifiedSwitch, pinVersion: version };
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
