// Loopback development previews use one explicitly configured synthetic site.
// Production and external setup never acquire an implicit tenant selection.
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { root } from "./lib.mjs";
import { databaseUrl, managesLocalDatabase } from "./postgres.mjs";

function syntheticDevelopment(env) {
  return (
    (env.NODE_ENV || "development") === "development" &&
    (env.DEPLOYMENT_MODE || "development") === "development" &&
    (env.DATA_CLASSIFICATION || "synthetic") === "synthetic"
  );
}

const publishedSite = `
  SELECT d.hostname
  FROM tenant_domains d
  JOIN tenants t ON t.id = d.tenant_id
  JOIN brand_websites w
    ON w.tenant_id = d.tenant_id AND w.brand_id = d.brand_id
  WHERE d.verified_at IS NOT NULL
    AND t.status = 'active'
    AND w.published_at IS NOT NULL`;

async function query(env, pool, sql, values) {
  if (pool) return pool.query(sql, values);
  const owned = new Pool({
    connectionString: databaseUrl(
      env.MIGRATION_DATABASE_URL || env.DATABASE_URL,
    ),
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  owned.on("error", () => {});
  try {
    return await owned.query(sql, values);
  } finally {
    await owned.end();
  }
}

export async function prepareDevelopmentPublicSite({
  env = process.env,
  cwd = root,
  pool,
} = {}) {
  if (!syntheticDevelopment(env) || !managesLocalDatabase(env)) return;
  if (env.DEV_PUBLIC_SITE_HOST) return env.DEV_PUBLIC_SITE_HOST;

  // Use the same fixture source as seed-dev-tenant.ts, never the first tenant
  // or arbitrary published site in an existing database.
  const { cafeLegendPlatformFixtures } =
    await import("../packages/shared/src/platform/fixtures.ts");
  const domain = cafeLegendPlatformFixtures.domains.find(
    (entry) => entry.kind === "platform_subdomain" && entry.verifiedAt,
  );
  const result = domain
    ? await query(
        env,
        pool,
        `${publishedSite}
          AND d.id = $1 AND d.tenant_id = $2
          AND d.brand_id = $3 AND d.hostname = $4`,
        [domain.id, domain.tenantId, domain.brandId, domain.hostname],
      )
    : { rows: [] };
  const hostname = result.rows[0]?.hostname;
  if (!hostname)
    throw new Error(
      "The synthetic tenant domain or published website is missing. Run pnpm dev:prepare to restore the development seed.",
    );
  appendFileSync(
    resolve(cwd, ".env.local"),
    `\nDEV_PUBLIC_SITE_HOST="${hostname}"\n`,
    { mode: 0o600 },
  );
  env.DEV_PUBLIC_SITE_HOST = hostname;
  return hostname;
}

export async function verifyDevelopmentPublicSite({
  env = process.env,
  pool,
} = {}) {
  if (!syntheticDevelopment(env)) return;
  const hostname = env.DEV_PUBLIC_SITE_HOST;
  if (!hostname && !managesLocalDatabase(env)) return;
  if (!hostname)
    throw new Error(
      "DEV_PUBLIC_SITE_HOST is missing. Run pnpm dev:prepare to configure the local public website.",
    );
  const result = await query(
    env,
    pool,
    `${publishedSite} AND d.hostname = $1`,
    [hostname],
  );
  if (!result.rows.length)
    throw new Error(
      "DEV_PUBLIC_SITE_HOST must name a verified domain of an active tenant with a published website. Run pnpm dev:prepare to restore the development seed, or correct the configured host.",
    );
  return true;
}
