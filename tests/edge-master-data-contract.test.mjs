import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_PROTOCOL_VERSION,
  catalogRecordUpdatedEvent,
  catalogRecordUpdatedPayloadSchema,
} from "../packages/shared/src/edge/index.ts";
import { eventCatalogByName } from "../packages/shared/src/events/index.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const outletId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-11-14T12:00:00.000Z";
const station = {
  id: recordId,
  tenantId,
  outletId,
  name: "Coffee bar",
  type: "coffee_bar",
  printerDeviceId: null,
  targetSeconds: 120,
  ...(CATALOG_PROTOCOL_VERSION >= 3
    ? { displayOrder: 0, isActive: true, autoPrintFallback: true }
    : {}),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
  syncTxid: "9",
};

test("legend-3x9l registers the dedicated catalog full-state event in WS-02", () => {
  assert.deepEqual(eventCatalogByName.get("catalog_record.updated"), {
    name: "catalog_record.updated",
    aggregateType: "catalog_record",
    version: 1,
    payloadSchemaRef: "catalog_record.updated.v1",
    workstream: "WS-02",
  });
  assert.equal(catalogRecordUpdatedEvent.name, "catalog_record.updated");
  assert.equal(catalogRecordUpdatedEvent.entry.aggregateType, "catalog_record");
});

test("legend-3x9l retains a complete typed catalog record through JSON", () => {
  const payload = { stream: "stations", record: station };
  assert.deepEqual(catalogRecordUpdatedPayloadSchema.parse(payload), payload);
  assert.deepEqual(
    catalogRecordUpdatedEvent.payloadSchema.parse(
      JSON.parse(JSON.stringify(payload)),
    ),
    payload,
  );
});

test("legend-3x9l rejects partial hints and stream/record mismatches", () => {
  const payload = { stream: "stations", record: station };
  for (const invalid of [
    { stream: "stations", record: { id: recordId, syncTxid: "9" } },
    { stream: "stations", records: [station] },
    { stream: "menu_items", record: station },
    { stream: "unknown", record: station },
    { ...payload, operation: "updated" },
    { ...payload, record: { ...station, unexpected: true } },
    { ...payload, record: { ...station, syncTxid: "newest" } },
  ])
    assert.equal(
      catalogRecordUpdatedPayloadSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
});
