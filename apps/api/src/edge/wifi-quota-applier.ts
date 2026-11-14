// Edge side of the cloud -> edge Wi-Fi quota forwarding (bead legend-xk7az;
// PRD v1.7 §3 F25, FAC-12/FAC-13). The cloud queues `wifi_quota.updated`
// (edge/wifi-quota-forwarding.ts). Receiving it only VALIDATES the event and
// writes it to the local queue `wifi_quota_apply_queue` (bead legend-oeqme);
// the worker (edge/wifi-quota-queue-worker.ts) pushes it to the controller
// through the edge Wi-Fi agent outside the receive transaction. The agent or
// the controller being down (503, timeouts) therefore never rolls the receive
// back, never holds the outlet link and never delays the orders behind it.
//
// Ordering and replays: the aggregate is classified `master_data` (full state,
// absolute quota), so the link applies only a sequence newer than the last one
// it holds. A replay or an older event is skipped before it reaches this
// function: it can never lower a quota that a newer event raised. A newer
// event of the same Wi-Fi session supersedes the older ones still queued.
//
// What is decided where:
//   - Receive (here): malformed or foreign events are a domain refusal
//     (CoreError 4xx): the link records an `applier_refused` conflict and goes
//     on. Everything else about the controller is the worker's business.
//   - Worker: no live grant (the device is not connected here, the guest's own
//     start call applies the current quota), retry with backoff on not-ready /
//     in-flight, final refusal and exhausted attempts as `applier_refused`
//     conflict (see wifi-quota-queue-worker.ts).
//   - Edge offline: the cloud queue holds the events; the cursor resumes in
//     order when the link is back.
import { and, eq, lt } from "drizzle-orm";
import { CoreError, type OutletId } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  wifiQuotaUpdatedEdgePayloadSchema,
  wifiQuotaUpdatedEvent,
} from "@starter/shared/facility";
import { wifiQuotaApplyQueue } from "../db/schema/index.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import type { EdgeApplyMeta } from "./ports.ts";

/** Queues one forwarded quota change for the controller push. */
export async function applyWifiQuotaUpdated(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const tenantId = meta.context.tenant.tenantId;
  if (meta.direction !== "cloud_to_edge")
    throw new CoreError(
      "FORBIDDEN",
      "wifi_quota.updated only travels cloud to edge",
    );
  if (event.tenantId !== tenantId)
    throw new CoreError("FORBIDDEN", "Event tenant does not match the context");
  if (!event.outletId)
    throw new CoreError("VALIDATION_ERROR", "Event has no outlet");
  const payload = wifiQuotaUpdatedEdgePayloadSchema.parse(event.payload);
  const { sessionId, fullSpeedKbps, baseSpeedKbps, sessionEndsAt } = payload;
  if (
    sessionId === null ||
    fullSpeedKbps === undefined ||
    baseSpeedKbps === undefined ||
    sessionEndsAt === undefined
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Event lacks the session or the speeds the edge needs",
    );
  if (event.aggregateId !== sessionId)
    throw new CoreError("VALIDATION_ERROR", "Event does not match its session");
  const outletId = event.outletId as OutletId;

  // Replay guard: (tenant, event id). The link already skips a received
  // event; this keeps the queue idempotent on its own.
  const inserted = await tx
    .insert(wifiQuotaApplyQueue)
    .values({
      tenantId,
      outletId,
      eventId: event.id,
      wifiSessionId: sessionId,
      aggregateSequence: event.sequence,
      event: { ...event, payload },
    })
    .onConflictDoNothing()
    .returning({ id: wifiQuotaApplyQueue.id });
  if (inserted.length === 0) return;
  // Full state: the older changes of this session that never reached the
  // controller are obsolete, applying them first would only add noise.
  await tx
    .update(wifiQuotaApplyQueue)
    .set({ status: "superseded", doneAt: new Date() })
    .where(
      and(
        eq(wifiQuotaApplyQueue.tenantId, tenantId),
        eq(wifiQuotaApplyQueue.outletId, outletId),
        eq(wifiQuotaApplyQueue.wifiSessionId, sessionId),
        eq(wifiQuotaApplyQueue.status, "pending"),
        lt(wifiQuotaApplyQueue.aggregateSequence, event.sequence),
      ),
    );
}

/**
 * Registers `wifi_quota.updated` on the cloud_to_edge dispatcher and
 * classifies its aggregate as full-state master data (receiver side, edge
 * boot; applier-registry.ts). Idempotent.
 */
export function registerWifiQuotaEdgeApplier(): void {
  registerEdgeEventHandler(
    "cloud_to_edge",
    wifiQuotaUpdatedEvent.name,
    applyWifiQuotaUpdated,
  );
  registerEdgeAggregateKind(
    wifiQuotaUpdatedEvent.entry.aggregateType,
    "master_data",
  );
}
