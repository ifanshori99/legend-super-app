// TEN-09: tenant configuration export / template / import (bead legend-34c).
// Runs the real Express app, Better Auth and PostgreSQL.
//
// Endpoints (platform admin only):
//   GET  /api/platform/tenants/:id/config-export      -> bundle (not stored)
//   POST /api/platform/tenants/:id/config-templates   -> template summary
//   GET  /api/platform/config-templates[/:templateId] -> list / full template
//   POST /api/platform/tenants/:id/config-import      -> config_imports row
//   GET  /api/platform/tenants/:id/config-readiness   -> { ready, checks }
//
// Assumptions where the brief is silent (kept loose on purpose):
// - responses are wrapped as `{ data }`; the helpers also accept a bare body.
// - template creation answers 201; a successful import answers 200 or 201.
// - a failed import answers 422 with `error.code = CONFIG_IMPORT_FAILED` and
//   `error.details` = [{ field: "importId", message: <id> }] (the
//   platform error-detail shape, seen in the first run); an invalid bundle answers 422
//   `CONFIG_BUNDLE_INVALID`; an unknown target answers 404; a non-active
//   target is refused with some 4xx.
// - no customer/member table is seeded (name unknown) and no POS order is
//   seeded (not cheap); transaction data is covered by the employee and the
//   integration secret rows plus the "only configuration sections" check.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const appRole = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
});

const limits = cafeLegendPlatformFixtures.tenant.limits;
const OPENING_HOURS = JSON.stringify({
  mon: { opens: "08:00", closes: "22:00" },
  tue: { opens: "08:00", closes: "22:00" },
  wed: { opens: "08:00", closes: "22:00" },
  thu: { opens: "08:00", closes: "22:00" },
  fri: { opens: "08:00", closes: "23:00" },
  sat: { opens: "08:00", closes: "23:00" },
  sun: { opens: "08:00", closes: "22:00" },
});
const ZONE_HOURS = JSON.stringify([
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
]);
const ALLOWED_SECTIONS = [
  "modules",
  "text_overrides",
  "theme",
  "roles",
  "approval_policies",
  "chart_of_accounts",
  "tax_rules",
  "service_charge_rules",
  "zones",
  "checklists",
  "loyalty_policy",
  "facilities",
  "wifi_policies",
  "payroll_settings",
];
const UUID_TEXT =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Strings that must never appear in a bundle or a stored template.
const SECRETS = {
  npwp: "SECRET-NPWP-TEN09-0123456789",
  integration: "sk-live-TEN09-integration-secret",
  employeeName: "Budi Rahasia Santoso",
  employeeNo: "TEN09-EMP-RAHASIA",
};

// ----------------------------------------------------------------- helpers

type Admin = { client: ReturnType<typeof agent>; userId: string };
const adminUserIds: string[] = [];

async function adminClient(): Promise<Admin> {
  const client = agent(app);
  const email = await signUp(client, "Platform Admin TEN-09");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  adminUserIds.push(userId);
  await verifySessionMfa(email);
  return { client, userId };
}

// Response bodies and bundles are navigated loosely on purpose; the shared
// zod schemas own their exact types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const dataOf = (body: { data?: unknown }) => (body.data ?? body) as Loose;

async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const suffix = () => randomBytes(4).toString("hex");

async function createTenant(
  admin: Admin,
  input: {
    plan?: string;
    modules?: string[];
    limits?: Record<string, number>;
    /** Keep the defaults every new tenant is provisioned with. */
    keepDefaults?: boolean;
  } = {},
): Promise<string> {
  const created = await admin.client
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `ten09-${suffix()}`,
      name: "Uji TEN-09",
      plan: input.plan ?? "lengkap",
      deploymentMode: "shared",
      featureFlags: {
        modules: input.modules ?? ["pos"],
        integrationProviders: [],
      },
      limits: input.limits ?? limits,
      firstAdmin: {
        name: "Admin Pertama",
        whatsapp: "6281234567890",
        email: null,
      },
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const tenantId = created.body.data.id as string;
  if (!input.keepDefaults) await clearProvisionedDefaults(tenantId);
  return tenantId;
}

/**
 * Tenant creation now provisions default approval policies, tax settings, a
 * PBJT rule and a service charge (legend-9obf, legend-2qz7). These tests build
 * their own source configuration and count rows exactly, so they start from a
 * tenant without those defaults; `keepDefaults` covers the real-world path.
 */
async function clearProvisionedDefaults(tenantId: string) {
  await asTenant(tenantId, async (client) => {
    for (const table of [
      "service_charge_rules",
      "tax_rules",
      "tax_settings",
      "approval_policies",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
  });
}

type Structure = {
  brandId: string;
  legalEntityIds: string[];
  outletIds: Record<string, string>;
};

/** Brand, legal entit(y|ies) and outlets with the given codes. */
async function addStructure(
  tenantId: string,
  input: {
    outletCodes: string[];
    legalEntities?: number;
    npwp?: boolean;
  },
): Promise<Structure> {
  return asTenant(tenantId, async (client) => {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM brands WHERE tenant_id = $1 LIMIT 1",
      [tenantId],
    );
    let brandId = existing.rows[0]?.id;
    if (!brandId) {
      brandId = randomUUID();
      await client.query(
        "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
        [brandId, tenantId, `brand-${suffix()}`, "Kopi Legenda"],
      );
    }
    const legalEntityIds: string[] = [];
    for (let index = 0; index < (input.legalEntities ?? 1); index += 1) {
      const id = randomUUID();
      legalEntityIds.push(id);
      if (input.npwp && index === 0)
        await client.query(
          `INSERT INTO legal_entities
             (id, tenant_id, name, is_pkp, npwp_encrypted, npwp_last4, npwp_hash)
           VALUES ($1, $2, $3, true, $4, '6789', $5)`,
          [
            id,
            tenantId,
            "PT Kopi Legenda Nusantara",
            SECRETS.npwp,
            `hash-${SECRETS.npwp}`,
          ],
        );
      else
        await client.query(
          "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
          [id, tenantId, `PT Uji ${index + 1} ${suffix()}`],
        );
    }
    const outletIds: Record<string, string> = {};
    for (const code of input.outletCodes) {
      const id = randomUUID();
      outletIds[code] = id;
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
        [
          id,
          tenantId,
          brandId,
          legalEntityIds[0],
          code,
          `Outlet ${code}`,
          OPENING_HOURS,
        ],
      );
    }
    return { brandId, legalEntityIds, outletIds };
  });
}

const CODE_A = "KLG-01";
const CODE_B = "KLG-02";

type Source = {
  tenantId: string;
  structure: Structure;
  adminUserId: string;
  employeeId: string;
  employeeUserId: string;
  integrationId: string;
  roleId: string;
};

