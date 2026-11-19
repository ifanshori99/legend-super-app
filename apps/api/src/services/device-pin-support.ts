// Shared plumbing for the device pin and supervisor override services (bead
// legend-dxb): outlet membership, outlet-scoped contexts and the outbox
// append. Authorization decisions come from @starter/shared/access through
// permission-resolver.ts; nothing here re-implements the scope rules.

import { createHash } from "node:crypto";
import {
  isAssignmentActive,
  scopeCovers,
  type AccessTarget,
} from "@starter/shared/access";
import {
  createUlid,
  outletIdSchema,
  ulidSchema,
  ulidToUuid,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { and, eq, sql } from "drizzle-orm";
import { domainEventOutbox } from "../db/schema";
import { appendOutbox } from "./core-outbox";
import type { TenantAccessData, Tx } from "./permission-resolver";

/** Device/edge replication and source-module stream (same as other WS-01 services). */
export const DEVICE_PIN_EVENT_DESTINATION = "cloud-sync";

/** RLS scope of exactly one outlet, minted on the server (TEN-03). */
export function outletContext(
  tenant: TenantContext,
  outletId: string,
): ScopedTenantContext {
  return establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });
}

export function outletTarget(outletId: string): AccessTarget {
  return { type: "outlet", id: outletIdSchema.parse(outletId) };
}

/**
 * True when `userId` holds an active assignment (any role) reaching the
 * outlet: tenant, its brand, the outlet itself, or one of its stations (a
 * barista on a KDS station still switches in with a pin at that outlet).
 * Deny by default: no assignment, no membership.
 */
export function isOutletMember(
  tenant: TenantContext,
  userId: string,
  data: TenantAccessData,
  outletId: string,
  now: Date,
): boolean {
  // The DB clock of the load wins over the caller's `now` (bead 1201).
  const at = data.clock ?? now;
  const target = outletTarget(outletId);
  const wanted = outletId.toLowerCase();
  return data.assignments.some((row) => {
    if (
      row.tenantId.toLowerCase() !== tenant.tenantId.toLowerCase() ||
      row.userId.toLowerCase() !== userId.toLowerCase() ||
      !isAssignmentActive(row, at)
    )
      return false;
    if (row.scope.type === "station") {
      const stationId = row.scope.id.toLowerCase();
      return data.org.stations.some(
        (station) =>
          station.id.toLowerCase() === stationId &&
          station.outletId.toLowerCase() === wanted,
      );
    }
    return scopeCovers(row.scope, target, data.org);
  });
}

/**
 * Outlets the user belongs to through any active assignment, as an RLS
 * context: tenant-wide for a tenant assignment, else the reached outlets.
 * null = no membership (deny).
 */
export function membershipContext(
  tenant: TenantContext,
  userId: string,
  data: TenantAccessData,
  now: Date,
): ScopedTenantContext | null {
  const at = data.clock ?? now;
  const outlets = data.org.outlets.filter((outlet) =>
    isOutletMember(tenant, userId, data, outlet.id, at),
  );
  const tenantWide = data.assignments.some(
    (row) =>
      row.tenantId.toLowerCase() === tenant.tenantId.toLowerCase() &&
      row.userId.toLowerCase() === userId.toLowerCase() &&
      isAssignmentActive(row, at) &&
      row.scope.type === "tenant",
  );
  if (tenantWide)
    return establishScopedTenantContext(tenant, { kind: "tenant" });
  if (outlets.length === 0) return null;
  return establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: outlets.map((outlet) => outlet.id),
  });
}

type EventDefinition = {
  readonly name: string;
  readonly version: number;
  readonly payloadSchemaRef: string;
  readonly entry: { readonly aggregateType: string };
  readonly envelopeSchema: { parse(value: unknown): unknown };
};

export type EventActor =
  { readonly type: "user"; readonly id: string } | { readonly type: "system" };

function storedAggregateId(aggregateId: string): string {
  return ulidSchema.safeParse(aggregateId).success
    ? ulidToUuid(aggregateId)
    : aggregateId.toLowerCase();
}

