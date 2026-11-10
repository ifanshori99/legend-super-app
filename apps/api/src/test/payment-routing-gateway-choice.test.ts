// Gateway choice per payment method (sub-302 Slice B, D8, D12-D14): a rule may
// only name a gateway that is registered, switched on by Super Admin, allowed
// for the tenant and backed by an active integration for that scope. Real
// Express app and PostgreSQL; the adapters are inert doubles. Global rows
// (platform gateways, the seeded tenant's flags) are restored after each test.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  cafeLegendPlatformFixtures,
  createTenantInputSchema,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import {
  registerPaymentGateway,
  resetPaymentGateways,
  unconfiguredPaymentGateway,
  type PaymentGatewayPort,
} from "../services/payment-gateway";
import { upsertRoutingRule } from "../services/payment-routing.service";
import { createTenant } from "../services/platform-org.service";
import { resetPlatformGatewayCache } from "../services/platform-payment-gateway.service";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const port = (provider: string): PaymentGatewayPort => ({
  ...unconfiguredPaymentGateway,
  provider,
});

const scopeOf = (id: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: id, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

const rule = (overrides: Record<string, unknown> = {}) => ({
  outletId: null,
  method: "qris" as const,
  provider: "duitku",
  fallbackProvider: null,
  enabled: true,
  ...overrides,
});

const userIds: string[] = [];
const roleIds: string[] = [];
let originalFlags: unknown;
let ownerUserId: string;

async function user(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const id = session.body.user.id as string;
  userIds.push(id);
  await verifySessionMfa(email);
  return { client, userId: id };
}

async function assignTemplate(
  userId: string,
  templateKey: string,
  forTenant = tenantId,
) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [forTenant, templateKey],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [forTenant, userId, rows[0]!.id],
  );
}

async function setFlags(providers: string[]) {
  await owner.query(
    `UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}', $2::jsonb) WHERE id = $1`,
    [tenantId, JSON.stringify(providers)],
  );
}

async function integrate(
  provider: string,
  outletId: string | null,
  status = "active",
) {
  await owner.query(
    `INSERT INTO tenant_integrations (tenant_id, outlet_id, provider, status, credentials_encrypted)
     VALUES ($1, $2, $3, $4, 'sealed')`,
    [tenantId, outletId, provider, status],
  );
}

async function platformGateway(provider: string, enabled: boolean) {
  await owner.query(
    "UPDATE platform_payment_gateways SET enabled = $2 WHERE provider = $1",
    [provider, enabled],
  );
  resetPlatformGatewayCache();
}

async function expectRefused(
  promise: Promise<unknown>,
  reason: RegExp,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    status: 422,
    code: "VALIDATION_ERROR",
    message: expect.stringMatching(/^GATEWAY_NOT_AVAILABLE: /),
  });
  await expect(promise).rejects.toThrow(reason);
}

beforeAll(async () => {
  const flags = await owner.query(
    "SELECT feature_flags FROM tenants WHERE id = $1",
    [tenantId],
  );
  originalFlags = flags.rows[0].feature_flags;
  ownerUserId = (await user("Routing owner")).userId;
  await assignTemplate(ownerUserId, "owner");
});

beforeEach(async () => {
  resetPaymentGateways();
  registerPaymentGateway(port("doit"));
  registerPaymentGateway(port("duitku"));
  await platformGateway("duitku", true);
  await setFlags(["doit", "duitku"]);
  await integrate("duitku", outletB);
  await integrate("doit", null);
});

afterEach(async () => {
  resetPaymentGateways();
  await owner.query(
    "DELETE FROM payment_routing_rules WHERE tenant_id = $1 AND method IN ('qris','va','bank_transfer')",
    [tenantId],
  );
  await owner.query(
    "DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider IN ('duitku','doit')",
    [tenantId],
  );
  await platformGateway("duitku", false);
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenantId,
    JSON.stringify(originalFlags),
  ]);
});

afterAll(async () => {
  if (roleIds.length) {
    await owner.query("DELETE FROM role_assignments WHERE role_id = ANY($1)", [
      roleIds,
    ]);
    await owner.query("DELETE FROM roles WHERE id = ANY($1)", [roleIds]);
  }
  await owner.end();
});

