// Identity events through the transactional outbox (legend-83ll).
//
// `session.revoked` is appended on the same tenant transaction that revokes the
// session row, to its own `identity` destination. The worker registers a
// consumer for that destination (`deliverIdentityEvent`), so the row is
// delivered and acked instead of dead-lettering. The sessions table is global
// (no RLS), so a session without a `tenant_id` (platform login) has no tenant
// stream and emits nothing.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  createUlid,
  type ScopedTenantContext,
  assertTrustedScopedContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  sessionRevokedEvent,
  type SessionRevocationReason,
} from "@starter/shared/identity";
import type * as schema from "../db/schema";
import { domainEventOutbox, session } from "../db/schema";
import { appendOutbox } from "./core-outbox";

type Database = NodePgDatabase<typeof schema>;
export type IdentityTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Own destination: the cloud-sync stream is the edge sync link, sessions are
 * cloud only. */
export const IDENTITY_DESTINATION = "identity";

/**
 * Next sequence of one session's stream. The advisory lock serializes two
 * concurrent revokes of the same session; it is released at commit.
 */
async function nextSessionSequence(
  tx: IdentityTx,
  tenantId: string,
  sessionId: string,
): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`identity-outbox:${tenantId}:session:${sessionId}`}))`,
  );
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, IDENTITY_DESTINATION),
        eq(domainEventOutbox.aggregateType, "session"),
        eq(domainEventOutbox.aggregateId, sessionId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** Append `session.revoked` on the caller's tenant transaction. */
export async function appendSessionRevoked(
  tx: IdentityTx,
  context: ScopedTenantContext,
  input: {
    sessionId: string;
    userId: string;
    cause: SessionRevocationReason;
    now: Date;
  },
): Promise<void> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const definition = sessionRevokedEvent;
  const sequence = await nextSessionSequence(tx, tenantId, input.sessionId);
  const eventId = createUlid(input.now.getTime());
  const event = definition.envelopeSchema.parse({
    id: eventId,
    tenantId,
    outletId: null,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.sessionId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor: { type: "user", id: input.userId },
    deviceId: null,
    idempotencyKey: `${definition.name}:${input.sessionId}:${sequence}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      sessionId: input.sessionId,
      userId: input.userId,
      cause: input.cause,
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: IDENTITY_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * Consumer of the `identity` destination, run inside the consumption
 * transaction. `session.revoked` makes sure the session row is closed: a
 * producer that only emitted the event cannot leave the session usable. It is
 * idempotent (a row already revoked is untouched), so a replay is a no-op.
 * Any other event name throws, so the outbox retries and dead-letters it
 * instead of acking something no consumer understood.
 */
export async function deliverIdentityEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: IdentityTx,
): Promise<void> {
  assertTrustedScopedContext(context);
  if (event.tenantId !== context.tenant.tenantId)
    throw new Error("Event tenant does not match context");
  if (event.name !== sessionRevokedEvent.name)
    throw new Error(`No identity consumer for ${event.name}`);
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
        eq(session.tenantId, event.tenantId),
        isNull(session.revokedAt),
      ),
    );
}
