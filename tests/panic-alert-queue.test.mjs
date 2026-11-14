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
    unitCode: null,
    areaName: null,
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

// ---------------------------------------------------------------------------
// legend-jztb7, written from docs/briefs/sub-panic-alert-wiring.md section A
// (not from the implementation).
//
// Assumptions where the brief is silent:
//  - An acknowledged frame for an item that is already taken with a name keeps
//    the first name (not tested either way).
//  - "sync" does not change the connection status.

const ACKED_AT = "2026-11-14T10:00:09.000Z";
const acked = (alertId, byName = "Rina", acknowledgedAt = ACKED_AT) => ({
  type: "acknowledged",
  frame: { type: "acknowledged", alertId, acknowledgedAt, byName },
});
const sync = (alerts, knownBefore = []) => ({
  type: "sync",
  alerts: alerts.map((a) => (typeof a === "string" ? frame(a) : a)),
  knownBefore,
});
const item = (s, id) => s.items.find((i) => i.alertId === id);

describe("jztb7: items carry location and taken-by fields", () => {
  test("initial state has no closed ids", () => {
    assert.deepEqual(q.initialPanicQueue.closedIds, []);
  });

  test("unitCode and areaName are copied from the frame; taken fields start null", () => {
    const s = run([alert(A, { unitCode: "P2", areaName: "Area Pria" })]);
    const [i] = q.pendingAlerts(s);
    assert.equal(i.unitCode, "P2");
    assert.equal(i.areaName, "Area Pria");
    assert.equal(i.takenBy, null);
    assert.equal(i.takenAt, null);
  });

  test("null unitCode and areaName stay null", () => {
    const [i] = q.pendingAlerts(run([alert(A)]));
    assert.equal(i.unitCode, null);
    assert.equal(i.areaName, null);
  });
});

describe("jztb7: acknowledged frame", () => {
  test("idle item becomes taken with the colleague's name and time", () => {
    const s = run([alert(A), acked(A, "Rina")]);
    const i = item(s, A);
    assert.equal(i.ack, "taken");
    assert.equal(i.takenBy, "Rina");
    assert.equal(i.takenAt, ACKED_AT);
    assert.deepEqual(q.pendingAlerts(s), []);
    assert.deepEqual(ids(q.settledAlerts(s)), [A]);
    assert.equal(q.panicView(s), "settled");
  });

  test("a failed item becomes taken", () => {
    const s = run([
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-failed", alertId: A },
      acked(A),
    ]);
    assert.equal(item(s, A).ack, "taken");
    assert.equal(item(s, A).takenBy, "Rina");
  });

  test("a session-lost item becomes taken", () => {
    const s = run([
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-session", alertId: A },
      acked(A),
    ]);
    assert.equal(item(s, A).ack, "taken");
    assert.equal(item(s, A).takenBy, "Rina");
    assert.equal(item(s, A).takenAt, ACKED_AT);
  });

  test("an item taken without a name (409 without body) gets the name filled in", () => {
    const s = run([
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-taken", alertId: A },
      acked(A, "Rina"),
    ]);
    assert.equal(item(s, A).ack, "taken");
    assert.equal(item(s, A).takenBy, "Rina");
    assert.equal(item(s, A).takenAt, ACKED_AT);
  });

  test("a sending item is not changed (the POST result decides)", () => {
    const base = run([alert(A), { type: "ack-start", alertId: A }]);
    const s = run([acked(A)], base);
    assert.equal(item(s, A).ack, "sending");
    assert.equal(item(s, A).takenBy, null);
    assert.equal(item(s, A).takenAt, null);
  });

  test("my own acknowledged item is not changed", () => {
    const base = run([
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-ok", alertId: A },
    ]);
    const s = run([acked(A, "Rina")], base);
    assert.equal(item(s, A).ack, "mine");
    assert.equal(item(s, A).takenBy, null);
    assert.equal(item(s, A).takenAt, null);
  });

  test("only the targeted alert changes", () => {
    const s = run([alert(A), alert(B), acked(B)]);
    assert.equal(item(s, A).ack, "idle");
    assert.equal(item(s, B).ack, "taken");
    assert.deepEqual(ids(q.pendingAlerts(s)), [A]);
    assert.equal(q.panicView(s), "alert");
  });

  test("a taken item can be closed", () => {
    const s = run([alert(A), acked(A), { type: "dismiss", alertId: A }]);
    assert.equal(item(s, A).dismissed, true);
    assert.equal(q.panicView(s), "idle");
  });

  test("repeating the frame does not duplicate or change anything", () => {
    const once = run([alert(A), acked(A)]);
    const twice = run([acked(A)], once);
    assert.deepEqual(twice.items, once.items);
  });

  test("it does not mutate the previous state", () => {
    const before = run([alert(A)]);
    const snapshot = JSON.stringify(before);
    q.panicQueueReducer(before, acked(A));
    q.panicQueueReducer(before, acked(B));
    assert.equal(JSON.stringify(before), snapshot);
  });
});

