import type { z } from "../core/index.ts";
import type {
  eventEnvelopeSchema,
  outboxRowSchema,
  syncCheckpointSchema,
} from "./schemas.ts";

export const eventFixture = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  name: "order.paid",
  version: 1,
  aggregateType: "order",
  aggregateId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  sequence: 2,
  occurredAt: "2026-11-01T12:00:00.000Z",
  actor: { type: "user", id: "33333333-3333-4333-8333-333333333333" },
  idempotencyKey: "order-paid-001",
  payloadSchemaRef: "order.paid.v1",
  payload: { totalIdr: 90000, receiptNumber: "LG-001" },
} satisfies z.input<typeof eventEnvelopeSchema>;
export const outboxFixture = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  event: eventFixture,
  direction: "edge_to_cloud",
  destination: "cloud-sync",
  peerId: "44444444-4444-4444-8444-444444444444",
  status: "pending",
  attempts: 0,
  availableAt: "2026-11-01T12:00:00.000Z",
  leaseOwner: null,
  leaseUntil: null,
  deliveredAt: null,
  createdAt: "2026-11-01T12:00:00.000Z",
} satisfies z.input<typeof outboxRowSchema>;
export const syncCheckpointFixture = {
  tenantId: eventFixture.tenantId,
  outletId: eventFixture.outletId,
  peerId: outboxFixture.peerId,
  direction: "edge_to_cloud",
  cursor: "edge-position-42",
  lastEventId: eventFixture.id,
  updatedAt: "2026-11-01T12:01:00.000Z",
} satisfies z.input<typeof syncCheckpointSchema>;
