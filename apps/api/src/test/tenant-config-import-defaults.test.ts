// Bead legend-z1qk8: importing a template into a tenant that still holds the
// provisioning defaults (keepDefaults, the real-world path). A tenant-wide tax
// settings row or SC-DINE-IN service charge rule that is STILL EXACTLY the
// default is overwritten by the template. If the owner changed it, the import
// skips it and records a warning. Per-outlet rows are never treated as defaults.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { zoneConfigKey } from "../services/tenant-config-types";
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
const OUTLET_CODE = "DFL-01";
const SECTIONS = ["tax_rules", "service_charge_rules"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const dataOf = (body: { data?: unknown }) => (body.data ?? body) as Loose;
const suffix = () => randomBytes(4).toString("hex");

type Admin = { client: ReturnType<typeof agent>; userId: string };
const adminUserIds: string[] = [];

async function adminClient(): Promise<Admin> {
  const client = agent(app);
  const email = await signUp(client, "Platform Admin Defaults");
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

async function createTenant(
  admin: Admin,
  keepDefaults: boolean,
): Promise<string> {
  const created = await admin.client
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `dflt-${suffix()}`,
      name: "Uji import default",
      plan: "lengkap",
      deploymentMode: "shared",
      featureFlags: { modules: ["pos"], integrationProviders: [] },
      limits,
      firstAdmin: {
        name: "Admin Pertama",
        whatsapp: "6281234567890",
        email: null,
      },
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const tenantId = created.body.data.id as string;
  if (!keepDefaults)
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
  return tenantId;
}

/** Brand, legal entity and one outlet; returns the outlet id. */
async function addOutlet(tenantId: string): Promise<string> {
  return asTenant(tenantId, async (client) => {
    const brandId = randomUUID();
    const legalEntityId = randomUUID();
    const outletId = randomUUID();
    await client.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      [brandId, tenantId, `brand-${suffix()}`, "Kopi Legenda"],
    );
    await client.query(
      "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
      [legalEntityId, tenantId, `PT Uji ${suffix()}`],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
      [
        outletId,
        tenantId,
        brandId,
        legalEntityId,
        OUTLET_CODE,
        `Outlet ${OUTLET_CODE}`,
        OPENING_HOURS,
      ],
    );
    return outletId;
  });
}

const tenantPath = (tenantId: string) => `/api/platform/tenants/${tenantId}`;

async function importBundle(admin: Admin, tenantId: string, bundle: unknown) {
  const response = await admin.client
    .post(`${tenantPath(tenantId)}/config-import`)
    .set(originHeader)
    .send({ bundle, sections: SECTIONS });
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  const data = dataOf(response.body);
  expect(data.status).toBe("applied");
  return data as { warnings: string[] };
}

type SettingsRow = {
  outlet_id: string | null;
  service_rounding_mode: string;
  tax_rounding_mode: string;
  version: number;
  status: string;
  effective_from: string;
};

async function settingsRows(tenantId: string): Promise<SettingsRow[]> {
  const rows = await owner.query<SettingsRow>(
    `SELECT outlet_id, service_rounding_mode, tax_rounding_mode, version, status,
            effective_from::text AS effective_from
       FROM tax_settings WHERE tenant_id = $1 ORDER BY outlet_id NULLS FIRST, version`,
    [tenantId],
  );
  return rows.rows;
}

type ChargeRow = {
  outlet_id: string | null;
  code: string;
  name: string;
  rate_bp: number;
  version: number;
  status: string;
  effective_from: string;
};

async function chargeRows(tenantId: string): Promise<ChargeRow[]> {
  const rows = await owner.query<ChargeRow>(
    `SELECT outlet_id, code, name, rate_bp, version, status,
            effective_from::text AS effective_from
       FROM service_charge_rules WHERE tenant_id = $1
      ORDER BY outlet_id NULLS FIRST, code, version`,
    [tenantId],
  );
  return rows.rows;
}

const DEFAULT_FROM = "2024-01-01";

const OVERWRITE_ACTION = "tenant_config.import_default_overwrite";

type OverwriteAudit = {
  objectType: string;
  maskedChanges: { before: Loose; after: Loose };
};

async function overwriteAudits(tenantId: string): Promise<OverwriteAudit[]> {
  const rows = await owner.query<{ event: OverwriteAudit }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
      ORDER BY event->>'objectType'`,
    [tenantId, OVERWRITE_ACTION],
  );
  return rows.rows.map((row) => row.event);
}

/** A published version 2 of the tenant-wide tax settings (owner edit). */
async function insertTaxSettingsV2(
  tenantId: string,
  serviceRounding: string,
  taxRounding: string,
): Promise<void> {
  await asTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, $3, $4, 'half_up', NULL,
               'fixed_bp', 2, '2026-06-01', 'published', now(), $5)`,
      [randomUUID(), tenantId, serviceRounding, taxRounding, admin.userId],
    );
  });
}

