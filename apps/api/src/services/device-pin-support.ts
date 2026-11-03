// Shared plumbing for the device pin and supervisor override services (bead
// legend-dxb): outlet membership, outlet-scoped contexts and the outbox
// append. Authorization decisions come from @starter/shared/access through
// permission-resolver.ts; nothing here re-implements the scope rules.

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
  const target = outletTarget(outletId);
  const wanted = outletId.toLowerCase();
  return data.assignments.some((row) => {
    if (
      row.tenantId.toLowerCase() !== tenant.tenantId.toLowerCase() ||
      row.userId.toLowerCase() !== userId.toLowerCase() ||
      !isAssignmentActive(row, now)
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
  const outlets = data.org.outlets.filter((outlet) =>
    isOutletMember(tenant, userId, data, outlet.id, now),
  );
  const tenantWide = data.assignments.some(
    (row) =>
      row.tenantId.toLowerCase() === tenant.tenantId.toLowerCase() &&
      row.userId.toLowerCase() === userId.toLowerCase() &&
      isAssignmentActive(row, now) &&
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