describe("jztb7: closedIds (handled by a colleague before it reached this phone)", () => {
  test("an acknowledged frame for an unknown alert records its id once", () => {
    const s = run([acked(A), acked(A)]);
    assert.deepEqual(s.closedIds, [A]);
    assert.deepEqual(s.items, []);
    assert.equal(q.panicView(s), "idle");
  });

  test("a late alert frame for a closed id is ignored", () => {
    const s = run([acked(A), alert(A), alert(B)]);
    assert.deepEqual(ids(s.items), [B]);
    assert.deepEqual(ids(q.pendingAlerts(s)), [B]);
    assert.equal(item(s, B).order, 1, "the ignored alert took no order number");
  });

  test("closed ids of several alerts are all kept", () => {
    const s = run([acked(A), acked(B)]);
    assert.deepEqual([...s.closedIds].sort(), [A, B].sort());
  });

  test("an acknowledged frame for a known alert does not add to closedIds", () => {
    const s = run([alert(A), acked(A)]);
    assert.deepEqual(s.closedIds, []);
  });

  test("a closed id does not affect other alerts or the connection", () => {
    const s = run([{ type: "status", status: "open" }, acked(A), alert(B)]);
    assert.equal(s.connection, "open");
    assert.deepEqual(ids(q.pendingAlerts(s)), [B]);
  });
});

describe("jztb7: ack-taken with a name", () => {
  test("byName and at are stored", () => {
    const s = run([
      alert(A),
      { type: "ack-start", alertId: A },
      {
        type: "ack-taken",
        alertId: A,
        byName: "Dewi",
        at: "2026-11-14T10:01:00.000Z",
      },
    ]);
    assert.equal(item(s, A).ack, "taken");
    assert.equal(item(s, A).takenBy, "Dewi");
    assert.equal(item(s, A).takenAt, "2026-11-14T10:01:00.000Z");
  });

  test("without a name the item is taken and takenBy stays null", () => {
    const s = run([
      alert(A),
      { type: "ack-start", alertId: A },
      { type: "ack-taken", alertId: A },
    ]);
    assert.equal(item(s, A).takenBy, null);
    assert.equal(item(s, A).takenAt, null);
  });

  test("null byName and at keep what was already known", () => {
    const s = run([
      alert(A),
      acked(A, "Rina"),
      { type: "ack-taken", alertId: A, byName: null, at: null },
    ]);
    assert.equal(item(s, A).takenBy, "Rina");
    assert.equal(item(s, A).takenAt, ACKED_AT);
  });

  test("the 409 name settles a sending item that the frame left alone", () => {
    const s = run([
      alert(A),
      { type: "ack-start", alertId: A },
      acked(A, "Rina"),
      { type: "ack-taken", alertId: A, byName: "Rina", at: ACKED_AT },
    ]);
    assert.equal(item(s, A).ack, "taken");
    assert.equal(item(s, A).takenBy, "Rina");
  });
});

