// Service-charge overlap guard at publish (bead legend-mdh0) and the outlet
// default rule's actor (createOutlet passes the signed-in owner).
//
// Assumptions where the brief is silent:
// - A new version of an existing code is made by POSTing a rule with the same
//   code; the API numbers it latest + 1. The seeded SC-DINE-IN (tenant-wide,
//   dine_in + reservation, food_beverage) is the "old rule" a new rule ties with.
// - Error body shape is { error: { code, message } } like other tax routes.
// - Audit actor is read from event->>'actorType' / event->>'actorId'.
// - createOutlet called without an actor must not record a user actor
//   (published_by falls back to the system user id, observed 0...01).
// - The concurrency/lock sharing with createServiceChargeRule and the seed is
//   not asserted (needs holding a lock in a tx); only the two-publish race is.

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
import type { ScopedTenantContext } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { createOutlet } from "../services/org.service";
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

const unique = () => randomBytes(4).toString("hex");
const today = () => businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (platformAdminIds.length > 0)
    await owner.query(
      "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
      [platformAdminIds],
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

// Platform admin user ids this file inserted; cleanup deletes only these.
const platformAdminIds: string[] = [];

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
  platformAdminIds.push(userId);
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

type Owner = Awaited<ReturnType<typeof tenantOwnerClient>>;

const addDays = (days: number) =>
  businessDateOf(
    new Date(Date.now() + days * 86_400_000),
    DEFAULT_BUSINESS_DAY_CLOCK,
  );

function ruleBody(overrides: Record<string, unknown> = {}) {
  return {
    outletId: null,
    code: `SC-${unique()}`.toUpperCase(),
    name: "Uji overlap",
    rateBp: 1000,
    zoneId: null,
    orderTypes: ["dine_in"],
    itemClasses: ["food_beverage"],
    isActive: true,
    effectiveFrom: today(),
    ...overrides,
  };
}

async function createRule(
  ownerClient: Owner,
  overrides: Record<string, unknown> = {},
) {
  const created = await ownerClient.client
    .post("/api/tax/service-charge-rules")
    .set(originHeader)
    .send(ruleBody(overrides));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

function publishRule(ownerClient: Owner, id: string) {
  return ownerClient.client
    .post(`/api/tax/service-charge-rules/${id}/publish`)
    .set(originHeader)
    .send({ idempotencyKey: `publish-${id}` });
}

async function createAndPublish(
  ownerClient: Owner,
  overrides: Record<string, unknown> = {},
) {
  const id = await createRule(ownerClient, overrides);
  const published = await publishRule(ownerClient, id);
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return id;
}

const statusOf = (id: string) =>
  owner
    .query<{ status: string }>(
      "SELECT status FROM service_charge_rules WHERE id = $1",
      [id],
    )
    .then((r) => r.rows[0]!.status);

/** Publishes an inactive version of the seeded SC-DINE-IN: turns it off. */
function switchOffDefault(ownerClient: Owner, overrides = {}) {
  return createAndPublish(ownerClient, {
    code: SERVICE_CODE,
    isActive: false,
    orderTypes: ["dine_in", "reservation"],
    ...overrides,
  });
}

async function newTenantWithOutlet() {
  const tenantId = await createTenantViaPanel();
  const ownerClient = await tenantOwnerClient(tenantId);
  const { outletId } = await createOutletApi(ownerClient);
  return { tenantId, ownerClient, outletId };
}

// -------------------------------------------------------------------- tests

describe("legend-mdh0 publish refuses a service charge that ties with a rule in force", () => {
  it("returns 409 TAX_RULE_AMBIGUOUS naming the other code, and the row stays draft", async () => {
    const { tenantId, ownerClient } = await newTenantWithOutlet();
    const id = await createRule(ownerClient, { code: "SC-OWNER" });

    const response = await publishRule(ownerClient, id);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("TAX_RULE_AMBIGUOUS");
    expect(response.body.error.message).toContain(SERVICE_CODE);
    expect(await statusOf(id)).toBe("draft");
    const published = (await selectServiceRules(tenantId)).filter(
      (r) => r.status === "published",
    );
    expect(published.map((r) => r.code)).toEqual([SERVICE_CODE]);
  });

  it("switching the old rule off first lets the new rule publish, and preview charges the owner's rate", async () => {
    const { ownerClient, outletId } = await newTenantWithOutlet();

    await switchOffDefault(ownerClient);
    await createAndPublish(ownerClient, { code: "SC-OWNER", rateBp: 1000 });

    const preview = await ownerClient.client
      .post("/api/tax/preview")
      .set(originHeader)
      .send(previewBody(outletId, "dine_in"));
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.serviceChargeIdr).toBe(10_000);
  });
});

describe("legend-mdh0 publishes that do not tie are accepted", () => {
  // The rules below are mutually non-tying, so one tenant serves all cases.
  let ctx: Awaited<ReturnType<typeof newTenantWithOutlet>>;
  beforeAll(async () => {
    ctx = await newTenantWithOutlet();
  });

  it("a rule in a different zone", async () => {
    await createAndPublish(ctx.ownerClient, { zoneId: randomUUID() });
  });

  it("a takeaway-only rule next to the dine-in default (different channels)", async () => {
    await createAndPublish(ctx.ownerClient, { orderTypes: ["takeaway"] });
  });

  it("a rule with empty orderTypes next to one with explicit orderTypes (different rank)", async () => {
    await createAndPublish(ctx.ownerClient, { orderTypes: [] });
  });

  it("an outlet-scoped rule next to the tenant-wide default", async () => {
    await createAndPublish(ctx.ownerClient, {
      outletId: ctx.outletId,
      orderTypes: ["dine_in", "reservation"],
    });
  });

  it("an inactive version never ties", async () => {
    await createAndPublish(ctx.ownerClient, { isActive: false });
  });
});

describe("legend-mdh0 future-dated ties", () => {
  it("a rule starting earlier is refused when a peer starting later would then tie with it", async () => {
    const { ownerClient } = await newTenantWithOutlet();
    await switchOffDefault(ownerClient);
    const peerId = await createAndPublish(ownerClient, {
      code: "SC-LATER",
      effectiveFrom: addDays(7),
    });

    const earlier = await createRule(ownerClient, {
      code: "SC-EARLIER",
      effectiveFrom: addDays(5),
    });
    const response = await publishRule(ownerClient, earlier);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("TAX_RULE_AMBIGUOUS");
    expect(response.body.error.message).toContain("SC-LATER");
    expect(await statusOf(earlier)).toBe("draft");
    expect(await statusOf(peerId)).toBe("published");
  });

  it("a rule starting on the same later date as a peer is refused", async () => {
    const { ownerClient } = await newTenantWithOutlet();
    await switchOffDefault(ownerClient);
    await createAndPublish(ownerClient, {
      code: "SC-PEER",
      effectiveFrom: addDays(7),
    });

    const twin = await createRule(ownerClient, {
      code: "SC-TWIN",
      effectiveFrom: addDays(7),
    });
    const response = await publishRule(ownerClient, twin);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("TAX_RULE_AMBIGUOUS");
    expect(await statusOf(twin)).toBe("draft");
  });
});

describe("legend-mdh0 a stronger rule cannot hide a tie", () => {
  const ONLINE = ["takeaway", "gofood", "grabfood", "shopeefood"];

  it("SC-B ties with SC-A and is refused even though SC-ONLINE outranks both on takeaway", async () => {
    const { ownerClient, outletId } = await newTenantWithOutlet();
    // SC-ONLINE: explicit order types, no overlap with the dine-in default.
    const online = await createAndPublish(ownerClient, {
      code: "SC-ONLINE",
      orderTypes: ONLINE,
      rateBp: 700,
    });
    // SC-A: empty orderTypes. Ranks differ from SC-DINE-IN and SC-ONLINE: accepted.
    await createAndPublish(ownerClient, {
      code: "SC-A",
      orderTypes: [],
      rateBp: 300,
    });

    const b = await createRule(ownerClient, {
      code: "SC-B",
      orderTypes: [],
      rateBp: 400,
    });
    const response = await publishRule(ownerClient, b);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("TAX_RULE_AMBIGUOUS");
    expect(response.body.error.message).toContain("SC-A");
    expect(await statusOf(b)).toBe("draft");

    // Checkout still works while SC-ONLINE is on, and after it is switched off.
    const before = await ownerClient.client
      .post("/api/tax/preview")
      .set(originHeader)
      .send(previewBody(outletId, "takeaway"));
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.data.serviceChargeIdr).toBe(7_000);

    await createAndPublish(ownerClient, {
      code: "SC-ONLINE",
      orderTypes: ONLINE,
      isActive: false,
    });
    expect(await statusOf(online)).toBe("published");
    const after = await ownerClient.client
      .post("/api/tax/preview")
      .set(originHeader)
      .send(previewBody(outletId, "takeaway"));
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.data.serviceChargeIdr).toBe(3_000);
  });
});

