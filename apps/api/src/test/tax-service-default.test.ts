// Default service charge (bead legend-2qz7; PRD v1.7 §3.14 F11 "Service Charge
// per zona atau tipe pesanan", D13). A tenant created from the Platform panel
// gets a published tenant-wide 5% dine-in service charge rule (SC-DINE-IN, food
// and beverage). An outlet created in a tenant that has no tenant-wide
// SC-DINE-IN gets an outlet-scoped one. The backfill never seeds service charge.
//
// Same harness as tax-provisioning.test.ts: real Express app, Better Auth and
// PostgreSQL.
//
// Assumptions where the brief is silent:
// - An "old" tenant (created before this feature) is simulated by creating a
//   panel tenant and deleting its service charge rules and their audit rows.
// - Audit rows are matched by `event->>'action'` = tax.service_charge.provisioned
//   and tenant id; `maskedChanges` is not asserted.
// - Expected preview tax is derived from the default PBJT rule's own
//   `include_service_in_base` flag read from the database, not hard coded.
// - Preview of a takeaway line uses channel "takeaway" and an outlet that has
//   the default rule; service charge must be 0.
// - "Owner-changed" means a newer version row of the rule or is_active=false;
//   a disabled/changed tenant-wide rule still counts as "tenant already has one".

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type {
  OutletId,
  ScopedTenantContext,
  UserId,
} from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  backfillTenantTaxDefaults,
  provisionDefaultServiceChargeRule,
} from "../services/tax-provisioning.service";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const SERVICE_ACTION = "tax.service_charge.provisioned";
const SERVICE_CODE = "SC-DINE-IN";

const OPENING_HOURS = {
  mon: { opens: "08:00", closes: "22:00" },
  tue: { opens: "08:00", closes: "22:00" },
  wed: { opens: "08:00", closes: "22:00" },
  thu: { opens: "08:00", closes: "22:00" },
  fri: { opens: "08:00", closes: "23:00" },
  sat: { opens: "08:00", closes: "23:00" },
  sun: { opens: "08:00", closes: "22:00" },
};

const limits = {
  maxOutlets: 50,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 100,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 50_000,
  emailCostCapIdr: 10_000,
};

const OLD_TENANT_AUDIT_BASE = 1;
const unique = () => randomBytes(4).toString("hex");
// platform_admins rows this file inserted; cleanup deletes only these.
const adminUserIds: string[] = [];
const today = () => businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (adminUserIds.length > 0)
    await owner.query(
      "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
      [adminUserIds],
    );
  await owner.end();
});

// ------------------------------------------------------------------ helpers

function scopedContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function adminClient() {
  const client = agent(app);
  const email = await signUp(client, "Service Default Admin");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  adminUserIds.push(userId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [seededTenantId, userId],
  );
  await verifySessionMfa(email);
  return { client, userId };
}

/** Creates a tenant through the Platform panel API and returns its id. */
async function createTenantViaPanel() {
  const { client: platform } = await adminClient();
  const created = await platform
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `svc-${unique()}`,
      name: "Uji Service Charge",
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
  return created.body.data.id as string;
}

/** Signed-in owner of the tenant; the Host header resolves the tenant. */
async function tenantOwnerClient(tenantId: string) {
  const client = agent(app);
  const email = await signUp(client, "Service Default Owner");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId, userId],
  );
  await verifySessionMfa(email);

  const hostname = `svc-${unique()}.contoh.example`;
  const brandId = randomUUID();
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand domain')",
    [brandId, tenantId, `dom-${unique()}`],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
    [randomUUID(), tenantId, brandId, hostname],
  );
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  const hosted = new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && methods.has(prop))
        return (url: string) =>
          (target as unknown as Record<string, (u: string) => Test>)[prop]!(
            url,
          ).set("Host", hostname);
      return Reflect.get(target, prop, receiver);
    },
  });
  return { client: hosted, brandId, userId };
}

type OwnerClient = Awaited<ReturnType<typeof tenantOwnerClient>>;

