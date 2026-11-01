import assert from "node:assert/strict";
import { test } from "node:test";
import * as events from "../packages/shared/src/events/index.ts";

test("Cafe Legend fixtures satisfy event, outbox and sync contracts", () => {
  assert.ok(events.eventEnvelopeSchema.parse(events.eventFixture));
  assert.ok(events.outboxRowSchema.parse(events.outboxFixture));
  assert.ok(events.syncCheckpointSchema.parse(events.syncCheckpointFixture));
});

test("event identity, order, actor, version and names are validated", () => {
  for (const patch of [
    { id: "bad" },
    { tenantId: "bad" },
    { outletId: "bad" },
    { aggregateId: "bad" },
    { sequence: 0 },
    { version: 0 },
    { name: "OrderPaid" },
    { name: "payment.created", aggregateType: "order" },
    { occurredAt: "2026-11-01" },
    { actor: { type: "robot" } },
    { idempotencyKey: "" },
    { payloadSchemaRef: "" },
  ])
    assert.equal(
      events.eventEnvelopeSchema.safeParse({ ...events.eventFixture, ...patch })
        .success,
      false,
      JSON.stringify(patch),
    );
});

test("outbox leases and delivery states cannot contradict each other", () => {
  const row = events.outboxFixture;
  assert.equal(
    events.outboxRowSchema.safeParse({ ...row, status: "processing" }).success,
    false,
  );
  assert.equal(
    events.outboxRowSchema.safeParse({ ...row, status: "delivered" }).success,
    false,
  );
  assert.equal(
    events.outboxRowSchema.safeParse({ ...row, attempts: -1 }).success,
    false,
  );
});

test("catalog entries are unique, named for their aggregate and register schemas", () => {
  const names = events.eventCatalog.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("order.paid"));
  assert.ok(names.includes("payment.paid"));
  for (const entry of events.eventCatalog)
    assert.ok(
      events.eventCatalogEntrySchema.safeParse(entry).success,
      entry.name,
    );
  assert.equal(
    events.eventCatalogEntrySchema.safeParse({
      ...events.eventCatalog[0],
      name: "wrong.created",
    }).success,
    false,
  );
});

test("sync checkpoints retain independent direction, peer and opaque resume cursor", () => {
  const checkpoint = events.syncCheckpointFixture;
  assert.equal(
    events.syncCheckpointSchema.safeParse({
      ...checkpoint,
      direction: "sideways",
    }).success,
    false,
  );
  assert.equal(
    events.syncCheckpointSchema.safeParse({ ...checkpoint, cursor: "" })
      .success,
    false,
  );
  assert.equal(
    events.syncCheckpointSchema.safeParse({ ...checkpoint, peerId: "bad" })
      .success,
    false,
  );
});

test("outbox supports local worker delivery and paired sync destinations", () => {
  const local = { ...events.outboxFixture, direction: null, peerId: null };
  assert.equal(events.outboxRowSchema.safeParse(local).success, true);
  assert.equal(
    events.outboxRowSchema.safeParse({ ...local, direction: "edge_to_cloud" })
      .success,
    false,
  );
  assert.equal(
    events.outboxRowSchema.safeParse({
      ...local,
      peerId: events.outboxFixture.peerId,
    }).success,
    false,
  );
});
