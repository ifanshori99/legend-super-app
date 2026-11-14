// Staff panic alert queue (bead legend-alovk, Arah A). Pure reducer tests for
// `apps/web/src/features/facility-staff/panic-queue.ts`, written from
// docs/briefs/sub-panic-alert-ui.md section A (not from the implementation).
// No React, no browser, no database.
//
// Assumptions where the brief is silent:
//  - ack-ok/ack-taken/ack-failed/ack-session on an unknown alertId change nothing.
//  - Alert frames keep the receivedAt they came with; FIFO ignores it.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { registerWebAlias } from "./helpers/web-alias.mjs";

const OUTLET = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1b01";
const A = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1a01";
const B = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1a02";
const C = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1a03";

let q;

before(async () => {
  registerWebAlias();
  q = await import("../apps/web/src/features/facility-staff/panic-queue.ts");
});

function frame(alertId, extra = {}) {
  return {
    type: "panic",
    alertId,
    outletId: OUTLET,
    unitId: "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1c01",
    receivedAt: "2026-11-14T10:00:00.000Z",
    kind: "press",
    ...extra,
  };
}

function run(actions, start = q.initialPanicQueue) {
  return actions.reduce((s, a) => q.panicQueueReducer(s, a), start);
}
const alert = (id, extra) => ({ type: "alert", frame: frame(id, extra) });
const ids = (items) => items.map((i) => i.alertId);

describe("initial state", () => {
  test("starts connecting with nothing queued and an idle view", () => {
    assert.equal(q.initialPanicQueue.connection, "connecting");
    assert.deepEqual(q.initialPanicQueue.items, []);
    assert.equal(q.panicView(q.initialPanicQueue), "idle");
    assert.deepEqual(q.pendingAlerts(q.initialPanicQueue), []);
    assert.deepEqual(q.settledAlerts(q.initialPanicQueue), []);
  });
});

describe("arrival order (FIFO) and dedupe", () => {
  test("one alert becomes pending order 1, ack idle, not dismissed", () => {
    const s = run([alert(A, { kind: "test", unitId: null })]);
    assert.equal(q.panicView(s), "alert");
    const [item] = q.pendingAlerts(s);
    assert.equal(item.alertId, A);
    assert.equal(item.order, 1);
    assert.equal(item.ack, "idle");
    assert.equal(item.dismissed, false);
    assert.equal(item.kind, "test");
    assert.equal(item.unitId, null);
    assert.equal(item.outletId, OUTLET);
  });

  test("a second alert queues behind the first and does not replace the one being read", () => {
    const s = run([alert(A), alert(B)]);
    assert.equal(q.panicView(s), "queue");
    const pending = q.pendingAlerts(s);
    assert.deepEqual(ids(pending), [A, B]);
    assert.deepEqual(
      pending.map((i) => i.order),
      [1, 2],
    );
  });

  test("order follows arrival, not receivedAt", () => {
    const s = run([
      alert(A, { receivedAt: "2026-11-14T10:05:00.000Z" }),
      alert(B, { receivedAt: "2026-11-14T10:00:00.000Z" }),
      alert(C, { receivedAt: "2026-11-14T09:00:00.000Z" }),
    ]);
    assert.deepEqual(ids(q.pendingAlerts(s)), [A, B, C]);
  });

  test("a repeated alertId is ignored and does not shift the order", () => {
    const s = run([alert(A), alert(B), alert(A), alert(C)]);
    assert.deepEqual(ids(q.pendingAlerts(s)), [A, B, C]);
    assert.deepEqual(
      q.pendingAlerts(s).map((i) => i.order),
      [1, 2, 3],
    );
    assert.equal(s.items.length, 3);
  });

  test("a resend of an alert already acknowledged stays acknowledged", () => {
    const s = run([
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-ok", alertId: A },
      alert(A),
    ]);
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].ack, "mine");
    assert.equal(q.panicView(s), "settled");
  });

  test("when the first is handled the next pending alert is the oldest remaining", () => {
    const s = run([
      alert(A),
      alert(B),
      alert(C),
      { type: "ack-start", alertId: A },
      { type: "ack-ok", alertId: A },
    ]);
    assert.deepEqual(ids(q.pendingAlerts(s)), [B, C]);
    assert.deepEqual(ids(q.settledAlerts(s)), [A]);
    assert.equal(q.panicView(s), "queue");
  });

  test("handling one alert does not resolve the others (view drops from queue to alert)", () => {
    const s = run([
      alert(A),
      alert(B),
      { type: "ack-start", alertId: A },
      { type: "ack-ok", alertId: A },
    ]);
    assert.equal(q.panicView(s), "alert");
    assert.deepEqual(ids(q.pendingAlerts(s)), [B]);
  });
});

