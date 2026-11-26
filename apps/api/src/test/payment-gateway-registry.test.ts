// Gateway registry and per-intent provider selection (sub-302 D1-D6, D11).
//
// - registry: one adapter per provider, fail closed when unknown, the test-only
//   `setPaymentGateway` shim keeps the old one-port-for-everything behaviour;
// - new intents: the routing rule's provider, its fallback only when the
//   primary is down or disabled on the platform (Q73);
// - existing intents never move (PAY-05): status polls go to the origin port;
// - poller: every registered provider is polled, one provider's three errors
//   do not stop another's;
// - a provider without a refund port (Duitku) leaves its refunds `approved`
//   for manual settlement.
//
// Service level on PostgreSQL. The platform "enabled" switch is mocked here: it
// is read from `platform_payment_gateways` by slice B.
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
  vi,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import type { PaymentGatewayStatus } from "@starter/shared/payment";

const platform = vi.hoisted(() => ({ enabled: new Set<string>() }));
vi.mock("../services/platform-payment-gateway.service", () => ({
  isPlatformGatewayEnabled: async (provider: string) =>
    platform.enabled.has(provider),
  // The seeded platform default is DOIT; a switched-off default is no default.
  platformDefaultGateway: async () =>
    platform.enabled.has("doit") ? "doit" : null,
}));

import { env } from "../config/env";
import {
  paymentGatewayFor,
  registerPaymentGateway,
  registeredGatewayProviders,
  resetPaymentGateways,
  setPaymentGateway,
  unconfiguredPaymentGateway,
  type GatewayIntentRequest,
  type GatewayPaymentStatus,
  type PaymentGatewayPort,
} from "../services/payment-gateway";
import {
  outletGatewayHealth,
  selectGatewayForNewIntent,
} from "../services/payment-gateway-select";
import {
  registerPaymentRefundGateway,
  resetPaymentRefundGateways,
  type GatewayRefundLookup,
  type GatewayRefundRequest,
  type GatewayRefundResult,
  type PaymentRefundPort,
} from "../services/payment-refund-gateway";
import {
  runRefundPayout,
  sweepApprovedRefundPayouts,
} from "../services/payment-refund.service";
import {
  createIntent,
  createPaymentLink,
  getPaymentLinkView,
  pollPendingGatewayIntents,
} from "../services/payment.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const PARKED_LEASE = "2999-01-01T00:00:00.000Z";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");

function outletContext(outletId: OutletId = outletA): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletId] },
  );
}

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
}

/** Gateway double for one provider code. */
class FakeGateway implements PaymentGatewayPort {
  healthValue: PaymentGatewayStatus = "available";
  reason: "unconfigured" | undefined = undefined;
  healthCalls = 0;
  created: GatewayIntentRequest[] = [];
  /** providerRef -> status reads. */
  readonly statusReads = new Map<string, number>();
  failStatus = false;
  failChannels = false;
  private readonly refs = new Set<string>();
  constructor(readonly provider: string) {}

