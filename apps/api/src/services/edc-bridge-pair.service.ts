// EDC bridge pairing codes (B4 legend-wasr7.24; schema db/schema/edc-bridge-pair.ts,
// migration 0543). Backoffice gets an 8-character code, never the device
// token; the tablet trades the code once at POST /api/edc-bridge/pair.
//
// - Issue (`issueEdcBridgePairCodeTx`, inside the device service's tenant
//   transaction): the device row is locked, its live code cancelled, a new one
//   stored as selector (first 4 characters) + keyed HMAC of the whole code.
//   The code is answered once and never logged or audited.
// - Redeem: a per-IP slot first (5 wrong codes per 15 minutes, in the
//   database: survives a restart, shared by every instance), then the
//   SECURITY DEFINER lookup by selector + hash, which also counts a wrong code
//   against the live code of that selector (locked at 5). The hit is re-read
//   under tenant RLS with the device row and then the code row locked (same
//   lock order as issue), the hash compared in constant time, the code marked
//   used and the device token replaced in one transaction: of two parallel
//   redeems only one sees the code unused. Wrong, expired, used, cancelled and
//   locked codes all get the same answer.
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { createUlid, type ScopedTenantContext } from "@starter/shared/core";
import {
  EDC_BRIDGE_PAIRING_CODE_ALPHABET,
  EDC_BRIDGE_PAIRING_CODE_TTL_MS,
  EDC_BRIDGE_PAIRING_IP_WINDOW_MS,
  EDC_BRIDGE_PAIRING_MAX_ATTEMPTS,
} from "@starter/shared/edc/bridge";
import type {
  EdcBridgePairCode,
  PairEdcBridgeInput,
  PairedEdcBridgeDevice,
} from "@starter/shared/edc/bridge-devices";
import { db } from "../db/index.ts";
import {
  edcBridgeDevices,
  edcBridgePairCodes,
  type EdcBridgeDeviceRow,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getCloudEdcRuntime,
  hashEdcBridgeToken,
  tenantWideContext,
} from "../edge/edc/cloud-runtime.ts";
import { identityDigest } from "../lib/identity-digest.ts";
import { recordAudit } from "./core-audit.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A new device token: `edcb_<device ULID>_<32 random bytes base64url>`. */
export const newEdcBridgeDeviceToken = (deviceId: string) =>
  `edcb_${deviceId}_${randomBytes(32).toString("base64url")}`;

/** 8 characters of the unambiguous alphabet, each from crypto `randomInt`. */
export function newEdcBridgePairCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1)
    code +=
      EDC_BRIDGE_PAIRING_CODE_ALPHABET[
        randomInt(EDC_BRIDGE_PAIRING_CODE_ALPHABET.length)
      ];
  return code;
}

/** Keyed HMAC-SHA-256 hex of a (normalised, upper-case) pairing code. */
export const edcBridgePairCodeDigest = (code: string) =>
  identityDigest("edc-pair-code", code);

const selectorOf = (code: string) => code.slice(0, 4);

/**
 * Cancels the device's live code and stores a new one. Runs inside the
 * caller's tenant transaction after the permission check. Locks the device
 * row so two issues for one device cannot both insert a live code.
 */
export async function issueEdcBridgePairCodeTx(
  tx: Tx,
  ctx: ScopedTenantContext,
  actor: string,
  device: EdcBridgeDeviceRow,
): Promise<EdcBridgePairCode> {
  await tx
    .select({ id: edcBridgeDevices.id })
    .from(edcBridgeDevices)
    .where(
      and(
        eq(edcBridgeDevices.tenantId, ctx.tenant.tenantId),
        eq(edcBridgeDevices.id, device.id),
      ),
    )
    .for("update");
  const now = new Date();
  await tx
    .update(edcBridgePairCodes)
    .set({ revokedAt: now })
    .where(
      and(
        eq(edcBridgePairCodes.tenantId, ctx.tenant.tenantId),
        eq(edcBridgePairCodes.deviceId, device.id),
        isNull(edcBridgePairCodes.usedAt),
        isNull(edcBridgePairCodes.revokedAt),
      ),
    );
  const code = newEdcBridgePairCode();
  const expiresAt = new Date(now.getTime() + EDC_BRIDGE_PAIRING_CODE_TTL_MS);
  await tx.insert(edcBridgePairCodes).values({
    tenantId: ctx.tenant.tenantId,
    outletId: device.outletId,
    deviceId: device.id,
    codeSelector: selectorOf(code),
    codeHash: edcBridgePairCodeDigest(code),
    expiresAt,
    createdBy: actor,
  });
  return { code, expiresAt: expiresAt.toISOString() };
}

/** Revocation of a device also cancels its live code. */
export async function cancelEdcBridgePairCodesTx(
  tx: Tx,
  ctx: ScopedTenantContext,
  deviceId: string,
) {
  await tx
    .update(edcBridgePairCodes)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(edcBridgePairCodes.tenantId, ctx.tenant.tenantId),
        eq(edcBridgePairCodes.deviceId, deviceId),
        isNull(edcBridgePairCodes.usedAt),
        isNull(edcBridgePairCodes.revokedAt),
      ),
    );
}