describe("acknowledging", () => {
  test("ack-start then ack-ok: sending, then mine", () => {
    let s = run([alert(A), { type: "ack-start", alertId: A }]);
    assert.equal(s.items[0].ack, "sending");
    assert.deepEqual(ids(q.pendingAlerts(s)), [A]);
    s = run([{ type: "ack-ok", alertId: A }], s);
    assert.equal(s.items[0].ack, "mine");
    assert.deepEqual(q.pendingAlerts(s), []);
    assert.deepEqual(ids(q.settledAlerts(s)), [A]);
    assert.equal(q.panicView(s), "settled");
  });

  test("ack-taken (409, a colleague was first) settles as taken", () => {
    const s = run([
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-taken", alertId: A },
    ]);
    assert.equal(s.items[0].ack, "taken");
    assert.deepEqual(ids(q.settledAlerts(s)), [A]);
    assert.deepEqual(q.pendingAlerts(s), []);
    assert.equal(q.panicView(s), "settled");
  });

  test("ack-failed keeps the alert pending and it can be retried", () => {
    let s = run([
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-failed", alertId: A },
    ]);
    assert.equal(s.items[0].ack, "failed");
    assert.deepEqual(ids(q.pendingAlerts(s)), [A]);
    assert.deepEqual(q.settledAlerts(s), []);
    assert.equal(q.panicView(s), "alert");
    s = run([{ type: "ack-start", alertId: A }], s);
    assert.equal(s.items[0].ack, "sending");
    s = run([{ type: "ack-ok", alertId: A }], s);
    assert.equal(s.items[0].ack, "mine");
  });

  test("ack-session (401) keeps the alert pending and it can be retried", () => {
    let s = run([
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-session", alertId: A },
    ]);
    assert.equal(s.items[0].ack, "session");
    assert.deepEqual(ids(q.pendingAlerts(s)), [A]);
    assert.equal(q.panicView(s), "alert");
    s = run([{ type: "ack-start", alertId: A }], s);
    assert.equal(s.items[0].ack, "sending");
  });

  test("ack-start is ignored while already sending or after the alert is settled", () => {
    const sending = run([alert(A), { type: "ack-start", alertId: A }]);
    assert.equal(
      q.panicQueueReducer(sending, { type: "ack-start", alertId: A }).items[0]
        .ack,
      "sending",
    );
    const mine = run([{ type: "ack-ok", alertId: A }], sending);
    assert.equal(
      q.panicQueueReducer(mine, { type: "ack-start", alertId: A }).items[0].ack,
      "mine",
    );
    const taken = run([
      alert(B),
      { type: "ack-start", alertId: B },
      { type: "ack-taken", alertId: B },
      { type: "ack-start", alertId: B },
    ]);
    assert.equal(taken.items[0].ack, "taken");
  });

  test("ack only changes the targeted alert", () => {
    const s = run([
      alert(A),
      alert(B),
      { type: "ack-start", alertId: B },
      { type: "ack-failed", alertId: B },
    ]);
    assert.equal(s.items.find((i) => i.alertId === A).ack, "idle");
    assert.equal(s.items.find((i) => i.alertId === B).ack, "failed");
    assert.deepEqual(ids(q.pendingAlerts(s)), [A, B]);
  });

  test("an unknown alertId changes nothing", () => {
    const base = run([alert(A)]);
    for (const type of [
      "ack-start",
      "ack-ok",
      "ack-taken",
      "ack-failed",
      "ack-session",
      "dismiss",
    ]) {
      const next = q.panicQueueReducer(base, { type, alertId: B });
      assert.deepEqual(next.items, base.items, type);
    }
  });
});