/**
 * Appends one domain event in the caller's transaction (transactional
 * outbox). The caller holds the aggregate's row lock, which serialises the
 * per-aggregate sequence.
 */
export async function appendDevicePinEvent(
  tx: Tx,
  context: ScopedTenantContext,
  definition: EventDefinition,
  input: {
    readonly aggregateId: string;
    readonly outletId: string;
    readonly actor: EventActor;
    readonly deviceId: string | null;
    readonly payload: Record<string, unknown>;
    readonly now: Date;
  },
): Promise<void> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, context.tenant.tenantId),
        eq(domainEventOutbox.destination, DEVICE_PIN_EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, definition.entry.aggregateType),
        eq(domainEventOutbox.aggregateId, storedAggregateId(input.aggregateId)),
      ),
    );
  const sequence = Number(row?.last ?? 0) + 1;
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor: input.actor,
    deviceId: input.deviceId,
    idempotencyKey: `${definition.name}:${input.aggregateId}:${sequence}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: DEVICE_PIN_EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/** The fields a POS override request is fingerprinted by. */
export type PosOverrideFingerprintFields = {
  readonly requestedBy: string;
  readonly outletId: string;
  readonly action: string;
  readonly valueIdr: number;
  readonly reason: string;
  readonly reasonCode: string | null;
  readonly objectType: string;
  readonly objectId: string;
  readonly method: string;
  readonly approverUserId: string | null;
};

/**
 * Request fingerprint of a POS override (legend-fjwxo). A PIN approval typed on
 * a verified device is bound to it: `deviceId` is part of the hash, so a replay
 * from another device is IDEMPOTENCY_KEY_REUSED and consumption can re-derive
 * the fingerprint from the stored row and the caller's device. No device = the
 * legacy fingerprint (unbound approval, unchanged for stored rows).
 */
export function posOverrideFingerprint(
  fields: PosOverrideFingerprintFields,
  deviceId: string | null,
): string {
  const normalized = {
    requestedBy: fields.requestedBy.toLowerCase(),
    outletId: fields.outletId.toLowerCase(),
    action: fields.action,
    valueIdr: fields.valueIdr,
    reason: fields.reason,
    reasonCode: fields.reasonCode,
    objectType: fields.objectType,
    objectId: fields.objectId.toLowerCase(),
    method: fields.method,
    approverUserId: fields.approverUserId?.toLowerCase() ?? null,
  };
  return createHash("sha256")
    .update(
      JSON.stringify(
        deviceId === null
          ? normalized
          : { ...normalized, deviceId: deviceId.toLowerCase() },
      ),
    )
    .digest("hex");
}

/** The stored override columns the device binding is derived from. */
export type PosOverrideDeviceBindRow = {
  readonly requestedBy: string;
  readonly outletId: string;
  readonly action: string;
  readonly valueIdr: number;
  readonly reason: string;
  readonly reasonCode: string | null;
  readonly objectType: string;
  readonly objectId: string;
  readonly method: string;
  readonly approvedBy: string | null;
  readonly requestFingerprint: string;
};

/**
 * Whether `deviceId` (the verified device the caller acts from, null: none) may
 * use a stored override (legend-fjwxo). Only a PIN approval is bound: the
 * device is part of its stored fingerprint, so it is re-derived from the row.
 * An approval made with no device stays usable as before; one made on a device
 * is refused for any other device and for a caller naming none. Shared by every
 * consumer of a `cash_shift_close` / void / discount approval.
 */
export function posOverrideUsableFromDevice(
  override: PosOverrideDeviceBindRow,
  deviceId: string | null,
): boolean {
  if (override.method !== "supervisor_pin") return true;
  const fields = {
    requestedBy: override.requestedBy,
    outletId: override.outletId,
    action: override.action,
    valueIdr: override.valueIdr,
    reason: override.reason,
    reasonCode: override.reasonCode,
    objectType: override.objectType,
    objectId: override.objectId,
    method: override.method,
    approverUserId: override.approvedBy,
  };
  if (posOverrideFingerprint(fields, null) === override.requestFingerprint)
    return true;
  return (
    deviceId !== null &&
    posOverrideFingerprint(fields, deviceId) === override.requestFingerprint
  );
}
