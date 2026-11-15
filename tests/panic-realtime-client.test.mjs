// Panic-alert realtime client (WS-02, bead legend-kpzmi, kartu B). Runs with the
// root node:test suite, no database, no browser: a fake socket and a fake
// scheduler stand in for WebSocket and setTimeout. No UI is involved (the
// banner is a later gate-ui card); this proves the transport module only.
//
// Contract these tests fix for `apps/web/src/features/facility-staff/panic-realtime.ts`
// (written from docs/CONTRACT.md + packages/shared/src/facility/emergency.ts):
//
//   createPanicRealtimeClient({
//     url,                       // ws(s) URL of the receiver endpoint
//     socketFactory,             // (url, protocols: string[]) => socket
//     onAlert,                   // (PanicRealtimeFrame) => void
//     onStatus?,                 // ("connecting"|"open"|"reconnecting"|"unreachable"|"revoked"|"stopped") => void
//     onRevoked?,                // () => void, close code 4401
//     apiFetch?,                 // (path, { method, body }) => Promise<unknown>; default = web apiFetch
//     scheduler?,                // { setTimeout(fn, ms) => handle, clearTimeout(handle) }
//     backoff?,                  // { baseMs, maxMs }; delay = min(baseMs * 2^attempt, maxMs)
//   }) => { start(), stop(), ack(alertId) => Promise<void> }
//
// socket = WebSocket-like: send(string), close(code?, reason?), and the
// handler properties onopen / onmessage({ data }) / onclose({ code }) / onerror.
//
// Assumptions (the spec leaves them open):
//  - The server resends an open alert every 3 s until `received`; the client
//    answers `received` every time but calls `onAlert` once per alertId.
//  - `received` is only sent after `onAlert` returned without throwing, so a
//    phone that failed to show the alert gets the resend.
//  - Backoff resets to baseMs after a socket opened successfully.
//  - Any close code other than 4401 (including 1000 and 1006) reconnects,
//    unless stop() was called.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { registerWebAlias } from "./helpers/web-alias.mjs";
import {
  EMERGENCY_REVOKED_CLOSE_CODE,
  EMERGENCY_WS_PROTOCOL,
} from "../packages/shared/src/facility/index.ts";

const ALERT_A = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1a01";
const ALERT_B = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1a02";
const OUTLET = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1b01";
const UNIT = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1c01";
const URL_WS = "wss://api.example.test/api/emergency/ws";

let createPanicRealtimeClient;

before(async () => {
  registerWebAlias();
  ({ createPanicRealtimeClient } =
    await import("../apps/web/src/features/facility-staff/panic-realtime.ts"));
});

function frame(alertId = ALERT_A, extra = {}) {
  return {
    type: "panic",
    alertId,
    outletId: OUTLET,
    unitId: UNIT,
    unitCode: null,
    areaName: null,
    receivedAt: "2026-11-14T10:00:00.000Z",
    kind: "press",
    ...extra,
  };
}

class FakeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
    this.closed = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
  // test helpers: what the server side does
  open() {
    this.onopen?.({});
  }
  push(payload) {
    this.onmessage?.({
      data: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  }
  serverClose(code) {
    this.onclose?.({ code });
  }
}

function fakeScheduler() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
    pending() {
      return timers.filter((t) => !t.cancelled && !t.fired);
    },
    // fire the oldest pending timer; returns its delay
    fire() {
      const timer = this.pending()[0];
      assert.ok(timer, "expected a pending reconnect timer");
      timer.fired = true;
      timer.fn();
      return timer.ms;
    },
  };
}

function harness(options = {}) {
  const sockets = [];
  const alerts = [];
  const statuses = [];
  const acks = [];
  const acknowledged = [];
  const scheduler = fakeScheduler();
  let revoked = 0;
  const client = createPanicRealtimeClient({
    url: URL_WS,
    socketFactory: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    onAlert: (f) => alerts.push(f),
    onAcknowledged: (f) => acknowledged.push(f),
    onStatus: (s) => statuses.push(s),
    onRevoked: () => {
      revoked += 1;
    },
    apiFetch: async (path, init) => {
      acks.push({ path, init });
      return { data: {} };
    },
    scheduler,
    backoff: { baseMs: 1000, maxMs: 8000 },
    ...options,
  });
  return {
    client,
    sockets,
    alerts,
    statuses,
    acks,
    acknowledged,
    scheduler,
    revoked: () => revoked,
    last: () => sockets[sockets.length - 1],
  };
}