/** A Cafe-Legend-like tenant: every config section, plus PII and secrets. */
async function seedSource(admin: Admin): Promise<Source> {
  const tenantId = await createTenant(admin, {
    modules: ["pos", "qr_order", "accounting"],
  });
  const structure = await addStructure(tenantId, {
    outletCodes: [CODE_A, CODE_B],
    npwp: true,
  });
  const [legalEntityId] = structure.legalEntityIds;
  const outletA = structure.outletIds[CODE_A]!;
  const outletB = structure.outletIds[CODE_B]!;

  // A real user for the employee row (PII that must not travel).
  const staff = agent(app);
  await signUp(staff, "Budi Rahasia");
  const staffSession = await staff.get("/api/auth/get-session");
  const employeeUserId = staffSession.body.user.id as string;

  const ids = {
    role: randomUUID(),
    zoneIndoor: randomUUID(),
    zoneTerrace: randomUUID(),
    zoneB: randomUUID(),
    facility: randomUUID(),
    area: randomUUID(),
    unitOne: randomUUID(),
    unitTwo: randomUUID(),
    product: randomUUID(),
    wifi: randomUUID(),
    taxRule: randomUUID(),
    employee: randomUUID(),
    integration: randomUUID(),
    checklist: randomUUID(),
  };

  await asTenant(tenantId, async (client) => {
    // roles + approval matrix
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Kepala Bar', false, $3, true, '["tenant","outlet"]')`,
      [
        ids.role,
        tenantId,
        JSON.stringify([
          "floor.table.view",
          "floor.table.operate",
          "floor.table.manage",
        ]),
      ],
    );
    await client.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, 'refund', 500000, $2, 1, true)`,
      [tenantId, ids.role],
    );
    await client.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       SELECT $1, 'void', NULL, id, 1, true FROM roles
        WHERE tenant_id = $1 AND template_key = 'supervisor'`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp)
       VALUES ($1, $2, 1500)`,
      [tenantId, outletA],
    );

    // chart of accounts (+ a child) and role mappings
    const cash = await client.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, '1101', 'Kas', 'asset', 'cash_and_equivalents') RETURNING id`,
      [tenantId, legalEntityId],
    );
    const pettyCash = await client.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
       VALUES ($1, $2, '1102', 'Kas Kecil', 'asset', 'cash_and_equivalents', $3) RETURNING id`,
      [tenantId, legalEntityId, cash.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, '4101', 'Penjualan', 'revenue', 'revenue')`,
      [tenantId, legalEntityId],
    );
    await client.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'bank', $3), ($1, $2, 'accounts_receivable', $4)`,
      [tenantId, legalEntityId, cash.rows[0]!.id, pettyCash.rows[0]!.id],
    );

    // tax: PBJT published v1 (+ a later DRAFT v2 that must not travel),
    // an outlet override, tenant-default tax settings, zone-bound service.
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenantId, admin.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status)
       VALUES ($1, $2, NULL, 'PBJT', 'PBJT 12% draft', 'pbjt', 1200, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 2, '2027-01-01', 'draft')`,
      [randomUUID(), tenantId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, $3, 'PBJT-KLG', 'PBJT khusus outlet', 'pbjt', 1100, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $4)`,
      [randomUUID(), tenantId, outletA, admin.userId],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenantId, admin.userId],
    );

    // zones, zone-bound service charge
    for (const [id, outlet, name] of [
      [ids.zoneIndoor, outletA, "Indoor"],
      [ids.zoneTerrace, outletA, "Teras"],
      [ids.zoneB, outletB, "Lantai 2"],
    ] as const)
      await client.query(
        `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode,
           service_charge_bp, minimum_spend_idr, hours, status, sort_order)
         VALUES ($1, $2, $3, $4, 'pay_first', 500, 0, $5, 'active', 0)`,
        [id, tenantId, outlet, name, ZONE_HOURS],
      );
    await client.query(
      `INSERT INTO service_charge_rules
         (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes, is_active,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, $3, 'SC-INDOOR', 'Service Indoor', 500, $4, '[]',
               '["food_beverage"]', true, 1, '2026-01-01', 'published', now(), $5)`,
      [randomUUID(), tenantId, outletA, ids.zoneIndoor, admin.userId],
    );

    // checklist (items carry a uuid id in the real shape; it must not travel)
    await client.query(
      `INSERT INTO ops_checklist_templates (id, tenant_id, outlet_id, name, type, items, schedule, role_id)
       VALUES ($1, $2, $3, 'Buka Toko', 'opening', $4, $5, $6)`,
      [
        ids.checklist,
        tenantId,
        outletA,
        JSON.stringify([
          {
            id: randomUUID(),
            label: "Kasir dibuka dan dihitung",
            instruction: null,
            requiredEvidence: [],
          },
        ]),
        JSON.stringify({
          shiftTemplateId: null,
          stationId: null,
          zoneId: null,
          dueTime: "09:00",
        }),
        ids.role,
      ],
    );

    // facility with area, units, product
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Shower Pria', 'shower', 20, 10, 10, $4, $5, $6)`,
      [
        ids.facility,
        tenantId,
        outletA,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "00:00",
            closesAt: "23:59",
          },
        ]),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
      ],
    );
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area Pria', 0)`,
      [ids.area, tenantId, outletA, ids.facility],
    );
    for (const [index, unitId] of [ids.unitOne, ids.unitTwo].entries())
      await client.query(
        `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, 'available', $7)`,
        [
          unitId,
          tenantId,
          outletA,
          ids.facility,
          ids.area,
          `P${index + 1}`,
          index,
        ],
      );
    await client.query(
      `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active, tax_rule_id)
       VALUES ($1, $2, $3, $4, 'Shower Sekali', 'single', 25000, 1, true, $5)`,
      [ids.product, tenantId, outletA, ids.facility, ids.taxRule],
    );

    // wifi policy for the indoor zone
    await client.query(
      `INSERT INTO wifi_policies
         (id, tenant_id, outlet_id, zone_id, facility_id, free_minutes, peak_free_minutes, spend_per_extra_hour_idr,
          extra_minutes, max_devices, peak_schedule, base_speed_kbps, full_speed_kbps,
          min_spend_per_hour_idr, tier_bonus_minutes)
       VALUES ($1, $2, $3, $4, $5, 120, 60, 30000, 60, 2, $6, 2048, 10240, NULL, $7)`,
      [
        ids.wifi,
        tenantId,
        outletA,
        ids.zoneIndoor,
        ids.facility,
        JSON.stringify([
          { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "11:30", endsAt: "14:00" },
        ]),
        JSON.stringify({ gold: 60, platinum: 120 }),
      ],
    );

    // PII / secrets that must NOT travel
    await client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
      [
        ids.employee,
        tenantId,
        employeeUserId,
        SECRETS.employeeNo,
        SECRETS.employeeName,
        outletA,
      ],
    );
    await client.query(
      `INSERT INTO tenant_integrations (id, tenant_id, provider, config)
       VALUES ($1, $2, 'doit', $3)`,
      [
        ids.integration,
        tenantId,
        JSON.stringify({ apiKey: SECRETS.integration }),
      ],
    );
  });

  return {
    tenantId,
    structure,
    adminUserId: admin.userId,
    employeeId: ids.employee,
    employeeUserId,
    integrationId: ids.integration,
    roleId: ids.role,
  };
}

/** Every config table whose rows a bundle covers, as stable row text. */
const SNAPSHOT_TABLES = [
  "roles",
  "approval_policies",
  "pos_approval_policies",
  "chart_of_accounts",
  "account_mappings",
  "tax_rules",
  "tax_settings",
  "service_charge_rules",
  "floor_zones",
  "ops_checklist_templates",
  "facilities",
  "facility_areas",
  "facility_units",
  "facility_products",
  "wifi_policies",
];

