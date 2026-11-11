// Control-plane event stream (legend-83ll / legend-fy5y, 488 items 4, 5, 9).
//
// Tenant lifecycle events and the platform-only `session.revoked` are written
// to the reserved sentinel tenant stream (CONTROL_PLANE_TENANT_ID) in the
// ordinary domain_event_outbox, atomically on the caller's transaction. The
// relay sweeps that stream on its own (worker-main `controlPlaneRelay`), so a
// suspended or archived subject tenant, which the registry view hides, no
// longer blocks its own events.
//
// - `control-plane` is routed: `deliverControlPlaneEvent` consumes it.
// - `control-plane-package` is parked: no consumer exists, the relay never
//   claims it, the row stays pending (fail closed) until a consumer is added.
// - The subject tenant of a lifecycle event is its `aggregateId`, never the
//   envelope `tenantId` (always the sentinel here).

import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertTrustedScopedContext,
  createUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CONTROL_PLANE_TENANT_ID,
  type DomainEventDefinition,
  type EventActor,
  type EventEnvelope,
} from "@starter/shared/events";
import { sessionRevokedEvent } from "@starter/shared/identity";
import { platformEvents } from "@starter/shared/platform";
import type * as schema from "../db/schema";
import { domainEventOutbox, session } from "../db/schema";
import { appendOutbox } from "./core-outbox";

type Database = NodePgDatabase<typeof schema>;
export type ControlPlaneTx = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/** Trusted server context of the control-plane stream (worker job source). */
export function controlPlaneContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: CONTROL_PLANE_TENANT_ID,
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );
}

/**
 * Run `run` with the transaction's RLS scope switched to the sentinel tenant,
 * then restore the caller's tenant and outlet scope. Same transaction, so the
 * domain change, its audit row and the event commit or roll back together. A
 * missed restore would make later tenant rows fail the RLS check loudly.
 */
export async function withControlPlaneScope<T>(
  tx: ControlPlaneTx,
  run: () => Promise<T>,
): Promise<T> {
  const saved = await tx.execute(
    sql`SELECT current_setting('app.tenant_id', true) AS tenant_id, current_setting('app.outlet_ids', true) AS outlet_ids`,
  );
  const previousTenant = String(saved.rows[0]?.tenant_id ?? "");
  const previousOutlets = String(saved.rows[0]?.outlet_ids ?? "");
  await tx.execute(
    sql`SELECT set_config('app.tenant_id', ${CONTROL_PLANE_TENANT_ID}, true), set_config('app.outlet_ids', '*', true)`,
  );
  try {
    return await run();
  } finally {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${previousTenant}, true), set_config('app.outlet_ids', ${previousOutlets}, true)`,
    );
  }
}

/** Next sequence of one aggregate stream per destination. The advisory lock
 * serializes two concurrent appends of the same stream until commit. */
async function nextControlPlaneSequence(
  tx: ControlPlaneTx,
  destination: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`control-outbox:${destination}:${aggregateType}:${aggregateId}`}))`,
  );
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, CONTROL_PLANE_TENANT_ID),
        eq(domainEventOutbox.destination, destination),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** Append a control-plane event on the caller's transaction. */
export async function appendControlPlaneEvent(
  tx: ControlPlaneTx,
  input: {
    definition: DomainEventDefinition;
    destination: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    actor: EventActor;
    now: Date;
  },
): Promise<void> {
  const { definition } = input;
  const aggregateType = definition.entry.aggregateType;
  await withControlPlaneScope(tx, async () => {
    const sequence = await nextControlPlaneSequence(
      tx,
      input.destination,
      aggregateType,
      input.aggregateId,
    );
    const event = definition.envelopeSchema.parse({
      id: createUlid(input.now.getTime()),
      tenantId: CONTROL_PLANE_TENANT_ID,
      outletId: null,
      name: definition.name,
      version: definition.version,
      aggregateType,
      aggregateId: input.aggregateId,
      sequence,
      occurredAt: input.now.toISOString(),
      actor: input.actor,
      deviceId: null,
      idempotencyKey: `${definition.name}:${input.aggregateId}:${sequence}`,
      payloadSchemaRef: definition.payloadSchemaRef,
      payload: input.payload,
    });
    await appendOutbox(tx, controlPlaneContext(), {
      id: createUlid(input.now.getTime()),
      event,
      destination: input.destination,
      direction: null,
      peerId: null,
    });
  });
}

/**
 * Consumer of the routed `control-plane` destination, run inside the
 * consumption transaction.
 * - `session.revoked` closes a platform session (idempotent: only a row with
 *   no tenant and no revocation is touched).
 * - `tenant.status_changed` is acknowledged only. Revoking the subject
 *   tenant's sessions is a CTO decision not taken here, so the event is
 *   delivered (no longer stuck pending) without side effects.
 * Any other name throws, so the outbox retries and dead-letters it instead of
 * acking something no consumer understood (`tenant.package_changed` is parked
 * on its own destination and never reaches this function).
 */
export async function deliverControlPlaneEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: ControlPlaneTx,
): Promise<void> {
  assertTrustedScopedContext(context);
  if (
    context.tenant.tenantId !== CONTROL_PLANE_TENANT_ID ||
    event.tenantId !== CONTROL_PLANE_TENANT_ID
  )
    throw new Error("Control-plane consumer requires the control-plane tenant");
  if (event.name === sessionRevokedEvent.name) {
    const payload = sessionRevokedEvent.envelopeSchema.parse(event).payload as {
      sessionId: string;
      userId: string;
    };
    await tx
      .update(session)
      .set({
        revokedAt: new Date(event.occurredAt),
        // Same shape as revokeOwnSession: expired at creation + 1 ms.
        expiresAt: sql`${session.createdAt} + interval '1 millisecond'`,
      })
      .where(
        and(
          eq(session.id, payload.sessionId),
          eq(session.userId, payload.userId),
          isNull(session.tenantId),
          isNull(session.revokedAt),
        ),
      );
    return;
  }
  if (event.name === "tenant.status_changed") {
    // Validates the envelope; acknowledges without side effects.
    platformEvents["tenant.status_changed"].envelopeSchema.parse(event);
    return;
  }
  throw new Error(`No control-plane consumer for ${event.name}`);
}
