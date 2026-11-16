#!/usr/bin/env node
// Low-footprint, one-shot readiness probe. Run from an independent machine as
// well as locally: a monitor on the same VM cannot report loss of that VM.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createAlertChannels } from "./adapters.mjs";

function endpoint(value, name) {
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.username || url.password || url.hash)
    throw new Error(`${name} is invalid`);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error(`${name} must use HTTPS or loopback HTTP`);
  return url.toString();
}

export async function probe(url, fetcher = fetch) {
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Age in seconds of the oldest open transaction that holds an id, or of the
// oldest prepared transaction, which is what pins pg_snapshot_xmin and stops
// edge catalog and PIN sync (legend-9h0kg). The age counts from xact_start (the
// start of the transaction, not of its id), so it can over-estimate: that errs
// on the side of alerting.
// psql reads the connection from the libpq environment (PGHOST, PGUSER,
// PGPASSWORD, PGDATABASE, PGSSLMODE), so no secret appears in the arguments;
// -w makes it fail instead of prompting for a password.
// Without superuser or pg_read_all_stats, xact_start of other sessions is NULL
// and the age would read 0 forever, so the query also reports whether the login
// may see them and the probe fails when it may not.
const XMIN_AGE_SQL = `SELECT (r.rolsuper OR pg_has_role(r.oid, 'pg_read_all_stats', 'USAGE')),
  coalesce(extract(epoch FROM now() - least(
    (SELECT min(xact_start) FROM pg_stat_activity WHERE backend_xid IS NOT NULL),
    (SELECT min(prepared) FROM pg_prepared_xacts)
  )), 0)::int
FROM pg_roles r WHERE r.rolname = current_user`;

// psql --tuples-only --no-align prints `t|<seconds>`.
export function parseXminAge(stdout) {
  const [visible, seconds, ...extra] = stdout.trim().split("|");
  if (visible !== "t")
    throw new Error(
      "The monitoring login needs superuser or pg_read_all_stats",
    );
  const age = Number(seconds);
  if (
    extra.length ||
    !/^\d+$/.test(seconds ?? "") ||
    !Number.isSafeInteger(age)
  )
    throw new Error("Bad xmin age");
  return age;
}

export function queryXminAge() {
  return new Promise((resolve, reject) => {
    execFile(
      "psql",
      [
        "-w",
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        XMIN_AGE_SQL,
      ],
      { timeout: 5000, env: process.env },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(parseXminAge(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

// A failed query counts as down: silence must not look healthy.
export async function xminWithinLimit(maxAgeSeconds, query = queryXminAge) {
  try {
    return (await query()) <= maxAgeSeconds;
  } catch {
    return false;
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function operationalConfig(config) {
  for (const key of ["MONITOR_TENANT_ID", "MONITOR_OUTLET_ID"])
    if (!uuid.test(config[key] ?? "")) throw new Error(`${key} must be a UUID`);
  const thresholds = {};
  for (const [key, fallback] of [
    ["MONITOR_DEVICE_MAX_AGE_SECONDS", 120],
    ["MONITOR_QUEUE_MAX_PENDING", 100],
    ["MONITOR_SYNC_MAX_AGE_SECONDS", 300],
  ]) {
    const value = Number(config[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${key} must be a positive integer`);
    thresholds[key] = value;
  }
  return thresholds;
}

/** Existing device credentials write these rows; no caller-submitted metrics. */
export function operationalQuery(config) {
  operationalConfig(config);
  const tenant = config.MONITOR_TENANT_ID;
  const outlet = config.MONITOR_OUTLET_ID;
  // Only strict UUIDs above enter SQL. Both explicit filters and local RLS scope
  // are applied even when the operator's connection can read other outlets.
  return `BEGIN READ ONLY;
SET LOCAL app.tenant_id = '${tenant}';
SET LOCAL app.outlet_ids = '["${outlet}"]';
WITH nodes AS (
  SELECT id, instance_id FROM edge_nodes
  WHERE tenant_id = '${tenant}'::uuid AND outlet_id = '${outlet}'::uuid
    AND status = 'active' AND revoked_at IS NULL
), backlog AS (
  SELECT q.edge_node_id, count(*) AS pending
  FROM edge_outbound_queue q JOIN nodes n ON n.id = q.edge_node_id
  WHERE q.tenant_id = '${tenant}'::uuid AND q.outlet_id = '${outlet}'::uuid
    AND q.status = 'pending' AND q.direction = 'edge_to_cloud'
  GROUP BY q.edge_node_id
), beats AS (
  SELECT id, status, last_seen_at FROM devices
  WHERE tenant_id = '${tenant}'::uuid AND outlet_id = '${outlet}'::uuid
    AND status = 'active' AND revoked_at IS NULL
)
SELECT json_build_object(
  'observedAt', now(),
  'devices', coalesce((SELECT json_agg(json_build_object(
    'id', id, 'status', status, 'lastSeenAt', last_seen_at)) FROM beats), '[]'::json),
  'pendingEventCount', coalesce((SELECT sum(pending) FROM backlog), 0),
  'lastSyncedAt', (SELECT CASE WHEN count(*) FILTER (WHERE s.last_acked_at IS NULL) > 0
    THEN NULL ELSE min(s.last_acked_at) END FROM backlog b
    LEFT JOIN sync_cursors s ON s.edge_node_id = b.edge_node_id
      AND s.tenant_id = '${tenant}'::uuid AND s.outlet_id = '${outlet}'::uuid
      AND s.direction = 'edge_to_cloud')
) FROM outlets o
WHERE o.tenant_id = '${tenant}'::uuid AND o.id = '${outlet}'::uuid
  AND EXISTS (SELECT 1 FROM nodes WHERE instance_id IS NOT NULL);
COMMIT;`;
}

export function queryOperational(config, execute = execFile) {
  const query = operationalQuery(config);
  return new Promise((resolve, reject) => {
    execute(
      "psql",
      [
        "-w",
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--quiet",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        query,
      ],
      { timeout: 5000, maxBuffer: 1024 * 1024, env: process.env },
      (error, stdout) => {
        if (error)
          return reject(new Error("Operational database query failed"));
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error("Invalid operational database response"));
        }
      },
    );
  });
}

const dateMs = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));

function operationalChecks(sample, limits) {
  if (
    !sample ||
    !dateMs(sample.observedAt) ||
    !Array.isArray(sample.devices) ||
    !Number.isSafeInteger(sample.pendingEventCount) ||
    sample.pendingEventCount < 0 ||
    !(sample.lastSyncedAt === null || dateMs(sample.lastSyncedAt)) ||
    sample.devices.some(
      (device) =>
        !device ||
        !uuid.test(device.id ?? "") ||
        !["active", "revoked"].includes(device.status) ||
        !(device.lastSeenAt === null || dateMs(device.lastSeenAt)),
    )
  )
    throw new Error("Invalid operational snapshot");
  const now = Date.parse(sample.observedAt);
  const deviceOk = sample.devices.every(
    (device) =>
      device.status === "revoked" ||
      (device.lastSeenAt !== null &&
        Date.parse(device.lastSeenAt) <= now &&
        now - Date.parse(device.lastSeenAt) <=
          limits.MONITOR_DEVICE_MAX_AGE_SECONDS * 1000),
  );
  const syncOk =
    sample.pendingEventCount === 0 ||
    (sample.lastSyncedAt !== null &&
      Date.parse(sample.lastSyncedAt) <= now &&
      now - Date.parse(sample.lastSyncedAt) <=
        limits.MONITOR_SYNC_MAX_AGE_SECONDS * 1000);
  return [
    ["device_heartbeat", () => deviceOk],
    [
      "queue_depth",
      () => sample.pendingEventCount <= limits.MONITOR_QUEUE_MAX_PENDING,
    ],
    ["sync_lag", () => syncOk],
  ];
}

// An adapter is an operator-provided authenticated alert relay, not an assumed
// KirimDev or email API. Relay implementations deliver to their named channel.
export async function sendAlert(url, token, alert, fetcher = fetch) {
  if (!token) throw new Error("Alert relay token is required");
  const result = await fetcher(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(alert),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!result.ok) throw new Error(`Alert relay returned ${result.status}`);
}

export async function run(
  config,
  fetcher = fetch,
  queryAge = queryXminAge,
  querySource = queryOperational,
) {
  const apiUrl = endpoint(config.API_HEALTH_URL, "API_HEALTH_URL");
  const webUrl = endpoint(config.WEB_HEALTH_URL, "WEB_HEALTH_URL");
  const checks = [
    ["api_readiness", () => probe(apiUrl, fetcher)],
    ["web", () => probe(webUrl, fetcher)],
  ];
  if (config.MONITOR_XMIN_ENABLED === "true") {
    const maxAge = Number(config.MONITOR_XMIN_MAX_AGE_SECONDS ?? 600);
    if (!Number.isInteger(maxAge) || maxAge <= 0)
      throw new Error(
        "MONITOR_XMIN_MAX_AGE_SECONDS must be a positive integer",
      );
    checks.push(["xmin_age", () => xminWithinLimit(maxAge, queryAge)]);
  }
  const relays = [
    ["email", config.ALERT_EMAIL_RELAY_URL, config.ALERT_EMAIL_RELAY_TOKEN],
    [
      "whatsapp",
      config.ALERT_WHATSAPP_RELAY_URL,
      config.ALERT_WHATSAPP_RELAY_TOKEN,
    ],
  ]
    .filter(([, url]) => url)
    .map(([name, url, token]) => [name, endpoint(url, `${name} relay`), token]);
  for (const [, , token] of relays)
    if (!token) throw new Error("Each configured alert relay needs a token");
  const channels = createAlertChannels(
    config,
    fetcher,
    relays.map(([name, url, token]) => [
      name,
      (alert) => sendAlert(url, token, alert, fetcher),
    ]),
  );
  if (!channels.length)
    throw new Error(
      "At least one alert relay is required (or a direct provider)",
    );
  if (!config.MONITOR_STATE_FILE || !config.MONITOR_STATE_FILE.startsWith("/"))
    throw new Error("MONITOR_STATE_FILE must be an absolute path");
  let previous = {};
  try {
    previous = JSON.parse(await readFile(config.MONITOR_STATE_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const next = { ...previous };
  // Persist the same logical send before I/O so ambiguous provider responses
  // retry with the same UUID and body, including after a process restart.
  const pending = { ...previous.$pending };
  next.$pending = pending;
  const save = async () => {
    await mkdir(dirname(config.MONITOR_STATE_FILE), {
      recursive: true,
      mode: 0o700,
    });
    const temp = `${config.MONITOR_STATE_FILE}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
    await rename(temp, config.MONITOR_STATE_FILE);
  };
  if (config.MONITOR_OPERATIONAL_ENABLED === "true") {
    const limits = operationalConfig(config);
    try {
      const sample = await querySource(config);
      checks.push(
        ["operational_source", () => true],
        ...operationalChecks(sample, limits),
      );
    } catch {
      checks.push(["operational_source", () => false]);
    }
  }
  let deliveryFailed = false;
  for (const [name, check] of checks) {
    const ok = await check();
    for (const [channel, deliver] of channels) {
      const key = `${name}:${channel}`;
      try {
        // Resolve ambiguous sends before planning a newer transition. The
        // provider may already have delivered the previous payload; discarding
        // it on recovery could leave the operator seeing an unresolved outage.
        if (pending[key]) {
          await deliver(pending[key]);
          next[key] = pending[key].status === "recovered";
          delete pending[key];
          await save();
        }
        // First healthy observation does not generate a recovery alert.
        if (next[key] === ok || (next[key] === undefined && ok)) {
          next[key] = ok;
          continue;
        }
        const status = ok ? "recovered" : "down";
        if (pending[key]?.status !== status)
          pending[key] = {
            source: "legend-monitor",
            check: name,
            status,
            observedAt: new Date().toISOString(),
            deliveryId: randomUUID(),
            ...(config.MONITOR_OPERATIONAL_ENABLED === "true"
              ? {
                  tenantId: config.MONITOR_TENANT_ID,
                  outletId: config.MONITOR_OUTLET_ID,
                }
              : {}),
          };
        await save();
        await deliver(pending[key]);
        next[key] = ok;
        delete pending[key];
        await save();
      } catch {
        // Keep the previous state so the next run retries delivery.
        deliveryFailed = true;
        console.error(
          JSON.stringify({
            level: "error",
            event: "alert_delivery_failed",
            check: name,
            channel,
          }),
        );
      }
    }
    console.log(
      JSON.stringify({
        level: ok ? "info" : "error",
        event: "health_check",
        check: name,
        status: ok ? "ok" : "down",
      }),
    );
  }
  await save();
  if (deliveryFailed)
    throw new Error("One or more alerts could not be delivered");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run(process.env).catch((error) => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "monitor_failed",
        message: error.message,
      }),
    );
    process.exitCode = 1;
  });
}