describe("panic realtime client: connect and receive", () => {
  test("start opens one socket with the emergency subprotocol", () => {
    const h = harness();
    h.client.start();
    assert.equal(h.sockets.length, 1);
    assert.equal(h.last().url, URL_WS);
    assert.deepEqual([...h.last().protocols], [EMERGENCY_WS_PROTOCOL]);
    assert.equal(h.statuses.at(-1), "connecting");
    h.last().open();
    assert.equal(h.statuses.at(-1), "open");
  });

  test("calling start twice does not open a second socket", () => {
    const h = harness();
    h.client.start();
    h.client.start();
    assert.equal(h.sockets.length, 1);
  });

  test("a valid panic frame reaches onAlert and is answered with received", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.last().push(frame(ALERT_A, { kind: "test" }));
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0].alertId, ALERT_A);
    assert.equal(h.alerts[0].kind, "test");
    assert.deepEqual(h.last().sent, [{ type: "received", alertId: ALERT_A }]);
  });

  test("a resend of the same alert is answered again but shown once", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.last().push(frame(ALERT_A));
    h.last().push(frame(ALERT_A));
    assert.equal(h.alerts.length, 1);
    assert.equal(h.last().sent.length, 2);
    h.last().push(frame(ALERT_B));
    assert.equal(h.alerts.length, 2);
    assert.deepEqual(h.last().sent.at(-1), {
      type: "received",
      alertId: ALERT_B,
    });
  });

  test("no received reply when onAlert throws, so the server resends", () => {
    const h = harness({
      onAlert: () => {
        throw new Error("render failed");
      },
    });
    h.client.start();
    h.last().open();
    h.last().push(frame(ALERT_A));
    assert.deepEqual(h.last().sent, []);
    assert.equal(h.sockets.length, 1, "socket stays open");
  });
});

describe("panic realtime client: invalid frames are ignored", () => {
  const cases = {
    "not JSON": "{oops",
    "empty string": "",
    "JSON null": "null",
    "unknown type": { type: "ping" },
    "received echo from server": { type: "received", alertId: ALERT_A },
    "missing alertId": (() => {
      const rest = frame();
      delete rest.alertId;
      return rest;
    })(),
    "alertId not a uuid": frame("not-a-uuid"),
    "unknown extra key (strict)": frame(ALERT_A, { guestName: "x" }),
    "unknown kind": frame(ALERT_A, { kind: "fire" }),
    "receivedAt not a date": frame(ALERT_A, { receivedAt: "yesterday" }),
  };
  for (const [name, payload] of Object.entries(cases)) {
    test(`ignores ${name}`, () => {
      const h = harness();
      h.client.start();
      h.last().open();
      h.last().push(payload);
      assert.equal(h.alerts.length, 0);
      assert.deepEqual(h.last().sent, []);
      assert.equal(h.last().closed, null, "socket is not closed");
      assert.equal(h.sockets.length, 1);
      // and a valid frame afterwards still works
      h.last().push(frame(ALERT_A));
      assert.equal(h.alerts.length, 1);
    });
  }

  test("a binary/non-string payload is ignored", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.last().onmessage({ data: new Uint8Array([1, 2, 3]) });
    assert.equal(h.alerts.length, 0);
    assert.deepEqual(h.last().sent, []);
  });
});

describe("panic realtime client: reconnect with backoff", () => {
  test("an unexpected close schedules a reconnect with growing delay", () => {
    const h = harness();
    h.client.start();
    h.last().serverClose(1006);
    assert.equal(h.statuses.at(-1), "reconnecting");
    assert.equal(h.scheduler.pending().length, 1);
    assert.equal(h.sockets.length, 1, "does not reconnect before the timer");

    assert.equal(h.scheduler.fire(), 1000);
    assert.equal(h.sockets.length, 2);
    h.last().serverClose(1006);
    assert.equal(h.scheduler.fire(), 2000);
    h.last().serverClose(1006);
    assert.equal(h.scheduler.fire(), 4000);
    h.last().serverClose(1006);
    assert.equal(h.scheduler.fire(), 8000);
    h.last().serverClose(1006);
    assert.equal(h.scheduler.fire(), 8000, "delay is capped at maxMs");
    assert.equal(h.sockets.length, 6);
    assert.deepEqual([...h.last().protocols], [EMERGENCY_WS_PROTOCOL]);
  });

  test("the delay resets after a socket opened", () => {
    const h = harness();
    h.client.start();
    h.last().serverClose(1006);
    assert.equal(h.scheduler.fire(), 1000);
    h.last().serverClose(1006);
    assert.equal(h.scheduler.fire(), 2000);
    h.last().open();
    h.last().serverClose(1006);
    assert.equal(h.scheduler.fire(), 1000);
  });

  test("a normal close (1000) also reconnects", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.last().serverClose(1000);
    assert.equal(h.scheduler.pending().length, 1);
  });

  test("the same alert is shown again after a reconnect is not required, but replies still go out", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.last().push(frame(ALERT_A));
    h.last().serverClose(1006);
    h.scheduler.fire();
    h.last().open();
    h.last().push(frame(ALERT_A));
    assert.deepEqual(h.last().sent, [{ type: "received", alertId: ALERT_A }]);
    assert.equal(h.alerts.length, 1);
  });

  test("an error event alone does not create a second socket", () => {
    const h = harness();
    h.client.start();
    h.last().onerror?.({});
    assert.equal(h.sockets.length, 1);
    assert.equal(h.scheduler.pending().length, 0);
  });
});

