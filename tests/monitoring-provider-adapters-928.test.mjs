import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createAlertChannels } from "../deploy/monitoring/adapters.mjs";
import {
  operationalQuery,
  queryOperational,
  run,
} from "../deploy/monitoring/check.mjs";

const scope = {
  MONITOR_TENANT_ID: "22345678-1234-4234-8234-123456789abc",
  MONITOR_OUTLET_ID: "32345678-1234-4234-8234-123456789abc",
};
const email = {
  ALERT_EMAIL_PROVIDER: "brevo",
  ALERT_BREVO_API_KEY: "test-key",
  ALERT_EMAIL_FROM: "monitor@example.test",
  ALERT_EMAIL_TO: "ops@example.test",
};
const whatsapp = {
  ALERT_WHATSAPP_PROVIDER: "kirimdev",
  ALERT_KIRIMDEV_API_KEY: `kdv_live_${"a".repeat(24)}`,
  ALERT_WHATSAPP_PHONE_NUMBER_ID: "106540352242922",
  ALERT_WHATSAPP_TO: "+628123456789",
  ALERT_WHATSAPP_TEMPLATE_NAME: "operational_alert",
  ALERT_WHATSAPP_TEMPLATE_LANGUAGE: "id",
};
const alert = {
  source: "legend-monitor",
  check: "device_heartbeat",
  status: "down",
  observedAt: "2026-11-16T12:00:00.000Z",
  deliveryId: "42345678-1234-4234-8234-123456789abc",
  tenantId: scope.MONITOR_TENANT_ID,
  outletId: scope.MONITOR_OUTLET_ID,
};

test("legend-4lm6: Brevo receives authenticated email with a stable UUID; duplicate acceptance is acknowledged", async () => {
  const requests = [];
  const [, send] = createAlertChannels(email, async (url, options) => {
    requests.push({ url, options });
    return { status: 400, json: async () => ({ code: "duplicate_parameter" }) };
  })[0];
  await send(alert);
  await send(alert);
  assert.equal(requests[0].url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.headers["api-key"], "test-key");
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.sender, { email: "monitor@example.test" });
  assert.deepEqual(body.to, [{ email: "ops@example.test" }]);
  assert.equal(body.headers.idempotencyKey, alert.deliveryId);
  assert.match(body.textContent, /device_heartbeat/);
  assert.equal(requests[1].options.body, requests[0].options.body);
});

test("legend-4lm6: Kirimdev uses the fixed production sender, approved template and accepts only a message acknowledgement", async () => {
  let status = 202;
  let data = { id: "msg_accepted" };
  const requests = [];
  const [, send] = createAlertChannels(whatsapp, async (url, options) => {
    requests.push({ url, options });
    return { status, json: async () => ({ data }) };
  })[0];
  await send(alert);
  const { url, options } = requests[0];
  assert.equal(url, "https://api.kirimdev.com/v1/106540352242922/messages");
  assert.equal(options.redirect, "error");
  assert.equal(
    options.headers.authorization,
    `Bearer ${whatsapp.ALERT_KIRIMDEV_API_KEY}`,
  );
  assert.equal(options.headers["Idempotency-Key"], alert.deliveryId);
  const body = JSON.parse(options.body);
  assert.equal(body.messaging_product, "whatsapp");
  assert.equal(body.to, "+628123456789");
  assert.equal(body.type, "template");
  assert.equal(body.template.name, "operational_alert");
  assert.deepEqual(body.template.language, { code: "id" });
  assert.match(
    body.template.components[0].parameters[0].text,
    /device_heartbeat/,
  );
  data = {};
  await assert.rejects(send(alert), /Kirimdev alert delivery failed/);
  status = 503;
  data = { id: "not-accepted" };
  await assert.rejects(send(alert), /Kirimdev alert delivery failed/);
});

test("legend-4lm6: provider auth/transient errors never acknowledge delivery and missing sender/route fails before network", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return {
      status: 401,
      json: async () => ({ message: "secret response must not escape" }),
    };
  };
  const [, send] = createAlertChannels(email, fetcher)[0];
  await assert.rejects(
    send(alert),
    (error) =>
      /401/.test(error.message) && !/secret response/.test(error.message),
  );
  assert.throws(
    () =>
      createAlertChannels(
        { ...whatsapp, ALERT_WHATSAPP_PHONE_NUMBER_ID: "" },
        fetcher,
      ),
    /PHONE_NUMBER_ID/,
  );
  assert.throws(
    () =>
      createAlertChannels(
        { ...whatsapp, ALERT_WHATSAPP_TEMPLATE_NAME: "" },
        fetcher,
      ),
    /TEMPLATE_NAME/,
  );
  assert.throws(
    () => createAlertChannels({ ...email, ALERT_EMAIL_TO: "" }, fetcher),
    /ALERT_EMAIL_TO/,
  );
  assert.throws(
    () => createAlertChannels(email, fetcher, [["email", async () => {}]]),
    /Choose one/,
  );
  assert.equal(calls, 1);
});

