import assert from "node:assert/strict";
import { test } from "node:test";
import * as events from "../packages/shared/src/events/index.ts";
import { z } from "../packages/shared/src/core/index.ts";

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

// --- legend-cyu.4 review additions -----------------------------------------

test("payloadSchemaRef must be exactly <name>.v<version>", () => {
  const event = events.eventFixture;
  for (const patch of [
    { payloadSchemaRef: "payment.paid.v1" },
    { payloadSchemaRef: "order.paid.v2" },
    { payloadSchemaRef: "order.paid" },
    { version: 2 },
  ])
    assert.equal(
      events.eventEnvelopeSchema.safeParse({ ...event, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  assert.equal(
    events.eventEnvelopeSchema.safeParse({
      ...event,
      version: 2,
      payloadSchemaRef: "order.paid.v2",
    }).success,
    true,
  );
});

test("payload must be JSON so it survives the outbox and sync round trip", () => {
  for (const payload of [
    { at: new Date() },
    { big: 10n },
    { fn: () => 1 },
    { nan: Number.NaN },
    { undef: undefined },
  ])
    assert.equal(
      events.eventEnvelopeSchema.safeParse({ ...events.eventFixture, payload })
        .success,
      false,
    );
  const roundTrip = JSON.parse(JSON.stringify(events.eventFixture));
  assert.deepEqual(
    events.eventEnvelopeSchema.parse(roundTrip),
    events.eventEnvelopeSchema.parse(events.eventFixture),
  );
});

test("actor kinds match the audit contract and carry UUID ids", () => {
  const uuid = "33333333-3333-4333-8333-333333333333";
  for (const actor of [
    { type: "user", id: uuid },
    { type: "ai", id: uuid },
    { type: "mcp_client", id: uuid },
    { type: "device", id: uuid },
    { type: "system" },
  ])
    assert.equal(
      events.eventEnvelopeSchema.safeParse({ ...events.eventFixture, actor })
        .success,
      true,
      JSON.stringify(actor),
    );
  for (const actor of [
    { type: "mcp", id: uuid },
    { type: "ai", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    { type: "device" },
    { type: "user" },
    { type: "system", id: "x" },
  ])
    assert.equal(
      events.eventEnvelopeSchema.safeParse({ ...events.eventFixture, actor })
        .success,
      false,
      JSON.stringify(actor),
    );
});

test("deviceId is optional, defaults to null and must be a UUID", () => {
  assert.equal(
    events.eventEnvelopeSchema.parse(events.eventFixture).deviceId,
    null,
  );
  const deviceId = "55555555-5555-4555-8555-555555555555";
  assert.equal(
    events.eventEnvelopeSchema.parse({ ...events.eventFixture, deviceId })
      .deviceId,
    deviceId,
  );
  assert.equal(
    events.eventEnvelopeSchema.safeParse({
      ...events.eventFixture,
      deviceId: "pos-1",
    }).success,
    false,
  );
});

test("outbox has a terminal failed state for bounded retries", () => {
  const failed = {
    ...events.outboxFixture,
    status: "failed",
    attempts: 8,
    lastError: "HTTP 503",
  };
  assert.equal(events.outboxRowSchema.safeParse(failed).success, true);
  assert.equal(
    events.outboxRowSchema.safeParse({
      ...failed,
      deliveredAt: events.outboxFixture.createdAt,
    }).success,
    false,
  );
  assert.equal(
    events.outboxRowSchema.safeParse({
      ...failed,
      leaseOwner: "w",
      leaseUntil: events.outboxFixture.createdAt,
    }).success,
    false,
  );
  assert.equal(
    events.outboxRowSchema.parse(events.outboxFixture).lastError,
    null,
  );
  assert.equal(
    events.outboxRowSchema.safeParse({ ...failed, lastError: "x".repeat(1001) })
      .success,
    false,
  );
});

test("outbox processing and delivered rows were attempted at least once", () => {
  const lease = {
    leaseOwner: "worker-1",
    leaseUntil: "2026-11-01T12:05:00.000Z",
  };
  assert.equal(
    events.outboxRowSchema.safeParse({
      ...events.outboxFixture,
      status: "processing",
      attempts: 0,
      ...lease,
    }).success,
    false,
  );
  assert.equal(
    events.outboxRowSchema.safeParse({
      ...events.outboxFixture,
      status: "processing",
      attempts: 1,
      ...lease,
    }).success,
    true,
  );
  assert.equal(
    events.outboxRowSchema.safeParse({
      ...events.outboxFixture,
      status: "delivered",
      attempts: 0,
      deliveredAt: events.outboxFixture.createdAt,
    }).success,
    false,
  );
});

test("isOutboxRowClaimable: due pending rows and expired leases only", () => {
  const at = (iso) => new Date(iso);
  const pending = events.outboxFixture;
  assert.equal(
    events.isOutboxRowClaimable(pending, at("2026-11-01T11:59:59.999Z")),
    false,
  );
  assert.equal(
    events.isOutboxRowClaimable(pending, at("2026-11-01T12:00:00.000Z")),
    true,
  );
  const leased = {
    ...pending,
    status: "processing",
    attempts: 1,
    leaseOwner: "w",
    leaseUntil: "2026-11-01T12:05:00.000Z",
  };
  assert.equal(
    events.isOutboxRowClaimable(leased, at("2026-11-01T12:04:59.999Z")),
    false,
  );
  assert.equal(
    events.isOutboxRowClaimable(leased, at("2026-11-01T12:05:00.000Z")),
    true,
  );
  assert.equal(
    events.isOutboxRowClaimable(
      { ...pending, status: "failed", attempts: 8 },
      at("2027-01-01T00:00:00Z"),
    ),
    false,
  );
  assert.equal(
    events.isOutboxRowClaimable(
      {
        ...pending,
        status: "delivered",
        attempts: 1,
        deliveredAt: pending.createdAt,
      },
      at("2027-01-01T00:00:00Z"),
    ),
    false,
  );
});

test("classifyEventSequence tells consumers to apply, skip or wait", () => {
  const event = { ...events.eventFixture, sequence: 5 };
  assert.deepEqual(events.classifyEventSequence(4, event), { action: "apply" });
  assert.deepEqual(events.classifyEventSequence(5, event), {
    action: "duplicate",
  });
  assert.deepEqual(events.classifyEventSequence(9, event), {
    action: "duplicate",
  });
  assert.deepEqual(events.classifyEventSequence(2, event), {
    action: "gap",
    missingFrom: 3,
    missingTo: 4,
  });
  assert.deepEqual(events.classifyEventSequence(0, { ...event, sequence: 1 }), {
    action: "apply",
  });
  assert.throws(() => events.classifyEventSequence(-1, event), RangeError);
  assert.throws(() => events.classifyEventSequence(1.5, event), RangeError);
});

test("eventDedupeKey is scoped to the tenant", () => {
  const other = {
    ...events.eventFixture,
    tenantId: "99999999-9999-4999-8999-999999999999",
  };
  assert.notEqual(
    events.eventDedupeKey(events.eventFixture),
    events.eventDedupeKey(other),
  );
  assert.equal(
    events.eventDedupeKey(events.eventFixture),
    events.eventDedupeKey({ ...events.eventFixture }),
  );
});

test("catalog is frozen, lookup-able and consistent with the envelope rules", () => {
  assert.equal(Object.isFrozen(events.eventCatalog), true);
  assert.equal(Object.isFrozen(events.eventCatalog[0]), true);
  assert.equal(
    events.eventCatalogByName.get("order.paid")?.workstream,
    "WS-04",
  );
  assert.equal(events.eventCatalogByName.get("nope.nope"), undefined);
  for (const entry of events.eventCatalog) {
    assert.equal(entry.payloadSchemaRef, `${entry.name}.v${entry.version}`);
    assert.match(entry.aggregateType, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
  }
  assert.equal(
    events.eventCatalogEntrySchema.safeParse({
      ...events.eventCatalog[0],
      payloadSchemaRef: "other.v1",
    }).success,
    false,
  );
  assert.equal(
    events.eventCatalogEntrySchema.safeParse({
      ...events.eventCatalog[0],
      aggregateType: "Order",
      name: "Order.paid",
    }).success,
    false,
  );
});

test("blocked edge outbox alert is registered under WS-02", () => {
  assert.deepEqual(events.eventCatalogByName.get("edge_outbox.blocked"), {
    name: "edge_outbox.blocked",
    aggregateType: "edge_outbox",
    version: 1,
    payloadSchemaRef: "edge_outbox.blocked.v1",
    workstream: "WS-02",
  });
});

test("adapter domain events are registered under WS-00", () => {
  for (const name of [
    "provider_webhook.received",
    "wa_inbound_message.received",
    "outbound_message.sent",
    "outbound_message.failed",
    "edc_transaction.created",
    "edc_transaction.settled",
    "edc_transaction.cancelled",
    "wifi_session.authorized",
    "wifi_session.revoked",
    "lock_credential.issued",
    "lock_credential.revoked",
    "delivery_channel.action_executed",
  ])
    assert.equal(
      events.eventCatalogByName.get(name)?.workstream,
      "WS-00",
      name,
    );
});

test("defineDomainEvent binds a payload schema to a catalogued event", () => {
  const orderPaid = events.defineDomainEvent({
    name: "order.paid",
    payload: z.strictObject({
      totalIdr: z.number().int(),
      receiptNumber: z.string(),
    }),
  });
  assert.equal(orderPaid.payloadSchemaRef, "order.paid.v1");
  assert.equal(orderPaid.entry.workstream, "WS-04");
  assert.ok(orderPaid.envelopeSchema.parse(events.eventFixture));
  assert.equal(
    orderPaid.envelopeSchema.safeParse({
      ...events.eventFixture,
      payload: { totalIdr: "1" },
    }).success,
    false,
  );
  assert.equal(
    orderPaid.envelopeSchema.safeParse({
      ...events.eventFixture,
      payload: { ...events.eventFixture.payload, extra: 1 },
    }).success,
    false,
  );
  assert.equal(
    orderPaid.envelopeSchema.safeParse({
      ...events.eventFixture,
      name: "order.voided",
      payloadSchemaRef: "order.voided.v1",
    }).success,
    false,
  );
  assert.throws(
    () =>
      events.defineDomainEvent({ name: "order.typo", payload: z.object({}) }),
    /not in the event catalog/,
  );
  assert.throws(
    () =>
      events.defineDomainEvent({
        name: "order.paid",
        version: 2,
        payload: z.object({}),
      }),
    /version/,
  );
});