async function createOutletApi(
  { client, brandId }: OwnerClient,
  entityId?: string,
): Promise<{ outletId: string; entityId: string }> {
  let legalEntityId = entityId;
  if (!legalEntityId) {
    const entity = await client
      .post("/api/org/legal-entities")
      .set(originHeader)
      .send({
        name: `PT Service ${unique()}`,
        npwp: null,
        isPkp: false,
        address: "Kota Bandung",
      });
    expect(entity.status, JSON.stringify(entity.body)).toBe(201);
    legalEntityId = entity.body.data.id as string;
  }
  const response = await client
    .post("/api/org/outlets")
    .set(originHeader)
    .send({
      brandId,
      legalEntityId,
      code: `SVC-${unique()}`.toUpperCase(),
      name: "Outlet Service",
      address: "Jl. Service No. 1, Kota Bandung",
      regionId: null,
      geofence: null,
      timeZone: "Asia/Jakarta",
      openingHours: OPENING_HOURS,
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { outletId: response.body.data.id as string, entityId: legalEntityId };
}

type ServiceRow = {
  id: string;
  tenant_id: string;
  outlet_id: string | null;
  code: string;
  rate_bp: number;
  order_types: string[];
  item_classes: string[];
  is_active: boolean;
  version: number;
  status: string;
  published_by: string | null;
};

const selectServiceRules = (tenantId: string) =>
  owner
    .query(
      "SELECT * FROM service_charge_rules WHERE tenant_id = $1 ORDER BY id",
      [tenantId],
    )
    .then((r) => r.rows as ServiceRow[]);

const selectTaxRules = (tenantId: string) =>
  owner
    .query("SELECT * FROM tax_rules WHERE tenant_id = $1 ORDER BY id", [
      tenantId,
    ])
    .then((r) => r.rows as Record<string, unknown>[]);

async function serviceAuditCount(tenantId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = $2",
    [tenantId, SERVICE_ACTION],
  );
  return rows[0]!.n;
}

/**
 * Turns a panel tenant into one created before this feature: no service rules.
 * Audit rows are append-only, so the panel's one provisioning audit row stays;
 * tests compare audit counts against that baseline (OLD_TENANT_AUDIT_BASE).
 */
async function makeOldTenant() {
  const tenantId = await createTenantViaPanel();
  await owner.query("DELETE FROM service_charge_rules WHERE tenant_id = $1", [
    tenantId,
  ]);
  expect(await selectServiceRules(tenantId)).toHaveLength(0);
  return tenantId;
}

function provisionInTx(
  tenantId: string,
  actorId: string,
  outletId: string | null,
) {
  const context = scopedContext(tenantId);
  return withTenant(db, context, (tx) =>
    provisionDefaultServiceChargeRule(
      tx,
      context,
      actorId as UserId,
      outletId as OutletId | null,
    ),
  );
}

function previewBody(
  outletId: string,
  channel: "dine_in" | "reservation" | "takeaway",
  businessDate = today(),
) {
  return {
    outletId,
    businessDate,
    channel,
    zoneId: null,
    regionCode: null,
    orderDiscountIdr: 0,
    lines: [
      {
        lineId: "L1",
        itemId: randomUUID(),
        categoryId: null,
        itemClass: "food_beverage",
        grossIdr: 100_000,
        discountIdr: 0,
        components: [],
      },
    ],
  };
}

/** Expected exclusive-price totals for a Rp 100.000 line given the PBJT rule. */
async function expectedTotals(tenantId: string, withService: boolean) {
  const rules = (await selectTaxRules(tenantId)).filter(
    (r) => r.code === "PBJT-FNB",
  );
  expect(rules).toHaveLength(1);
  const rate = rules[0]!.rate_bp as number;
  const includeService = rules[0]!.include_service_in_base as boolean;
  const service = withService ? 5_000 : 0;
  const taxBase = includeService ? 100_000 + service : 100_000;
  const tax = Math.round((taxBase * rate) / 10_000);
  return { service, tax, total: 100_000 + service + tax };
}

// -------------------------------------------------------------------- tests

describe("legend-2qz7 tenant created in the Platform panel gets a default 5% dine-in service charge", () => {
  it("creates one published, active, tenant-wide SC-DINE-IN 5% rule with audit", async () => {
    const tenantId = await createTenantViaPanel();

    const rules = await selectServiceRules(tenantId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      tenant_id: tenantId,
      outlet_id: null,
      code: SERVICE_CODE,
      rate_bp: 500,
      order_types: ["dine_in", "reservation"],
      item_classes: ["food_beverage"],
      is_active: true,
      status: "published",
      version: 1,
    });
    expect(rules[0]!.published_by).not.toBeNull();
    expect(await serviceAuditCount(tenantId)).toBe(1);
  });

  it("an outlet created in that new tenant gets no extra rule (tenant-wide covers it)", async () => {
    const tenantId = await createTenantViaPanel();
    const ownerClient = await tenantOwnerClient(tenantId);
    const before = await selectServiceRules(tenantId);
    const auditBefore = await serviceAuditCount(tenantId);

    await createOutletApi(ownerClient);

    expect(await selectServiceRules(tenantId)).toEqual(before);
    expect(await serviceAuditCount(tenantId)).toBe(auditBefore);
  });

  it("preview of a dine-in bill shows subtotal, 5% service charge and tax on the base the rule defines", async () => {
    const tenantId = await createTenantViaPanel();
    const ownerClient = await tenantOwnerClient(tenantId);
    const { outletId } = await createOutletApi(ownerClient);

    const preview = await ownerClient.client
      .post("/api/tax/preview")
      .set(originHeader)
      .send(previewBody(outletId, "dine_in"));
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);

    const expected = await expectedTotals(tenantId, true);
    expect(preview.body.data.serviceChargeIdr).toBe(5_000);
    expect(preview.body.data.taxIdr).toBe(expected.tax);
    expect(preview.body.data.totalIdr).toBe(expected.total);
  });

  it("preview of a dine-in reservation bill gets the same 5% service charge (legend-9flj)", async () => {
    const tenantId = await createTenantViaPanel();
    const ownerClient = await tenantOwnerClient(tenantId);
    const { outletId } = await createOutletApi(ownerClient);

    const preview = await ownerClient.client
      .post("/api/tax/preview")
      .set(originHeader)
      .send(previewBody(outletId, "reservation"));
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);

    const expected = await expectedTotals(tenantId, true);
    expect(preview.body.data.serviceChargeIdr).toBe(5_000);
    expect(preview.body.data.taxIdr).toBe(expected.tax);
    expect(preview.body.data.totalIdr).toBe(expected.total);
  });

  it("an outlet default in an old tenant also covers reservation bills (legend-9flj)", async () => {
    const tenantId = await makeOldTenant();
    const ownerClient = await tenantOwnerClient(tenantId);
    const { outletId } = await createOutletApi(ownerClient);

    const preview = await ownerClient.client
      .post("/api/tax/preview")
      .set(originHeader)
      .send(previewBody(outletId, "reservation"));
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.serviceChargeIdr).toBe(5_000);
  });

  it("preview of a takeaway bill has no service charge", async () => {
    const tenantId = await createTenantViaPanel();
    const ownerClient = await tenantOwnerClient(tenantId);
    const { outletId } = await createOutletApi(ownerClient);

    const preview = await ownerClient.client
      .post("/api/tax/preview")
      .set(originHeader)
      .send(previewBody(outletId, "takeaway"));
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);

    const expected = await expectedTotals(tenantId, false);
    expect(preview.body.data.serviceChargeIdr).toBe(0);
    expect(preview.body.data.taxIdr).toBe(expected.tax);
    expect(preview.body.data.totalIdr).toBe(expected.total);
  });
});

