import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../deploy/monitoring/check.mjs";

const observedAt = "2026-11-16T12:00:00.000Z";
const deviceId = "12345678-1234-4234-8234-123456789abc";

function snapshot(overrides = {}) {
  return {
    observedAt,
    devices: [{ id: deviceId, status: "active", lastSeenAt: observedAt }],
    pendingEventCount: 0,
    lastSyncedAt: null,
    ...overrides,
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "legend-monitor-928-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    API_HEALTH_URL: "https://api.example.test/api/health/ready",
    WEB_HEALTH_URL: "https://web.example.test/",
    ALERT_EMAIL_RELAY_URL: "https://relay.example.test/email",
    ALERT_EMAIL_RELAY_TOKEN: "test-email-token",
    ALERT_WHATSAPP_RELAY_URL: "https://relay.example.test/whatsapp",
    ALERT_WHATSAPP_RELAY_TOKEN: "test-whatsapp-token",
    MONITOR_STATE_FILE: join(directory, "state.json"),
    MONITOR_OPERATIONAL_ENABLED: "true",
    MONITOR_TENANT_ID: "22345678-1234-4234-8234-123456789abc",
    MONITOR_OUTLET_ID: "32345678-1234-4234-8234-123456789abc",
    MONITOR_DEVICE_MAX_AGE_SECONDS: "120",
    MONITOR_QUEUE_MAX_PENDING: "100",
    MONITOR_SYNC_MAX_AGE_SECONDS: "300",
  };
}

function relayRecorder(alerts, accepts = () => true) {
  return async (url, options = {}) => {
    if (options.method !== "POST") return { ok: true };
    assert.equal(options.redirect, "error");
    assert.match(options.headers.authorization, /^Bearer test-/);
    const alert = JSON.parse(options.body);
    const channel = url.endsWith("whatsapp") ? "whatsapp" : "email";
    alerts.push({ channel, check: alert.check, status: alert.status });
    return { ok: accepts(channel), status: 503 };
  };
}

test("legend-4lm6: trusted device, queue and sync failures route to both channels once, then recover", async (t) => {
  const config = await fixture(t);
  const alerts = [];
  let sample = snapshot({
    devices: [
      {
        id: deviceId,
        status: "active",
        lastSeenAt: "2026-11-16T11:57:59.000Z",
      },
    ],
    pendingEventCount: 101,
    lastSyncedAt: "2026-11-16T11:54:59.000Z",
  });
  let reads = 0;
  const source = async (scope) => {
    reads++;
    assert.equal(scope.MONITOR_TENANT_ID, config.MONITOR_TENANT_ID);
    assert.equal(scope.MONITOR_OUTLET_ID, config.MONITOR_OUTLET_ID);
    return sample;
  };
  const fetcher = relayRecorder(alerts);
  await run(config, fetcher, undefined, source);
  await run(config, fetcher, undefined, source);
  sample = snapshot();
  await run(config, fetcher, undefined, source);
  assert.equal(reads, 3);
  for (const check of ["device_heartbeat", "queue_depth", "sync_lag"])
    for (const channel of ["email", "whatsapp"])
      assert.deepEqual(
        alerts.filter(
          (alert) => alert.check === check && alert.channel === channel,
        ),
        [
          { channel, check, status: "down" },
          { channel, check, status: "recovered" },
        ],
      );
});

test("legend-4lm6: use source time, allow threshold boundary, ignore revoked devices and empty-queue sync age", async (t) => {
  const config = await fixture(t);
  const alerts = [];
  const source = async () =>
    snapshot({
      devices: [
        {
          id: deviceId,
          status: "active",
          lastSeenAt: "2026-11-16T11:58:00.000Z",
        },
        {
          id: "42345678-1234-4234-8234-123456789abc",
          status: "revoked",
          lastSeenAt: null,
        },
      ],
      pendingEventCount: 100,
      lastSyncedAt: "2026-11-16T11:55:00.000Z",
    });
  await run(config, relayRecorder(alerts), undefined, source);
  await run(config, relayRecorder(alerts), undefined, async () => snapshot());
  assert.deepEqual(alerts, []);
  const state = JSON.parse(await readFile(config.MONITOR_STATE_FILE, "utf8"));
  assert.equal(state["device_heartbeat:email"], true);
  assert.equal(state["queue_depth:email"], true);
  assert.equal(state["sync_lag:email"], true);
});

