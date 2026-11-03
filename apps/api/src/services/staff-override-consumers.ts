// `approval.resolved` consumer for POS supervisor overrides approved from the
// supervisor's phone (bead legend-obh5, from legend-dxb; PRD v1.7 §3 F6
// "Override Supervisor", §3 F7 "Kotak Approval", AUTH-06). Wired in
// worker-main.ts before the deployment's own `deliverEvent`, next to
// `handlePaymentPaid`.
//
// The approval service never writes another module's tables: it appends
// `approval.resolved` and the source module applies the effect in its own
// transaction. This consumer only reacts to chains this module opened
// (sourceModule `pos_override`, objectType `pos_override`) and delegates to
// `settlePosOverrideForApproval`, which re-reads the chain outcome and the
// final approver from the database under the override's row lock. The event
// payload is a trigger, never the authority: a forged or stale event claiming
// "approved" cannot approve a chain that the database still has pending, and
// the approver is re-checked there (requester != approver, override
// permission on the outlet — AUTH-06, fail closed).
//
// - Other event names and other source modules: ignored (not ours).
// - A `pos_override` event of the wrong shape, another tenant, no outlet, or
//   whose chain belongs to a different override: throws, so the outbox retries
//   and finally dead-letters it for an operator. Nothing is written (fail
//   closed); a pending override stays pending and blocks the action.
// - Replay: settling an override that is no longer pending returns it
//   unchanged, so a redelivered event records nothing twice.

import { approvalResolvedEvent } from "@starter/shared/identity";
import {
  CoreError,
  ulidSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { posOverrides } from "../db/schema/device-pin.ts";
import { withTenant } from "../db/tenant.ts";
import { outletContext } from "./device-pin-support.ts";
import {
  POS_OVERRIDE_SOURCE_MODULE,
  settlePosOverrideForApproval,
} from "./staff-override.service.ts";

/** Envelope as the worker hands it to `deliverEvent`. */
export type DomainEvent = EventEnvelope;

/** objectType the override service opens its approval requests with. */
const POS_OVERRIDE_OBJECT_TYPE = "pos_override";

function sourceModuleOf(event: DomainEvent): unknown {
  const payload: unknown = event.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>).sourceModule
    : undefined;
}

/** ULID or UUID spelling of one id, compared in its stored (uuid) form. */
function storedId(id: string): string {
  return ulidSchema.safeParse(id).success
    ? ulidToUuid(id).toLowerCase()
    : id.toLowerCase();
}

function refuse(message: string): never {
  // No payload, ids only in the message the outbox stores as lastError.
  throw new CoreError("VALIDATION_ERROR", message);
}

/**
 * Settles the phone-approved POS override that owns the resolved chain.
 * Idempotent and replay safe; ignores other events and source modules; throws
 * (no write) on a malformed or foreign `pos_override` event.
 */
export async function handleApprovalResolved(
  context: ScopedTenantContext,
  event: DomainEvent,
  now: Date = new Date(),
): Promise<void> {
  if (event.name !== approvalResolvedEvent.name) return;
  if (sourceModuleOf(event) !== POS_OVERRIDE_SOURCE_MODULE) return;

  const parsed = approvalResolvedEvent.envelopeSchema.safeParse(event);
  if (!parsed.success)
    refuse("approval.resolved for pos_override has an unknown shape");
  const resolved = parsed.data;
  if (resolved.tenantId.toLowerCase() !== context.tenant.tenantId.toLowerCase())
    refuse("approval.resolved tenant does not match the worker context");
  if (resolved.payload.objectType !== POS_OVERRIDE_OBJECT_TYPE)
    refuse("approval.resolved for pos_override names another object type");
  // A POS override always belongs to one outlet; settle on exactly that RLS
  // scope so an override of another outlet stays invisible (TEN-03).
  if (resolved.outletId === null)
    refuse("approval.resolved for pos_override has no outlet");
  const scoped = outletContext(context.tenant, resolved.outletId);
  const chainId = resolved.payload.chainId;

  // The chain must belong to the override the event names (unique index on
  // approval_request_id). A mismatch is corrupt or forged input: refuse.
  const owner = await withTenant(db, scoped, async (tx) => {
    const [row] = await tx
      .select({ id: posOverrides.id })
      .from(posOverrides)
      .where(
        and(
          eq(posOverrides.tenantId, context.tenant.tenantId),
          eq(posOverrides.approvalRequestId, chainId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  // The override was never recorded (its opening transaction rolled back) or
  // lives at another outlet: nothing of ours to settle.
  if (owner === null) return;
  if (storedId(owner.id) !== storedId(resolved.payload.objectId))
    refuse("approval.resolved chain belongs to another override");

  await settlePosOverrideForApproval(scoped, chainId, now);
}