test("legend-4lm6: ambiguous provider response retries the persisted identical payload and new incidents get a new UUID", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "legend-provider-928-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    ...whatsapp,
    API_HEALTH_URL: "https://api.example.test/api/health/ready",
    WEB_HEALTH_URL: "https://web.example.test/",
    MONITOR_STATE_FILE: join(directory, "state.json"),
  };
  const requests = [];
  let acknowledged = false;
  let healthy = false;
  const fetcher = async (url, options) => {
    if (options.method !== "POST")
      return { ok: !url.includes("api.example") || healthy };
    requests.push(options);
    if (!acknowledged) throw new Error("response lost");
    return {
      status: 200,
      json: async () => ({ data: { id: "msg_accepted" } }),
    };
  };
  await assert.rejects(run(config, fetcher), /alerts could not be delivered/);
  acknowledged = true;
  await run(config, fetcher);
  assert.equal(
    requests[0].headers["Idempotency-Key"],
    requests[1].headers["Idempotency-Key"],
  );
  assert.equal(requests[0].body, requests[1].body);
  healthy = true;
  await run(config, fetcher);
  healthy = false;
  await run(config, fetcher);
  assert.notEqual(
    requests[2].headers["Idempotency-Key"],
    requests[1].headers["Idempotency-Key"],
  );
  assert.notEqual(
    requests[3].headers["Idempotency-Key"],
    requests[1].headers["Idempotency-Key"],
  );
});