test("legend-4lm6: never-seen active devices and an unsynced nonempty queue are unhealthy", async (t) => {
  const config = await fixture(t);
  const alerts = [];
  await run(config, relayRecorder(alerts), undefined, async () =>
    snapshot({
      devices: [{ id: deviceId, status: "active", lastSeenAt: null }],
      pendingEventCount: 1,
    }),
  );
  assert.deepEqual(
    alerts
      .filter((alert) => alert.channel === "email")
      .map((alert) => alert.check)
      .sort(),
    ["device_heartbeat", "sync_lag"],
  );
});

test("legend-4lm6: failed or malformed operational observations alert unavailable and recover only after a valid source", async (t) => {
  const config = await fixture(t);
  const alerts = [];
  const fetcher = relayRecorder(alerts);
  await run(config, fetcher, undefined, async () => {
    throw new Error("database unavailable");
  });
  await run(config, fetcher, undefined, async () =>
    snapshot({ pendingEventCount: "bad" }),
  );
  await run(config, fetcher, undefined, async () => snapshot());
  assert.deepEqual(
    alerts.filter((alert) => alert.channel === "email"),
    [
      { channel: "email", check: "operational_source", status: "down" },
      { channel: "email", check: "operational_source", status: "recovered" },
    ],
  );
});

test("legend-4lm6: failed WhatsApp delivery retries independently without resending acknowledged email", async (t) => {
  const config = await fixture(t);
  const alerts = [];
  let whatsappUp = false;
  const fetcher = relayRecorder(
    alerts,
    (channel) => channel === "email" || whatsappUp,
  );
  const source = async () =>
    snapshot({ pendingEventCount: 101, lastSyncedAt: observedAt });
  await assert.rejects(
    run(config, fetcher, undefined, source),
    /alerts could not be delivered/,
  );
  const state = JSON.parse(await readFile(config.MONITOR_STATE_FILE, "utf8"));
  assert.equal(state["queue_depth:email"], false);
  assert.equal(state["queue_depth:whatsapp"], undefined);
  whatsappUp = true;
  await run(config, fetcher, undefined, source);
  assert.deepEqual(alerts, [
    { channel: "email", check: "queue_depth", status: "down" },
    { channel: "whatsapp", check: "queue_depth", status: "down" },
    { channel: "whatsapp", check: "queue_depth", status: "down" },
  ]);
});

test("legend-4lm6: enabled operational monitoring requires explicit tenant and outlet scope before reading", async (t) => {
  const config = await fixture(t);
  let reads = 0;
  const source = async () => {
    reads++;
    return snapshot();
  };
  await assert.rejects(
    run(
      { ...config, MONITOR_TENANT_ID: "" },
      relayRecorder([]),
      undefined,
      source,
    ),
    /MONITOR_TENANT_ID/,
  );
  await assert.rejects(
    run(
      { ...config, MONITOR_OUTLET_ID: "not-an-id" },
      relayRecorder([]),
      undefined,
      source,
    ),
    /MONITOR_OUTLET_ID/,
  );
  assert.equal(reads, 0);
});

test("legend-4lm6: disabled operational monitoring never reads the database source", async (t) => {
  const config = await fixture(t);
  await run(
    { ...config, MONITOR_OPERATIONAL_ENABLED: "false" },
    relayRecorder([]),
    undefined,
    async () => {
      assert.fail("disabled source must not be queried");
    },
  );
});
