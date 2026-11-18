// Cloud side of the edge -> cloud `staff_pin.device_throttled` alert (bead
// legend-62jtd). The edge throttles a device after 10 wrong staff PINs in 5
// minutes (services/staff-pin-proof.service.ts). Its own notification table is
// not read by anyone, so the edge queues this event and the cloud notifies the
// outlet's supervisors here, idempotently (the notification consumer dedupes on
// the event id). The payload carries the device id only: never a PIN, hash,
// salt or token. The outlet comes from the verified node scope, so another
// tenant or outlet never receives it.
import { z } from "zod";
import { CoreError } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { notifyOutletSupervisors } from "../services/edge-sync-conflict-alert.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { registerEdgeEventHandler } from "./applier-registry.ts";
import { assertEdgeEventScope } from "./deferred-event-applier.ts";
import type { EdgeApplyMeta } from "./ports.ts";

export const STAFF_PIN_DEVICE_THROTTLED_EVENT = "staff_pin.device_throttled";

const payloadSchema = z.strictObject({
  deviceId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
});

// Same text the cloud writes for a device throttled on the cloud itself
// (staff-pin-proof.service.ts alertDeviceThrottled).
const TITLE = "Perangkat outlet dibatasi karena PIN salah";
const BODY =
  "Satu perangkat outlet salah memasukkan PIN 10 kali dalam 5 menit dan dibatasi sementara. Periksa perangkat itu; cabut tokennya bila mencurigakan.";

export async function applyStaffPinDeviceThrottled(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const payload = payloadSchema.safeParse(event.payload);
  if (
    !payload.success ||
    event.version !== 1 ||
    event.aggregateType !== "staff_pin" ||
    event.aggregateId !== event.id ||
    event.sequence !== 1
  )
    throw new CoreError("VALIDATION_ERROR", "Invalid staff pin throttle event");
  await notifyOutletSupervisors(
    tx,
    meta.context,
    {
      tenantId: meta.context.tenant.tenantId,
      outletId,
      id: event.id,
      eventName: event.name,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: { deviceId: payload.data.deviceId },
      title: TITLE,
      body: BODY,
    },
    new Date(event.occurredAt),
  );
}

/**
 * Cloud boot (registerEdgeLink). The `staff_pin` aggregate type is already
 * classified and sequence-checked by registerAccessEdgeApplier, so only the
 * event handler is added here.
 */
export function registerStaffPinAlertEdgeApplier(): void {
  registerEdgeEventHandler(
    "edge_to_cloud",
    STAFF_PIN_DEVICE_THROTTLED_EVENT,
    applyStaffPinDeviceThrottled,
  );
}
