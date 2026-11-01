// Synthetic Cafe Legend organisation, seeded by the development/test bootstrap
// as the migration owner (never by the running API). Replaces the old
// app.dev_tenant_lookup bootstrap row: TEN-06 says a tenant is data created
// from the panel, so development starts from the same rows the panel writes.
//
// Guards: development deployment, synthetic data, never production. The seed is
// idempotent (ON CONFLICT updates the same ids), so `pnpm test` can run it on
// every fresh disposable database.
import { Pool } from "pg";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { databaseUrl } from "./connection";

if (
  (process.env.DEPLOYMENT_MODE ?? "development") !== "development" ||
  (process.env.DATA_CLASSIFICATION ?? "synthetic") !== "synthetic" ||
  process.env.NODE_ENV === "production"
) {
  throw new Error("Synthetic tenant seeding is permitted only in development.");
}

const fixtures = cafeLegendPlatformFixtures;
const pool = new Pool({
  connectionString: databaseUrl(process.env.MIGRATION_DATABASE_URL),
  max: 1,
});

const client = await pool.connect();
try {
  await client.query("BEGIN");

  for (const pack of fixtures.packages) {
    await client.query(
      `INSERT INTO platform_packages (key, name, modules, default_limits, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET
         name = EXCLUDED.name,
         modules = EXCLUDED.modules,
         default_limits = EXCLUDED.default_limits,
         status = EXCLUDED.status`,
      [
        pack.key,
        pack.name,
        JSON.stringify(pack.modules),
        JSON.stringify(pack.defaultLimits),
        pack.status,
      ],
    );
  }

  const tenant = fixtures.tenant;
  await client.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       slug = EXCLUDED.slug,
       name = EXCLUDED.name,
       plan = EXCLUDED.plan,
       status = EXCLUDED.status,
       deployment_mode = EXCLUDED.deployment_mode,
       feature_flags = EXCLUDED.feature_flags,
       limits = EXCLUDED.limits`,
    [
      tenant.id,
      tenant.slug,
      tenant.name,
      tenant.plan,
      tenant.status,
      tenant.deploymentMode,
      JSON.stringify(tenant.featureFlags),
      JSON.stringify(tenant.limits),
      tenant.createdBy,
    ],
  );

  // Tenant-owned rows need the tenant context even for the seeding login.
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [
    tenant.id,
  ]);

  const brand = fixtures.brand;
  await client.query(
    `INSERT INTO brands (id, tenant_id, slug, name, logo_media_id, theme_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       slug = EXCLUDED.slug,
       name = EXCLUDED.name,
       logo_media_id = EXCLUDED.logo_media_id`,
    [brand.id, tenant.id, brand.slug, brand.name, brand.logoMediaId, null],
  );

  // Tenant Themes come with the brand, so the whitelabel brand context has a
  // real active theme to render. The brand points at the active version.
  for (const theme of fixtures.themes) {
    await client.query(
      `INSERT INTO tenant_themes (id, tenant_id, brand_id, version, tokens, logo_media_id, font_family, corners, contrast_check_passed, status, created_by, created_at, activated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         version = EXCLUDED.version,
         tokens = EXCLUDED.tokens,
         logo_media_id = EXCLUDED.logo_media_id,
         font_family = EXCLUDED.font_family,
         corners = EXCLUDED.corners,
         contrast_check_passed = EXCLUDED.contrast_check_passed,
         status = EXCLUDED.status,
         activated_at = EXCLUDED.activated_at`,
      [
        theme.id,
        tenant.id,
        brand.id,
        theme.version,
        JSON.stringify(theme.tokens),
        theme.logoMediaId,
        theme.fontFamily,
        theme.corners,
        theme.contrastCheckPassed,
        theme.status,
        theme.createdBy,
        theme.createdAt,
        theme.activatedAt,
      ],
    );
  }
  const activeTheme = fixtures.themes.find(
    (theme) => theme.status === "active",
  );
  if (activeTheme) {
    await client.query(
      "UPDATE brands SET theme_id = $1 WHERE id = $2 AND tenant_id = $3",
      [activeTheme.id, brand.id, tenant.id],
    );
  }

  const legalEntity = fixtures.legalEntity;
  await client.query(
    `INSERT INTO legal_entities (id, tenant_id, name, npwp_encrypted, npwp_last4, npwp_hash, is_pkp, address)
     VALUES ($1, $2, $3, NULL, $4, NULL, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       is_pkp = EXCLUDED.is_pkp,
       address = EXCLUDED.address`,
    [
      legalEntity.id,
      tenant.id,
      legalEntity.name,
      legalEntity.npwpLast4,
      legalEntity.isPkp,
      legalEntity.address,
    ],
  );

  for (const outlet of fixtures.outlets) {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, region_id, geofence, timezone, opening_hours, edge_node_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12)
       ON CONFLICT (id) DO UPDATE SET
         code = EXCLUDED.code,
         name = EXCLUDED.name,
         address = EXCLUDED.address,
         geofence = EXCLUDED.geofence,
         timezone = EXCLUDED.timezone,
         opening_hours = EXCLUDED.opening_hours,
         status = EXCLUDED.status`,
      [
        outlet.id,
        tenant.id,
        brand.id,
        legalEntity.id,
        outlet.code,
        outlet.name,
        outlet.address,
        outlet.regionId,
        outlet.geofence === null ? null : JSON.stringify(outlet.geofence),
        outlet.timeZone,
        JSON.stringify(outlet.openingHours),
        outlet.status,
      ],
    );
  }

  for (const domain of fixtures.domains) {
    await client.query(
      `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         hostname = EXCLUDED.hostname,
         kind = EXCLUDED.kind,
         tls_status = EXCLUDED.tls_status,
         verified_at = EXCLUDED.verified_at`,
      [
        domain.id,
        tenant.id,
        brand.id,
        domain.hostname,
        domain.kind,
        domain.tlsStatus,
        domain.verifiedAt,
      ],
    );
  }

  // Role templates (PRD §3.7, bead legend-4f9). A tenant created from the panel
  // gets them in the same transaction; the synthetic dev tenant is inserted by
  // this script instead, so seed the same 17 tenant-level rows idempotently.
  for (const template of ROLE_TEMPLATES.filter(
    (row) => row.level === "tenant",
  )) {
    await client.query(
      `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, true, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, template_key) DO NOTHING`,
      [
        tenant.id,
        template.defaultName,
        template.key,
        JSON.stringify(template.permissions),
        template.mfaRequired,
        JSON.stringify(template.allowedScopeTypes),
      ],
    );
  }

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
