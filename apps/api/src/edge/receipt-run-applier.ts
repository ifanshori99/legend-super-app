// Cloud side of the edge -> cloud `receipt_run.reported` event (bead
// legend-zy43): an edge node reports one offline device receipt run and the
// cloud merges it with mergeDeviceReceiptRun (pos-receipt.service.ts) in the
// apply transaction. The merge is idempotent (a replay inserts nothing), so a
// redelivered event is safe.
//
// Fail closed like the other appliers: a wrong direction, tenant, outlet or
// node, a payload that does not parse, or a run that names another tenant,
// outlet or device throws a CoreError (4xx); the link records an
// `applier_refused` conflict (db-link-store.ts) instead of stalling the node.
// A merge refusal (PosError 4xx: RECEIPT_SEQUENCE_GAP, RECEIPT_SEQUENCE_NOT_
// PROVISIONED, prefix mismatch, regression, unmatched void) is refused the
// same way, never retried: the merge writes nothing on a refusal, and the
// device resends the full run (a later event) once the hole or the
// provisioning is fixed. Anything else (database failure) aborts the batch so
// the sender keeps it queued. The cloud apply writes no outbox event (it would
// echo back to the edge). Never logs payloads.
import { CoreError } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  PosError,
  RECEIPT_RUN_AGGREGATE,
  RECEIPT_RUN_REPORTED_EVENT,
  receiptRunReportedPayloadSchema,
} from "@starter/shared/pos";
import { mergeDeviceReceiptRun } from "../services/pos-receipt.service.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeAggregateLastSequence,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import type {
  EdgeEventHandler,
  EdgeLastSequenceHook,
} from "./applier-registry.ts";
import { assertEdgeEventScope } from "./deferred-event-applier.ts";
import type { EdgeApplyMeta } from "./ports.ts";

/**
 * Each report is a self-contained run (the device resends the full range), so
 * the link accepts any aggregate sequence, like the access applier does.
 */
const acceptIncomingSequence: EdgeLastSequenceHook = async (_tx, aggregate) =>
  aggregate.sequence === undefined ? null : aggregate.sequence - 1;

/** A merge refusal becomes a 4xx CoreError (a conflict row, not a stall). */
function refuseMerge(error: unknown): never {
  if (error instanceof PosError && error.status >= 400 && error.status < 500)
    throw new CoreError(
      error.status === 409 ? "CONFLICT" : "VALIDATION_ERROR",
      error.message,
    );
  throw error;
}

async function applyReceiptRunReported(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const parsed = receiptRunReportedPayloadSchema.safeParse(event.payload);
  if (!parsed.success)
    throw new CoreError("VALIDATION_ERROR", `Invalid ${event.name} payload`);
  const { sequence, receipts } = parsed.data;
  const tenantId = meta.context.tenant.tenantId;
  // The run must belong to the event's own tenant, outlet and device (the
  // aggregate id is the device id); nothing a payload says widens the scope.
  if (
    event.aggregateType !== RECEIPT_RUN_AGGREGATE ||
    event.aggregateId.toLowerCase() !== sequence.deviceId.toLowerCase() ||
    sequence.tenantId !== tenantId ||
    sequence.outletId !== outletId ||
    receipts.some(
      ({ receipt }) =>
        receipt.tenantId !== tenantId ||
        receipt.outletId !== outletId ||
        receipt.deviceId !== sequence.deviceId,
    )
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Receipt run does not match its event scope",
    );
  try {
    await mergeDeviceReceiptRun(tx, meta.context, {
      sequence: {
        outletId: sequence.outletId,
        deviceId: sequence.deviceId,
        prefix: sequence.prefix,
        lastNumber: sequence.lastNumber,
      },
      receipts: receipts.map(({ receipt, outletSnapshot }) => ({
        ...receipt,
        outletSnapshot,
      })),
    });
  } catch (error) {
    refuseMerge(error);
  }
}

// Stable identity: the registry treats a different handler as a wiring bug.
const handleReceiptRunReported: EdgeEventHandler = applyReceiptRunReported;

/**
 * Cloud boot (registerEdgeLink): applies `receipt_run.reported` from an edge
 * and classifies the `receipt_run` aggregate as append-only transaction
 * events. Idempotent.
 */
export function registerReceiptRunEdgeApplier(): void {
  registerEdgeEventHandler(
    "edge_to_cloud",
    RECEIPT_RUN_REPORTED_EVENT,
    handleReceiptRunReported,
  );
  registerEdgeAggregateKind(RECEIPT_RUN_AGGREGATE, "transaction_event");
  registerEdgeAggregateLastSequence(
    "edge_to_cloud",
    RECEIPT_RUN_AGGREGATE,
    acceptIncomingSequence,
  );
}