describe("jztb7: sync (open alerts fetched from the server)", () => {
  test("adds alerts in the array order after existing ones", () => {
    const s = run([alert(A), sync([B, C])]);
    assert.deepEqual(ids(q.pendingAlerts(s)), [A, B, C]);
    assert.deepEqual(
      q.pendingAlerts(s).map((i) => i.order),
      [1, 2, 3],
    );
    assert.equal(q.panicView(s), "queue");
  });

  test("restores alerts after a reload (empty state)", () => {
    const s = run([
      { type: "status", status: "open" },
      sync([
        frame(B, { unitCode: "W1", areaName: "Area Wanita" }),
        frame(A, { unitCode: "P2", areaName: "Area Pria" }),
      ]),
    ]);
    assert.deepEqual(ids(q.pendingAlerts(s)), [B, A], "server order is kept");
    assert.equal(item(s, B).unitCode, "W1");
    assert.equal(item(s, A).areaName, "Area Pria");
    assert.equal(q.panicView(s), "queue");
  });

  test("an alert already queued is not added twice and keeps its order", () => {
    const s = run([alert(A), alert(B), sync([A, C], [A, B])]);
    assert.deepEqual(ids(s.items), [A, B, C]);
    assert.equal(item(s, A).order, 1);
    assert.equal(item(s, B).order, 2);
    assert.equal(item(s, C).order, 3);
  });

  test("the same sync applied twice changes nothing", () => {
    const once = run([sync([A, B])]);
    const twice = run([sync([A, B], [A, B])], once);
    assert.deepEqual(twice.items, once.items);
  });

  test("alerts whose id is in closedIds are not added", () => {
    const s = run([acked(A), sync([A, B])]);
    assert.deepEqual(ids(s.items), [B]);
  });

  test("a known pending alert missing from the server list became taken by a colleague", () => {
    const s = run([alert(A), alert(B), sync([B], [A, B])]);
    assert.equal(item(s, A).ack, "taken");
    assert.equal(
      item(s, A).takenBy,
      null,
      "name unknown: shown as 'rekan lain'",
    );
    assert.equal(item(s, B).ack, "idle");
    assert.deepEqual(ids(q.pendingAlerts(s)), [B]);
    assert.deepEqual(ids(q.settledAlerts(s)), [A]);
  });

  test("failed and session items missing from the server list also become taken", () => {
    const s = run([
      alert(A),
      alert(B),
      { type: "ack-start", alertId: A },
      { type: "ack-failed", alertId: A },
      { type: "ack-start", alertId: B },
      { type: "ack-session", alertId: B },
      sync([], [A, B]),
    ]);
    assert.equal(item(s, A).ack, "taken");
    assert.equal(item(s, B).ack, "taken");
    assert.equal(q.panicView(s), "settled");
  });

  test("a known alert that the server still lists stays pending", () => {
    const s = run([alert(A), sync([A], [A])]);
    assert.equal(item(s, A).ack, "idle");
  });

  test("an alert that was not known before the request is not taken, even if absent", () => {
    // It arrived by WebSocket while the request was in flight.
    const s = run([alert(A), alert(B), sync([], [A])]);
    assert.equal(item(s, A).ack, "taken");
    assert.equal(item(s, B).ack, "idle");
  });

  test("sending, mine and dismissed items are not touched", () => {
    const s = run([
      alert(A),
      alert(B),
      alert(C),
      { type: "ack-start", alertId: A },
      { type: "ack-start", alertId: B },
      { type: "ack-ok", alertId: B },
      { type: "ack-start", alertId: C },
      { type: "ack-ok", alertId: C },
      { type: "dismiss", alertId: C },
      sync([], [A, B, C]),
    ]);
    assert.equal(item(s, A).ack, "sending");
    assert.equal(item(s, B).ack, "mine");
    assert.equal(item(s, C).ack, "mine");
    assert.equal(item(s, C).dismissed, true);
  });

  test("an already taken item keeps its name", () => {
    const s = run([alert(A), acked(A, "Rina"), sync([], [A])]);
    assert.equal(item(s, A).ack, "taken");
    assert.equal(item(s, A).takenBy, "Rina");
  });

  test("knownBefore ids that are not in the queue change nothing", () => {
    const base = run([alert(A)]);
    const s = run([sync([], [B])], base);
    assert.deepEqual(s.items, base.items);
  });

  test("an empty sync with nothing known is a no-op", () => {
    const base = run([alert(A), { type: "status", status: "open" }]);
    const s = run([sync([], [])], base);
    assert.deepEqual(s.items, base.items);
    assert.equal(s.connection, "open");
  });

  test("it does not mutate the previous state", () => {
    const before = run([alert(A)]);
    const snapshot = JSON.stringify(before);
    q.panicQueueReducer(before, sync([B], [A]));
    assert.equal(JSON.stringify(before), snapshot);
  });
});