describe("legend-mdh0 outlet-scoped ties", () => {
  it("two outlet-scoped rules for the same outlet and channel: the second is refused", async () => {
    const { ownerClient, outletId } = await newTenantWithOutlet();
    await createAndPublish(ownerClient, { code: "SC-OUT-1", outletId });

    const second = await createRule(ownerClient, {
      code: "SC-OUT-2",
      outletId,
    });
    const response = await publishRule(ownerClient, second);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("TAX_RULE_AMBIGUOUS");
    expect(response.body.error.message).toContain("SC-OUT-1");
    expect(await statusOf(second)).toBe("draft");
  });

  it("outlet-scoped rules for two different outlets do not tie", async () => {
    const { ownerClient, outletId } = await newTenantWithOutlet();
    const other = await createOutletApi(ownerClient);
    await createAndPublish(ownerClient, { code: "SC-O-A", outletId });
    await createAndPublish(ownerClient, {
      code: "SC-O-B",
      outletId: other.outletId,
    });
  });
});

describe("legend-mdh0 concurrent publishes", () => {
  it("two tying drafts published at once: exactly one succeeds, the other gets 409", async () => {
    const { tenantId, ownerClient } = await newTenantWithOutlet();
    await switchOffDefault(ownerClient);
    const a = await createRule(ownerClient, { code: "SC-RACE-A" });
    const b = await createRule(ownerClient, { code: "SC-RACE-B" });

    const [ra, rb] = await Promise.all([
      publishRule(ownerClient, a),
      publishRule(ownerClient, b),
    ]);

    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(loser.body.error.code).toBe("TAX_RULE_AMBIGUOUS");
    const published = (await selectServiceRules(tenantId)).filter(
      (r) => r.status === "published" && r.code.startsWith("SC-RACE-"),
    );
    expect(published).toHaveLength(1);
  });
});

