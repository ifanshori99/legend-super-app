import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  new URL("../scripts/prepare.mjs", import.meta.url),
  "utf8",
).replace(/import[\s\S]*?from "[^"]+";/g, "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function prepare(existing = {}, managed = true) {
  const env = {
    DATABASE_URL: "postgresql://starter:owner@127.0.0.1:55432/development",
    APP_DATABASE_URL:
      "postgresql://legend_runtime_1111111111111111:runtime@127.0.0.1:55432/development",
    ...existing,
  };
  const writes = [];
  const provisioned = [];
  const messages = [];
  const fakeProcess = { env };
  const dependencies = {
    process: fakeProcess,
    URL,
    assertNode() {},
    async prepareEnvironment() {},
    runPnpm() {},
    root: "/test/project",
    managesLocalDatabase: () => managed,
    async provisionAppRole() {},
    async provisionRoles(options) {
      provisioned.push(options);
    },
    async prepareDevelopmentPublicSite() {},
    randomBytes: (length) => Buffer.alloc(length, 2),
    appendFileSync: (...args) => writes.push(args),
    resolve,
    console: {
      log: (...parts) => messages.push(parts.join(" ")),
      error: (...parts) => messages.push(parts.join(" ")),
    },
  };
  await new AsyncFunction(...Object.keys(dependencies), source)(
    ...Object.values(dependencies),
  );
  return { env, writes, provisioned, messages, exitCode: fakeProcess.exitCode };
}

test("Managed development provisions and privately saves a separate payout grantor", async () => {
  const result = await prepare();
  assert.equal(result.exitCode, undefined);
  const grantor = new URL(result.env.PAYOUT_GRANTOR_DATABASE_URL);
  assert.match(grantor.username, /^legend_grant_[a-f0-9]{16}$/);
  assert.equal(grantor.host, "127.0.0.1:55432");
  assert.equal(grantor.pathname, "/development");
  assert.equal(result.provisioned[0].grantorUrl, grantor.href);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0][0], "/test/project/.env.local");
  assert.equal(result.writes[0][2].mode, 0o600);
  assert.ok(
    result.writes[0][1].includes(
      `PAYOUT_GRANTOR_DATABASE_URL="${grantor.href}"`,
    ),
  );
  assert.ok(
    result.messages.every(
      (line) =>
        !line.includes(grantor.href) && !line.includes(grantor.password),
    ),
  );
});

test("Managed development preserves the existing grantor on repeated setup", async () => {
  const grantor =
    "postgresql://legend_grant_3333333333333333:existing@127.0.0.1:55432/development";
  const result = await prepare({ PAYOUT_GRANTOR_DATABASE_URL: grantor });
  assert.equal(result.exitCode, undefined);
  assert.equal(result.env.PAYOUT_GRANTOR_DATABASE_URL, grantor);
  assert.equal(result.provisioned[0]?.grantorUrl, grantor);
  assert.deepEqual(result.writes, []);
});

test("External setup never provisions or overwrites a grantor", async () => {
  const result = await prepare({}, false);
  assert.deepEqual(result.provisioned, []);
  assert.deepEqual(result.writes, []);
});