describe("legend-2qz7 outlet created in a tenant without service charge rules", () => {
  it("gets an outlet-scoped SC-DINE-IN 5% rule with audit, and its dine-in preview shows service", async () => {
    const tenantId = await makeOldTenant();
    const ownerClient = await tenantOwnerClient(tenantId);

    const { outletId } = await createOutletApi(ownerClient);

    const rules = await selectServiceRules(tenantId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      tenant_id: tenantId,
      outlet_id: outletId,
      code: SERVICE_CODE,
      rate_bp: 500,
      order_types: ["dine_in", "reservation"],
      item_classes: ["food_beverage"],
      is_active: true,
      status: "published",
    });
    expect(await serviceAuditCount(tenantId)).toBe(OLD_TENANT_AUDIT_BASE + 1);

    const preview = await ownerClient.client
      .post("/api/tax/preview")
      .set(originHeader)
      .send(previewBody(outletId, "dine_in"));
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.serviceChargeIdr).toBe(5_000);
  });

  it("a second outlet in the same tenant gets its own outlet-scoped rule", async () => {
    const tenantId = await makeOldTenant();
    const ownerClient = await tenantOwnerClient(tenantId);

    const first = await createOutletApi(ownerClient);
    const second = await createOutletApi(ownerClient, first.entityId);

    const rules = await selectServiceRules(tenantId);
    expect(rules.map((r) => r.outlet_id).sort()).toEqual(
      [first.outletId, second.outletId].sort(),
    );
    expect(rules.every((r) => r.code === SERVICE_CODE)).toBe(true);
  });
});