/** Defaults untouched, nothing audited, and both skips warned in Indonesian. */
async function expectDefaultsKept(
  tenantId: string,
  warnings: string[],
): Promise<void> {
  const [settings] = (await settingsRows(tenantId)).filter(
    (row) => row.outlet_id === null,
  );
  expect(settings).toMatchObject({
    service_rounding_mode: "half_up",
    tax_rounding_mode: "half_up",
    version: 1,
  });
  const [charge] = (await chargeRows(tenantId)).filter(
    (row) => row.outlet_id === null,
  );
  expect(charge).toMatchObject({ code: "SC-DINE-IN", rate_bp: 500 });
  expect(await overwriteAudits(tenantId)).toHaveLength(0);
  const text = warnings.join("\n");
  expect(text).toMatch(/pajak/i);
  expect(text).toMatch(/service charge/i);
  expect(text).toContain("ubah manual di Pengaturan");
}

let admin: Admin;
let bundle: Loose;

beforeAll(async () => {
  admin = await adminClient();
  // Source: no defaults, its own template values (tenant-wide and outlet A).
  const sourceId = await createTenant(admin, false);
  const outletId = await addOutlet(sourceId);
  await asTenant(sourceId, async (client) => {
    for (const [outlet, service, tax] of [
      [null, "down", "ceil"],
      [outletId, "floor", "floor"],
    ] as const)
      await client.query(
        `INSERT INTO tax_settings
           (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
            tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
            version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, $3, 'discount_service_tax', false, $4, $5, 'half_up', NULL,
                 'fixed_bp', 1, '2026-01-01', 'published', now(), $6)`,
        [randomUUID(), sourceId, outlet, service, tax, admin.userId],
      );
    for (const [outlet, name, rate] of [
      [null, "Service template", 1000],
      [outletId, "Service template outlet", 700],
    ] as const)
      await client.query(
        `INSERT INTO service_charge_rules
           (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes,
            is_active, version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, $3, 'SC-DINE-IN', $4, $5, NULL, '["dine_in"]',
                 '["food_beverage"]', true, 1, '2026-01-01', 'published', now(), $6)`,
        [randomUUID(), sourceId, outlet, name, rate, admin.userId],
      );
  });
  const exported = await admin.client.get(
    `${tenantPath(sourceId)}/config-export`,
  );
  expect(exported.status, JSON.stringify(exported.body)).toBe(200);
  bundle = dataOf(exported.body);
});

afterAll(async () => {
  await owner.query("DELETE FROM platform_admins WHERE user_id = ANY($1)", [
    adminUserIds,
  ]);
  await owner.end();
});

