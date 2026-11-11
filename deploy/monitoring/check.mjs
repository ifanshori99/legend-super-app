#!/usr/bin/env node
// Low-footprint, one-shot readiness probe. Run from an independent machine as
// well as locally: a monitor on the same VM cannot report loss of that VM.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

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

export async function run(config, fetcher = fetch, queryAge = queryXminAge) {
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
  const channels = [
    ["email", config.ALERT_EMAIL_RELAY_URL, config.ALERT_EMAIL_RELAY_TOKEN],
    [
      "whatsapp",
      config.ALERT_WHATSAPP_RELAY_URL,
      config.ALERT_WHATSAPP_RELAY_TOKEN,
    ],
  ]
    .filter(([, url]) => url)
    .map(([name, url, token]) => [name, endpoint(url, `${name} relay`), token]);
  if (!channels.length) throw new Error("At least one alert relay is required");
  for (const [, , token] of channels)
    if (!token) throw new Error("Each configured alert relay needs a token");
  if (!config.MONITOR_STATE_FILE || !config.MONITOR_STATE_FILE.startsWith("/"))
    throw new Error("MONITOR_STATE_FILE must be an absolute path");
  let previous = {};
  try {
    previous = JSON.parse(await readFile(config.MONITOR_STATE_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const next = { ...previous };
  let deliveryFailed = false;
  for (const [name, check] of checks) {
    const ok = await check();
    for (const [channel, relay, token] of channels) {
      const key = `${name}:${channel}`;
      // First healthy observation does not generate a recovery alert.
      if (previous[key] === ok || (previous[key] === undefined && ok)) {
        next[key] = ok;
        continue;
      }
      try {
        await sendAlert(
          relay,
          token,
          {
            source: "legend-monitor",
            check: name,
            status: ok ? "recovered" : "down",
            observedAt: new Date().toISOString(),
          },
          fetcher,
        );
        next[key] = ok;
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
  await mkdir(dirname(config.MONITOR_STATE_FILE), {
    recursive: true,
    mode: 0o700,
  });
  const temp = `${config.MONITOR_STATE_FILE}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
  await rename(temp, config.MONITOR_STATE_FILE);
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
