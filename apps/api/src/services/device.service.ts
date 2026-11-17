// Device registry, cloud side (bead legend-165; PRD v1.7 §3 F5 "Registri
// Perangkat" and "Mode Latihan", §6 `devices`, EDG-03 revocation).
//
// - enroll: a holder of `device.registry.manage` on the outlet enrolls a device
//   and receives its `dv1` token ONCE. The token is minted here, after the
//   registry row is re-read in the same transaction (active, same tenant). It
//   is never stored, logged or audited; only `token_issued_at` is kept, as the
//   floor for token `issuedAt`.
// - issueDeviceToken: reissue. Moves `token_issued_at` forward, so every older
//   token of the device stops verifying (device-registry-check.ts). Refused for
//   a revoked device.
// - revoke: `device.registry.revoke`; terminal (database trigger), audited,
//   closes any open training period. The token stops working at the next
//   registry check; the edge replica learns it through edge-device-sync.
// - training mode: per device, audited; an open `device_training_periods` row
//   is what report queries filter on (device-training.ts).
// - heartbeat: the device itself (token), updates last_seen_at/version.
//
// Idempotency: `enrollDevice` derives the device id from the client's
// idempotency key (HMAC-free, tenant-bound hash), so a replay finds the same
// row. A replay with different input is IDEMPOTENCY_KEY_REUSED. A replay
// re-shows the token only if the device was never reissued and the row is under
// 24h old; otherwise CONFLICT (no silent live token). Revoke is
// naturally idempotent (an already revoked device is returned unchanged).
// Reissue has no stored key: see `issueDeviceToken`.
import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  uuidSchema,
  type CursorPage,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEVICE_OFFLINE_AFTER_SECONDS,
  deviceHeartbeatBodySchema,
  deviceSchema,
  isDeviceOffline,
  transitionDevice,
  type Device,
} from "@starter/shared/edge";
import type { KitchenScannerStatus } from "@starter/shared/kitchen";
import { menuUpdatedEvent } from "@starter/shared/menu";
import type { Request, RequestHandler } from "express";
import type { z } from "zod";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { db } from "../db/index.ts";
import {
  deviceTrainingPeriods,
  devices,
  type DeviceStatus,
  type DeviceType,
} from "../db/schema/device.ts";
import { stations } from "../db/schema/menu.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import {
  DEVICE_TOKEN_TTL_SECONDS,
  signDeviceToken,
  verifyDeviceToken,
} from "../lib/device-token.ts";
import {
  getEdgeRuntimeState,
  isDeviceRegistryHardStale,
  reportDeviceRegistryHardStale,
} from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import { recordAudit } from "./audit-writer.ts";
import { findActiveDeviceForToken } from "./device-registry-check.ts";
import { recheckKdsSockets } from "./kds-realtime.ts";
import { appendMenuEvent } from "./menu-internals.ts";
import { closeSessionsOfSharedDevice } from "./shared-device.service.ts";
import type { Tx } from "./permission-resolver.ts";
import {
  deviceTakesReceipts,
  provisionNextDeviceReceiptSequence,
} from "./pos-receipt.service.ts";

type DeviceRow = typeof devices.$inferSelect;

/**
 * `devices.updated_at` comes from the database clock, not the app server's: the
 * edge sync watermark orders rows by it, and clock skew between app servers
 * would let a row land behind a watermark already handed out.
 */
const dbClock = sql`clock_timestamp()`;

/** An enroll replay may re-show the enrollment token for this long. */
export const ENROLL_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export type DeviceHeartbeatBody = z.infer<typeof deviceHeartbeatBodySchema>;

export function toDevice(row: DeviceRow): Device {
  return deviceSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    id: row.id,
    type: row.type,
    stationId: row.stationId,
    label: row.label,
    version: row.version,
    capabilities: row.capabilities,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    status: row.status,
    trainingMode: row.trainingMode,
    sharedMode: row.sharedMode,
  });
}