describe("rule validation (D12)", () => {
  it("accepts an enabled rule on a platform-enabled, allowed, integrated gateway", async () => {
    const saved = await upsertRoutingRule(
      scopeOf(tenantId),
      rule({ outletId: outletB, fallbackProvider: "doit" }),
      ownerUserId,
    );
    expect(saved).toMatchObject({
      outletId: outletB,
      provider: "duitku",
      fallbackProvider: "doit",
    });
  });

  it("refuses a rule that names a platform-disabled gateway", async () => {
    await platformGateway("duitku", false);
    await expectRefused(
      upsertRoutingRule(
        scopeOf(tenantId),
        rule({ outletId: outletB }),
        ownerUserId,
      ),
      /switched off/,
    );
  });

  it("refuses a gateway without a registered adapter", async () => {
    resetPaymentGateways();
    registerPaymentGateway(port("doit"));
    await expectRefused(
      upsertRoutingRule(
        scopeOf(tenantId),
        rule({ outletId: outletB }),
        ownerUserId,
      ),
      /no adapter/,
    );
  });

  it("refuses a gateway the tenant's package does not list", async () => {
    await setFlags(["doit"]);
    await expectRefused(
      upsertRoutingRule(
        scopeOf(tenantId),
        rule({ outletId: outletB }),
        ownerUserId,
      ),
      /package/,
    );
  });

  it("refuses a gateway with no active integration (none, draft or disabled)", async () => {
    await owner.query(
      "DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'duitku'",
      [tenantId],
    );
    await expectRefused(
      upsertRoutingRule(scopeOf(tenantId), rule(), ownerUserId),
      /no active integration/,
    );
    await integrate("duitku", null, "draft");
    await expectRefused(
      upsertRoutingRule(scopeOf(tenantId), rule(), ownerUserId),
      /no active integration/,
    );
    await owner.query(
      "UPDATE tenant_integrations SET status = 'disabled' WHERE tenant_id = $1 AND provider = 'duitku'",
      [tenantId],
    );
    await expectRefused(
      upsertRoutingRule(scopeOf(tenantId), rule(), ownerUserId),
      /no active integration/,
    );
  });

  it("refuses a fallback equal to the provider or without integration", async () => {
    await expectRefused(
      upsertRoutingRule(
        scopeOf(tenantId),
        rule({ outletId: outletB, fallbackProvider: "duitku" }),
        ownerUserId,
      ),
      /must differ/,
    );
    await owner.query(
      "DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'doit'",
      [tenantId],
    );
    await expectRefused(
      upsertRoutingRule(
        scopeOf(tenantId),
        rule({ outletId: outletB, fallbackProvider: "doit" }),
        ownerUserId,
      ),
      /doit has no active integration/,
    );
  });

  it("an outlet rule cannot use another outlet's integration; a tenant rule can use any active outlet row", async () => {
    await owner.query(
      "DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'doit'",
      [tenantId],
    );
    // duitku is integrated for outlet B only.
    await expectRefused(
      upsertRoutingRule(
        scopeOf(tenantId),
        rule({ outletId: outletA }),
        ownerUserId,
      ),
      /no active integration/,
    );
    await expect(
      upsertRoutingRule(
        scopeOf(tenantId),
        rule({ outletId: outletB }),
        ownerUserId,
      ),
    ).resolves.toMatchObject({ outletId: outletB });
    await expect(
      upsertRoutingRule(scopeOf(tenantId), rule(), ownerUserId),
    ).resolves.toMatchObject({ outletId: null });
  });

  it("does not check a rule that is being switched off", async () => {
    await platformGateway("duitku", false);
    await expect(
      upsertRoutingRule(
        scopeOf(tenantId),
        rule({ outletId: outletA, enabled: false }),
        ownerUserId,
      ),
    ).resolves.toMatchObject({ enabled: false });
  });
});

