// KDS station realtime client (WS-04, bead legend-dsbqr). Root node:test suite,
// no database, no browser: a fake socket and scheduler stand in for WebSocket
// and setTimeout. Proves the credential carriers (device and live acting-staff
// subprotocols, never the URL), the cursor handling and the close codes.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { registerWebAlias } from "./helpers/web-alias.mjs";
import {
  ticketItems,
  tickets,
} from "../packages/shared/src/kitchen/fixtures.ts";

const OUTLET = "6f1c2f64-5a0e-4c0e-9d2b-1b7c6a0f1b01";
const STATION = tickets[0].stationId;
const TICKET = {
  ...tickets[0],
  tableLabel: null,
  channel: "dine_in",
  items: ticketItems.filter((item) => item.ticketId === tickets[0].id),
};
const API = "https://api.example.test";

let createKdsRealtimeClient;
let kdsRealtimeProtocols;
let kdsRealtimeUrl;

before(async () => {
  registerWebAlias();
  ({ createKdsRealtimeClient, kdsRealtimeProtocols, kdsRealtimeUrl } =
    await import("../apps/web/src/features/ws04-kds/kds-realtime.ts"));
});

class FakeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.closed = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
  open() {
    this.onopen?.({});
  }
  push(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  serverClose(code) {
    this.onclose?.({ code });
  }
}

