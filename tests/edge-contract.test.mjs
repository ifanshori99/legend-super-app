import assert from "node:assert/strict";
import { test } from "node:test";
import * as edge from "../packages/shared/src/edge/index.ts";

test("EDG-02 Cafe Legend fixtures parse and batches reject cross-scope events", () => {
  for (const [schema, fixture] of edge.edgeFixtures)
    assert.equal(schema.safeParse(fixture).success, true);
  const batch = structuredClone(edge.syncBatchFixture);
  batch.events[0].outletId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.equal(edge.syncBatchSchema.safeParse(batch).success, false);
  batch.events[0].outletId = batch.outletId;
  batch.events.push(batch.events[0]);
  assert.equal(edge.syncBatchSchema.safeParse(batch).success, false);
});

test("EDG-02 conflict policy preserves transactions and chooses cloud master data", () => {
  assert.equal(edge.conflictResolution("master_data"), "cloud_wins");
  assert.equal(edge.conflictResolution("transaction_event"), "append_only");
});

test("EDG-03 revocation remains terminal and denies offline transactions", () => {
  assert.equal(edge.canDeviceTransact("active"), true);
  assert.equal(edge.canDeviceTransact("revoked"), false);
  assert.equal(edge.transitionDevice("active", "revoke"), "revoked");
  assert.throws(() => edge.transitionDevice("revoked", "revoke"));
});

test("EDG-02 print transitions reject invalid retries and RPC rejects unknown operations", () => {
  assert.equal(edge.transitionPrintJob("queued", "start"), "printing");
  assert.equal(edge.transitionPrintJob("failed", "retry"), "queued");
  assert.throws(() => edge.transitionPrintJob("printed", "start"));
  assert.equal(
    edge.agentRpcRequestSchema.safeParse({
      ...edge.agentRpcFixture,
      operation: "unknown",
    }).success,
    false,
  );
});
