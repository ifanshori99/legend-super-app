// legend-uhp28: fresh managed development setup configures one explicit public
// fixture host; external and non-synthetic environments are never rewritten.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { cafeLegendPlatformFixtures } from "../packages/shared/src/platform/index.ts";
import { localDatabaseUrl } from "../scripts/postgres.mjs";
import {
  prepareDevelopmentPublicSite,
  verifyDevelopmentPublicSite,
} from "../scripts/dev-public-site.mjs";

const fixtureDomain = cafeLegendPlatformFixtures.domains.find(
  (domain) => domain.verifiedAt && domain.brandId,
);
assert.ok(fixtureDomain, "the seeded fixture has a verified brand domain");

function managedEnv(overrides = {}) {
  const env = {
    COMPOSE_PROJECT_NAME: "legend-uhp28-test",
    POSTGRES_USER: "starter",
    POSTGRES_PASSWORD: "test-only-local-password",
    POSTGRES_DB: "legend_uhp28_test",
    POSTGRES_PORT: "15432",
    NODE_ENV: "development",
    DEPLOYMENT_MODE: "development",
    DATA_CLASSIFICATION: "synthetic",
  };
  return { ...env, DATABASE_URL: localDatabaseUrl(env), ...overrides };
}

function database(rows) {
  const calls = [];
  return {
    calls,
    async query(...args) {
      calls.push(args);
      return { rows };
    },
  };
}

function tempDirectory(run) {
  const cwd = mkdtempSync(resolve(tmpdir(), "legend-public-site-"));
  return Promise.resolve()
    .then(() => run(cwd))
    .finally(() => rmSync(cwd, { recursive: true, force: true }));
}

test("legend-uhp28 managed prepare configures the verified seeded fixture host once", () =>
  tempDirectory(async (cwd) => {
    const original =
      "# Existing settings stay intact\nWEB_URL=http://localhost:3501\n";
    writeFileSync(resolve(cwd, ".env.local"), original);
    const env = managedEnv();
    const pool = database([{ hostname: fixtureDomain.hostname }]);
    assert.equal(
      await prepareDevelopmentPublicSite({ env, cwd, pool }),
      fixtureDomain.hostname,
    );
    assert.equal(env.DEV_PUBLIC_SITE_HOST, fixtureDomain.hostname);
    const once = readFileSync(resolve(cwd, ".env.local"), "utf8");
    assert.ok(once.startsWith(original));
    assert.match(
      once,
      new RegExp(
        `^DEV_PUBLIC_SITE_HOST="${fixtureDomain.hostname.replaceAll(".", "\\.")}"$`,
        "m",
      ),
    );
    assert.equal(pool.calls.length, 1);
    await prepareDevelopmentPublicSite({ env, cwd, pool });
    assert.equal(readFileSync(resolve(cwd, ".env.local"), "utf8"), once);
    assert.equal(pool.calls.length, 1);
  }));

test("legend-uhp28 prepare preserves a deliberately configured host", () =>
  tempDirectory(async (cwd) => {
    const original = 'DEV_PUBLIC_SITE_HOST="my-synthetic-brand.example.test"\n';
    writeFileSync(resolve(cwd, ".env.local"), original);
    const env = managedEnv({
      DEV_PUBLIC_SITE_HOST: "my-synthetic-brand.example.test",
    });
    const pool = database([]);
    assert.equal(
      await prepareDevelopmentPublicSite({ env, cwd, pool }),
      env.DEV_PUBLIC_SITE_HOST,
    );
    assert.equal(readFileSync(resolve(cwd, ".env.local"), "utf8"), original);
    assert.equal(pool.calls.length, 0);
  }));

for (const overrides of [
  { DATABASE_URL: "postgresql://external:password@db.example/existing" },
  { NODE_ENV: "production" },
  { NODE_ENV: "test" },
  { DEPLOYMENT_MODE: "cloud" },
  { DATA_CLASSIFICATION: "real" },
])
  test(`legend-uhp28 prepare skips ineligible setup ${JSON.stringify(overrides)}`, () =>
    tempDirectory(async (cwd) => {
      const original = "# Existing settings\n";
      writeFileSync(resolve(cwd, ".env.local"), original);
      const env = managedEnv(overrides);
      const pool = database([{ hostname: fixtureDomain.hostname }]);
      assert.equal(
        await prepareDevelopmentPublicSite({ env, cwd, pool }),
        undefined,
      );
      assert.equal(env.DEV_PUBLIC_SITE_HOST, undefined);
      assert.equal(pool.calls.length, 0);
      assert.equal(readFileSync(resolve(cwd, ".env.local"), "utf8"), original);
    }));

test("legend-uhp28 prepare fails visibly if its expected seeded domain is missing", () =>
  tempDirectory(async (cwd) => {
    const env = managedEnv();
    const pool = database([]);
    await assert.rejects(
      prepareDevelopmentPublicSite({ env, cwd, pool }),
      /pnpm dev:prepare/,
    );
    assert.equal(env.DEV_PUBLIC_SITE_HOST, undefined);
  }));

test("legend-uhp28 doctor verifies the configured host against real published-site rows", async () => {
  const env = managedEnv({ DEV_PUBLIC_SITE_HOST: fixtureDomain.hostname });
  const pool = database([{ hostname: fixtureDomain.hostname }]);
  assert.equal(await verifyDevelopmentPublicSite({ env, pool }), true);
  assert.equal(pool.calls.length, 1);
  assert.ok(pool.calls[0][1].includes(fixtureDomain.hostname));
});

test("legend-uhp28 doctor reports an unverified, inactive or unpublished configured host", async () => {
  const env = managedEnv({ DEV_PUBLIC_SITE_HOST: fixtureDomain.hostname });
  const pool = database([]);
  await assert.rejects(
    verifyDevelopmentPublicSite({ env, pool }),
    /DEV_PUBLIC_SITE_HOST|pnpm dev:prepare/,
  );
});

test("legend-uhp28 doctor reports missing configuration in a managed development copy", async () => {
  await assert.rejects(
    verifyDevelopmentPublicSite({ env: managedEnv(), pool: database([]) }),
    /DEV_PUBLIC_SITE_HOST|pnpm dev:prepare/,
  );
});

test("legend-uhp28 doctor does not demand local aliases for external databases", async () => {
  const env = managedEnv({
    DATABASE_URL: "postgresql://external:password@db.example/existing",
  });
  const pool = database([]);
  assert.equal(await verifyDevelopmentPublicSite({ env, pool }), undefined);
  assert.equal(pool.calls.length, 0);
});