async function snapshot(tenantId: string): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  await asTenant(tenantId, async (client) => {
    for (const table of SNAPSHOT_TABLES) {
      const rows = await client.query<{ row: string }>(
        `SELECT t::text AS row FROM ${table} t WHERE tenant_id = $1 ORDER BY 1`,
        [tenantId],
      );
      result[table] = rows.rows.map((row) => row.row);
    }
    const tenant = await client.query<{ row: string }>(
      "SELECT t::text AS row FROM tenants t WHERE id = $1",
      [tenantId],
    );
    result.tenants = tenant.rows.map((row) => row.row);
  });
  return result;
}

/** What "row counts match" means: config rows that a bundle carries. */
const COUNT_QUERIES: Record<string, string> = {
  customRoles:
    "SELECT count(*) FROM roles WHERE tenant_id = $1 AND is_template = false",
  approvalPolicies:
    "SELECT count(*) FROM approval_policies WHERE tenant_id = $1",
  posApprovalPolicies:
    "SELECT count(*) FROM pos_approval_policies WHERE tenant_id = $1",
  chartOfAccounts:
    "SELECT count(*) FROM chart_of_accounts WHERE tenant_id = $1",
  accountMappings: "SELECT count(*) FROM account_mappings WHERE tenant_id = $1",
  // Only published rules travel; the source's draft v2 does not.
  taxRules:
    "SELECT count(*) FROM tax_rules WHERE tenant_id = $1 AND status = 'published'",
  taxSettings:
    "SELECT count(*) FROM tax_settings WHERE tenant_id = $1 AND status = 'published'",
  serviceChargeRules:
    "SELECT count(*) FROM service_charge_rules WHERE tenant_id = $1 AND status = 'published'",
  zones: "SELECT count(*) FROM floor_zones WHERE tenant_id = $1",
  checklists:
    "SELECT count(*) FROM ops_checklist_templates WHERE tenant_id = $1",
  facilities: "SELECT count(*) FROM facilities WHERE tenant_id = $1",
  facilityAreas: "SELECT count(*) FROM facility_areas WHERE tenant_id = $1",
  facilityUnits: "SELECT count(*) FROM facility_units WHERE tenant_id = $1",
  facilityProducts:
    "SELECT count(*) FROM facility_products WHERE tenant_id = $1",
  wifiPolicies: "SELECT count(*) FROM wifi_policies WHERE tenant_id = $1",
};

async function counts(tenantId: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  await asTenant(tenantId, async (client) => {
    for (const [name, sql] of Object.entries(COUNT_QUERIES)) {
      const row = await client.query<{ count: string }>(sql, [tenantId]);
      result[name] = Number(row.rows[0]!.count);
    }
  });
  return result;
}

const SOURCE_COUNTS = {
  customRoles: 1,
  approvalPolicies: 2,
  posApprovalPolicies: 1,
  chartOfAccounts: 3,
  accountMappings: 2,
  taxRules: 2,
  taxSettings: 1,
  serviceChargeRules: 1,
  zones: 3,
  checklists: 1,
  facilities: 1,
  facilityAreas: 1,
  facilityUnits: 2,
  facilityProducts: 1,
  wifiPolicies: 1,
};
const EMPTY_COUNTS = Object.fromEntries(
  Object.keys(SOURCE_COUNTS).map((name) => [name, 0]),
);

async function newTarget(
  admin: Admin,
  input: {
    outletCodes?: string[];
    legalEntities?: number;
    plan?: string;
    modules?: string[];
    limits?: Record<string, number>;
    keepDefaults?: boolean;
  } = {},
) {
  const tenantId = await createTenant(admin, {
    plan: input.plan,
    modules: input.modules,
    limits: input.limits,
    keepDefaults: input.keepDefaults,
  });
  const structure = await addStructure(tenantId, {
    outletCodes: input.outletCodes ?? [CODE_A, CODE_B],
    legalEntities: input.legalEntities,
  });
  return { tenantId, structure };
}

const tenantPath = (tenantId: string) => `/api/platform/tenants/${tenantId}`;