describe("legend-z1qk8 import over provisioning defaults", () => {
  it("overwrites tenant-wide tax settings and the service charge that are still the default", async () => {
    const tenantId = await createTenant(admin, true);
    await addOutlet(tenantId);
    // Fresh tenant: exactly the provisioning defaults.
    expect(await settingsRows(tenantId)).toEqual([
      expect.objectContaining({
        outlet_id: null,
        service_rounding_mode: "half_up",
        tax_rounding_mode: "half_up",
        version: 1,
        status: "published",
        effective_from: DEFAULT_FROM,
      }),
    ]);

    const imported = await importBundle(admin, tenantId, bundle);

    const settings = await settingsRows(tenantId);
    const tenantWide = settings.filter((row) => row.outlet_id === null);
    expect(tenantWide).toHaveLength(1);
    expect(tenantWide[0]).toMatchObject({
      service_rounding_mode: "down",
      tax_rounding_mode: "ceil",
      version: 1,
      status: "published",
    });
    const charges = (await chargeRows(tenantId)).filter(
      (row) => row.outlet_id === null,
    );
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      code: "SC-DINE-IN",
      name: "Service template",
      rate_bp: 1000,
      version: 1,
      status: "published",
    });
    expect(imported.warnings.join("\n")).not.toMatch(/skipped/i);

    // One audit row per overwritten default: only the changed fields, from/to.
    const audits = await overwriteAudits(tenantId);
    expect(audits.map((row) => row.objectType)).toEqual([
      "service_charge_rule",
      "tax_settings",
    ]);
    const [chargeAudit, taxAudit] = audits;
    expect(taxAudit!.maskedChanges).toEqual({
      before: {
        source: "config_import",
        serviceRoundingMode: "half_up",
        taxRoundingMode: "half_up",
      },
      after: {
        source: "config_import",
        serviceRoundingMode: "down",
        taxRoundingMode: "ceil",
      },
    });
    expect(chargeAudit!.maskedChanges.before).toMatchObject({
      source: "config_import",
      rateBp: 500,
    });
    expect(chargeAudit!.maskedChanges.after).toMatchObject({
      source: "config_import",
      rateBp: 1000,
    });
    expect(JSON.stringify(audits)).not.toMatch(/redacted/i);

    // Importing again changes nothing and stays silent: the row now matches
    // the template, there is nothing to warn about.
    const again = await importBundle(admin, tenantId, bundle);
    expect((await settingsRows(tenantId)).filter((r) => !r.outlet_id)).toEqual(
      tenantWide,
    );
    expect(again.warnings.join("\n")).not.toMatch(/skipped/i);
    expect(await overwriteAudits(tenantId)).toHaveLength(2);
  });

  it("skips the default overwrite and warns when the tenant already has a transaction", async () => {
    const tenantId = await createTenant(admin, true);
    const outletId = await addOutlet(tenantId);
    await asTenant(tenantId, async (client) => {
      // Minimal trading row; FK checks are off so no cashier or device is needed.
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO pos_shifts
           (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
            opened_at, opening_float_idr, open_key, open_fingerprint)
         VALUES ($1, $2, $3, $4, $5, current_date, 'open', now(), 100000, $6, $7)`,
        [
          randomUUID(),
          tenantId,
          outletId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          "a".repeat(64),
        ],
      );
    });

    const imported = await importBundle(admin, tenantId, bundle);

    await expectDefaultsKept(tenantId, imported.warnings);
  });

  it("skips the default overwrite and warns when the tenant has a registered edge node", async () => {
    const tenantId = await createTenant(admin, true);
    const outletId = await addOutlet(tenantId);
    await asTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, label, credential_hash)
         VALUES ($1, $2, $3, 'primary', 'Edge uji', $4)`,
        [randomUUID(), tenantId, outletId, "b".repeat(64)],
      );
    });

    const imported = await importBundle(admin, tenantId, bundle);

    await expectDefaultsKept(tenantId, imported.warnings);
  });

  it("skips tax settings and the service charge the owner changed, and warns", async () => {
    const tenantId = await createTenant(admin, true);
    await addOutlet(tenantId);
    await asTenant(tenantId, async (client) => {
      await client.query(
        "UPDATE tax_settings SET tax_rounding_mode = 'half_even' WHERE tenant_id = $1 AND outlet_id IS NULL",
        [tenantId],
      );
      await client.query(
        "UPDATE service_charge_rules SET rate_bp = 800 WHERE tenant_id = $1 AND outlet_id IS NULL AND code = 'SC-DINE-IN'",
        [tenantId],
      );
    });

    const imported = await importBundle(admin, tenantId, bundle);

    const [settings] = (await settingsRows(tenantId)).filter(
      (row) => row.outlet_id === null,
    );
    expect(settings).toMatchObject({
      service_rounding_mode: "half_up",
      tax_rounding_mode: "half_even",
    });
    const [charge] = (await chargeRows(tenantId)).filter(
      (row) => row.outlet_id === null,
    );
    expect(charge).toMatchObject({
      rate_bp: 800,
      name: "Service charge dine-in",
    });
    const warnings = imported.warnings.join("\n");
    expect(warnings).toMatch(/skipped tax settings/i);
    expect(warnings).toMatch(/skipped service charge rule "SC-DINE-IN"/i);
    expect(await overwriteAudits(tenantId)).toEqual([]);
  });

  it("skips the service charge when the owner already published a newer version", async () => {
    const tenantId = await createTenant(admin, true);
    await addOutlet(tenantId);
    await asTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO service_charge_rules
           (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes,
            is_active, version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, NULL, 'SC-DINE-IN', 'Service v2', 600, NULL, '["dine_in"]',
                 '["food_beverage"]', true, 2, '2026-06-01', 'published', now(), $3)`,
        [randomUUID(), tenantId, admin.userId],
      );
    });

    const imported = await importBundle(admin, tenantId, bundle);

    const charges = (await chargeRows(tenantId)).filter(
      (row) => row.outlet_id === null,
    );
    expect(charges.map((row) => [row.version, row.rate_bp])).toEqual([
      [1, 500],
      [2, 600],
    ]);
    expect(imported.warnings.join("\n")).toMatch(
      /skipped service charge rule/i,
    );
  });

  it("re-importing a zone-scoped service charge stays silent and changes nothing", async () => {
    const tenantId = await createTenant(admin, true);
    const outletId = await addOutlet(tenantId);
    const zoneName = "Terrace";
    await asTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
         VALUES ($1, $2, $3, $4, 'pay_first', '[]')`,
        [randomUUID(), tenantId, outletId, zoneName],
      );
    });
    const zoneKey = zoneConfigKey(OUTLET_CODE, zoneName);
    const zoned: Loose = structuredClone(bundle);
    for (const item of zoned.sections.service_charge_rules.items)
      if (item.outletKey === null) item.zoneKey = zoneKey;

    const first = await importBundle(admin, tenantId, zoned);
    expect(first.warnings.join("\n")).not.toMatch(/skipped/i);
    const chargesAfterFirst = await chargeRows(tenantId);
    const zoneIds = await owner.query(
      "SELECT zone_id FROM service_charge_rules WHERE tenant_id = $1 AND outlet_id IS NULL",
      [tenantId],
    );
    expect(zoneIds.rows[0].zone_id).not.toBeNull();

    // The row now holds the template's zone: re-import is idempotent and silent.
    const again = await importBundle(admin, tenantId, zoned);
    expect(again.warnings.join("\n")).not.toMatch(
      /changed after provisioning/i,
    );
    expect(again.warnings.join("\n")).not.toMatch(/skipped/i);
    expect(await chargeRows(tenantId)).toEqual(chargesAfterFirst);
  });

  it("compares the newest published tax settings version: skipped with a warning when it differs", async () => {
    const tenantId = await createTenant(admin, true);
    await addOutlet(tenantId);
    await insertTaxSettingsV2(tenantId, "floor", "floor");

    const imported = await importBundle(admin, tenantId, bundle);

    const tenantWide = (await settingsRows(tenantId)).filter(
      (row) => row.outlet_id === null,
    );
    expect(
      tenantWide.map((row) => [
        row.version,
        row.service_rounding_mode,
        row.tax_rounding_mode,
      ]),
    ).toEqual([
      [1, "half_up", "half_up"],
      [2, "floor", "floor"],
    ]);
    expect(imported.warnings.join("\n")).toMatch(/skipped tax settings/i);
  });

  it("stays silent when the newest tax settings version already equals the template", async () => {
    const tenantId = await createTenant(admin, true);
    await addOutlet(tenantId);
    await insertTaxSettingsV2(tenantId, "down", "ceil");

    const imported = await importBundle(admin, tenantId, bundle);

    expect(imported.warnings.join("\n")).not.toMatch(/skipped tax settings/i);
    expect(
      (await settingsRows(tenantId)).filter((row) => row.outlet_id === null),
    ).toHaveLength(2);
  });

  it("stays silent when the newest service charge version already equals the template", async () => {
    const tenantId = await createTenant(admin, true);
    await addOutlet(tenantId);
    await asTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO service_charge_rules
           (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes,
            is_active, version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, NULL, 'SC-DINE-IN', 'Service template', 1000, NULL, '["dine_in"]',
                 '["food_beverage"]', true, 2, '2026-06-01', 'published', now(), $3)`,
        [randomUUID(), tenantId, admin.userId],
      );
    });

    const imported = await importBundle(admin, tenantId, bundle);

    expect(imported.warnings.join("\n")).not.toMatch(/skipped service charge/i);
  });

  it("never treats a per-outlet row as the default, even with default values", async () => {
    const tenantId = await createTenant(admin, true);
    const outletId = await addOutlet(tenantId);
    await asTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tax_settings
           (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
            tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
            version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, $3, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
                 'fixed_bp', 1, $4, 'published', now(), $5)`,
        [randomUUID(), tenantId, outletId, DEFAULT_FROM, admin.userId],
      );
      await client.query(
        `INSERT INTO service_charge_rules
           (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes,
            is_active, version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, $3, 'SC-DINE-IN', 'Service charge dine-in', 500, NULL,
                 '["dine_in","reservation"]', '["food_beverage"]', true, 1, $4,
                 'published', now(), $5)`,
        [randomUUID(), tenantId, outletId, DEFAULT_FROM, admin.userId],
      );
    });

    await importBundle(admin, tenantId, bundle);

    const [outletSettings] = (await settingsRows(tenantId)).filter(
      (row) => row.outlet_id === outletId,
    );
    expect(outletSettings).toMatchObject({
      service_rounding_mode: "half_up",
      tax_rounding_mode: "half_up",
    });
    const [outletCharge] = (await chargeRows(tenantId)).filter(
      (row) => row.outlet_id === outletId,
    );
    expect(outletCharge).toMatchObject({
      rate_bp: 500,
      name: "Service charge dine-in",
    });
  });
});