  async health() {
    this.healthCalls += 1;
    return {
      status: this.healthValue,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created.push(input);
    const providerRef = `${this.provider}-${randomBytes(6).toString("hex")}`;
    this.refs.add(providerRef);
    return {
      providerRef,
      instructions: {
        method: "qris" as const,
        qrPayload: `00020101FAKE${this.provider}`,
        issuer: null,
      },
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: {
    providerRef: string;
  }): Promise<GatewayPaymentStatus> {
    statusOrder.push(input.providerRef);
    this.statusReads.set(
      input.providerRef,
      (this.statusReads.get(input.providerRef) ?? 0) + 1,
    );
    if (this.failStatus) throw new Error("provider down");
    return {
      status: "pending",
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    if (this.failChannels) throw new Error("channels down");
    return [{ code: "bca", name: "BCA" }];
  }
  totalReads() {
    let total = 0;
    for (const n of this.statusReads.values()) total += n;
    return total;
  }
}

let doit: FakeGateway;
let duitku: FakeGateway;
/** providerRef of every getStatus call, across gateways, in call order. */
let statusOrder: string[] = [];
const createdLinkIds: string[] = [];

async function setQrisRule(provider: string, fallback: string | null) {
  await owner.query(
    "DELETE FROM payment_routing_rules WHERE tenant_id = $1 AND outlet_id = $2 AND method = 'qris'",
    [tenantId, outletA],
  );
  await owner.query(
    `INSERT INTO payment_routing_rules (tenant_id, outlet_id, method, provider, fallback_provider, enabled, updated_by)
     VALUES ($1, $2, 'qris', $3, $4, true, 'system:test')`,
    [tenantId, outletA, provider, fallback],
  );
}

async function openBill() {
  const opened = await createPaymentLink(
    outletContext(),
    {
      outletId: outletA,
      reference: `RG-${unique()}`,
      tableLabel: "A07",
      pax: 2,
      subtotalIdr: 100_000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: 100_000,
      returnPath: "/t/v1.abc",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  createdLinkIds.push(opened.linkId);
  return opened;
}

async function newQrisIntent() {
  const { token } = await openBill();
  const intent = await createIntent(outletContext(), token, {
    method: "qris",
    channelCode: null,
    idempotencyKey: `k-${unique()}`,
  });
  const { rows } = await owner.query<{
    provider: string;
    provider_ref: string;
    status: string;
  }>(
    "SELECT provider, provider_ref, status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenantId, intent.id],
  );
  return { id: intent.id, ...rows[0]! };
}

let originalFlags: unknown;

/** The tenant's package: which gateways its `integrationProviders` lists. */
async function setPackageGateways(providers: string[]) {
  await owner.query(
    `UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}', $2::jsonb) WHERE id = $1`,
    [tenantId, JSON.stringify(providers)],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const flags = await owner.query<{ feature_flags: unknown }>(
    "SELECT feature_flags FROM tenants WHERE id = $1",
    [tenantId],
  );
  originalFlags = flags.rows[0]!.feature_flags;
});

beforeEach(async () => {
  platform.enabled = new Set(["doit", "duitku"]);
  statusOrder = [];
  await setPackageGateways(["doit", "duitku"]);
  doit = new FakeGateway("doit");
  duitku = new FakeGateway("duitku");
  resetPaymentGateways();
  registerPaymentGateway(doit);
  registerPaymentGateway(duitku);
  // The poller is tenant-wide: park every foreign intent so counts are exact.
  await owner.query(
    `UPDATE payment_intents SET gateway_poll_lease_until = $2
      WHERE tenant_id = $1 AND gateway_poll_lease_until IS NULL`,
    [tenantId, PARKED_LEASE],
  );
});

afterEach(async () => {
  resetPaymentGateways();
  resetPaymentRefundGateways();
  await owner.query(
    "DELETE FROM payment_routing_rules WHERE tenant_id = $1 AND outlet_id = $2 AND method = 'qris'",
    [tenantId, outletA],
  );
});

afterAll(async () => {
  if (createdLinkIds.length > 0) {
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    await owner.query(
      `DELETE FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      [tenantId, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [tenantId, createdLinkIds],
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdLinkIds],
    );
  }
  await owner.query(
    `UPDATE payment_intents SET gateway_poll_lease_until = NULL
      WHERE tenant_id = $1 AND gateway_poll_lease_until = $2`,
    [tenantId, PARKED_LEASE],
  );
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenantId,
    JSON.stringify(originalFlags),
  ]);
  await owner.end();
});

describe("gateway registry (D1, D2)", () => {
  it("answers with the adapter registered for the provider", () => {
    expect(paymentGatewayFor("doit")).toBe(doit);
    expect(paymentGatewayFor("duitku")).toBe(duitku);
    expect([...registeredGatewayProviders()].sort()).toEqual([
      "doit",
      "duitku",
    ]);
  });

  it("fails closed for a provider nobody registered", async () => {
    expect(paymentGatewayFor("pjp")).toBe(unconfiguredPaymentGateway);
    await expect(
      paymentGatewayFor("pjp").createIntent({} as GatewayIntentRequest),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("registering a provider again replaces its adapter", () => {
    const replacement = new FakeGateway("duitku");
    registerPaymentGateway(replacement);
    expect(paymentGatewayFor("duitku")).toBe(replacement);
    expect(registeredGatewayProviders()).toHaveLength(2);
  });

  it("reset drops every adapter", () => {
    resetPaymentGateways();
    expect(registeredGatewayProviders()).toEqual([]);
    expect(paymentGatewayFor("doit")).toBe(unconfiguredPaymentGateway);
  });

  it("the test shim answers for every provider, and register leaves it", () => {
    const only = new FakeGateway("x");
    setPaymentGateway(only);
    expect(paymentGatewayFor("doit")).toBe(only);
    expect(paymentGatewayFor("anything")).toBe(only);
    expect(registeredGatewayProviders()).toEqual(["x"]);
    registerPaymentGateway(doit);
    expect(paymentGatewayFor("duitku")).toBe(unconfiguredPaymentGateway);
    setPaymentGateway(null);
    expect(registeredGatewayProviders()).toEqual([]);
  });
});

describe("provider selection for a new intent (D4, Q73)", () => {
  it("uses the primary and never asks the fallback while the primary is up", async () => {
    await setQrisRule("duitku", "doit");
    const intent = await newQrisIntent();
    expect(intent.provider).toBe("duitku");
    expect(duitku.created).toHaveLength(1);
    expect(duitku.created[0]!.provider).toBe("duitku");
    expect(doit.created).toHaveLength(0);
    expect(doit.healthCalls).toBe(0);
  });

  it("uses the fallback when the primary is down", async () => {
    await setQrisRule("duitku", "doit");
    duitku.healthValue = "down";
    const intent = await newQrisIntent();
    expect(intent.provider).toBe("doit");
    expect(doit.created).toHaveLength(1);
    expect(doit.created[0]!.provider).toBe("doit");
    expect(duitku.created).toHaveLength(0);
  });

  it("a degraded primary still takes the payment", async () => {
    await setQrisRule("duitku", "doit");
    duitku.healthValue = "degraded";
    const intent = await newQrisIntent();
    expect(intent.provider).toBe("duitku");
  });

  it("uses the fallback when the primary is disabled on the platform", async () => {
    await setQrisRule("duitku", "doit");
    platform.enabled.delete("duitku");
    const intent = await newQrisIntent();
    expect(intent.provider).toBe("doit");
    expect(duitku.created).toHaveLength(0);
    expect(duitku.healthCalls).toBe(0);
  });

  it("answers 503 and stores nothing when no candidate is usable", async () => {
    await setQrisRule("duitku", "doit");
    duitku.healthValue = "down";
    doit.healthValue = "down";
    const { token, linkId } = await openBill();
    await expect(
      createIntent(outletContext(), token, {
        method: "qris",
        channelCode: null,
        idempotencyKey: `k-${unique()}`,
      }),
    ).rejects.toMatchObject({ status: 503 });
    const { rows } = await owner.query(
      "SELECT 1 FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = $2",
      [tenantId, linkId],
    );
    expect(rows).toHaveLength(0);
    expect(duitku.created).toHaveLength(0);
    expect(doit.created).toHaveLength(0);
  });

  it("a rule without a fallback does not fall back to anything", async () => {
    await setQrisRule("duitku", null);
    duitku.healthValue = "down";
    const selected = await selectGatewayForNewIntent(outletContext(), outletA, {
      provider: "duitku",
      fallbackProvider: null,
      enabled: true,
      isDefault: false,
    });
    expect(selected.provider).toBeNull();
    expect(selected.health.status).toBe("down");
    expect(doit.healthCalls).toBe(0);
  });

  it("keeps the primary's health when nothing is usable (unconfigured stays quiet)", async () => {
    duitku.healthValue = "down";
    duitku.reason = "unconfigured";
    const selected = await selectGatewayForNewIntent(outletContext(), outletA, {
      provider: "duitku",
      fallbackProvider: null,
      enabled: true,
      isDefault: false,
    });
    expect(selected).toMatchObject({
      provider: null,
      health: { status: "down", reason: "unconfigured" },
    });
  });
});

describe("outlet health (D4, D5 failover)", () => {
  it("is the best reading of the providers the outlet's rules name", async () => {
    await setQrisRule("duitku", "doit");
    duitku.healthValue = "down";
    const health = await outletGatewayHealth(outletContext(), outletA);
    expect(health.status).toBe("available");
    expect(health.provider.split("+").sort()).toEqual(["doit", "duitku"]);
  });

  it("is down only when every named provider is down", async () => {
    await setQrisRule("duitku", "doit");
    duitku.healthValue = "down";
    doit.healthValue = "down";
    const health = await outletGatewayHealth(outletContext(), outletA);
    expect(health.status).toBe("down");
    expect(health.reason).toBeUndefined();
  });

  it("is unconfigured only when every reading is down and unconfigured", async () => {
    await setQrisRule("duitku", "doit");
    for (const gateway of [doit, duitku]) {
      gateway.healthValue = "down";
      gateway.reason = "unconfigured";
    }
    expect(await outletGatewayHealth(outletContext(), outletA)).toMatchObject({
      status: "down",
      reason: "unconfigured",
    });
    doit.reason = undefined;
    expect(
      (await outletGatewayHealth(outletContext(), outletA)).reason,
    ).toBeUndefined();
  });
});

describe("an existing intent stays on its gateway (PAY-05, D11)", () => {
  it("polling after the rule switched asks the origin port only", async () => {
    await setQrisRule("duitku", null);
    const intent = await newQrisIntent();
    expect(intent.provider).toBe("duitku");
    await setQrisRule("doit", null);

    const result = await pollPendingGatewayIntents(
      tenantContext(),
      new Date(Date.now() + 120_000),
    );

    expect(result.checked).toBe(1);
    expect(duitku.statusReads.get(intent.provider_ref)).toBe(1);
    expect(doit.totalReads()).toBe(0);
  });

  it("a platform-disabled gateway is still polled for money in flight", async () => {
    await setQrisRule("duitku", null);
    const intent = await newQrisIntent();
    platform.enabled.delete("duitku");

    await pollPendingGatewayIntents(
      tenantContext(),
      new Date(Date.now() + 120_000),
    );

    expect(duitku.statusReads.get(intent.provider_ref)).toBe(1);
  });
});

describe("a gateway revoked from the tenant's package (legend-8zy5f, D4)", () => {
  it("a new intent skips a stored rule's revoked primary and uses the fallback", async () => {
    await setQrisRule("duitku", "doit");
    await setPackageGateways(["doit"]);
    const intent = await newQrisIntent();
    expect(intent.provider).toBe("doit");
    expect(duitku.created).toHaveLength(0);
    expect(duitku.healthCalls).toBe(0);
  });

  it("answers 503 and stores nothing when the only gateway was revoked", async () => {
    await setQrisRule("duitku", null);
    await setPackageGateways(["doit"]);
    const { token, linkId } = await openBill();
    await expect(
      createIntent(outletContext(), token, {
        method: "qris",
        channelCode: null,
        idempotencyKey: `k-${unique()}`,
      }),
    ).rejects.toMatchObject({ status: 503 });
    const { rows } = await owner.query(
      "SELECT 1 FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = $2",
      [tenantId, linkId],
    );
    expect(rows).toHaveLength(0);
    expect(duitku.created).toHaveLength(0);
  });

  it("a revoked fallback is never used when the primary is down", async () => {
    await setQrisRule("duitku", "doit");
    duitku.healthValue = "down";
    await setPackageGateways(["duitku"]);
    const { token } = await openBill();
    await expect(
      createIntent(outletContext(), token, {
        method: "qris",
        channelCode: null,
        idempotencyKey: `k-${unique()}`,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(doit.created).toHaveLength(0);
  });

  it("a revoked gateway is not offered as selectable and keeps the primary's health reading", async () => {
    await setQrisRule("duitku", null);
    await setPackageGateways(["doit"]);
    const selected = await selectGatewayForNewIntent(outletContext(), outletA, {
      provider: "duitku",
      fallbackProvider: null,
      enabled: true,
      isDefault: false,
    });
    expect(selected.provider).toBeNull();
    expect(selected.health.status).toBe("down");
  });

  it("an intent made before the revoke stays on its gateway", async () => {
    await setQrisRule("duitku", null);
    const intent = await newQrisIntent();
    expect(intent.provider).toBe("duitku");
    await setPackageGateways(["doit"]);

    const result = await pollPendingGatewayIntents(
      tenantContext(),
      new Date(Date.now() + 120_000),
    );

    expect(result.checked).toBe(1);
    expect(duitku.statusReads.get(intent.provider_ref)).toBe(1);
  });

  it("outlet health ignores a revoked gateway (failover sees the real picture)", async () => {
    await setQrisRule("duitku", "doit");
    doit.healthValue = "down";
    expect((await outletGatewayHealth(outletContext(), outletA)).status).toBe(
      "available",
    );
    await setPackageGateways(["doit"]);
    const health = await outletGatewayHealth(outletContext(), outletA);
    expect(health.status).toBe("down");
    expect(health.provider.split("+")).toEqual(["doit"]);
  });

  it("the PRD default (no stored rule) keeps DOIT for a tenant whose package lists no gateway", async () => {
    await setPackageGateways([]);
    const intent = await newQrisIntent();
    expect(intent.provider).toBe("doit");
  });

  it("the PRD default no longer takes DOIT once the package lists another gateway but not DOIT", async () => {
    await setPackageGateways(["duitku"]);
    const { token } = await openBill();
    await expect(
      createIntent(outletContext(), token, {
        method: "qris",
        channelCode: null,
        idempotencyKey: `k-${unique()}`,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(doit.created).toHaveLength(0);
    expect((await outletGatewayHealth(outletContext(), outletA)).status).toBe(
      "down",
    );
  });

  it("outlet health is down when every enabled rule's gateway was revoked", async () => {
    await setQrisRule("duitku", null);
    await owner.query(
      `INSERT INTO payment_routing_rules (tenant_id, outlet_id, method, provider, fallback_provider, enabled, updated_by)
       VALUES ($1, $2, 'va', 'duitku', NULL, true, 'system:test'),
              ($1, $2, 'bank_transfer', 'duitku', NULL, true, 'system:test')`,
      [tenantId, outletA],
    );
    try {
      await setPackageGateways(["doit"]);
      const health = await outletGatewayHealth(outletContext(), outletA);
      expect(health.status).toBe("down");
      expect(health.reason).toBeUndefined();
      expect(duitku.healthCalls).toBe(0);
      expect(doit.healthCalls).toBe(0);
    } finally {
      await owner.query(
        "DELETE FROM payment_routing_rules WHERE tenant_id = $1 AND outlet_id = $2 AND method IN ('va','bank_transfer')",
        [tenantId, outletA],
      );
    }
  });

  it("platform switch off: no-fallback rule answers 503, an old intent keeps polling", async () => {
    await setQrisRule("duitku", null);
    const old = await newQrisIntent();
    platform.enabled.delete("duitku");
    const { token } = await openBill();
    await expect(
      createIntent(outletContext(), token, {
        method: "qris",
        channelCode: null,
        idempotencyKey: `k-${unique()}`,
      }),
    ).rejects.toMatchObject({ status: 503 });
    await pollPendingGatewayIntents(
      tenantContext(),
      new Date(Date.now() + 120_000),
    );
    expect(duitku.statusReads.get(old.provider_ref)).toBe(1);
  });
});

describe("poller across providers (D5)", () => {
  it("polls both providers; three errors of one do not stop the other", async () => {
    await setQrisRule("duitku", null);
    const duitkuIntents = [];
    for (let i = 0; i < 4; i += 1) duitkuIntents.push(await newQrisIntent());
    await setQrisRule("doit", null);
    const doitIntent = await newQrisIntent();
    duitku.failStatus = true;

    const result = await pollPendingGatewayIntents(
      tenantContext(),
      new Date(Date.now() + 120_000),
    );

    // Three consecutive Duitku errors stop Duitku (the fourth is skipped, not
    // counted); DOIT is still asked about its intent.
    expect(duitku.totalReads()).toBe(3);
    expect(duitku.statusReads.has(duitkuIntents[3]!.provider_ref)).toBe(false);
    expect(doit.statusReads.get(doitIntent.provider_ref)).toBe(1);
    expect(result.checked).toBe(4);
  });

  it("a down provider with a full batch never starves the other provider", async () => {
    await setQrisRule("duitku", null);
    for (let i = 0; i < 4; i += 1) await newQrisIntent();
    await setQrisRule("doit", null);
    const doitIntent = await newQrisIntent();
    duitku.failStatus = true;

    // Limit 3: the three oldest rows are all Duitku. One shared window would
    // fill with them and never reach the DOIT intent.
    await pollPendingGatewayIntents(
      tenantContext(),
      new Date(Date.now() + 120_000),
      3,
    );

    expect(doit.statusReads.get(doitIntent.provider_ref)).toBe(1);
  });

  it("polls both providers in one least-recently-polled order, not grouped by provider", async () => {
    // DOIT registers first, so a per-provider grouping would ask it first.
    await setQrisRule("doit", null);
    const recent = [await newQrisIntent(), await newQrisIntent()];
    await setQrisRule("duitku", null);
    const never = [await newQrisIntent(), await newQrisIntent()];
    // DOIT rows were polled a moment ago; Duitku rows never were.
    await owner.query(
      "UPDATE payment_intents SET gateway_polled_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, recent.map((intent) => intent.id)],
    );

    await pollPendingGatewayIntents(
      tenantContext(),
      new Date(Date.now() + 120_000),
    );

    expect(statusOrder).toEqual([
      ...never.map((intent) => intent.provider_ref),
      ...recent.map((intent) => intent.provider_ref),
    ]);
  });

  it("returns at once when no gateway is registered", async () => {
    await setQrisRule("duitku", null);
    await newQrisIntent();
    resetPaymentGateways();
    const result = await pollPendingGatewayIntents(
      tenantContext(),
      new Date(Date.now() + 120_000),
    );
    expect(result).toEqual({ checked: 0, settled: 0 });
  });
});

describe("link view while every gateway is down (D4, D5 failover)", () => {
  it("renders gateway_down and fails over without asking channels", async () => {
    await setQrisRule("duitku", null);
    for (const gateway of [doit, duitku]) {
      gateway.healthValue = "down";
      gateway.failChannels = true;
    }
    const { token, linkId } = await openBill();

    const view = await getPaymentLinkView(outletContext(), token);

    expect(view.gateway.status).toBe("down");
    for (const method of view.methods)
      expect(method).toMatchObject({
        enabled: false,
        unavailableReason: "gateway_down",
      });
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'payment.link_failover_to_cashier'
          AND event->>'objectId' = $2`,
      [tenantId, linkId],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe("refund of a provider without a refund API (D6)", () => {
  class RecordingRefundPort implements PaymentRefundPort {
    readonly provider = "doit";
    readonly sent: GatewayRefundRequest[] = [];
    readonly lookups: string[] = [];
    async refund(input: GatewayRefundRequest): Promise<GatewayRefundResult> {
      this.sent.push(input);
      throw new Error("must not be called");
    }
    async getRefundStatus(input: {
      idempotencyKey: string;
    }): Promise<GatewayRefundLookup> {
      this.lookups.push(input.idempotencyKey);
      return { status: "not_found" };
    }
  }

  const refundIds: string[] = [];
  const intentIds: string[] = [];
  const linkIds: string[] = [];

  afterAll(async () => {
    const pool = new Pool({
      connectionString: process.env.STARTER_TEST_DATABASE_URL,
      max: 1,
    });
    await pool.query("DELETE FROM payment_refunds WHERE id = ANY($1::uuid[])", [
      refundIds,
    ]);
    await pool.query(
      "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await pool.query(
      "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await pool.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
      intentIds,
    ]);
    await pool.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
      linkIds,
    ]);
    await pool.end();
  });

  async function seedApprovedRefund(provider: string) {
    const linkId = randomUUID();
    const intentId = randomUUID();
    const refundId = randomUUID();
    const fundId = randomUUID();
    linkIds.push(linkId);
    intentIds.push(intentId);
    refundIds.push(refundId);
    await owner.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, 'system:test')`,
      [
        linkId,
        tenantId,
        outletA,
        randomBytes(32).toString("hex"),
        `RGR-${linkId.slice(0, 8)}`,
      ],
    );
    await owner.query(
      `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref)
       VALUES ($1, $2, $3, $4, 'qris', $5, 100000, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $7)`,
      [
        intentId,
        tenantId,
        outletA,
        linkId,
        provider,
        `rgr-${intentId}`,
        `pay-${intentId}`,
      ],
    );
    const evidence = await owner.query<{ id: string }>(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, $4, $5, 'qris', 'verified_webhook', 20000, now())
       RETURNING id`,
      [tenantId, outletA, intentId, provider, `ev-${intentId}`],
    );
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, 20000, 'overpayment')`,
      [fundId, tenantId, outletA, intentId, evidence.rows[0]!.id],
    );
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                    requested_by, approved_by, decided_at, payout_attempts,
                                    updated_at, unallocated_fund_id)
       VALUES ($1, $2, $3, $4, 20000, 'Kembalikan kelebihan bayar', 'approved', 'system:test', 'system:approver',
               now(), 0, now() - interval '2 hours', $5)`,
      [refundId, tenantId, outletA, intentId, fundId],
    );
    return refundId;
  }

  async function refundRow(refundId: string) {
    const { rows } = await owner.query<{
      status: string;
      payout_attempts: number;
    }>(
      "SELECT status, payout_attempts FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
      [tenantId, refundId],
    );
    return rows[0]!;
  }

  it("a Duitku refund is never sent or claimed and stays approved", async () => {
    const port = new RecordingRefundPort();
    registerPaymentRefundGateway(port);
    const refundId = await seedApprovedRefund("duitku");

    // legend-kmrto (Q45): the refusal is the stable REFUND_PROVIDER_DISABLED
    // (also with the switch on, Duitku has no refund port: still refused).
    await expect(
      runRefundPayout(tenantContext(), refundId),
    ).rejects.toMatchObject({ code: "REFUND_PROVIDER_DISABLED" });
    await sweepApprovedRefundPayouts(tenantContext(), new Date());

    expect(port.sent).toHaveLength(0);
    expect(port.lookups).not.toContain(`refund:${refundId}`);
    expect(await refundRow(refundId)).toEqual({
      status: "approved",
      payout_attempts: 0,
    });
  });

  it("a DOIT refund still reaches the DOIT port", async () => {
    const port = new RecordingRefundPort();
    registerPaymentRefundGateway(port);
    const refundId = await seedApprovedRefund("doit");
    // Quarantined and attempted once: the service only looks it up, never sends.
    await owner.query(
      "UPDATE payment_refunds SET payout_attempts = 1, last_payout_error = 'PAYOUT_QUARANTINED' WHERE id = $1",
      [refundId],
    );

    // legend-kmrto (Q45): the DOIT port is reachable only with the switch on;
    // the config is read once at import, so flip the object and restore it.
    const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
    const before = flags.DOIT_REFUNDS_ENABLED;
    flags.DOIT_REFUNDS_ENABLED = true;
    try {
      await runRefundPayout(tenantContext(), refundId);
    } finally {
      flags.DOIT_REFUNDS_ENABLED = before;
    }

    expect(port.lookups).toContain(`refund:${refundId}`);
    expect(port.sent).toHaveLength(0);
  });
});
