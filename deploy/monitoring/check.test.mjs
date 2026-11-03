import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./check.mjs";

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
