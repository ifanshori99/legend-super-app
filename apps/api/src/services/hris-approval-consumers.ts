// `approval.resolved` consumer for HRIS leave and overtime requests (bead
// legend-hggk; PRD v1.7 §3 Kelompok D 29 "Cuti, Izin & Lembur", F7 "Kotak
// Approval"). Wired in worker-main.ts next to staff-override's
// `handleApprovalResolved`. Modelled on staff-override-consumers.ts.
//
// The approval service never writes another module's tables: it appends
// `approval.resolved` and the source module applies the effect in its own
// transaction. This consumer only reacts to chains this module opened
// (sourceModule `hris_leave` / `hris_overtime`) and delegates to the settle
// functions, which re-read the chain outcome from the database under the
// request row lock. The event payload is a trigger, never the authority.
//
// - Other event names and other source modules: ignored (not ours).
// - A `hris_*` event of the wrong shape, another tenant, no outlet, or whose
//   chain belongs to a different request: throws (outbox retries, then
//   dead-letters); nothing is written (fail closed).
// - Replay: settling a request that is no longer pending is a no-op.

import { approvalResolvedEvent } from "@starter/shared/identity";
import {
  CoreError,
  ulidSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { leaveRequests, overtimeRequests } from "../db/schema/hris-leave.ts";
import { withTenant } from "../db/tenant.ts";
import {
  HRIS_LEAVE_OBJECT_TYPE,
  HRIS_LEAVE_SOURCE_MODULE,
  settleLeaveRequest,
} from "./hris-leave-request.service.ts";
import { settleOvertimeRequest } from "./hris-overtime.service.ts";

/** Envelope as the worker hands it to `deliverEvent`. */
export type DomainEvent = EventEnvelope;

const HRIS_OVERTIME_SOURCE_MODULE = "hris_overtime";
const HRIS_OVERTIME_OBJECT_TYPE = "overtime_request";

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
 * Settles the leave or overtime request that owns the resolved chain.
 * Idempotent and replay safe; ignores other events and source modules.
 */
export async function handleHrisApprovalResolved(
  context: ScopedTenantContext,
  event: DomainEvent,
): Promise<void> {
  if (event.name !== approvalResolvedEvent.name) return;
  const sourceModule = sourceModuleOf(event);
  if (
    sourceModule !== HRIS_LEAVE_SOURCE_MODULE &&
    sourceModule !== HRIS_OVERTIME_SOURCE_MODULE
  )
    return;

  const parsed = approvalResolvedEvent.envelopeSchema.safeParse(event);
  if (!parsed.success)
    refuse(`approval.resolved for ${sourceModule} has an unknown shape`);
  const resolved = parsed.data;
  if (resolved.tenantId.toLowerCase() !== context.tenant.tenantId.toLowerCase())
    refuse("approval.resolved tenant does not match the worker context");
  const isLeave = sourceModule === HRIS_LEAVE_SOURCE_MODULE;
  if (
    resolved.payload.objectType !==
    (isLeave ? HRIS_LEAVE_OBJECT_TYPE : HRIS_OVERTIME_OBJECT_TYPE)
  )
    refuse(`approval.resolved for ${sourceModule} names another object type`);
  // Requests always belong to one outlet; settle on exactly that RLS scope so
  // another outlet's approval rows stay invisible (TEN-03).
  if (resolved.outletId === null)
    refuse(`approval.resolved for ${sourceModule} has no outlet`);
  const scoped = establishScopedTenantContext(context.tenant, {
    kind: "outlets",
    outletIds: [resolved.outletId],
  } as Parameters<typeof establishScopedTenantContext>[1]);
  const chainId = resolved.payload.chainId;

  // The chain must belong to the request the event names. A mismatch is
  // corrupt or forged input: refuse. No row: never recorded (rolled back) or
  // another outlet's: nothing of ours to settle.
  const owner = await withTenant(db, scoped, async (tx) => {
    const table = isLeave ? leaveRequests : overtimeRequests;
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.tenantId, context.tenant.tenantId),
          eq(table.approvalChainId, chainId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (owner === null) return;
  if (storedId(owner.id) !== storedId(resolved.payload.objectId))
    refuse(`approval.resolved chain belongs to another ${sourceModule} row`);

  if (isLeave) await settleLeaveRequest(scoped, owner.id);
  else await settleOvertimeRequest(scoped, owner.id);
}
