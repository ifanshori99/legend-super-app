// legend-osqou.40: with no stored rule an online method follows the platform
// default gateway; no default means off (fail closed). Only the test-only
// legacy port mode keeps DOIT. Global platform rows are restored after each test.
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  registerPaymentGateway,
  resetPaymentGateways,
  setPaymentGateway,
  unconfiguredPaymentGateway,
} from "../services/payment-gateway";
import {
  resetGatewayHealthCache,
  syncGatewayHealth,
} from "../services/payment-failover.service";
import { outletGatewayHealth } from "../services/payment-gateway-select";
import { resolveRoutingRule } from "../services/payment-routing.service";
import { resetPlatformGatewayCache } from "../services/platform-payment-gateway.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);
const port = (provider: string) => ({
  ...unconfiguredPaymentGateway,
  provider,
});

const resolve = (method: "qris" | "va" | "cash") =>
  withTenant(db, context, (tx) =>
    resolveRoutingRule(tx, context, outletId, method),
  );

async function setGateways(
  rows: Record<string, { enabled: boolean; isDefault: boolean }>,
) {
  // Clear the default first: the partial unique index allows one.
  await owner.query("UPDATE platform_payment_gateways SET is_default = false");
  for (const [provider, row] of Object.entries(rows))
    await owner.query(
      "UPDATE platform_payment_gateways SET enabled = $2, is_default = $3 WHERE provider = $1",
      [provider, row.enabled, row.isDefault],
    );
  resetPlatformGatewayCache();
}

beforeEach(async () => {
  await owner.query(
    "DELETE FROM payment_routing_rules WHERE tenant_id = $1 AND method IN ('qris','va')",
    [tenantId],
  );
  resetPaymentGateways();
  registerPaymentGateway(port("doit"));
  registerPaymentGateway(port("duitku"));
});

afterEach(async () => {
  resetPaymentGateways();
  await setGateways({
    duitku: { enabled: false, isDefault: false },
    doit: { enabled: true, isDefault: true },
  });
});

afterAll(async () => {
  await owner.end();
});

describe("default routing without a stored rule (legend-osqou.40)", () => {
  it("follows the platform default gateway", async () => {
    await setGateways({
      duitku: { enabled: true, isDefault: true },
      doit: { enabled: false, isDefault: false },
    });
    for (const method of ["qris", "va"] as const)
      expect(await resolve(method)).toMatchObject({
        provider: "duitku",
        enabled: true,
        isDefault: true,
      });
  });

  it("is off when no gateway is the platform default", async () => {
    await setGateways({
      duitku: { enabled: true, isDefault: false },
      doit: { enabled: true, isDefault: false },
    });
    expect(await resolve("qris")).toMatchObject({
      enabled: false,
      isDefault: true,
    });
  });

  it("never routes to a switched-off DOIT by default", async () => {
    await setGateways({
      duitku: { enabled: true, isDefault: false },
      doit: { enabled: false, isDefault: false },
    });
    const routing = await resolve("va");
    expect(routing.enabled).toBe(false);
    expect(routing.provider).not.toBe("doit");
  });

  it("keeps a counter method disabled", async () => {
    expect(await resolve("cash")).toMatchObject({ enabled: false });
  });

  it("keeps DOIT in the test-only legacy port mode", async () => {
    setPaymentGateway(port("doit"));
    await setGateways({
      duitku: { enabled: true, isDefault: true },
      doit: { enabled: false, isDefault: false },
    });
    expect(await resolve("qris")).toMatchObject({
      provider: "doit",
      enabled: true,
    });
  });
});

describe("no default gateway is no incident (legend-osqou.40)", () => {
  it("reads unconfigured and opens no incident", async () => {
    await owner.query(
      "DELETE FROM payment_routing_rules WHERE tenant_id = $1",
      [tenantId],
    );
    await setGateways({
      duitku: { enabled: true, isDefault: false },
      doit: { enabled: true, isDefault: false },
    });
    resetGatewayHealthCache();
    const marks = () =>
      owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1 AND outlet_id = $2 AND event->>'action' LIKE 'payment.gateway_%'`,
        [tenantId, outletId],
      );
    const before = (await marks()).rows[0]!.n;
    const health = await outletGatewayHealth(context, outletId);
    expect(health).toMatchObject({ status: "down", reason: "unconfigured" });
    const result = await syncGatewayHealth(context, outletId, health);
    expect(result).toEqual({ transition: "none", openIncident: null });
    expect((await marks()).rows[0]!.n).toBe(before);
  });
});