describe("panic realtime client: unreachable (upgrade refused, never opened)", () => {
  const unreachableCount = (h) =>
    h.statuses.filter((s) => s === "unreachable").length;

  test("4 consecutive closes without an open report unreachable once", () => {
    const h = harness();
    h.client.start();
    for (let i = 0; i < 3; i += 1) {
      h.last().serverClose(1006);
      assert.equal(unreachableCount(h), 0, `not yet after close ${i + 1}`);
      h.scheduler.fire();
    }
    h.last().serverClose(1006);
    assert.equal(unreachableCount(h), 1);
    assert.equal(h.statuses.at(-1), "unreachable");
    // keeps retrying, at the backoff max, without repeating the signal
    assert.equal(h.scheduler.pending().length, 1);
    assert.equal(h.scheduler.fire(), 8000);
    h.last().serverClose(1006);
    assert.equal(h.scheduler.fire(), 8000);
    h.last().serverClose(1006);
    assert.equal(unreachableCount(h), 1);
    assert.equal(h.statuses.at(-1), "unreachable");
  });

  test("a successful open resets the count and the status", () => {
    const h = harness();
    h.client.start();
    for (let i = 0; i < 4; i += 1) {
      h.last().serverClose(1006);
      h.scheduler.fire();
    }
    assert.equal(unreachableCount(h), 1);
    h.last().open();
    assert.equal(h.statuses.at(-1), "open");
    // closing the opened socket does not count as a refused attempt
    h.last().serverClose(1006);
    h.scheduler.fire();
    // three refused closes are below the threshold again
    for (let i = 0; i < 2; i += 1) {
      h.last().serverClose(1006);
      h.scheduler.fire();
    }
    h.last().serverClose(1006);
    assert.equal(unreachableCount(h), 1);
    h.scheduler.fire();
    h.last().serverClose(1006);
    assert.equal(unreachableCount(h), 2);
  });

  test("an open in between keeps the count below the threshold", () => {
    const h = harness();
    h.client.start();
    for (let i = 0; i < 3; i += 1) {
      h.last().serverClose(1006);
      h.scheduler.fire();
    }
    h.last().open();
    h.last().serverClose(1006);
    h.scheduler.fire();
    h.last().serverClose(1006);
    assert.equal(unreachableCount(h), 0);
  });

  test("4401 after unreachable still revokes", () => {
    const h = harness();
    h.client.start();
    for (let i = 0; i < 4; i += 1) {
      h.last().serverClose(1006);
      h.scheduler.fire();
    }
    h.last().serverClose(4401);
    assert.equal(h.statuses.at(-1), "revoked");
    assert.equal(h.revoked(), 1);
    assert.equal(h.scheduler.pending().length, 0);
  });
});

describe("panic realtime client: revoked session (close 4401)", () => {
  test("the constant is 4401", () => {
    assert.equal(EMERGENCY_REVOKED_CLOSE_CODE, 4401);
  });

  test("close 4401 stops for good: no reconnect, onRevoked once", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.last().serverClose(4401);
    assert.equal(h.statuses.at(-1), "revoked");
    assert.equal(h.revoked(), 1);
    assert.equal(h.scheduler.pending().length, 0);
    assert.equal(h.sockets.length, 1);
  });

  test("close 4401 during a reconnect attempt also stops", () => {
    const h = harness();
    h.client.start();
    h.last().serverClose(1006);
    h.scheduler.fire();
    h.last().serverClose(4401);
    assert.equal(h.statuses.at(-1), "revoked");
    assert.equal(h.scheduler.pending().length, 0);
    assert.equal(h.sockets.length, 2);
  });

  test("start after revoked does not reconnect", () => {
    const h = harness();
    h.client.start();
    h.last().serverClose(4401);
    h.client.start();
    assert.equal(h.sockets.length, 1);
  });
});