export type EdcBridgePairOutcome =
  | { kind: "paired"; data: PairedEdcBridgeDevice }
  | { kind: "invalid" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

async function consume(
  code: string,
): Promise<(PairedEdcBridgeDevice & { tenantId: string }) | null> {
  const hash = edcBridgePairCodeDigest(code);
  const resolved = await db.execute<{ id: string; tenant_id: string }>(
    sql`SELECT id, tenant_id FROM app.edc_bridge_pair_resolve_code(${selectorOf(code)}, ${hash})`,
  );
  const hit = resolved.rows[0];
  if (!hit) return null;
  const ctx = tenantWideContext(hit.tenant_id);
  const tenantId = ctx.tenant.tenantId;
  return withTenant(db, ctx, async (tx) => {
    const [named] = await tx
      .select({
        deviceId: edcBridgePairCodes.deviceId,
        outletId: edcBridgePairCodes.outletId,
      })
      .from(edcBridgePairCodes)
      .where(
        and(
          eq(edcBridgePairCodes.tenantId, tenantId),
          eq(edcBridgePairCodes.id, hit.id),
        ),
      )
      .limit(1);
    if (!named) return null;
    // Device first, then the code: the lock order of issue.
    const [device] = await tx
      .select({ id: edcBridgeDevices.id, outletId: edcBridgeDevices.outletId })
      .from(edcBridgeDevices)
      .where(
        and(
          eq(edcBridgeDevices.tenantId, tenantId),
          eq(edcBridgeDevices.outletId, named.outletId),
          eq(edcBridgeDevices.id, named.deviceId),
          isNull(edcBridgeDevices.revokedAt),
        ),
      )
      .for("update");
    if (!device) return null;
    const [row] = await tx
      .select({
        id: edcBridgePairCodes.id,
        codeHash: edcBridgePairCodes.codeHash,
      })
      .from(edcBridgePairCodes)
      .where(
        and(
          eq(edcBridgePairCodes.tenantId, tenantId),
          eq(edcBridgePairCodes.id, hit.id),
          eq(edcBridgePairCodes.deviceId, device.id),
          isNull(edcBridgePairCodes.usedAt),
          isNull(edcBridgePairCodes.revokedAt),
          gt(edcBridgePairCodes.expiresAt, sql`now()`),
          lt(
            edcBridgePairCodes.failedAttempts,
            EDC_BRIDGE_PAIRING_MAX_ATTEMPTS,
          ),
        ),
      )
      .for("update");
    if (
      !row ||
      !timingSafeEqual(
        Buffer.from(row.codeHash, "hex"),
        Buffer.from(hash, "hex"),
      )
    )
      return null;
    const token = newEdcBridgeDeviceToken(device.id);
    const now = new Date();
    await tx
      .update(edcBridgePairCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(edcBridgePairCodes.tenantId, tenantId),
          eq(edcBridgePairCodes.id, row.id),
        ),
      );
    await tx
      .update(edcBridgeDevices)
      .set({ tokenHash: hashEdcBridgeToken(token) })
      .where(
        and(
          eq(edcBridgeDevices.tenantId, tenantId),
          eq(edcBridgeDevices.id, device.id),
        ),
      );
    // Neither the code nor the token (nor their hashes) is audited.
    await recordAudit(
      tx,
      ctx,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: device.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "edc_bridge_device.paired",
        objectType: "edc_bridge_device",
        objectId: device.id,
        reason: null,
        maskedChanges: { before: null, after: { paired: true } },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      ["paired"],
    );
    return { tenantId, deviceId: device.id, token };
  });
}

/**
 * POST /api/edc-bridge/pair. `ipDigest` is `clientIpDigest(req.ip)`. A right
 * code gives its IP slot back; anything else keeps it.
 */
export async function redeemEdcBridgePairCode(
  input: PairEdcBridgeInput,
  ipDigest: string,
): Promise<EdcBridgePairOutcome> {
  const slots = await db.execute<{
    slot_id: string | null;
    retry_after_seconds: number | null;
  }>(
    sql`SELECT slot_id, retry_after_seconds FROM app.edc_bridge_pair_take_ip_slot(${ipDigest}, ${EDC_BRIDGE_PAIRING_MAX_ATTEMPTS}, ${EDC_BRIDGE_PAIRING_IP_WINDOW_MS / 1000})`,
  );
  const slot = slots.rows[0];
  if (!slot?.slot_id)
    return {
      kind: "rate_limited",
      retryAfterSeconds: Math.max(1, Number(slot?.retry_after_seconds ?? 1)),
    };
  const paired = await consume(input.code);
  if (!paired) return { kind: "invalid" };
  await db.execute(
    sql`SELECT app.edc_bridge_pair_release_ip_slot(${slot.slot_id})`,
  );
  // A tablet still connected with the replaced token is told and closed.
  getCloudEdcRuntime()?.revoked(paired.tenantId, paired.deviceId);
  return {
    kind: "paired",
    data: { deviceId: paired.deviceId, token: paired.token },
  };
}