describe("admin API (D12-D14)", () => {
  it("needs org.settings.manage, not payment.edc.manage", async () => {
    const role = await owner.query<{ id: string }>(
      `INSERT INTO roles (tenant_id, name, is_template, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, false, '["payment.edc.manage"]'::jsonb, false, '["tenant"]'::jsonb)
       RETURNING id`,
      [tenantId, `Edc saja ${randomBytes(3).toString("hex")}`],
    );
    roleIds.push(role.rows[0]!.id);
    const edc = await user("EDC only");
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantId, edc.userId, role.rows[0]!.id],
    );
    const settings = await user("Settings admin");
    await assignTemplate(settings.userId, "tenant_admin");

    const route = (method: "qris" | "va") =>
      `/api/payments/admin/routing/${method}`;
    const body = {
      outletId: outletB,
      provider: "duitku",
      fallbackProvider: null,
      enabled: true,
    };
    expect((await edc.client.get("/api/payments/admin/routing")).status).toBe(
      403,
    );
    expect(
      (
        await edc.client
          .put(route("qris"))
          .set(originHeader)
          .set("Idempotency-Key", randomUUID())
          .send(body)
      ).status,
    ).toBe(403);

    const put = await settings.client
      .put(route("qris"))
      .set(originHeader)
      .set("Idempotency-Key", randomUUID())
      .send(body);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data).toMatchObject({ provider: "duitku", method: "qris" });

    const refused = await settings.client
      .put(route("va"))
      .set(originHeader)
      .set("Idempotency-Key", randomUUID())
      .send({ ...body, outletId: outletA });
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/^GATEWAY_NOT_AVAILABLE/);
  });

  it("lists registered, platform-enabled, tenant-allowed gateways with the integration state", async () => {
    const settings = await user("Settings viewer");
    await assignTemplate(settings.userId, "tenant_admin");
    const view = async (outletId?: string) =>
      (
        await settings.client.get(
          `/api/payments/admin/routing${outletId ? `?outletId=${outletId}` : ""}`,
        )
      ).body.data.providers;

    // Outlet A: doit has a tenant-wide integration, duitku only outlet B's.
    expect(await view(outletA)).toEqual([
      { code: "doit", name: "DOIT", kind: "gateway", enabled: true },
      { code: "duitku", name: "Duitku", kind: "gateway", enabled: false },
    ]);
    expect(await view(outletB)).toEqual([
      { code: "doit", name: "DOIT", kind: "gateway", enabled: true },
      { code: "duitku", name: "Duitku", kind: "gateway", enabled: true },
    ]);
    await platformGateway("duitku", false);
    expect((await view()).map((p: { code: string }) => p.code)).toEqual([
      "doit",
    ]);
    await platformGateway("duitku", true);
    await setFlags(["doit"]);
    expect((await view()).map((p: { code: string }) => p.code)).toEqual([
      "doit",
    ]);
  });
});

