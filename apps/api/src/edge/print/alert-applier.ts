import { z } from "zod";
import { CoreError } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { messagesId } from "@starter/shared/i18n";
import { notifyOutletSupervisors } from "../../services/edge-sync-conflict-alert.ts";
import type { EdgeTx } from "../../services/edge-queue.service.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
} from "../applier-registry.ts";
import { assertEdgeEventScope } from "../deferred-event-applier.ts";
import type { EdgeApplyMeta } from "../ports.ts";

const payloadSchema = z.strictObject({
  kind: z.enum(["printer_offline", "job_failed", "kds_down"]),
  subjectId: z
    .string()
    .regex(
      /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    ),
});

export async function applyPrintAlertRaised(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const payload = payloadSchema.safeParse(event.payload);
  if (
    !payload.success ||
    event.version !== 1 ||
    event.aggregateType !== "print_alert" ||
    event.aggregateId !== event.id ||
    event.sequence !== 1
  )
    throw new CoreError("VALIDATION_ERROR", "Invalid print alert event");
  const copy = messagesId.deviceRegistry.printAlerts[payload.data.kind];
  await notifyOutletSupervisors(
    tx,
    meta.context,
    {
      tenantId: meta.context.tenant.tenantId,
      outletId,
      id: event.id,
      category: "printer_offline",
      eventName: event.name,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: payload.data,
      title: copy.title,
      body: copy.body,
    },
    new Date(event.occurredAt),
  );
}

export function registerPrintAlertEdgeApplier(): void {
  registerEdgeEventHandler(
    "edge_to_cloud",
    "print_alert.raised",
    applyPrintAlertRaised,
  );
  registerEdgeAggregateKind("print_alert", "transaction_event");
}
