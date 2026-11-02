// Stable retry identity for header-based idempotency (bead legend-8tv6,
// contracts.md "Typed web client & idempotency headers"), tested in plain Node
// ESM like the other FE contract tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttemptKeyTracker } from "../apps/web/src/features/ws05-payment-admin/attempt-key.ts";

test("legend-8tv6 keeps the key per attempt and rotates it on change or success", () => {
  let created = 0;
  const tracker = createAttemptKeyTracker(() => `key-${++created}-12345678`);
  const payload = { method: "qris", body: { enabled: true } };

  const first = tracker.keyFor(payload);
  assert.equal(tracker.keyFor({ ...payload }), first);
  assert.equal(tracker.keyFor(payload), first);

  const changed = tracker.keyFor({ ...payload, body: { enabled: false } });
  assert.notEqual(changed, first);
  assert.equal(
    tracker.keyFor({ ...payload, body: { enabled: false } }),
    changed,
  );

  tracker.settle();
  const afterSuccess = tracker.keyFor({ ...payload, body: { enabled: false } });
  assert.notEqual(afterSuccess, changed);
  assert.equal(
    tracker.keyFor({ ...payload, body: { enabled: false } }),
    afterSuccess,
  );
  assert.equal(created, 3);
});