test("legend-4lm6: production operational source reads scoped trusted registry and queue rows without connection secrets in arguments", async () => {
  const query = operationalQuery(scope);
  assert.match(query, /BEGIN READ ONLY/);
  assert.match(query, /SET LOCAL app\.tenant_id/);
  assert.match(query, /SET LOCAL app\.outlet_ids/);
  assert.match(query, /FROM devices/);
  assert.match(query, /FROM edge_nodes/);
  assert.match(query, /FROM edge_outbound_queue/);
  assert.match(query, /sync_cursors/);
  assert.doesNotMatch(query, /app\.outlet_ids = '\*'/);
  assert.throws(
    () =>
      operationalQuery({
        ...scope,
        MONITOR_OUTLET_ID: "'; DROP TABLE devices; --",
      }),
    /MONITOR_OUTLET_ID/,
  );
  let calls = 0;
  const result = await queryOperational(
    scope,
    (command, args, options, callback) => {
      calls++;
      assert.equal(command, "psql");
      assert.ok(args.includes("ON_ERROR_STOP=1"));
      assert.ok(args.includes("-w"));
      assert.equal(args.at(-1), query);
      assert.equal(options.timeout, 5000);
      callback(
        null,
        JSON.stringify({
          observedAt: alert.observedAt,
          devices: [],
          pendingEventCount: 0,
          lastSyncedAt: null,
        }),
      );
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.observedAt, alert.observedAt);
  await assert.rejects(
    queryOperational(scope, (_command, _args, _options, callback) =>
      callback(new Error("connection secret")),
    ),
    /Operational database query failed/,
  );
});

function databaseSource(scopeConfig, setup) {
  assert.ok(
    process.env.STARTER_TEST_DATABASE_URL,
    "Run pnpm test to create an isolated database",
  );
  const connection = new URL(process.env.STARTER_TEST_DATABASE_URL);
  return queryOperational(scopeConfig, (command, args, options, callback) => {
    const query = args.at(-1);
    execFile(
      command,
      [...args.slice(0, -1), setup, "--command", query],
      {
        ...options,
        env: {
          ...options.env,
          PGHOST: connection.hostname,
          PGPORT: connection.port,
          PGUSER: decodeURIComponent(connection.username),
          PGPASSWORD: decodeURIComponent(connection.password),
          PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
          ...(connection.searchParams.has("sslmode")
            ? { PGSSLMODE: connection.searchParams.get("sslmode") }
            : {}),
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          // Only print the class of failure, never connection details or raw SQL.
          const reason =
            [
              "permission denied",
              "read-only",
              "cannot execute",
              "does not exist",
              "syntax error",
              "connection refused",
              "password authentication failed",
              "transaction",
              "invalid input",
            ].find((text) => stderr.toLowerCase().includes(text)) ??
            "unclassified";
          console.error(`Monitoring DB fixture failure: ${reason}`);
        }
        callback(error, stdout);
      },
    );
  });
}

// Temporary tables shadow public tables only in this psql session. This runs
// the production source SQL in real PostgreSQL without sharing mutable fixtures.
const monitoringTables = `
CREATE TEMP TABLE outlets (tenant_id uuid, id uuid);
CREATE TEMP TABLE edge_nodes (tenant_id uuid, outlet_id uuid, id uuid, status text,
  revoked_at timestamptz, last_heartbeat_at timestamptz, instance_id uuid);
CREATE TEMP TABLE devices (tenant_id uuid, outlet_id uuid, id uuid, status text,
  revoked_at timestamptz, last_seen_at timestamptz);
CREATE TEMP TABLE edge_outbound_queue (tenant_id uuid, outlet_id uuid, edge_node_id uuid,
  status text, direction text);
CREATE TEMP TABLE sync_cursors (tenant_id uuid, outlet_id uuid, edge_node_id uuid,
  direction text, last_acked_at timestamptz);
INSERT INTO outlets VALUES ('${scope.MONITOR_TENANT_ID}', '${scope.MONITOR_OUTLET_ID}');
INSERT INTO edge_nodes VALUES ('${scope.MONITOR_TENANT_ID}', '${scope.MONITOR_OUTLET_ID}',
  '52345678-1234-4234-8234-123456789abc', 'active', NULL, now() - interval '7 days',
  '62345678-1234-4234-8234-123456789abc');
INSERT INTO devices VALUES ('${scope.MONITOR_TENANT_ID}', '${scope.MONITOR_OUTLET_ID}',
  '72345678-1234-4234-8234-123456789abc', 'active', NULL, now());
INSERT INTO devices VALUES ('82345678-1234-4234-8234-123456789abc', '${scope.MONITOR_OUTLET_ID}',
  '92345678-1234-4234-8234-123456789abc', 'active', NULL, NULL);
INSERT INTO devices VALUES ('${scope.MONITOR_TENANT_ID}', 'a2345678-1234-4234-8234-123456789abc',
  'b2345678-1234-4234-8234-123456789abc', 'active', NULL, NULL);
`;

test("legend-4lm6 review P1: a healthy local device is not offline because the edge boot timestamp is old", async () => {
  const sample = await databaseSource(scope, monitoringTables);
  assert.equal(sample.devices.length, 1);
  assert.equal(sample.devices[0].id, "72345678-1234-4234-8234-123456789abc");
  assert.equal(sample.pendingEventCount, 0);
});

test("legend-4lm6 review P1: nonexistent outlet and cloud-only DB cannot produce an empty healthy operational source", async () => {
  await assert.rejects(
    databaseSource(
      { ...scope, MONITOR_OUTLET_ID: "c2345678-1234-4234-8234-123456789abc" },
      monitoringTables,
    ),
    /Invalid operational database response/,
  );
  await assert.rejects(
    databaseSource(
      scope,
      `${monitoringTables}\nUPDATE edge_nodes SET instance_id = NULL;`,
    ),
    /Invalid operational database response/,
  );
});

test("legend-4lm6 review P2: recovery follows an ambiguous down attempt even when the first healthy sample arrives before retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "legend-recovery-928-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    ...whatsapp,
    API_HEALTH_URL: "https://api.example.test/api/health/ready",
    WEB_HEALTH_URL: "https://web.example.test/",
    MONITOR_STATE_FILE: join(directory, "state.json"),
  };
  let healthy = false;
  let first = true;
  const statuses = [];
  const fetcher = async (url, options) => {
    if (options.method !== "POST")
      return { ok: !url.includes("api.example") || healthy };
    const body = JSON.parse(options.body);
    statuses.push(
      body.template.components[0].parameters[0].text.includes("recovered")
        ? "recovered"
        : "down",
    );
    if (first) {
      first = false;
      throw new Error("accepted but response lost");
    }
    return { status: 200, json: async () => ({ data: { id: "accepted" } }) };
  };
  await assert.rejects(run(config, fetcher), /alerts could not be delivered/);
  healthy = true;
  await run(config, fetcher);
  assert.equal(statuses.at(-1), "recovered");
});