describe("panic realtime client: stop", () => {
  test("stop closes the socket and never reconnects", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.client.stop();
    assert.notEqual(h.last().closed, null);
    assert.equal(h.statuses.at(-1), "stopped");
    // the browser then fires close; that must not schedule a reconnect
    h.last().serverClose(1000);
    assert.equal(h.scheduler.pending().length, 0);
    assert.equal(h.sockets.length, 1);
  });

  test("stop cancels a pending reconnect", () => {
    const h = harness();
    h.client.start();
    h.last().serverClose(1006);
    assert.equal(h.scheduler.pending().length, 1);
    h.client.stop();
    assert.equal(h.scheduler.pending().length, 0);
    assert.equal(h.sockets.length, 1);
  });

  test("frames arriving after stop are ignored", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.client.stop();
    h.last().push(frame(ALERT_A));
    assert.equal(h.alerts.length, 0);
    assert.deepEqual(h.last().sent, []);
  });
});

describe("panic realtime client: acknowledge", () => {
  test("ack POSTs an empty body to the alert's ack endpoint", async () => {
    const h = harness();
    await h.client.ack(ALERT_A);
    assert.equal(h.acks.length, 1);
    assert.equal(h.acks[0].path, `/api/emergency/alerts/${ALERT_A}/ack`);
    assert.equal(h.acks[0].init.method, "POST");
    assert.deepEqual(h.acks[0].init.body ?? {}, {});
  });

  test("ack encodes the alert id in the path", async () => {
    const h = harness();
    await h.client.ack("a/b?c#d");
    assert.equal(h.acks[0].path, "/api/emergency/alerts/a%2Fb%3Fc%23d/ack");
  });

  test("ack rejects with the API error so the UI can show it", async () => {
    const boom = new Error("Sesi darurat tidak berlaku.");
    const h = harness({
      apiFetch: async () => {
        throw boom;
      },
    });
    await assert.rejects(() => h.client.ack(ALERT_A), boom);
  });

  test("ack does not need an open socket and does not touch it", async () => {
    const h = harness();
    await h.client.ack(ALERT_A);
    assert.equal(h.sockets.length, 0);
  });
});

// ---------------------------------------------------------------------------
// legend-jztb7, written from docs/briefs/sub-panic-alert-wiring.md section B and
// packages/shared/src/facility/emergency.ts (not from the implementation).
// Assumptions: apiGet is called with the path only; a frame whose type is
// "acknowledged" never reaches onAlert; the strict schemas drop anything else.

const ACKED_AT = "2026-11-14T10:00:05.000Z";
const ackFrame = (alertId = ALERT_A, extra = {}) => ({
  type: "acknowledged",
  alertId,
  acknowledgedAt: ACKED_AT,
  byName: "Rina",
  ...extra,
});

describe("panic realtime client: panic frame carries the location", () => {
  test("unitCode and areaName reach onAlert and the frame is answered", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.last().push(frame(ALERT_A, { unitCode: "P2", areaName: "Area Pria" }));
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0].unitCode, "P2");
    assert.equal(h.alerts[0].areaName, "Area Pria");
    assert.deepEqual(h.last().sent, [{ type: "received", alertId: ALERT_A }]);
  });

  test("null unitCode and areaName are valid", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.last().push(frame(ALERT_A, { unitId: null }));
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0].unitCode, null);
    assert.equal(h.alerts[0].areaName, null);
  });

  test("a frame without unitCode is ignored (strict contract)", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    const rest = frame(ALERT_A);
    delete rest.unitCode;
    h.last().push(rest);
    assert.equal(h.alerts.length, 0);
    assert.deepEqual(h.last().sent, []);
  });
});