async function exportBundle(admin: Admin, tenantId: string) {
  const response = await admin.client.get(
    `${tenantPath(tenantId)}/config-export`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return dataOf(response.body);
}

async function createTemplate(
  admin: Admin,
  tenantId: string,
  name: string,
  sections?: string[],
) {
  const response = await admin.client
    .post(`${tenantPath(tenantId)}/config-templates`)
    .set(originHeader)
    .send(sections ? { name, sections } : { name });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return dataOf(response.body);
}

function postImport(admin: Admin, tenantId: string, body: unknown) {
  return admin.client
    .post(`${tenantPath(tenantId)}/config-import`)
    .set(originHeader)
    .send(body as object);
}

async function importOk(admin: Admin, tenantId: string, body: unknown) {
  const response = await postImport(admin, tenantId, body);
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  return dataOf(response.body);
}

async function readiness(admin: Admin, tenantId: string) {
  const response = await admin.client.get(
    `${tenantPath(tenantId)}/config-readiness`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return dataOf(response.body) as {
    ready: boolean;
    checks: { check: string; ok: boolean; detail: string }[];
  };
}

async function importRows(tenantId: string) {
  const rows = await owner.query<{
    id: string;
    status: string;
    errors: string[];
    warnings: string[];
    applied_sections: string[];
  }>(
    `SELECT id, status, errors, warnings, applied_sections
       FROM config_imports WHERE tenant_id = $1 ORDER BY started_at`,
    [tenantId],
  );
  return rows.rows;
}

// ------------------------------------------------------------------- setup

let admin: Admin;
let source: Source;
let sourceBundle: Loose;
let template: { id: string; name: string; version: number };

beforeAll(async () => {
  admin = await adminClient();
  source = await seedSource(admin);
  sourceBundle = await exportBundle(admin, source.tenantId);
  template = await createTemplate(
    admin,
    source.tenantId,
    `Cafe Legend ${suffix()}`,
  );
});

afterAll(async () => {
  await owner.query("DELETE FROM platform_admins WHERE user_id = ANY($1)", [
    adminUserIds,
  ]);
  await owner.end();
  await appRole.end();
});

// ------------------------------------------------------------------- tests

describe("TEN-09 seeded source tenant", () => {
  it("TEN-09 the source fixture holds every config section it is meant to export", async () => {
    expect(await counts(source.tenantId)).toEqual(SOURCE_COUNTS);
    const ready = await readiness(admin, source.tenantId);
    expect(ready.ready, JSON.stringify(ready.checks)).toBe(true);
  });
});

describe("TEN-09 export, template and import", () => {
  it("TEN-09 exports a template and imports it into a new empty tenant that is then ready, with matching row counts", async () => {
    const target = await newTarget(admin, { modules: ["pos"] });

    // Empty state: a brand-new tenant is not ready yet.
    const before = await readiness(admin, target.tenantId);
    expect(before.ready).toBe(false);
    for (const check of ["approval_policies", "tax_settings", "tax_rules"])
      expect(before.checks.find((row) => row.check === check)?.ok, check).toBe(
        false,
      );
    expect(await counts(target.tenantId)).toEqual(EMPTY_COUNTS);

    const imported = await importOk(admin, target.tenantId, {
      templateId: template.id,
    });
    expect(imported).toMatchObject({
      tenantId: target.tenantId,
      templateId: template.id,
      status: "applied",
    });
    expect(imported.appliedSections).toEqual(
      expect.arrayContaining([
        "modules",
        "roles",
        "approval_policies",
        "chart_of_accounts",
        "tax_rules",
        "service_charge_rules",
        "zones",
        "checklists",
        "facilities",
        "wifi_policies",
      ]),
    );

    const after = await readiness(admin, target.tenantId);
    expect(after.ready, JSON.stringify(after.checks)).toBe(true);
    expect(after.checks.every((row) => row.ok)).toBe(true);
    expect(await counts(target.tenantId)).toEqual(SOURCE_COUNTS);
    // Every imported facility starts with the 1970-01-01 hours baseline
    // (legend-4us1a), so a later hours change never rewrites the past.
    const baselines = await owner.query<{ effective_from: string }>(
      `SELECT effective_from::text AS effective_from
         FROM facility_operating_hours_versions WHERE tenant_id = $1`,
      [target.tenantId],
    );
    expect(baselines.rows.map((row) => row.effective_from)).toEqual([
      "1970-01-01",
    ]);

    // Modules are unioned into the target (package validated).
    const flags = await owner.query<{ feature_flags: { modules: string[] } }>(
      "SELECT feature_flags FROM tenants WHERE id = $1",
      [target.tenantId],
    );
    expect(flags.rows[0]!.feature_flags.modules).toEqual(
      expect.arrayContaining(["pos", "qr_order", "accounting"]),
    );

    // Versioned config lands as a fresh published v1 owned by the importer,
    // and the source's draft v2 did not travel.
    const taxes = await owner.query<{
      code: string;
      rate_bp: number;
      version: number;
      status: string;
      published_by: string;
    }>(
      `SELECT code, rate_bp, version, status, published_by FROM tax_rules
        WHERE tenant_id = $1 ORDER BY code`,
      [target.tenantId],
    );
    expect(taxes.rows).toEqual([
      {
        code: "PBJT",
        rate_bp: 1000,
        version: 1,
        status: "published",
        published_by: admin.userId,
      },
      {
        code: "PBJT-KLG",
        rate_bp: 1100,
        version: 1,
        status: "published",
        published_by: admin.userId,
      },
    ]);

    // Cross-row references were re-pointed at the target's own rows.
    const links = await owner.query<{ ok: boolean }>(
      `SELECT (sc.zone_id = z.id AND z.outlet_id = o.id AND o.tenant_id = $1) AS ok
         FROM service_charge_rules sc
         JOIN floor_zones z ON z.id = sc.zone_id AND z.tenant_id = sc.tenant_id
         JOIN outlets o ON o.id = sc.outlet_id AND o.tenant_id = sc.tenant_id
        WHERE sc.tenant_id = $1 AND sc.code = 'SC-INDOOR' AND z.name = 'Indoor'
          AND o.code = $2`,
      [target.tenantId, CODE_A],
    );
    expect(links.rows).toEqual([{ ok: true }]);
    const wifi = await owner.query<{ name: string }>(
      `SELECT z.name FROM wifi_policies w JOIN floor_zones z
         ON z.id = w.zone_id AND z.tenant_id = w.tenant_id
        WHERE w.tenant_id = $1`,
      [target.tenantId],
    );
    expect(wifi.rows).toEqual([{ name: "Indoor" }]);

    // The import is recorded.
    const rows = await importRows(target.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: imported.id, status: "applied" });
  });

  it("TEN-09 lists stored templates without their payload and returns the full template by id", async () => {
    const listed = await admin.client.get(
      "/api/platform/config-templates?limit=100",
    );
    expect(listed.status).toBe(200);
    const summary = (listed.body.data as Loose[]).find(
      (row) => row.id === template.id,
    );
    expect(summary).toMatchObject({
      name: template.name,
      version: 1,
      sourceTenantId: source.tenantId,
    });
    expect(summary).not.toHaveProperty("payload");

    const fetched = await admin.client.get(
      `/api/platform/config-templates/${template.id}`,
    );
    expect(fetched.status, JSON.stringify(fetched.body).slice(0, 600)).toBe(
      200,
    );
    const full = dataOf(fetched.body);
    expect(full.id).toBe(template.id);
    expect(full.payload.formatVersion).toBe(1);
    expect(full.payload.sections).toEqual(sourceBundle.sections);

    const missing = await admin.client.get(
      `/api/platform/config-templates/${randomUUID()}`,
    );
    expect(missing.status).toBe(404);
  });

  it("TEN-09 saving a template under an existing name creates the next version", async () => {
    const name = `Versi ${suffix()}`;
    const first = await createTemplate(admin, source.tenantId, name, [
      "modules",
    ]);
    const second = await createTemplate(admin, source.tenantId, name, [
      "modules",
    ]);
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    const fetched = await admin.client.get(
      `/api/platform/config-templates/${second.id}`,
    );
    // Only the chosen sections are stored.
    expect(Object.keys(dataOf(fetched.body).payload.sections)).toEqual([
      "modules",
    ]);
  });

  it("TEN-09 importing into a freshly provisioned tenant keeps its defaults and still ends ready", async () => {
    const target = await newTarget(admin, { keepDefaults: true });
    const imported = await importOk(admin, target.tenantId, {
      templateId: template.id,
    });
    expect(imported.status).toBe("applied");
    // The default tax settings stay (one published row per scope), they are not
    // duplicated or replaced by the template's.
    expect((await counts(target.tenantId)).taxSettings).toBe(1);
    const ready = await readiness(admin, target.tenantId);
    expect(ready.ready, JSON.stringify(ready.checks)).toBe(true);
  });

  it("TEN-09 imports only the sections that were selected", async () => {
    const target = await newTarget(admin);
    const imported = await importOk(admin, target.tenantId, {
      templateId: template.id,
      sections: ["roles"],
    });
    expect(imported.appliedSections).toEqual(["roles"]);
    expect(await counts(target.tenantId)).toEqual({
      ...EMPTY_COUNTS,
      customRoles: 1,
    });
  });

  it("TEN-09 importing an uploaded bundle works the same as importing a template", async () => {
    const target = await newTarget(admin);
    const imported = await importOk(admin, target.tenantId, {
      bundle: sourceBundle,
    });
    expect(imported).toMatchObject({ status: "applied", templateId: null });
    expect(await counts(target.tenantId)).toEqual(SOURCE_COUNTS);
  });

  it("TEN-09 applies the chart of accounts to every target legal entity", async () => {
    const target = await newTarget(admin, { legalEntities: 2 });
    await importOk(admin, target.tenantId, { templateId: template.id });
    const counted = await counts(target.tenantId);
    expect(counted.chartOfAccounts).toBe(6);
    expect(counted.accountMappings).toBe(4);
    const ready = await readiness(admin, target.tenantId);
    expect(ready.ready, JSON.stringify(ready.checks)).toBe(true);
  });

  it("TEN-09 skips outlet-scoped items without a matching target outlet and records a warning", async () => {
    const target = await newTarget(admin, { outletCodes: [CODE_A] });
    const imported = await importOk(admin, target.tenantId, {
      templateId: template.id,
    });
    expect(imported.status).toBe("applied");
    // Zone "Lantai 2" belongs to the outlet the target does not have.
    const zones = await owner.query<{ name: string }>(
      "SELECT name FROM floor_zones WHERE tenant_id = $1 ORDER BY name",
      [target.tenantId],
    );
    expect(zones.rows.map((row) => row.name)).toEqual(["Indoor", "Teras"]);
    expect((imported.warnings as string[]).length).toBeGreaterThan(0);
    const [row] = await importRows(target.tenantId);
    expect(row!.warnings.length).toBeGreaterThan(0);
    expect((await readiness(admin, target.tenantId)).ready).toBe(true);
  });

  it("TEN-09 keeps the target's package limits and warns when the bundle's limits differ", async () => {
    const targetLimits = { ...limits, maxOutlets: 3 };
    const target = await newTarget(admin, { limits: targetLimits });
    const imported = await importOk(admin, target.tenantId, {
      templateId: template.id,
    });
    const row = await owner.query<{ limits: Record<string, number> }>(
      "SELECT limits FROM tenants WHERE id = $1",
      [target.tenantId],
    );
    expect(row.rows[0]!.limits.maxOutlets).toBe(3);
    expect((imported.warnings as string[]).length).toBeGreaterThan(0);
  });

  it("TEN-09 refuses modules outside the target's package and changes nothing", async () => {
    // "accounting" is not part of the outlet-dasar package (see the platform
    // org API tests), and the source tenant has it enabled.
    const target = await newTarget(admin, {
      plan: "outlet-dasar",
      modules: ["pos"],
      limits: { ...limits, maxOutlets: 1 },
      outletCodes: [CODE_A],
    });
    const before = await snapshot(target.tenantId);
    const response = await postImport(admin, target.tenantId, {
      templateId: template.id,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("CONFIG_IMPORT_FAILED");
    expect(await snapshot(target.tenantId)).toEqual(before);
    const rows = await importRows(target.tenantId);
    expect(rows.map((row) => row.status)).toEqual(["failed"]);
  });
});

describe("TEN-09 what a bundle must not carry", () => {
  it("TEN-09 the exported bundle holds configuration sections only, no source ids, secrets, PII or transactions", async () => {
    const text = JSON.stringify(sourceBundle);
    expect(sourceBundle.formatVersion).toBe(1);

    // Only known configuration sections; loyalty/payroll have no tables yet.
    const sections = Object.keys(sourceBundle.sections);
    for (const section of sections) expect(ALLOWED_SECTIONS).toContain(section);
    expect(sections).not.toContain("loyalty_policy");
    expect(sections).not.toContain("payroll_settings");
    for (const section of [
      "roles",
      "approval_policies",
      "chart_of_accounts",
      "tax_rules",
      "service_charge_rules",
      "zones",
      "checklists",
      "facilities",
      "wifi_policies",
    ])
      expect(
        sourceBundle.sections[section]?.items?.length,
        section,
      ).toBeGreaterThan(0);

    // No uuid at all, and none of the source's identifiers verbatim.
    expect(text).not.toMatch(UUID_TEXT);
    for (const id of [
      source.tenantId,
      source.structure.brandId,
      ...source.structure.legalEntityIds,
      ...Object.values(source.structure.outletIds),
      source.adminUserId,
      source.employeeUserId,
      source.employeeId,
      source.integrationId,
      source.roleId,
    ])
      expect(text.toLowerCase()).not.toContain(id.toLowerCase());

    // No secret, no PII, no tenant-bound field names.
    for (const secret of Object.values(SECRETS))
      expect(text).not.toContain(secret);
    expect(text).not.toContain("6281234567890");
    expect(text).not.toMatch(
      /"(id|tenantId|outletId|legalEntityId|userId|employeeId|createdBy|updatedBy|publishedBy|deviceId|npwp|secretRef|email|phone)"\s*:/,
    );

    // Versioned config exports the published row only.
    expect(text).not.toContain("PBJT 12% draft");

    // Outlet-scoped rows reference outlets by lower-cased code.
    expect(text).toContain(`"${CODE_A.toLowerCase()}"`);
  });

  it("TEN-09 the stored template carries no source ids, secrets or PII either", async () => {
    const stored = await owner.query<{ payload: string }>(
      "SELECT payload::text AS payload FROM config_templates WHERE id = $1",
      [template.id],
    );
    const text = stored.rows[0]!.payload;
    expect(text).not.toMatch(UUID_TEXT);
    for (const secret of Object.values(SECRETS))
      expect(text).not.toContain(secret);
    expect(text).not.toContain(source.tenantId);
  });

  it("TEN-09 importing carries no people, integrations or transaction rows into the target", async () => {
    const target = await newTarget(admin);
    const before = await owner.query<{ assignments: string }>(
      "SELECT count(*) AS assignments FROM role_assignments WHERE tenant_id = $1",
      [target.tenantId],
    );
    await importOk(admin, target.tenantId, { templateId: template.id });
    for (const table of ["employees", "tenant_integrations", "tax_snapshots"]) {
      const rows = await owner.query<{ count: string }>(
        `SELECT count(*) FROM ${table} WHERE tenant_id = $1`,
        [target.tenantId],
      );
      expect(Number(rows.rows[0]!.count), table).toBe(0);
    }
    const after = await owner.query<{ assignments: string }>(
      "SELECT count(*) AS assignments FROM role_assignments WHERE tenant_id = $1",
      [target.tenantId],
    );
    expect(after.rows[0]!.assignments).toBe(before.rows[0]!.assignments);
    // The legal entity of the target has no npwp copied from the source.
    const npwp = await owner.query<{ npwp_encrypted: string | null }>(
      "SELECT npwp_encrypted FROM legal_entities WHERE tenant_id = $1",
      [target.tenantId],
    );
    expect(npwp.rows.every((row) => row.npwp_encrypted === null)).toBe(true);
  });

  it("TEN-09 exporting is read-only and an empty tenant exports no empty sections", async () => {
    const before = await snapshot(source.tenantId);
    await exportBundle(admin, source.tenantId);
    expect(await snapshot(source.tenantId)).toEqual(before);

    const empty = await newTarget(admin);
    const bundle = await exportBundle(admin, empty.tenantId);
    for (const section of [
      "chart_of_accounts",
      "tax_rules",
      "service_charge_rules",
      "zones",
      "checklists",
      "facilities",
      "wifi_policies",
      "approval_policies",
      "loyalty_policy",
      "payroll_settings",
    ])
      expect(bundle.sections[section], section).toBeUndefined();
  });
});

describe("TEN-09 failure and repeat imports", () => {
  it("TEN-09 an import that fails halfway leaves the target unchanged and records a failed import", async () => {
    const target = await newTarget(admin);
    const broken = JSON.parse(JSON.stringify(sourceBundle));
    // roles, CoA, zones ... apply first; the Wi-Fi policy then points at a
    // zone the bundle does not contain.
    broken.sections.wifi_policies.items[0].zoneKey = "zone-that-does-not-exist";
    expect(broken.sections.roles.items.length).toBeGreaterThan(0);
    expect(broken.sections.chart_of_accounts.items.length).toBeGreaterThan(0);

    const before = await snapshot(target.tenantId);
    expect(await counts(target.tenantId)).toEqual(EMPTY_COUNTS);

    const response = await postImport(admin, target.tenantId, {
      bundle: broken,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("CONFIG_IMPORT_FAILED");
    const importId = (
      response.body.error.details as { field: string; message: string }[]
    ).find((detail) => detail.field === "importId")?.message;
    expect(importId, JSON.stringify(response.body)).toBeTruthy();

    expect(await snapshot(target.tenantId)).toEqual(before);
    expect(await counts(target.tenantId)).toEqual(EMPTY_COUNTS);

    const rows = await importRows(target.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: importId, status: "failed" });
    expect(rows[0]!.errors.length).toBeGreaterThan(0);
    expect(rows[0]!.applied_sections).toEqual([]);

    // The target is still usable: the intact template imports afterwards.
    await importOk(admin, target.tenantId, { templateId: template.id });
    expect(await counts(target.tenantId)).toEqual(SOURCE_COUNTS);
  });

  it("TEN-09 non-empty loyalty or payroll settings fail the import as not supported yet", async () => {
    const target = await newTarget(admin);
    const before = await snapshot(target.tenantId);
    const bundle = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      sections: {
        payroll_settings: {
          version: 1,
          items: [
            {
              key: "pt.staff",
              kind: "payroll_policy",
              legalEntityKey: "pt",
              name: "Bulanan",
              employeeGroup: {
                code: "STAFF",
                name: "Staff",
                employmentTypes: ["pkwtt"],
              },
              cycle: {
                frequency: "monthly",
                cutoffDay: 20,
                payDay: 25,
                payMonthOffset: 0,
              },
              payDateAdjustment: "previous_working_day",
              jkkRiskClass: "low",
              bpjsProgrammes: [],
              isActive: true,
            },
          ],
        },
      },
    };
    const response = await postImport(admin, target.tenantId, { bundle });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("CONFIG_IMPORT_FAILED");
    expect(await snapshot(target.tenantId)).toEqual(before);
    const [row] = await importRows(target.tenantId);
    expect(row!.status).toBe("failed");
    expect(row!.errors.join(" ")).toMatch(/not supported yet/i);

    // Empty sections are fine.
    const empty = await importOk(admin, target.tenantId, {
      bundle: {
        ...bundle,
        sections: {
          payroll_settings: { version: 1, items: [] },
          loyalty_policy: { version: 1, items: [] },
        },
      },
    });
    expect(empty.status).toBe("applied");
  });

  it("TEN-09 importing the same template twice creates no duplicates", async () => {
    const target = await newTarget(admin);
    const first = await importOk(admin, target.tenantId, {
      templateId: template.id,
    });
    const afterFirst = await snapshot(target.tenantId);
    expect(await counts(target.tenantId)).toEqual(SOURCE_COUNTS);

    const second = await importOk(admin, target.tenantId, {
      templateId: template.id,
    });
    expect(second.status).toBe("applied");
    expect(second.id).not.toBe(first.id);

    // Same counts, and existing rows were neither edited nor replaced.
    expect(await counts(target.tenantId)).toEqual(SOURCE_COUNTS);
    const afterSecond = await snapshot(target.tenantId);
    afterSecond.tenants = afterFirst.tenants;
    expect(afterSecond).toEqual(afterFirst);
    expect((await readiness(admin, target.tenantId)).ready).toBe(true);
    expect(
      (await importRows(target.tenantId)).map((row) => row.status),
    ).toEqual(["applied", "applied"]);
  });

  it("TEN-09 refuses an invalid bundle before anything is written", async () => {
    const target = await newTarget(admin);
    const before = await snapshot(target.tenantId);

    // A source identifier smuggled into an item.
    const smuggled = JSON.parse(JSON.stringify(sourceBundle));
    smuggled.sections.zones.items[0].name = source.structure.brandId;
    const leaked = await postImport(admin, target.tenantId, {
      bundle: smuggled,
    });
    expect(leaked.status).toBe(422);
    expect(leaked.body.error.code).toBe("CONFIG_BUNDLE_INVALID");

    // A forbidden key (tenant-bound id) in an item.
    const forbidden = JSON.parse(JSON.stringify(sourceBundle));
    forbidden.sections.zones.items[0].outletId = "x";
    const forbiddenResponse = await postImport(admin, target.tenantId, {
      bundle: forbidden,
    });
    expect(forbiddenResponse.status).toBe(422);
    expect(forbiddenResponse.body.error.code).toBe("CONFIG_BUNDLE_INVALID");

    // Not a bundle at all.
    const junk = await postImport(admin, target.tenantId, {
      bundle: { hello: "world" },
    });
    expect(junk.status).toBe(422);
    expect(junk.body.error.code).toBe("CONFIG_BUNDLE_INVALID");

    // Exactly one of templateId / bundle.
    const both = await postImport(admin, target.tenantId, {
      templateId: template.id,
      bundle: sourceBundle,
    });
    expect(both.status).toBe(422);
    const neither = await postImport(admin, target.tenantId, {});
    expect(neither.status).toBe(422);

    expect(await snapshot(target.tenantId)).toEqual(before);
    expect(await importRows(target.tenantId)).toEqual([]);
  });

  it("TEN-09 refuses an unknown template, an unknown tenant and a non-active tenant", async () => {
    const target = await newTarget(admin);
    const unknownTemplate = await postImport(admin, target.tenantId, {
      templateId: randomUUID(),
    });
    expect(unknownTemplate.status).toBe(404);

    const unknownTenant = await postImport(admin, randomUUID(), {
      templateId: template.id,
    });
    expect(unknownTenant.status).toBe(404);

    const suspended = await admin.client
      .post(`${tenantPath(target.tenantId)}/status`)
      .set(originHeader)
      .send({
        status: "suspended",
        reason: "Uji impor ke tenant ditangguhkan.",
      });
    expect(suspended.status).toBe(200);
    const before = await snapshot(target.tenantId);
    const refused = await postImport(admin, target.tenantId, {
      templateId: template.id,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await counts(target.tenantId)).toEqual(EMPTY_COUNTS);
    expect((await snapshot(target.tenantId)).roles).toEqual(before.roles);
  });
});

describe("TEN-09 role and checklist safety on import", () => {
  const roleItem = (overrides: Record<string, unknown>) => ({
    key: "role.auditor-uji",
    kind: "custom",
    templateKey: null,
    name: "Auditor Uji",
    permissions: ["floor.table.view"],
    mfaRequired: false,
    allowedScopeTypes: ["tenant"],
    ...overrides,
  });
  const bundleOf = (sections: Record<string, unknown>) => ({
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    sections,
  });
  const rolesBundle = (items: unknown[]) =>
    bundleOf({ roles: { version: 1, items } });

  it("TEN-09 a custom role with an MFA-requiring permission is imported with MFA required, whatever the bundle says", async () => {
    const target = await newTarget(admin);
    // access.role.view is tagged access_admin, which makes a custom role
    // back-office (AUTH-05), so the bundle's mfaRequired:false cannot stand.
    const imported = await importOk(admin, target.tenantId, {
      bundle: rolesBundle([
        roleItem({
          permissions: ["access.role.view"],
          mfaRequired: false,
        }),
      ]),
    });
    expect(imported.status).toBe("applied");
    const roles = await owner.query<{ mfa_required: boolean }>(
      "SELECT mfa_required FROM roles WHERE tenant_id = $1 AND name = 'Auditor Uji' AND is_template = false",
      [target.tenantId],
    );
    expect(roles.rows).toEqual([{ mfa_required: true }]);
  });

  it("TEN-09 a template-kind role item with more permissions than its template is refused and nothing is written", async () => {
    const target = await newTarget(admin);
    const before = await snapshot(target.tenantId);
    const response = await postImport(admin, target.tenantId, {
      bundle: rolesBundle([
        roleItem({
          key: "tpl.cashier",
          kind: "template",
          templateKey: "cashier",
          name: "Kasir",
          // The cashier template never holds access administration.
          permissions: ["pos.sale.create", "access.role.manage"],
          allowedScopeTypes: ["outlet"],
        }),
      ]),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await snapshot(target.tenantId)).toEqual(before);
    expect(
      (await importRows(target.tenantId)).filter(
        (row) => row.status === "applied",
      ),
    ).toEqual([]);
  });

  it("TEN-09 a bundle cannot create or match the super_admin template", async () => {
    const target = await newTarget(admin);
    const before = await snapshot(target.tenantId);
    const response = await postImport(admin, target.tenantId, {
      bundle: rolesBundle([
        roleItem({
          key: "tpl.super_admin",
          kind: "template",
          templateKey: "super_admin",
          name: "Super Admin",
          permissions: [],
          mfaRequired: true,
        }),
      ]),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await snapshot(target.tenantId)).toEqual(before);
    expect(
      (await importRows(target.tenantId)).filter(
        (row) => row.status === "applied",
      ),
    ).toEqual([]);
  });

  it("TEN-09 a checklist whose role is not in the bundle still imports, without a role, and warns", async () => {
    const target = await newTarget(admin);
    const checklist = JSON.parse(
      JSON.stringify(sourceBundle.sections.checklists.items[0]),
    );
    checklist.roleKey = "role.tidak-ada-di-bundle";
    const imported = await importOk(admin, target.tenantId, {
      bundle: bundleOf({ checklists: { version: 1, items: [checklist] } }),
    });
    expect(imported.status).toBe("applied");
    expect((imported.warnings as string[]).length).toBeGreaterThan(0);

    const rows = await owner.query<{ name: string; role_id: string | null }>(
      "SELECT name, role_id FROM ops_checklist_templates WHERE tenant_id = $1",
      [target.tenantId],
    );
    expect(rows.rows).toEqual([{ name: "Buka Toko", role_id: null }]);
    const [row] = await importRows(target.tenantId);
    expect(row!.warnings.length).toBeGreaterThan(0);
  });

  // legend-5cwrq: reference checks run for kind-shaped items.
  const approvalItem = (overrides: Record<string, unknown> = {}) => ({
    key: "ap.void.1",
    kind: "approval",
    actionType: "void",
    thresholdIdr: null,
    approverRoleKey: "role.auditor-uji",
    levels: 1,
    requiresDistinctActor: true,
    ...overrides,
  });
  const accountItem = (overrides: Record<string, unknown> = {}) => ({
    key: "acct.9000",
    kind: "account",
    code: "9000",
    name: "Akun Uji",
    type: "asset",
    reportGroup: "cash_and_equivalents",
    parentKey: null,
    isActive: true,
    ...overrides,
  });

  it("TEN-09 legend-5cwrq an approval policy naming a role key the bundle does not carry is refused and nothing is written", async () => {
    const target = await newTarget(admin);
    const before = await snapshot(target.tenantId);
    const response = await postImport(admin, target.tenantId, {
      bundle: bundleOf({
        roles: { version: 1, items: [roleItem({})] },
        approval_policies: {
          version: 1,
          items: [approvalItem({ approverRoleKey: "role.tidak-ada" })],
        },
      }),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await snapshot(target.tenantId)).toEqual(before);
    expect(
      (await importRows(target.tenantId)).filter(
        (row) => row.status === "applied",
      ),
    ).toEqual([]);

    // Control: the same bundle with the role key present imports, so the
    // refusal above is about the reference and nothing else.
    const control = await importOk(admin, target.tenantId, {
      bundle: bundleOf({
        roles: { version: 1, items: [roleItem({})] },
        approval_policies: { version: 1, items: [approvalItem()] },
      }),
    });
    expect(control.status).toBe("applied");
  });

  it("TEN-09 legend-5cwrq a chart-of-accounts item whose parent key is not in the bundle is refused and nothing is written", async () => {
    const target = await newTarget(admin);
    const before = await snapshot(target.tenantId);
    const response = await postImport(admin, target.tenantId, {
      bundle: bundleOf({
        chart_of_accounts: {
          version: 1,
          items: [accountItem({ parentKey: "acct.9999" })],
        },
      }),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await snapshot(target.tenantId)).toEqual(before);
    expect(
      (await importRows(target.tenantId)).filter(
        (row) => row.status === "applied",
      ),
    ).toEqual([]);

    const control = await importOk(admin, target.tenantId, {
      bundle: bundleOf({
        chart_of_accounts: { version: 1, items: [accountItem()] },
      }),
    });
    expect(control.status).toBe("applied");
  });
});

// Founder decision: the cashier discount approval threshold is at most 5000 bp
// (50%) and at least 1 bp. A pos_discount item outside 1..5000 is refused with
// 422 (either CONFIG_BUNDLE_INVALID or CONFIG_IMPORT_FAILED; both are 422) and
// nothing is written. 5000 is accepted and stored as is.
describe("TEN-09 pos_discount threshold range (1..5000 bp)", () => {
  const posDiscountBundle = (discountThresholdBp: number) => ({
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    sections: {
      approval_policies: {
        version: 1,
        items: [
          {
            key: "pos.discount.tenant",
            kind: "pos_discount",
            outletKey: null,
            discountThresholdBp,
          },
        ],
      },
    },
  });
  const storedThresholds = async (tenantId: string) =>
    (
      await owner.query<{ bp: number }>(
        `SELECT discount_threshold_bp::int AS bp FROM pos_approval_policies
          WHERE tenant_id = $1 ORDER BY outlet_id NULLS FIRST`,
        [tenantId],
      )
    ).rows.map((row) => row.bp);

  it.each([5_001, 7_500, 10_000, 0])(
    "TEN-09 discount-cap-5000 an import with a pos_discount threshold of %i is refused and nothing is written",
    async (discountThresholdBp) => {
      const target = await newTarget(admin);
      const before = await snapshot(target.tenantId);
      const response = await postImport(admin, target.tenantId, {
        bundle: posDiscountBundle(discountThresholdBp),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(await snapshot(target.tenantId)).toEqual(before);
      expect(await storedThresholds(target.tenantId)).toEqual([]);
      expect(
        (await importRows(target.tenantId)).filter(
          (row) => row.status === "applied",
        ),
      ).toEqual([]);
    },
  );

  it.each([5_000, 1])(
    "TEN-09 discount-cap-5000 an import with a pos_discount threshold of %i is accepted and stored as is",
    async (discountThresholdBp) => {
      const target = await newTarget(admin);
      const imported = await importOk(admin, target.tenantId, {
        bundle: posDiscountBundle(discountThresholdBp),
      });
      expect(imported.status).toBe("applied");
      expect(await storedThresholds(target.tenantId)).toEqual([
        discountThresholdBp,
      ]);
    },
  );
});

describe("TEN-09 access", () => {
  it("TEN-09 answers 401 without a session and 403 to tenant admins, legacy admins and plain users on every endpoint", async () => {
    const target = await newTarget(admin);

    // A tenant admin with a verified second factor, but no platform role.
    const tenantAdmin = agent(app);
    const tenantAdminEmail = await signUp(tenantAdmin, "Admin Tenant TEN-09");
    await setRole(tenantAdminEmail, null);
    const session = await tenantAdmin.get("/api/auth/get-session");
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
        WHERE tenant_id = $1 AND template_key = 'tenant_admin'`,
      [source.tenantId, session.body.user.id],
    );
    await verifySessionMfa(tenantAdminEmail);

    // The global Better Auth admin role is not a platform admin either.
    const legacy = agent(app);
    const legacyEmail = await signUp(legacy, "Legacy Admin TEN-09");
    await setRole(legacyEmail, "admin");
    await verifySessionMfa(legacyEmail);

    const plain = agent(app);
    const plainEmail = await signUp(plain, "Pengguna Biasa");
    await verifySessionMfa(plainEmail);

    const calls = (client: ReturnType<typeof agent>) => [
      client.get("/api/platform/config-templates"),
      client.get(`/api/platform/config-templates/${template.id}`),
      client.get(`${tenantPath(source.tenantId)}/config-export`),
      client.get(`${tenantPath(source.tenantId)}/config-readiness`),
      client
        .post(`${tenantPath(source.tenantId)}/config-templates`)
        .set(originHeader)
        .send({ name: "Tidak boleh" }),
      client
        .post(`${tenantPath(target.tenantId)}/config-import`)
        .set(originHeader)
        .send({ templateId: template.id }),
    ];

    const templatesBefore = await owner.query<{ count: string }>(
      "SELECT count(*) FROM config_templates",
    );
    const targetBefore = await snapshot(target.tenantId);

    for (const response of await Promise.all(calls(agent(app))))
      expect(response.status).toBe(401);
    for (const [label, client] of [
      ["tenant admin", tenantAdmin],
      ["legacy admin", legacy],
      ["plain user", plain],
    ] as const)
      for (const response of await Promise.all(calls(client))) {
        expect(response.status, `${label} ${response.request.url}`).toBe(403);
        expect(response.body.error.code).toBe("FORBIDDEN");
      }

    // Nothing was written by the refused calls.
    const templatesAfter = await owner.query<{ count: string }>(
      "SELECT count(*) FROM config_templates",
    );
    expect(templatesAfter.rows[0]!.count).toBe(templatesBefore.rows[0]!.count);
    expect(await snapshot(target.tenantId)).toEqual(targetBefore);
    expect(await importRows(target.tenantId)).toEqual([]);
  });

  it("TEN-09 refuses a platform admin's writes from an untrusted origin", async () => {
    const target = await newTarget(admin);
    const response = await admin.client
      .post(`${tenantPath(target.tenantId)}/config-import`)
      .set({ Origin: "https://untrusted.example" })
      .send({ templateId: template.id });
    expect(response.status).toBe(403);
    expect(await importRows(target.tenantId)).toEqual([]);
  });
});

describe("TEN-09 tenant isolation", () => {
  it("TEN-09 importing into one tenant never touches other tenants, and config_imports stay invisible across tenants under RLS", async () => {
    // A is the source, C a bystander that has config of its own and an
    // outlet with the same code as the target's.
    const bystander = await newTarget(admin, { outletCodes: [CODE_A] });
    const [bystanderEntity] = bystander.structure.legalEntityIds;
    await asTenant(bystander.tenantId, async (client) => {
      await client.query(
        `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode,
           service_charge_bp, minimum_spend_idr, hours, status, sort_order)
         VALUES ($1, $2, $3, 'Zona Tetangga', 'pay_first', 0, 0, $4, 'active', 0)`,
        [
          randomUUID(),
          bystander.tenantId,
          bystander.structure.outletIds[CODE_A],
          ZONE_HOURS,
        ],
      );
      await client.query(
        `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
         VALUES ($1, $2, 'Peran Tetangga', false, '["floor.table.view"]', '["tenant"]')`,
        [randomUUID(), bystander.tenantId],
      );
      await client.query(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, '9999', 'Akun Tetangga', 'asset', 'cash_and_equivalents')`,
        [bystander.tenantId, bystanderEntity],
      );
    });

    const target = await newTarget(admin);
    const sourceBefore = await snapshot(source.tenantId);
    const bystanderBefore = await snapshot(bystander.tenantId);

    const imported = await importOk(admin, target.tenantId, {
      templateId: template.id,
    });
    expect(await counts(target.tenantId)).toEqual(SOURCE_COUNTS);

    expect(await snapshot(source.tenantId)).toEqual(sourceBefore);
    expect(await snapshot(bystander.tenantId)).toEqual(bystanderBefore);
    expect(await importRows(source.tenantId)).toEqual([]);
    expect(await importRows(bystander.tenantId)).toEqual([]);

    // Imported rows belong to the target's own outlets and legal entity.
    const foreign = await owner.query<{ count: string }>(
      `SELECT count(*) FROM floor_zones z
        WHERE z.tenant_id = $1
          AND NOT EXISTS (SELECT 1 FROM outlets o
                           WHERE o.id = z.outlet_id AND o.tenant_id = $1)`,
      [target.tenantId],
    );
    expect(Number(foreign.rows[0]!.count)).toBe(0);

    // RLS: the application role only sees the current tenant's imports.
    const visibleIds = async (tenantId: string | null) => {
      const client = await appRole.connect();
      try {
        await client.query("BEGIN");
        if (tenantId)
          await client.query(
            "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
            [tenantId],
          );
        const rows = await client.query<{ id: string; tenant_id: string }>(
          "SELECT id, tenant_id FROM config_imports",
        );
        await client.query("COMMIT");
        return rows.rows;
      } catch {
        await client.query("ROLLBACK");
        return []; // refusing the query outright is also isolation
      } finally {
        client.release();
      }
    };
    const asTarget = await visibleIds(target.tenantId);
    expect(asTarget.map((row) => row.id)).toContain(imported.id);
    expect(asTarget.every((row) => row.tenant_id === target.tenantId)).toBe(
      true,
    );
    expect(
      (await visibleIds(source.tenantId)).filter(
        (row) => row.id === imported.id,
      ),
    ).toEqual([]);
    expect(
      (await visibleIds(bystander.tenantId)).filter(
        (row) => row.id === imported.id,
      ),
    ).toEqual([]);
    expect(await visibleIds(null)).toEqual([]);
  });
});