describe("legend-2qz7 tenant-wide owner service rule and outlet audit", () => {
  // Assumption: any tenant-wide service charge rule (any code) means the owner
  // already chose; the outlet default is skipped and the owner's rule applies.
  it("a tenant with its own tenant-wide 'SVC' 10% rule: new outlet gets no SC-DINE-IN and dine-in still charges 10%", async () => {
    const tenantId = await makeOldTenant();
    const ruleId = randomUUID();
    await owner.query(
      `INSERT INTO service_charge_rules
         (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes, is_active,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'SVC', 'Service Owner', 1000, NULL, '["dine_in"]',
               '["food_beverage"]', true, 1, '2024-01-01', 'published', now(), $3)`,
      [ruleId, tenantId, randomUUID()],
    );
    const before = await selectServiceRules(tenantId);
    const auditBefore = await serviceAuditCount(tenantId);
    const ownerClient = await tenantOwnerClient(tenantId);

    const { outletId } = await createOutletApi(ownerClient);

    const after = await selectServiceRules(tenantId);
    expect(after).toEqual(before);
    expect(after.map((r) => r.code)).toEqual(["SVC"]);
    expect(after.some((r) => r.code === SERVICE_CODE)).toBe(false);
    expect(await serviceAuditCount(tenantId)).toBe(auditBefore);

    const preview = await ownerClient.client
      .post("/api/tax/preview")
      .set(originHeader)
      .send(previewBody(outletId, "dine_in"));
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.serviceChargeIdr).toBe(10_000);
  });

  it("the audit row of an outlet default carries the outlet id", async () => {
    const tenantId = await makeOldTenant();
    const ownerClient = await tenantOwnerClient(tenantId);

    const { outletId } = await createOutletApi(ownerClient);

    const { rows } = await owner.query<{
      outlet_id: string | null;
      object_id: string | null;
    }>(
      `SELECT outlet_id, event->>'objectId' AS object_id FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2 AND outlet_id = $3`,
      [tenantId, SERVICE_ACTION, outletId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ outlet_id: outletId, object_id: outletId });
  });
});