describe("new tenants and isolation (D8)", () => {
  let actorUserId: string;
  beforeAll(async () => {
    actorUserId = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Super Admin Uji', $2, true)`,
      [actorUserId, `platform-${actorUserId}@example.com`],
    );
    userIds.push(actorUserId);
  });

  const newTenant = (providers: string[]) =>
    createTenant(
      createTenantInputSchema.parse({
        slug: `gw-${randomBytes(4).toString("hex")}`,
        name: "Uji Gateway",
        plan: "lengkap",
        deploymentMode: "shared",
        featureFlags: {
          modules: ["pos", "qr_order"],
          integrationProviders: providers,
        },
        limits: {
          maxOutlets: 5,
          maxActiveEmployees: 30,
          maxDevices: 10,
          aiRequestsPerMonth: 100,
          whatsappCostCapIdr: 0,
          aiCostCapIdr: 50_000,
          emailCostCapIdr: 10_000,
        },
        firstAdmin: {
          name: "Admin Gateway",
          whatsapp: `62812${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, "0")}`,
          email: null,
        },
      }),
      actorUserId,
    );

  const rulesOf = async (id: string) =>
    (
      await owner.query(
        "SELECT method, provider, fallback_provider, enabled, outlet_id FROM payment_routing_rules WHERE tenant_id = $1 ORDER BY method",
        [id],
      )
    ).rows;

  it("gives a new tenant the platform default gateway and online-method rules, and never rewrites it later", async () => {
    const first = await newTenant([]);
    expect(first.featureFlags.integrationProviders).toEqual(["doit"]);
    expect(await rulesOf(first.id)).toEqual(
      ["bank_transfer", "qris", "va"].map((method) => ({
        method,
        provider: "doit",
        fallback_provider: null,
        enabled: true,
        outlet_id: null,
      })),
    );

    // Switch the platform default to duitku: the existing tenant is untouched.
    await owner.query(
      "UPDATE platform_payment_gateways SET is_default = false",
    );
    await owner.query(
      "UPDATE platform_payment_gateways SET enabled = true, is_default = true WHERE provider = 'duitku'",
    );
    resetPlatformGatewayCache();
    try {
      const second = await newTenant(["duitku"]);
      // Already lists a payment gateway: kept as given, rules follow the default.
      expect(second.featureFlags.integrationProviders).toEqual(["duitku"]);
      expect((await rulesOf(second.id)).map((r) => r.provider)).toEqual([
        "duitku",
        "duitku",
        "duitku",
      ]);
      const third = await newTenant([]);
      expect(third.featureFlags.integrationProviders).toEqual(["duitku"]);
      expect((await rulesOf(first.id)).map((r) => r.provider)).toEqual([
        "doit",
        "doit",
        "doit",
      ]);
    } finally {
      await owner.query(
        "UPDATE platform_payment_gateways SET is_default = false",
      );
      await owner.query(
        `UPDATE platform_payment_gateways SET is_default = (provider = 'doit'),
           enabled = (provider = 'doit')`,
      );
      resetPlatformGatewayCache();
    }
  });

  it("seeds rules on the platform default only when the tenant lists it, else on the first listed enabled gateway, else none", async () => {
    const restore = async () => {
      await owner.query(
        "UPDATE platform_payment_gateways SET is_default = (provider = 'doit'), enabled = (provider = 'doit')",
      );
      resetPlatformGatewayCache();
    };
    try {
      // Default doit; Super Admin listed only duitku, which is enabled.
      await owner.query(
        "UPDATE platform_payment_gateways SET enabled = true WHERE provider = 'duitku'",
      );
      resetPlatformGatewayCache();
      const onlyDuitku = await newTenant(["duitku"]);
      expect(onlyDuitku.featureFlags.integrationProviders).toEqual(["duitku"]);
      expect((await rulesOf(onlyDuitku.id)).map((r) => r.provider)).toEqual([
        "duitku",
        "duitku",
        "duitku",
      ]);
      // Lists the default too: the default wins.
      const both = await newTenant(["duitku", "doit"]);
      expect((await rulesOf(both.id)).map((r) => r.provider)).toEqual([
        "doit",
        "doit",
        "doit",
      ]);
      // Lists only a gateway that is switched off: no rules seeded.
      await owner.query(
        "UPDATE platform_payment_gateways SET enabled = false WHERE provider = 'duitku'",
      );
      resetPlatformGatewayCache();
      const offOnly = await newTenant(["duitku"]);
      expect(await rulesOf(offOnly.id)).toEqual([]);
    } finally {
      await restore();
    }
  });

  it("tenant B cannot route to a gateway because tenant A has an integration", async () => {
    const other = await newTenant(["doit", "duitku"]);
    const bOwner = await user("Tenant B owner");
    await assignTemplate(bOwner.userId, "owner", other.id);
    // Tenant A has an active duitku integration (beforeEach); B has none.
    await expectRefused(
      upsertRoutingRule(scopeOf(other.id), rule(), bOwner.userId),
      /no active integration/,
    );
    // Tenant A's owner has no standing in tenant B.
    await expect(
      upsertRoutingRule(scopeOf(other.id), rule(), ownerUserId),
    ).rejects.toThrow();
    await owner.query(
      "DELETE FROM payment_routing_rules WHERE tenant_id = $1 AND method = 'qris' AND outlet_id IS NULL AND provider = 'duitku'",
      [tenantId],
    );
    expect((await rulesOf(other.id)).every((r) => r.provider === "doit")).toBe(
      true,
    );
  });
});
