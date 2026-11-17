// Synthetic Cafe Legend organisation, seeded by the development/test bootstrap
// as the migration owner (never by the running API). Replaces the old
// app.dev_tenant_lookup bootstrap row: TEN-06 says a tenant is data created
// from the panel, so development starts from the same rows the panel writes.
//
// Guards: development deployment, synthetic data, never production. The seed is
// idempotent (ON CONFLICT updates the same ids), so `pnpm test` can run it on
// every fresh disposable database.
import { Pool } from "pg";
import {
  DEFAULT_CASH_OUT_APPROVAL_POLICIES,
  DEFAULT_CASH_SHIFT_CLOSE_APPROVAL_POLICIES,
  DEFAULT_SHAREHOLDER_VERSION_APPROVAL_POLICIES,
  DEFAULT_REFUND_APPROVAL_POLICIES,
  ROLE_TEMPLATES,
} from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { cafeLegendTaxFixtures } from "@starter/shared/tax";
import {
  brandWebsiteContentSchema,
  cafeLegendWebsiteFixtures,
} from "@starter/shared/website";
import { guardDataImport } from "../config/data-import";
import { databaseUrl } from "./connection";

// Data import guard (legend-v4ld): synthetic, development-only source. The
// explicit checks below are defence in depth (NODE_ENV is not part of the
// deployment settings the guard reads).
guardDataImport("seed.dev-tenant", undefined, {
  databaseUrl: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
});
if (
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
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenant.id],
  );

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

  // Approval matrix defaults for AI/MCP write tools (AIG-03, legend-zw9r): one
  // level, the outlet manager; same rows as migration 0089 and
  // seedTenantRoleTemplates give other tenants. Only when the action has none.
  await client.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     SELECT r.tenant_id, a.action_type, NULL, r.id, 1, true
     FROM roles r
     CROSS JOIN (VALUES ('ai_action'), ('mcp_action')) AS a(action_type)
     WHERE r.tenant_id = $1 AND r.is_template AND r.template_key = 'outlet_manager'
       AND NOT EXISTS (
         SELECT 1 FROM approval_policies p
         WHERE p.tenant_id = r.tenant_id AND p.action_type = a.action_type
       )`,
    [tenant.id],
  );

  // Refund approval default (legend-zi9o, PRD §3.6 and D14, Q63): same level-1
  // rows from Rp0 (supervisor, outlet manager, general manager, owner) and same
  // no-refund-row rule as seedTenantRoleTemplates and migration 0286.
  await client.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     SELECT $1::uuid, 'refund', d.threshold_idr, r.id, d.level, true
     FROM unnest($2::bigint[], $3::int[], $4::text[]) AS d(threshold_idr, level, template_key)
     JOIN roles r
       ON r.tenant_id = $1::uuid AND r.is_template AND r.template_key = d.template_key
     WHERE NOT EXISTS (
       SELECT 1 FROM approval_policies p
       WHERE p.tenant_id = $1::uuid AND p.action_type = 'refund'
     )`,
    [
      tenant.id,
      DEFAULT_REFUND_APPROVAL_POLICIES.map((row) => row.thresholdIdr),
      DEFAULT_REFUND_APPROVAL_POLICIES.map((row) => row.level),
      DEFAULT_REFUND_APPROVAL_POLICIES.map((row) => row.roleTemplateKey),
    ],
  );

  // Cash out approval default (legend-4qowr, Q7): level 1 from Rp0 for the
  // Finance template, same no-cash_out-row rule as seedTenantRoleTemplates and
  // the data migration.
  await client.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     SELECT $1::uuid, 'cash_out', d.threshold_idr, r.id, d.level, true
     FROM unnest($2::bigint[], $3::int[], $4::text[]) AS d(threshold_idr, level, template_key)
     JOIN roles r
       ON r.tenant_id = $1::uuid AND r.is_template AND r.template_key = d.template_key
     WHERE NOT EXISTS (
       SELECT 1 FROM approval_policies p
       WHERE p.tenant_id = $1::uuid AND p.action_type = 'cash_out'
     )`,
    [
      tenant.id,
      DEFAULT_CASH_OUT_APPROVAL_POLICIES.map((row) => row.thresholdIdr),
      DEFAULT_CASH_OUT_APPROVAL_POLICIES.map((row) => row.level),
      DEFAULT_CASH_OUT_APPROVAL_POLICIES.map((row) => row.roleTemplateKey),
    ],
  );

  // Cash shift close approval default (legend-ccpn, Q28, PRD §3.10): same
  // level-1 rows from Rp0 (supervisor, outlet manager, general manager) and
  // same no-cash_shift_close-row rule as seedTenantRoleTemplates and the data
  // migration.
  await client.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     SELECT $1::uuid, 'cash_shift_close', d.threshold_idr, r.id, d.level, true
     FROM unnest($2::bigint[], $3::int[], $4::text[]) AS d(threshold_idr, level, template_key)
     JOIN roles r
       ON r.tenant_id = $1::uuid AND r.is_template AND r.template_key = d.template_key
     WHERE NOT EXISTS (
       SELECT 1 FROM approval_policies p
       WHERE p.tenant_id = $1::uuid AND p.action_type = 'cash_shift_close'
     )`,
    [
      tenant.id,
      DEFAULT_CASH_SHIFT_CLOSE_APPROVAL_POLICIES.map((row) => row.thresholdIdr),
      DEFAULT_CASH_SHIFT_CLOSE_APPROVAL_POLICIES.map((row) => row.level),
      DEFAULT_CASH_SHIFT_CLOSE_APPROVAL_POLICIES.map(
        (row) => row.roleTemplateKey,
      ),
    ],
  );

  // Shareholder version approval default (legend-tm6pp, Q2): one Owner level-1
  // row from Rp0, same no-shareholder_version-row rule as
  // seedTenantRoleTemplates and migration 0241.
  await client.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     SELECT $1::uuid, 'shareholder_version', d.threshold_idr, r.id, d.level, true
     FROM unnest($2::bigint[], $3::int[], $4::text[]) AS d(threshold_idr, level, template_key)
     JOIN roles r
       ON r.tenant_id = $1::uuid AND r.is_template AND r.template_key = d.template_key
     WHERE NOT EXISTS (
       SELECT 1 FROM approval_policies p
       WHERE p.tenant_id = $1::uuid AND p.action_type = 'shareholder_version'
     )`,
    [
      tenant.id,
      DEFAULT_SHAREHOLDER_VERSION_APPROVAL_POLICIES.map(
        (row) => row.thresholdIdr,
      ),
      DEFAULT_SHAREHOLDER_VERSION_APPROVAL_POLICIES.map((row) => row.level),
      DEFAULT_SHAREHOLDER_VERSION_APPROVAL_POLICIES.map(
        (row) => row.roleTemplateKey,
      ),
    ],
  );

  // Tax configuration (PRD §3.14 F11/F14, bead legend-559): the default PBJT
  // Bandung 10% F&B rule, a facility rule, the Private Room service charge and
  // the exclusive-price calculation options. Tenants created from the panel get
  // their defaults from the same fixtures once the tenant-create wiring lands;
  // seeding them here makes dev and the API tests run against real rows.
  const taxFixtures = cafeLegendTaxFixtures;
  for (const rule of taxFixtures.taxRules) {
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         rate_bp = EXCLUDED.rate_bp,
         region_code = EXCLUDED.region_code,
         channels = EXCLUDED.channels,
         applies_to = EXCLUDED.applies_to,
         price_includes_tax = EXCLUDED.price_includes_tax,
         include_service_in_base = EXCLUDED.include_service_in_base,
         is_active = EXCLUDED.is_active,
         effective_from = EXCLUDED.effective_from`,
      [
        rule.id,
        tenant.id,
        rule.outletId,
        rule.code,
        rule.name,
        rule.taxType,
        rule.rateBp,
        rule.regionCode,
        JSON.stringify(rule.channels),
        JSON.stringify(rule.appliesTo),
        rule.priceIncludesTax,
        rule.includeServiceInBase,
        rule.isActive,
        rule.version,
        rule.effectiveFrom,
        rule.status,
        rule.publishedAt,
        rule.publishedBy,
        rule.createdAt,
      ],
    );
  }
  for (const rule of taxFixtures.serviceChargeRules) {
    await client.query(
      `INSERT INTO service_charge_rules
         (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes, is_active,
          version, effective_from, status, published_at, published_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         rate_bp = EXCLUDED.rate_bp,
         zone_id = EXCLUDED.zone_id,
         order_types = EXCLUDED.order_types,
         item_classes = EXCLUDED.item_classes,
         is_active = EXCLUDED.is_active,
         effective_from = EXCLUDED.effective_from`,
      [
        rule.id,
        tenant.id,
        rule.outletId,
        rule.code,
        rule.name,
        rule.rateBp,
        rule.zoneId,
        JSON.stringify(rule.orderTypes),
        JSON.stringify(rule.itemClasses),
        rule.isActive,
        rule.version,
        rule.effectiveFrom,
        rule.status,
        rule.publishedAt,
        rule.publishedBy,
        rule.createdAt,
      ],
    );
  }
  for (const row of taxFixtures.settings) {
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation, version,
          effective_from, status, published_at, published_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (id) DO UPDATE SET
         calculation_order = EXCLUDED.calculation_order,
         prices_include_tax = EXCLUDED.prices_include_tax,
         service_rounding_mode = EXCLUDED.service_rounding_mode,
         tax_rounding_mode = EXCLUDED.tax_rounding_mode,
         inclusive_base_rounding_mode = EXCLUDED.inclusive_base_rounding_mode,
         bill_rounding = EXCLUDED.bill_rounding,
         package_allocation = EXCLUDED.package_allocation,
         effective_from = EXCLUDED.effective_from`,
      [
        row.id,
        tenant.id,
        row.outletId,
        row.calculationOrder,
        row.pricesIncludeTax,
        row.serviceRoundingMode,
        row.taxRoundingMode,
        row.inclusiveBaseRoundingMode,
        row.billRounding === null ? null : JSON.stringify(row.billRounding),
        row.packageAllocation,
        row.version,
        row.effectiveFrom,
        row.status,
        row.publishedAt,
        row.publishedBy,
        row.createdAt,
      ],
    );
  }

  // Published public website content (WS-08, legend-qgr6): the Cafe Legend
  // site fixture, so GET /api/public/site answers in development and tests.
  const site = cafeLegendWebsiteFixtures.site;
  const websiteContent = brandWebsiteContentSchema.parse({
    tagline: site.brand.tagline,
    description: site.brand.description,
    heroImages: site.heroImages,
    gallery: site.gallery,
    highlights: site.highlights,
    address: site.outlet.address,
    geo: site.outlet.geo,
    contact: site.contact,
    seo: site.seo,
    googleBusinessUrl: site.outlet.mapUrl,
  });
  await client.query(
    `INSERT INTO brand_websites (tenant_id, brand_id, outlet_id, content, published_at, updated_by)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (tenant_id, brand_id) DO UPDATE SET
       outlet_id = EXCLUDED.outlet_id,
       content = EXCLUDED.content,
       published_at = COALESCE(brand_websites.published_at, EXCLUDED.published_at),
       updated_at = now()`,
    [
      tenant.id,
      brand.id,
      fixtures.outlets[0].id,
      JSON.stringify(websiteContent),
      tenant.createdBy,
    ],
  );

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