describe("legend-2qz7 provisioning is idempotent and never overwrites owner choices", () => {
  it("repeated calls for the same tenant-wide or outlet scope do not duplicate rules or audit rows", async () => {
    const tenantId = await createTenantViaPanel();
    const ownerClient = await tenantOwnerClient(tenantId);
    const rulesBefore = await selectServiceRules(tenantId);
    const auditBefore = await serviceAuditCount(tenantId);

    await provisionInTx(tenantId, ownerClient.userId, null);
    await provisionInTx(tenantId, ownerClient.userId, null);
    expect(await selectServiceRules(tenantId)).toEqual(rulesBefore);

    // Old tenant: provisioning the same outlet twice leaves a single rule.
    const oldTenant = await makeOldTenant();
    const oldOwner = await tenantOwnerClient(oldTenant);
    const { outletId } = await createOutletApi(oldOwner);
    const oldRules = await selectServiceRules(oldTenant);
    const oldAudit = await serviceAuditCount(oldTenant);
    expect(oldRules).toHaveLength(1);

    await provisionInTx(oldTenant, oldOwner.userId, outletId);
    await provisionInTx(oldTenant, oldOwner.userId, outletId);
    expect(await selectServiceRules(oldTenant)).toEqual(oldRules);
    expect(await serviceAuditCount(oldTenant)).toBe(oldAudit);
    expect(await serviceAuditCount(tenantId)).toBe(auditBefore);
  });

  it("a tenant-wide rule the owner disabled is not re-enabled or re-created when an outlet is created", async () => {
    const tenantId = await createTenantViaPanel();
    await owner.query(
      "UPDATE service_charge_rules SET is_active = false WHERE tenant_id = $1",
      [tenantId],
    );
    const before = await selectServiceRules(tenantId);
    const auditBefore = await serviceAuditCount(tenantId);
    const ownerClient = await tenantOwnerClient(tenantId);

    const { outletId } = await createOutletApi(ownerClient);
    await provisionInTx(tenantId, ownerClient.userId, null);

    expect(await selectServiceRules(tenantId)).toEqual(before);
    expect(before[0]!.is_active).toBe(false);
    expect(await serviceAuditCount(tenantId)).toBe(auditBefore);

    // Owner choice is honored in pricing: no service charge on dine-in.
    const preview = await ownerClient.client
      .post("/api/tax/preview")
      .set(originHeader)
      .send(previewBody(outletId, "dine_in"));
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.serviceChargeIdr).toBe(0);
  });

  it("a rule the owner changed to a new version (7%) is not overwritten", async () => {
    const tenantId = await createTenantViaPanel();
    const [v1] = await selectServiceRules(tenantId);
    await owner.query(
      `INSERT INTO service_charge_rules
         (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes, is_active,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, $3, 'Service 7%', 700, NULL, '["dine_in"]',
               '["food_beverage"]', true, 2, '2026-01-02', 'published', now(), $4)`,
      [randomUUID(), tenantId, SERVICE_CODE, v1!.published_by],
    );
    const before = await selectServiceRules(tenantId);
    expect(before).toHaveLength(2);
    const ownerClient = await tenantOwnerClient(tenantId);

    await createOutletApi(ownerClient);
    await provisionInTx(tenantId, ownerClient.userId, null);

    expect(await selectServiceRules(tenantId)).toEqual(before);
  });

  it("an outlet-scoped rule the owner disabled is not re-enabled by another provisioning call", async () => {
    const tenantId = await makeOldTenant();
    const ownerClient = await tenantOwnerClient(tenantId);
    const { outletId } = await createOutletApi(ownerClient);
    await owner.query(
      "UPDATE service_charge_rules SET is_active = false WHERE tenant_id = $1",
      [tenantId],
    );
    const before = await selectServiceRules(tenantId);

    await provisionInTx(tenantId, ownerClient.userId, outletId);

    expect(await selectServiceRules(tenantId)).toEqual(before);
  });
});

describe("legend-2qz7 backfill does not seed service charge", () => {
  it("backfillTenantTaxDefaults adds PBJT and settings but no service charge rule or audit", async () => {
    const tenantId = randomUUID();
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Service backfill uji', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenantId, `svcb-${tenantId.slice(0, 8)}`, seededTenantId],
    );

    const result = await backfillTenantTaxDefaults(tenantId);

    expect(result).toEqual({
      rulesInserted: 1,
      settingsInserted: 1,
      priceReady: true,
    });
    expect(await selectServiceRules(tenantId)).toHaveLength(0);
    expect(await serviceAuditCount(tenantId)).toBe(0);
  });
});

describe("legend-2qz7 tenant isolation", () => {
  it("an outlet created in tenant B never adds or changes service rules of tenant A", async () => {
    const tenantA = await createTenantViaPanel();
    const tenantB = await makeOldTenant();
    const rulesA = await selectServiceRules(tenantA);
    const auditA = await serviceAuditCount(tenantA);

    const ownerB = await tenantOwnerClient(tenantB);
    await createOutletApi(ownerB);

    expect(await selectServiceRules(tenantA)).toEqual(rulesA);
    expect(await serviceAuditCount(tenantA)).toBe(auditA);
    const rulesB = await selectServiceRules(tenantB);
    expect(rulesB).toHaveLength(1);
    expect(rulesB.every((r) => r.tenant_id === tenantB)).toBe(true);
  });
});