/** Tenant-wide RLS scope of an already resolved tenant (lookups, heartbeat). */
export function tenantWideContext(tenant: TenantContext): ScopedTenantContext {
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

/**
 * The outlet of a device, read under tenant-wide RLS, so a route can check the
 * permission on that outlet. null = unknown device (or another tenant's): the
 * caller answers 404 without saying which.
 */
export async function findDeviceOutletId(
  tenant: TenantContext,
  deviceId: string,
): Promise<string | null> {
  const [row] = await withTenant(db, tenantWideContext(tenant), (tx) =>
    tx
      .select({ outletId: devices.outletId })
      .from(devices)
      .where(eq(devices.id, uuidSchema.parse(deviceId)))
      .limit(1),
  );
  return row?.outletId ?? null;
}

const notFound = () => new CoreError("NOT_FOUND", "Perangkat tidak ditemukan.");

/** Replay-stable device id: bound to the tenant and the client's key. */
function enrollmentDeviceId(tenantId: string, idempotencyKey: string): string {
  const hex = createHash("sha256")
    .update(`legend.device-enroll.v1\n${tenantId}\n${idempotencyKey}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function outletBrandId(tx: Tx, outletId: string): Promise<string> {
  const [outlet] = await tx
    .select({ brandId: outlets.brandId })
    .from(outlets)
    .where(eq(outlets.id, outletId))
    .limit(1);
  if (!outlet) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
  return outlet.brandId;
}

/**
 * Next token issue time in Unix seconds: not before now, and strictly after the
 * previous one, so a reissue inside the same second still rotates the old token
 * out. The stored `token_issued_at` is that whole second.
 */
function nextIssuedAt(previous: Date | null, now: Date): number {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!previous) return nowSeconds;
  return Math.max(nowSeconds, Math.floor(previous.getTime() / 1000) + 1);
}

/**
 * Mints the token from the freshly read row. Fails closed unless the row is
 * active, of this tenant, and carries the issue time being signed. The expiry
 * derives from the issue time, so a replay of the same issue is the same token.
 */
function mintForRow(
  row: DeviceRow,
  tenantId: string,
  brandId: string,
  issuedAt: number,
): string {
  if (
    row.tenantId !== tenantId ||
    row.status !== "active" ||
    row.revokedAt !== null ||
    row.tokenIssuedAt === null ||
    Math.floor(row.tokenIssuedAt.getTime() / 1000) !== issuedAt
  )
    throw new CoreError("CONFLICT", "Perangkat tidak aktif.");
  return signDeviceToken(
    { version: 1, tenantId, brandId, deviceId: row.id, issuedAt },
    issuedAt + DEVICE_TOKEN_TTL_SECONDS,
  );
}

/** A heartbeat this recent means the device already has a running session. */
const DEVICE_LIVE_SESSION_WINDOW_MS = 5 * 60_000;

export const EDGE_DEVICE_REGISTRY_STALE_CODE = "EDGE_DEVICE_REGISTRY_STALE";

/**
 * legend-2lgu: an edge whose device-registry replica is past its hard limit
 * refuses NEW device sessions (enroll, token, first heartbeat): a revocation
 * may be missing. Running sessions are never cut (see `heartbeatDevice`).
 * No-op on the cloud. Alerts the outlet's supervisors (once a day).
 */
async function assertDeviceRegistryFresh(now: Date): Promise<void> {
  if (!isDeviceRegistryHardStale(now)) return;
  await reportDeviceRegistryHardStale(now);
  throw new HttpError(
    503,
    EDGE_DEVICE_REGISTRY_STALE_CODE,
    "Data perangkat di edge sudah terlalu lama tidak diperbarui dari cloud. Sambungkan edge ke cloud, lalu coba lagi.",
  );
}

export type EnrollDeviceInput = {
  outletId: string;
  type: DeviceType;
  label: string;
  stationId?: string | null;
  idempotencyKey: string;
};

export async function enrollDevice(
  context: ScopedTenantContext,
  actorUserId: string,
  input: EnrollDeviceInput,
  now: Date = new Date(),
): Promise<{ device: Device; token: string }> {
  assertTrustedScopedContext(context);
  await assertDeviceRegistryFresh(now);
  const outletId = outletIdSchema.parse(input.outletId);
  assertOutletInScope(context.outletScope, outletId);
  const tenantId = context.tenant.tenantId;
  const stationId = input.stationId ?? null;
  const id = enrollmentDeviceId(tenantId, input.idempotencyKey);
  return withTenant(db, context, async (tx) => {
    if (stationId !== null) {
      const [station] = await tx
        .select({ id: stations.id })
        .from(stations)
        .where(
          and(
            eq(stations.id, stationId),
            eq(stations.outletId, outletId),
            isNull(stations.deletedAt),
          ),
        )
        .limit(1);
      if (!station)
        throw new CoreError(
          "VALIDATION_ERROR",
          "Stasiun tidak ditemukan di outlet ini.",
        );
    }
    const brandId = await outletBrandId(tx, outletId);
    const issuedAt = Math.floor(now.getTime() / 1000);
    const inserted = await tx
      .insert(devices)
      .values({
        id,
        tenantId,
        outletId,
        type: input.type,
        stationId,
        label: input.label,
        enrolledBy: actorUserId,
        tokenIssuedAt: new Date(issuedAt * 1000),
        createdAt: now,
        updatedAt: dbClock,
      })
      .onConflictDoNothing({ target: devices.id })
      .returning({ id: devices.id });
    // Re-read: the row that exists decides, not the one we meant to insert.
    const [row] = await tx
      .select()
      .from(devices)
      .where(eq(devices.id, id))
      .for("update");
    // Hidden by RLS (another outlet) or different input: the key was used.
    if (
      !row ||
      row.tenantId !== tenantId ||
      row.outletId !== outletId ||
      row.type !== input.type ||
      row.label !== input.label ||
      row.stationId !== stationId
    )
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai untuk permintaan lain.",
      );
    if (
      row.tokenIssuedAt === null ||
      row.status !== "active" ||
      row.revokedAt !== null
    )
      throw new CoreError("CONFLICT", "Perangkat tidak aktif.");
    const replay = inserted.length === 0;
    if (replay) {
      // A replay may re-show the enrollment token only while it is still the
      // newest one (never reissued) and the key is fresh. After a reissue the
      // replay must not mint a live token silently.
      const neverReissued =
        Math.floor(row.tokenIssuedAt.getTime() / 1000) ===
        Math.floor(row.createdAt.getTime() / 1000);
      const withinWindow =
        now.getTime() - row.createdAt.getTime() <= ENROLL_REPLAY_WINDOW_MS;
      if (!neverReissued || !withinWindow)
        throw new CoreError(
          "CONFLICT",
          "Perangkat sudah terdaftar. Terbitkan token baru dari registri.",
        );
    }
    // legend-3yqy: a device that can create a POS order gets its receipt
    // sequence (next free `P<n>`) in this transaction, so the edge can number
    // its sales offline. Idempotent on a replay. An edge never invents a
    // prefix; the cloud provisions it and the device pull carries it.
    if (deviceTakesReceipts(row.type) && !getEdgeRuntimeState().edgeMode)
      await provisionNextDeviceReceiptSequence(tx, context, {
        outletId,
        deviceId: row.id,
      });
    const token = mintForRow(
      row,
      tenantId,
      brandId,
      Math.floor(row.tokenIssuedAt.getTime() / 1000),
    );
    await recordAudit(
      {
        tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "device.enrolled",
        objectType: "device",
        objectId: id,
        reason: null,
        before: null,
        after: replay
          ? { type: input.type, label: input.label, stationId, replay: true }
          : { type: input.type, label: input.label, stationId },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return { device: toDevice(row), token };
  });
}

/**
 * Reissue: a new token, and every older one stops verifying. Refuses a revoked
 * device (CONFLICT). The client's idempotency key is validated by the route but
 * not stored (no column for it), so replaying a reissue rotates again; the
 * caller shows the new token once and only the newest works.
 */
export async function issueDeviceToken(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { deviceId: string },
  now: Date = new Date(),
): Promise<{ device: Device; token: string }> {
  assertTrustedScopedContext(context);
  await assertDeviceRegistryFresh(now);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(devices)
      .where(eq(devices.id, input.deviceId))
      .for("update");
    if (!current || current.tenantId !== tenantId) throw notFound();
    assertOutletInScope(context.outletScope, current.outletId);
    if (current.status !== "active" || current.revokedAt !== null)
      throw new CoreError("CONFLICT", "Perangkat sudah dicabut.");
    const issuedAt = nextIssuedAt(current.tokenIssuedAt, now);
    const [updated] = await tx
      .update(devices)
      .set({ tokenIssuedAt: new Date(issuedAt * 1000), updatedAt: dbClock })
      .where(and(eq(devices.id, current.id), eq(devices.status, "active")))
      .returning();
    if (!updated)
      throw new CoreError("CONFLICT", "Perangkat berubah, coba lagi.");
    // Web push registrations made with an older token stop with it (a lost or
    // stolen phone must not keep getting alarms). Same transaction and the
    // device row is locked FOR UPDATE, so a registration (FOR SHARE) either
    // commits first and is deleted here or waits and then sees the new floor.
    await tx.execute(
      sql`DELETE FROM push_subscriptions WHERE tenant_id=${tenantId}::uuid AND device_id=${updated.id}::uuid`,
    );
    const brandId = await outletBrandId(tx, updated.outletId);
    const token = mintForRow(updated, tenantId, brandId, issuedAt);
    await recordAudit(
      {
        tenantId,
        outletId: updated.outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "device.token_issued",
        objectType: "device",
        objectId: updated.id,
        reason: null,
        before: null,
        after: { tokenIssuedAt: new Date(issuedAt * 1000).toISOString() },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return { device: toDevice(updated), token };
  });
}

/** Closes the open training period of a device, if any. */
export async function closeTrainingPeriod(
  tx: Tx,
  deviceId: string,
  actorUserId: string,
  now: Date,
): Promise<boolean> {
  const [open] = await tx
    .select()
    .from(deviceTrainingPeriods)
    .where(
      and(
        eq(deviceTrainingPeriods.deviceId, deviceId),
        isNull(deviceTrainingPeriods.endedAt),
      ),
    )
    .for("update");
  if (!open) return false;
  // CHECK ended_at > started_at: never close at or before the start.
  const endedAt =
    now.getTime() > open.startedAt.getTime()
      ? now
      : new Date(open.startedAt.getTime() + 1);
  await tx
    .update(deviceTrainingPeriods)
    .set({ endedAt, endedBy: actorUserId })
    .where(eq(deviceTrainingPeriods.id, open.id));
  return true;
}

/**
 * Defense in depth behind requireAuth (legend-a6aq6). Since 1012, requireAuth
 * already refuses every marked session or shared-device token request on the
 * device routes (403 ACTING_STAFF_NOT_ALLOWED), for any device. This check
 * still refuses, with its own message, a session marked with the device or a
 * request carrying that device's own token that reaches the service anyway
 * (for example a mark whose session close failed after revoke or unflag): it must not switch
 * the guard off (disable shared mode or revoke the device): 403. Pass the
 * session's `sharedDeviceIds` and the request's resolved device id (null
 * without a device header).
 */
export function assertNotOwnSharedDevice(
  deviceId: string,
  sessionSharedDeviceIds: readonly string[] | null | undefined,
  requestDeviceId: string | null,
): void {
  if (
    sessionSharedDeviceIds?.includes(deviceId) ||
    requestDeviceId === deviceId
  )
    throw new HttpError(
      403,
      ACTING_STAFF_ERROR_CODES.SHARED_MODE_SELF_DISABLE,
      "Matikan mode perangkat bersama dari perangkat lain.",
    );
}

export async function revokeDevice(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { deviceId: string; reason: string },
  now: Date = new Date(),
): Promise<Device> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  let revoked = false;
  const result = await withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(devices)
      .where(eq(devices.id, input.deviceId))
      .for("update");
    if (!current || current.tenantId !== tenantId) throw notFound();
    assertOutletInScope(context.outletScope, current.outletId);
    if (current.status === "revoked") {
      // Idempotent, but still re-run the post-commit cleanup: an earlier
      // revoke may have committed and then failed before closing sessions.
      revoked = true;
      return toDevice(current);
    }
    const status: DeviceStatus = transitionDevice(current.status, "revoke");
    const [updated] = await tx
      .update(devices)
      .set({
        status,
        revokedAt: now,
        revokedBy: actorUserId,
        revokeReason: input.reason,
        trainingMode: false,
        updatedAt: dbClock,
      })
      .where(and(eq(devices.id, current.id), eq(devices.status, "active")))
      .returning();
    if (!updated)
      throw new CoreError("CONFLICT", "Perangkat berubah, coba lagi.");
    await closeTrainingPeriod(tx, current.id, actorUserId, now);
    // legend-4xai (Codex 159): a revoked printer must not stay bound to a
    // station. Same transaction, after the device row lock: createStation and
    // updateStation take the device FOR SHARE before writing the station, so
    // a bind in flight commits first and is cleared here. A station shares
    // its outlet with the device, so the caller's outlet RLS reaches it.
    const clearedStations = await tx
      .update(stations)
      .set({ printerDeviceId: null, updatedAt: now })
      .where(
        and(
          eq(stations.tenantId, tenantId),
          eq(stations.printerDeviceId, current.id),
        ),
      )
      .returning({ id: stations.id, outletId: stations.outletId });
    // Same event updateStation emits, so KDS and menu clients refresh the
    // cleared binding.
    for (const station of clearedStations)
      await appendMenuEvent(tx, context, menuUpdatedEvent, {
        aggregateId: station.id,
        actorUserId,
        payload: {
          entity: "station",
          entityId: station.id,
          operation: "updated",
        },
        affects: { kind: "outlet", outletId: station.outletId },
        now,
      });
    await recordAudit(
      {
        tenantId,
        outletId: current.outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "device.revoked",
        objectType: "device",
        objectId: current.id,
        reason: input.reason,
        before: { status: "active" },
        after: {
          status: "revoked",
          clearedStationIds: clearedStations.map((station) => station.id),
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    revoked = true;
    return toDevice(updated);
  });
  // legend-1024: after the commit, close the login sessions used on this
  // device and make open KDS screens re-resolve, so neither the cookie nor the
  // old tokens keep working as the login owner. Best effort: the registry
  // check already refuses the revoked device token on its own.
  if (revoked) {
    await closeSessionsOfSharedDevice(input.deviceId);
    recheckKdsSockets();
  }
  return result;
}

/**
 * Shared-device mode on/off (legend-f586w). Only flagged devices are guarded by
 * requireActingStaffOnSharedDevice. Revoked devices cannot change; same value
 * is a no-op without audit.
 */
export async function setDeviceSharedMode(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { deviceId: string; sharedMode: boolean },
): Promise<Device> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  let turnedOff = false;
  const result = await withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(devices)
      .where(eq(devices.id, input.deviceId))
      .for("update");
    if (!current || current.tenantId !== tenantId) throw notFound();
    assertOutletInScope(context.outletScope, current.outletId);
    if (current.status !== "active")
      throw new CoreError("CONFLICT", "Perangkat sudah dicabut.");
    if (input.sharedMode === true && current.type !== "pos")
      throw new CoreError(
        "CONFLICT",
        "Mode perangkat bersama hanya untuk perangkat POS.",
      );
    if (current.sharedMode === input.sharedMode) return toDevice(current);
    const [updated] = await tx
      .update(devices)
      .set({ sharedMode: input.sharedMode, updatedAt: dbClock })
      .where(and(eq(devices.id, current.id), eq(devices.status, "active")))
      .returning();
    if (!updated)
      throw new CoreError("CONFLICT", "Perangkat berubah, coba lagi.");
    await recordAudit(
      {
        tenantId,
        outletId: current.outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: input.sharedMode
          ? "device.shared_mode_enabled"
          : "device.shared_mode_disabled",
        objectType: "device",
        objectId: current.id,
        reason: null,
        before: { sharedMode: current.sharedMode },
        after: { sharedMode: input.sharedMode },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    turnedOff = current.sharedMode === true && input.sharedMode === false;
    return toDevice(updated);
  });
  // Shared mode switched off: close the login sessions used on this device and
  // make open KDS screens re-resolve (same cleanup as revokeDevice).
  if (turnedOff) {
    await closeSessionsOfSharedDevice(input.deviceId);
    recheckKdsSockets();
  }
  return result;
}

/**
 * Training mode on/off (F5 Mode Latihan). On opens a period, off closes it;
 * `devices.training_mode` mirrors the open period. Sales inside a period are
 * excluded from reports (device-training.ts). Revoked devices cannot change.
 */
export async function setDeviceTrainingMode(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { deviceId: string; trainingMode: boolean },
  now: Date = new Date(),
): Promise<Device> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(devices)
      .where(eq(devices.id, input.deviceId))
      .for("update");
    if (!current || current.tenantId !== tenantId) throw notFound();
    assertOutletInScope(context.outletScope, current.outletId);
    if (current.status !== "active")
      throw new CoreError("CONFLICT", "Perangkat sudah dicabut.");
    if (current.trainingMode === input.trainingMode) return toDevice(current);
    if (input.trainingMode)
      await tx.insert(deviceTrainingPeriods).values({
        tenantId,
        outletId: current.outletId,
        deviceId: current.id,
        startedAt: now,
        startedBy: actorUserId,
      });
    else await closeTrainingPeriod(tx, current.id, actorUserId, now);
    const [updated] = await tx
      .update(devices)
      .set({ trainingMode: input.trainingMode, updatedAt: dbClock })
      .where(and(eq(devices.id, current.id), eq(devices.status, "active")))
      .returning();
    if (!updated)
      throw new CoreError("CONFLICT", "Perangkat berubah, coba lagi.");
    await recordAudit(
      {
        tenantId,
        outletId: current.outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: input.trainingMode
          ? "device.training_started"
          : "device.training_ended",
        objectType: "device",
        objectId: current.id,
        reason: null,
        before: { trainingMode: current.trainingMode },
        after: { trainingMode: input.trainingMode },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toDevice(updated);
  });
}

export type ListOutletDevicesQuery = {
  outletId: string;
  type?: DeviceType;
  status?: DeviceStatus;
  cursor?: string;
  limit: number;
};

function parseListCursor(cursor: string): { at: Date; id: string } {
  let keys;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new CoreError("VALIDATION_ERROR", "Cursor tidak valid.");
  }
  const [at, id] = keys;
  const date = typeof at === "string" ? new Date(at) : null;
  if (
    keys.length !== 2 ||
    !date ||
    Number.isNaN(date.getTime()) ||
    typeof id !== "string" ||
    !uuidSchema.safeParse(id).success
  )
    throw new CoreError("VALIDATION_ERROR", "Cursor tidak valid.");
  return { at: date, id };
}

/** Keyset page of one outlet's devices (revoked included), oldest first. */
export async function listOutletDevices(
  context: ScopedTenantContext,
  query: ListOutletDevicesQuery,
): Promise<CursorPage<Device>> {
  assertTrustedScopedContext(context);
  const outletId = outletIdSchema.parse(query.outletId);
  assertOutletInScope(context.outletScope, outletId);
  const after = query.cursor ? parseListCursor(query.cursor) : null;
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.tenantId, context.tenant.tenantId),
          eq(devices.outletId, outletId),
          query.type ? eq(devices.type, query.type) : undefined,
          query.status ? eq(devices.status, query.status) : undefined,
          after
            ? or(
                gt(devices.createdAt, after.at),
                and(eq(devices.createdAt, after.at), gt(devices.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(devices.createdAt), asc(devices.id))
      .limit(query.limit + 1),
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map(toDevice),
    meta: {
      limit: query.limit,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id])
          : null,
    },
  };
}

/**
 * Heartbeat from the device itself. `context` is tenant-wide for the token's
 * tenant; `deviceId` comes from the verified token, never from the body. The
 * reported time is capped at `now` and never moves last_seen_at backwards;
 * a scanner `observedAt` ahead of `now` is clamped to `now` (a skewed device
 * clock must not stop the heartbeat, legend-40nvj).
 * Returns false (nothing updated) for an unknown or revoked device.
 */
export async function recordDeviceHeartbeat(
  context: ScopedTenantContext,
  deviceId: string,
  body: DeviceHeartbeatBody,
  now: Date,
): Promise<boolean> {
  assertTrustedScopedContext(context);
  const occurredAt = new Date(body.occurredAt);
  const scannerObservedAt = body.scanner
    ? new Date(
        Math.min(new Date(body.scanner.observedAt).getTime(), now.getTime()),
      )
    : null;
  const rows = await withTenant(db, context, (tx) =>
    tx
      .update(devices)
      .set({
        lastSeenAt: sql`GREATEST(${devices.lastSeenAt}, LEAST(${occurredAt.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz))`,
        version: body.version,
        capabilities: body.capabilities,
        // No `scanner` field: both columns stay as they are.
        ...(body.scanner && scannerObservedAt
          ? {
              scannerStatus: body.scanner.status,
              scannerObservedAt,
            }
          : {}),
        updatedAt: dbClock,
      })
      .where(
        and(
          eq(devices.id, deviceId),
          eq(devices.tenantId, context.tenant.tenantId),
          eq(devices.status, "active"),
          isNull(devices.revokedAt),
        ),
      )
      .returning({ id: devices.id }),
  );
  return rows.length > 0;
}

/**
 * Active devices of the outlet that never reported, or not within
 * DEVICE_OFFLINE_AFTER_SECONDS (EDG-05 alert source). Same rule as the shared
 * `isDeviceOffline`.
 */
export async function listOfflineDevices(
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<Device[]> {
  assertTrustedScopedContext(context);
  const outlet = outletIdSchema.parse(outletId);
  assertOutletInScope(context.outletScope, outlet);
  const cutoff = new Date(now.getTime() - DEVICE_OFFLINE_AFTER_SECONDS * 1000);
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.tenantId, context.tenant.tenantId),
          eq(devices.outletId, outlet),
          eq(devices.status, "active"),
          or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, cutoff)),
        ),
      )
      .orderBy(asc(devices.createdAt), asc(devices.id)),
  );
  return rows.map(toDevice);
}

/**
 * Scanner state of the outlet's KDS (legend-40nvj), from its live KDS devices:
 * not revoked and not `isDeviceOffline`, so a dead tablet never keeps a stale
 * "connected". Any connected -> connected; live devices that all reported
 * disconnected -> disconnected; no live device ever reported -> unknown. An
 * unknown outlet, or one of another tenant, answers 404.
 */
export async function getKitchenScannerStatus(
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<{ status: KitchenScannerStatus }> {
  assertTrustedScopedContext(context);
  const outlet = outletIdSchema.parse(outletId);
  assertOutletInScope(context.outletScope, outlet);
  const rows = await withTenant(db, context, async (tx) => {
    await outletBrandId(tx, outlet);
    return tx
      .select({
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        scannerStatus: devices.scannerStatus,
      })
      .from(devices)
      .where(
        and(
          eq(devices.tenantId, context.tenant.tenantId),
          eq(devices.outletId, outlet),
          eq(devices.type, "kds"),
          eq(devices.status, "active"),
          isNull(devices.revokedAt),
        ),
      );
  });
  const reported = rows.flatMap((row) =>
    isDeviceOffline(
      {
        status: row.status,
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      },
      now,
    ) || row.scannerStatus === null
      ? []
      : [row.scannerStatus],
  );
  if (reported.includes("connected")) return { status: "connected" };
  if (reported.length > 0) return { status: "disconnected" };
  return { status: "unknown" };
}

const heartbeatRefused = () =>
  new CoreError(
    "UNAUTHORIZED",
    "Hanya perangkat terdaftar yang dapat mengirim heartbeat.",
  );

/**
 * The tenant and device of a heartbeat, from the verified token alone. The
 * tenant resolver may have picked the domain context (source "domain") over the
 * device's, so `tenant.source` is not read; a resolved context only has to
 * agree with the token (same tenant, same brand when it pins one). On an edge
 * node the registry check also pins the node's outlet.
 */
async function heartbeatDevice(
  req: Request,
): Promise<{ tenant: TenantContext; deviceId: string }> {
  const raw = req.get(DEVICE_TOKEN_HEADER);
  const payload = raw ? verifyDeviceToken(raw) : null;
  if (payload === null) throw heartbeatRefused();
  const resolved = findTenantContext(req);
  if (resolved && resolved.tenantId !== payload.tenantId)
    throw new HttpError(
      403,
      "TENANT_MISMATCH",
      "Tenant does not match this device.",
    );
  if (
    resolved?.brandId != null &&
    payload.brandId !== null &&
    resolved.brandId !== payload.brandId
  )
    throw new HttpError(
      403,
      "TENANT_MISMATCH",
      "Tenant does not match this device.",
    );
  const runtime = getEdgeRuntimeState();
  if (runtime.edgeMode && !runtime.identity) throw heartbeatRefused();
  const identity = runtime.edgeMode ? runtime.identity : null;
  if (identity && identity.scope.tenantId !== payload.tenantId)
    throw heartbeatRefused();
  const device = await findActiveDeviceForToken(
    payload,
    identity ? { outletId: identity.scope.outletId } : undefined,
  );
  if (!device) throw heartbeatRefused();
  // legend-2lgu: only a NEW session is gated. A device that reported within
  // the live window keeps running through a hard-stale replica.
  const now = new Date();
  const hasLiveSession =
    device.lastSeenAt !== null &&
    now.getTime() - device.lastSeenAt.getTime() <=
      DEVICE_LIVE_SESSION_WINDOW_MS;
  if (!hasLiveSession) await assertDeviceRegistryFresh(now);
  return {
    tenant: establishTenantContext({
      tenantId: payload.tenantId,
      brandId: payload.brandId,
      source: "device",
    }),
    deviceId: device.id,
  };
}

/**
 * Device heartbeat (F5: every 30 s). Needs `jsonBody` before it; use
 * `deviceHeartbeatMiddleware` to get it with the tenant guard. The token is
 * checked here against the registry (active, tenant, rotation, outlet on the
 * edge); an update that touches no row is refused too.
 */
export const deviceHeartbeatHandler: RequestHandler = async (req, res) => {
  const { tenant, deviceId } = await heartbeatDevice(req);
  const body = deviceHeartbeatBodySchema.parse(req.body);
  const now = new Date();
  const recorded = await recordDeviceHeartbeat(
    tenantWideContext(tenant),
    deviceId,
    body,
    now,
  );
  if (!recorded)
    throw new CoreError("UNAUTHORIZED", "Perangkat tidak terdaftar.");
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ data: { deviceId, serverTime: now.toISOString() } });
};