describe("dismiss", () => {
  test("only a mine or taken alert can be closed", () => {
    const pending = run([alert(A)]);
    assert.equal(
      q.panicQueueReducer(pending, { type: "dismiss", alertId: A }).items[0]
        .dismissed,
      false,
    );
    const sending = run([{ type: "ack-start", alertId: A }], pending);
    assert.equal(
      q.panicQueueReducer(sending, { type: "dismiss", alertId: A }).items[0]
        .dismissed,
      false,
    );
    const failed = run([{ type: "ack-failed", alertId: A }], sending);
    assert.equal(
      q.panicQueueReducer(failed, { type: "dismiss", alertId: A }).items[0]
        .dismissed,
      false,
    );
    assert.equal(q.panicView(failed), "alert");
  });

  test("closing a mine alert returns the view to idle", () => {
    const s = run([
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-ok", alertId: A },
      { type: "dismiss", alertId: A },
    ]);
    assert.equal(s.items[0].dismissed, true);
    assert.deepEqual(q.settledAlerts(s), []);
    assert.deepEqual(q.pendingAlerts(s), []);
    assert.equal(q.panicView(s), "idle");
  });

  test("closing a taken alert returns the view to idle", () => {
    const s = run([
      alert(A),
      { type: "ack-taken", alertId: A },
      { type: "dismiss", alertId: A },
    ]);
    assert.equal(q.panicView(s), "idle");
  });

  test("a dismissed alert that is resent stays dismissed", () => {
    const s = run([
      alert(A),
      { type: "ack-ok", alertId: A },
      { type: "dismiss", alertId: A },
      alert(A),
    ]);
    assert.equal(s.items.length, 1);
    assert.equal(q.panicView(s), "idle");
  });
});

describe("connection status and view", () => {
  test("status updates the connection", () => {
    let s = run([{ type: "status", status: "open" }]);
    assert.equal(s.connection, "open");
    s = run([{ type: "status", status: "reconnecting" }], s);
    assert.equal(s.connection, "reconnecting");
    s = run([{ type: "status", status: "open" }], s);
    assert.equal(s.connection, "open");
  });

  test("reconnecting with a pending alert still shows the alert", () => {
    const s = run([alert(A), { type: "status", status: "reconnecting" }]);
    assert.equal(q.panicView(s), "alert");
    assert.equal(s.connection, "reconnecting");
  });

  test("unreachable with a pending alert still shows the alert (banner, not a new screen)", () => {
    const s = run([alert(A), { type: "status", status: "unreachable" }]);
    assert.equal(q.panicView(s), "alert");
    const two = run([alert(B)], s);
    assert.equal(q.panicView(two), "queue");
  });

  test("unreachable without a pending alert is the unreachable view", () => {
    const s = run([{ type: "status", status: "unreachable" }]);
    assert.equal(q.panicView(s), "unreachable");
  });

  test("unreachable beats settled when nothing is pending", () => {
    const s = run([
      alert(A),
      { type: "ack-ok", alertId: A },
      { type: "status", status: "unreachable" },
    ]);
    assert.equal(q.panicView(s), "unreachable");
  });

  test("open or reconnecting with no alert is idle", () => {
    assert.equal(
      q.panicView(run([{ type: "status", status: "open" }])),
      "idle",
    );
    assert.equal(
      q.panicView(run([{ type: "status", status: "reconnecting" }])),
      "idle",
    );
  });

  test("recovering from unreachable returns to idle", () => {
    const s = run([
      { type: "status", status: "unreachable" },
      { type: "status", status: "open" },
    ]);
    assert.equal(q.panicView(s), "idle");
  });
});

describe("revoked is sticky", () => {
  test("revoked shows the revoked view", () => {
    const s = run([{ type: "status", status: "revoked" }]);
    assert.equal(s.connection, "revoked");
    assert.equal(q.panicView(s), "revoked");
  });

  test("later statuses are ignored", () => {
    let s = run([{ type: "status", status: "revoked" }]);
    for (const status of [
      "connecting",
      "open",
      "reconnecting",
      "unreachable",
      "stopped",
    ]) {
      s = run([{ type: "status", status }], s);
      assert.equal(s.connection, "revoked", status);
      assert.equal(q.panicView(s), "revoked", status);
    }
  });

  test("revoked wins over pending alerts and a queue", () => {
    const s = run([alert(A), alert(B), { type: "status", status: "revoked" }]);
    assert.equal(q.panicView(s), "revoked");
  });

  test("revoked wins over settled alerts", () => {
    const s = run([
      alert(A),
      { type: "ack-ok", alertId: A },
      { type: "status", status: "revoked" },
    ]);
    assert.equal(q.panicView(s), "revoked");
  });
});

describe("purity", () => {
  test("the reducer does not mutate the previous state", () => {
    const before = run([alert(A)]);
    const snapshot = JSON.stringify(before);
    q.panicQueueReducer(before, alert(B));
    q.panicQueueReducer(before, { type: "ack-start", alertId: A });
    q.panicQueueReducer(before, { type: "status", status: "revoked" });
    assert.equal(JSON.stringify(before), snapshot);
  });
});
