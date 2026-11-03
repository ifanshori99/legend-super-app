import { expect, it, vi } from "vitest";
import { tenantIdSchema, ulidSchema } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createProductionWorkerConfig } from "../worker/production-config.ts";

const tenantId = tenantIdSchema.parse("11111111-1111-4111-8111-111111111111");
const otherTenantId = tenantIdSchema.parse(
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
);
const event = eventEnvelopeSchema.parse({
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  tenantId,
  outletId: null,
  name: "order.paid",
  version: 1,
  aggregateType: "order",
  aggregateId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  sequence: 1,
  occurredAt: "2026-11-01T12:00:00.000Z",
  actor: { type: "system" },
  idempotencyKey: "event-1",
  payloadSchemaRef: "order.paid.v1",
  payload: {},
});

it("legend-fzkl binds worker jobs and events to their trusted tenant", async () => {
  const transport = {
    deliverEvent: vi.fn(async () => {}),
    requestMissing: vi.fn(async () => {}),
  };
  const config = createProductionWorkerConfig(transport);
  const context = await config.resolveContext(tenantId);
  const other = await config.resolveContext(otherTenantId);
  const job = {
    tenantId,
    outboxId: ulidSchema.parse("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    generation: 0,
  };
  expect(await config.authorize(context, job)).toBe(true);
  expect(await config.authorize(other, job)).toBe(false);
  expect(await config.authorizeEvent(context, event)).toBe(true);
  expect(await config.authorizeEvent(other, event)).toBe(false);
  await expect(
    config.authorize({ ...context, tenant: { ...context.tenant } }, job),
  ).rejects.toThrow("Untrusted");
  await expect(
    config.deliverEvent(other, event, event.id, {} as never),
  ).rejects.toThrow("tenant mismatch");
  expect(transport.deliverEvent).not.toHaveBeenCalled();
});

it("legend-fzkl requires a durable transport and delegates gaps", async () => {
  expect(() => createProductionWorkerConfig({} as never)).toThrow("transport");
  const transport = {
    deliverEvent: vi.fn(async () => {}),
    requestMissing: vi.fn(async () => {}),
  };
  const config = createProductionWorkerConfig(transport);
  const context = await config.resolveContext(tenantId);
  const gap = {
    destination: "cloud-sync",
    aggregateType: "order",
    aggregateId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    missingSequence: 1,
  };
  await config.requestMissing(context, gap);
  expect(transport.requestMissing).toHaveBeenCalledWith(context, gap);
});