describe("legend-mdh0 outlet default rule records who created the outlet", () => {
  it("outlet created through the API by a tenant owner: audit and published_by carry the owner id", async () => {
    const tenantId = await makeOldTenant();
    const ownerClient = await tenantOwnerClient(tenantId);

    const { outletId } = await createOutletApi(ownerClient);

    const { rows } = await owner.query<{
      actor_type: string | null;
      actor_id: string | null;
    }>(
      `SELECT event->>'actorType' AS actor_type, event->>'actorId' AS actor_id
         FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2 AND outlet_id = $3`,
      [tenantId, SERVICE_ACTION, outletId],
    );
    expect(rows).toEqual([
      { actor_type: "user", actor_id: ownerClient.userId },
    ]);
    const rules = await selectServiceRules(tenantId);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.published_by).toBe(ownerClient.userId);
  });

  it("the service called without an actor still creates the outlet and its rule, with no user actor", async () => {
    const tenantId = await makeOldTenant();
    const ownerClient = await tenantOwnerClient(tenantId);
    const entity = await ownerClient.client
      .post("/api/org/legal-entities")
      .set(originHeader)
      .send({
        name: `PT Tanpa Aktor ${unique()}`,
        npwp: null,
        isPkp: false,
        address: "Kota Bandung",
      });
    expect(entity.status, JSON.stringify(entity.body)).toBe(201);

    const outlet = await createOutlet(scopedContext(tenantId), {
      brandId: ownerClient.brandId,
      legalEntityId: entity.body.data.id as string,
      code: `SVC-${unique()}`.toUpperCase(),
      name: "Outlet Tanpa Aktor",
      address: "Jl. Service No. 2, Kota Bandung",
      regionId: null,
      geofence: null,
      timeZone: "Asia/Jakarta",
      openingHours: OPENING_HOURS,
    } as Parameters<typeof createOutlet>[1]);

    const rules = await selectServiceRules(tenantId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      outlet_id: outlet.id,
      code: SERVICE_CODE,
    });
    // published_by falls back to the system user (not null, not a person).
    expect(rules[0]!.published_by).not.toBe(ownerClient.userId);
    const { rows } = await owner.query<{ actor_type: string | null }>(
      `SELECT event->>'actorType' AS actor_type FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2 AND outlet_id = $3`,
      [tenantId, SERVICE_ACTION, outlet.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_type).not.toBe("user");
  });
});