function fakeScheduler() {
  const timers = [];
  return {
    setTimeout(fn, ms) {
      const timer = { fn, ms, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
    fire() {
      const timer = timers.find((t) => !t.cancelled && !t.fired);
      assert.ok(timer, "expected a pending reconnect timer");
      timer.fired = true;
      timer.fn();
      return timer.ms;
    },
  };
}

function ticketFrame(sequence) {
  return {
    type: "ticket",
    stationId: STATION,
    entry: { sequence, ticket: TICKET },
  };
}

function harness(options = {}) {
  const sockets = [];
  const tickets = [];
  const statuses = [];
  const resyncs = [];
  const hellos = [];
  const scheduler = fakeScheduler();
  const client = createKdsRealtimeClient({
    apiOrigin: API,
    outletId: OUTLET,
    stationId: STATION,
    after: 5,
    socketFactory: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    getProtocols: () => ["legend-kds.v1"],
    onTicket: (entry) => tickets.push(entry.sequence),
    onHello: (sequence) => hellos.push(sequence),
    onResync: (sequence) => resyncs.push(sequence),
    onStatus: (status) => statuses.push(status),
    scheduler,
    backoff: { baseMs: 100, maxMs: 400 },
    ...options,
  });
  return { client, sockets, tickets, statuses, resyncs, hellos, scheduler };
}

describe("kdsRealtimeProtocols", () => {
  test("offers the device and the live acting-staff token as subprotocols", () => {
    assert.deepEqual(
      kdsRealtimeProtocols({
        getDeviceToken: () => "dev_abc123",
        readActingStaffToken: () => "pas_xyz789",
      }),
      [
        "legend-kds.v1",
        "legend-kds-device.dev_abc123",
        "legend-kds-staff.pas_xyz789",
      ],
    );
  });

  test("an expired acting-staff token is read as null and left out", () => {
    // readActingStaffToken answers null once expiresAt has passed.
    assert.deepEqual(
      kdsRealtimeProtocols({
        getDeviceToken: () => "dev_abc123",
        readActingStaffToken: () => null,
      }),
      ["legend-kds.v1", "legend-kds-device.dev_abc123"],
    );
  });

  test("the real readers drop an expired acting-staff token and keep a live one", () => {
    const store = () => {
      const data = new Map();
      return {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: (key) => data.delete(key),
      };
    };
    const local = store();
    const session = store();
    local.setItem("legend.device.token", "dev_real1");
    session.setItem(
      "legend-acting-staff",
      JSON.stringify({
        token: "pas_expired",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    globalThis.window = {
      localStorage: local,
      sessionStorage: session,
      location: { pathname: "/kds", assign() {} },
    };
    try {
      assert.deepEqual(kdsRealtimeProtocols(), [
        "legend-kds.v1",
        "legend-kds-device.dev_real1",
      ]);
    } finally {
      delete globalThis.window;
    }
  });

  test("no tokens leaves only the base protocol", () => {
    assert.deepEqual(
      kdsRealtimeProtocols({
        getDeviceToken: () => null,
        readActingStaffToken: () => null,
      }),
      ["legend-kds.v1"],
    );
  });
});

describe("kdsRealtimeUrl", () => {
  test("builds a wss URL with outlet, station and cursor, no token", () => {
    const url = kdsRealtimeUrl(API, OUTLET, STATION, 7);
    assert.equal(
      url,
      `wss://api.example.test/api/outlets/${OUTLET}/kitchen/stations/${STATION}/realtime?after=7`,
    );
    assert.ok(!/token|pas_|dev_/i.test(url));
  });

  test("omits after without a cursor, uses ws for http, encodes ids", () => {
    const url = kdsRealtimeUrl("http://localhost:4000", "a/b", "c d", null);
    assert.equal(
      url,
      "ws://localhost:4000/api/outlets/a%2Fb/kitchen/stations/c%20d/realtime",
    );
  });
});

describe("createKdsRealtimeClient", () => {
  test("connects with the cursor in the URL and the protocols from getProtocols", () => {
    const { client, sockets, statuses } = harness({
      getProtocols: () => ["legend-kds.v1", "legend-kds-device.dev_abc123"],
    });
    client.start();
    assert.equal(sockets.length, 1);
    assert.equal(
      sockets[0].url,
      `wss://api.example.test/api/outlets/${OUTLET}/kitchen/stations/${STATION}/realtime?after=5`,
    );
    assert.deepEqual(sockets[0].protocols, [
      "legend-kds.v1",
      "legend-kds-device.dev_abc123",
    ]);
    assert.ok(!sockets[0].url.includes("dev_abc123"));
    sockets[0].open();
    assert.deepEqual(statuses, ["connecting", "open"]);
  });

  test("passes only tickets above the cursor, in order, and ignores bad frames", () => {
    const { client, sockets, tickets, hellos } = harness();
    client.start();
    const socket = sockets[0];
    socket.open();
    socket.push({ type: "hello", stationId: STATION, sequence: 9 });
    socket.push(ticketFrame(5)); // at the cursor: replay, ignored
    socket.push(ticketFrame(6));
    socket.push(ticketFrame(6)); // duplicate
    socket.push(ticketFrame(7));
    socket.push({ type: "nonsense" });
    socket.onmessage({ data: "not json" });
    socket.onmessage({ data: new ArrayBuffer(2) });
    assert.deepEqual(hellos, [9]);
    assert.deepEqual(tickets, [6, 7]);
    assert.equal(client.cursor(), 7);
  });

  test("reconnects with backoff and asks after the last applied sequence", () => {
    const { client, sockets, scheduler, tickets } = harness();
    client.start();
    sockets[0].open();
    sockets[0].push(ticketFrame(6));
    sockets[0].serverClose(1006);
    assert.equal(scheduler.fire(), 100);
    assert.ok(sockets[1].url.endsWith("realtime?after=6"));
    sockets[1].serverClose(1006); // never opened: delay doubles
    assert.equal(scheduler.fire(), 200);
    sockets[2].serverClose(1006);
    assert.equal(scheduler.fire(), 400);
    sockets[3].serverClose(1006);
    assert.equal(scheduler.fire(), 400); // capped
    sockets[4].open();
    sockets[4].serverClose(1006);
    assert.equal(scheduler.fire(), 100); // reset by the open
    assert.deepEqual(tickets, [6]);
  });

  test("a throwing onTicket does not advance the cursor", () => {
    let calls = 0;
    const { client, sockets } = harness({
      onTicket: () => {
        calls += 1;
        throw new Error("render failed");
      },
    });
    client.start();
    sockets[0].open();
    sockets[0].push(ticketFrame(6));
    assert.equal(calls, 1);
    assert.equal(client.cursor(), 5);
  });

  test("close 4409 pauses, calls onResync, and resume reconnects from the snapshot cursor", () => {
    const { client, sockets, resyncs, statuses, scheduler } = harness();
    client.start();
    sockets[0].open();
    sockets[0].push({ type: "resync", stationId: STATION, sequence: 40 });
    sockets[0].serverClose(4409);
    assert.deepEqual(resyncs, [40]);
    assert.equal(statuses.at(-1), "resync");
    assert.equal(sockets.length, 1); // no automatic reconnect
    assert.throws(() => scheduler.fire());
    client.resume(40);
    assert.equal(sockets.length, 2);
    assert.ok(sockets[1].url.endsWith("realtime?after=40"));
    assert.equal(client.cursor(), 40);
  });

  test("close 1008 stops for good", () => {
    const { client, sockets, statuses, scheduler } = harness();
    client.start();
    sockets[0].serverClose(1008);
    assert.equal(statuses.at(-1), "denied");
    assert.throws(() => scheduler.fire());
    client.resume(10);
    assert.equal(sockets.length, 1);
  });

  test("stop closes the socket, cancels the timer, and ignores a late close", () => {
    const { client, sockets, scheduler, statuses } = harness();
    client.start();
    sockets[0].open();
    sockets[0].serverClose(1006);
    client.stop();
    assert.throws(() => scheduler.fire());
    assert.equal(statuses.at(-1), "stopped");
    client.start();
    const socket = sockets.at(-1);
    client.stop();
    assert.deepEqual(socket.closed, { code: 1000, reason: "stopped" });
  });

  test("protocols are read again on every connect", () => {
    let token = "pas_one";
    const { client, sockets, scheduler } = harness({
      getProtocols: () => ["legend-kds.v1", `legend-kds-staff.${token}`],
    });
    client.start();
    sockets[0].serverClose(1006);
    token = "pas_two";
    scheduler.fire();
    assert.equal(sockets[0].protocols[1], "legend-kds-staff.pas_one");
    assert.equal(sockets[1].protocols[1], "legend-kds-staff.pas_two");
  });
});
