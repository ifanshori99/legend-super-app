import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseXminAge, run } from "../deploy/monitoring/check.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "legend-monitor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    API_HEALTH_URL: "https://api.example.test/api/health/ready",
    WEB_HEALTH_URL: "https://web.example.test/",
    ALERT_EMAIL_RELAY_URL: "https://relay.example.test/email",
    ALERT_EMAIL_RELAY_TOKEN: "test-only",
    MONITOR_STATE_FILE: join(directory, "state.json"),
  };
}

test("legend-az9 alerts once per failure and sends recovery", async (t) => {
  const config = await fixture(t);
  const statuses = [];
  let apiUp = false;
  const fetcher = async (url, options) => {
    if (options.method === "POST") {
      statuses.push(JSON.parse(options.body).status);
      return { ok: true };
    }
    return { ok: !url.includes("api.example") || apiUp };
  };
  await run(config, fetcher);
  await run(config, fetcher);
  apiUp = true;
  await run(config, fetcher);
  assert.deepEqual(statuses, ["down", "recovered"]);
});

test("legend-az9 retries a failed relay delivery and rejects missing routing", async (t) => {
  const config = await fixture(t);
  let relayUp = false;
  const fetcher = async (url, options) => {
    if (options.method === "POST") return { ok: relayUp, status: 503 };
    return { ok: !url.includes("api.example") };
  };
  await assert.rejects(run(config, fetcher), /alerts could not be delivered/);
  const state = JSON.parse(await readFile(config.MONITOR_STATE_FILE, "utf8"));
  assert.equal(state["api_readiness:email"], undefined);
  relayUp = true;
  await run(config, fetcher);
  const updated = JSON.parse(await readFile(config.MONITOR_STATE_FILE, "utf8"));
  assert.equal(updated["api_readiness:email"], false);
  await assert.rejects(
    run({ ...config, ALERT_EMAIL_RELAY_URL: "" }, fetcher),
    /relay is required/,
  );
});

test("legend-9h0kg alerts when the oldest open transaction is older than the limit", async (t) => {
  const config = {
    ...(await fixture(t)),
    MONITOR_XMIN_ENABLED: "true",
    MONITOR_XMIN_MAX_AGE_SECONDS: "600",
  };
  const alerts = [];
  const fetcher = async (url, options) => {
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      alerts.push(`${body.check}:${body.status}`);
    }
    return { ok: true };
  };
  let age = 601;
  await run(config, fetcher, async () => age);
  await run(config, fetcher, async () => age);
  age = 600;
  await run(config, fetcher, async () => age);
  await run(config, fetcher, async () => {
    throw new Error("psql missing");
  });
  assert.deepEqual(alerts, [
    "xmin_age:down",
    "xmin_age:recovered",
    "xmin_age:down",
  ]);
  const off = await fixture(t);
  await run(off, fetcher, async () => {
    throw new Error("must not run when disabled");
  });
});

test("legend-9h0kg xmin probe output: a login that cannot see other sessions is an error, not age 0", () => {
  assert.equal(parseXminAge("t|601\n"), 601);
  assert.equal(parseXminAge("t|0\n"), 0);
  assert.throws(() => parseXminAge("f|0\n"), /pg_read_all_stats/);
  assert.throws(() => parseXminAge(""), /pg_read_all_stats/);
  assert.throws(() => parseXminAge("t|\n"), /Bad xmin age/);
  assert.throws(() => parseXminAge("t|abc\n"), /Bad xmin age/);
  assert.throws(() => parseXminAge("t|1|2\n"), /Bad xmin age/);
});