describe("panic realtime client: acknowledged frames", () => {
  test("an acknowledged frame reaches onAcknowledged and gets no reply", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.last().push(ackFrame(ALERT_A));
    assert.equal(h.acknowledged.length, 1);
    assert.equal(h.acknowledged[0].alertId, ALERT_A);
    assert.equal(h.acknowledged[0].byName, "Rina");
    assert.equal(h.acknowledged[0].acknowledgedAt, ACKED_AT);
    assert.deepEqual(h.last().sent, []);
    assert.equal(h.alerts.length, 0, "not an alert");
  });

  test("every acknowledged frame is delivered, not once per alertId", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.last().push(ackFrame(ALERT_A));
    h.last().push(ackFrame(ALERT_A));
    h.last().push(ackFrame(ALERT_B, { byName: "Dewi" }));
    assert.equal(h.acknowledged.length, 3);
    assert.equal(h.acknowledged[2].byName, "Dewi");
    assert.deepEqual(h.last().sent, []);
  });

  test("a panic frame still works alongside acknowledged frames", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.last().push(ackFrame(ALERT_B));
    h.last().push(frame(ALERT_A));
    assert.equal(h.alerts.length, 1);
    assert.equal(h.acknowledged.length, 1);
    assert.deepEqual(h.last().sent, [{ type: "received", alertId: ALERT_A }]);
  });

  test("no onAcknowledged option: the frame is ignored without error", () => {
    const h = harness({ onAcknowledged: undefined });
    h.client.start();
    h.last().open();
    h.last().push(ackFrame(ALERT_A));
    assert.equal(h.last().closed, null);
    assert.deepEqual(h.last().sent, []);
    h.last().push(frame(ALERT_A));
    assert.equal(h.alerts.length, 1);
  });

  const invalid = {
    "alertId not a uuid": ackFrame("not-a-uuid"),
    "missing byName": (() => {
      const rest = ackFrame();
      delete rest.byName;
      return rest;
    })(),
    "acknowledgedAt not a date": ackFrame(ALERT_A, { acknowledgedAt: "soon" }),
    "unknown extra key (strict)": ackFrame(ALERT_A, { userId: "x" }),
  };
  for (const [name, payload] of Object.entries(invalid)) {
    test(`ignores an acknowledged frame with ${name}`, () => {
      const h = harness();
      h.client.start();
      h.last().open();
      h.last().push(payload);
      assert.equal(h.acknowledged.length, 0);
      assert.equal(h.alerts.length, 0);
      assert.deepEqual(h.last().sent, []);
      assert.equal(h.last().closed, null);
    });
  }

  test("frames after stop are not delivered", () => {
    const h = harness();
    h.client.start();
    h.last().open();
    h.client.stop();
    h.last().push(ackFrame(ALERT_A));
    assert.equal(h.acknowledged.length, 0);
  });
});

describe("panic realtime client: openAlerts", () => {
  const OPEN_PATH = "/api/emergency/open-alerts";
  const good = (alertId, extra = {}) =>
    frame(alertId, { unitCode: "P2", areaName: "Area Pria", ...extra });

  test("GETs the open-alerts path and returns the parsed alerts in order", async () => {
    const gets = [];
    const h = harness({
      apiGet: async (path) => {
        gets.push(path);
        return { data: { alerts: [good(ALERT_A), good(ALERT_B)] } };
      },
    });
    const result = await h.client.openAlerts();
    assert.deepEqual(gets, [OPEN_PATH]);
    assert.deepEqual(result, [good(ALERT_A), good(ALERT_B)]);
  });

  test("an empty list is an empty array", async () => {
    const h = harness({ apiGet: async () => ({ data: { alerts: [] } }) });
    assert.deepEqual(await h.client.openAlerts(), []);
  });

  test("invalid items are dropped, valid ones kept", async () => {
    const noCode = good(ALERT_B);
    delete noCode.unitCode;
    const h = harness({
      apiGet: async () => ({
        data: {
          alerts: [
            good(ALERT_A),
            noCode,
            good("not-a-uuid"),
            good(ALERT_B, { guestName: "x" }),
            { type: "acknowledged", alertId: ALERT_B },
            null,
            "oops",
            good(ALERT_B, { kind: "test" }),
          ],
        },
      }),
    });
    const result = await h.client.openAlerts();
    assert.deepEqual(
      result.map((a) => [a.alertId, a.kind]),
      [
        [ALERT_A, "press"],
        [ALERT_B, "test"],
      ],
    );
  });

  test("a request error is thrown to the caller", async () => {
    const boom = new Error("Sesi darurat tidak berlaku.");
    const h = harness({
      apiGet: async () => {
        throw boom;
      },
    });
    await assert.rejects(() => h.client.openAlerts(), boom);
  });

  test("it does not touch the socket and does not call onAlert", async () => {
    const h = harness({
      apiGet: async () => ({ data: { alerts: [good(ALERT_A)] } }),
    });
    await h.client.openAlerts();
    assert.equal(h.sockets.length, 0);
    assert.equal(h.alerts.length, 0);
  });

  test("ack still rethrows a 409 untouched", async () => {
    const conflict = Object.assign(new Error("Sudah ditangani."), {
      status: 409,
      acknowledgedBy: { displayName: "Rina" },
      acknowledgedAt: ACKED_AT,
    });
    const h = harness({
      apiFetch: async () => {
        throw conflict;
      },
    });
    await assert.rejects(() => h.client.ack(ALERT_A), conflict);
  });
});
