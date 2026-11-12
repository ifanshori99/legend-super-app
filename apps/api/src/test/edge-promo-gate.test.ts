// Promo and voucher freshness gate on an edge (bead legend-10nex, CTO decision
// after founder Q57). Written from the design (docs: design-q61.md section P):
//  - cloud process: promos and vouchers always apply;
//  - edge without a freshness provider: promos off (fail closed);
//  - edge, provider false (no successful sync of catalog:promotions and
//    catalog:vouchers within 24 h, or never synced): promos off, the sale goes
//    at the normal price, an explicit voucher code is refused with a message;
//  - the owner override of the sales hold never opens stale promos;
//  - a discount that is not applied can only raise the price to normal, so no
//    outlet loses money.
//
// Assumptions:
//  - "no code" means voucherCode null. A quote WITH a code while promos are off
//    is not specified by the design and is not asserted.
//  - startPromoGate reads edge_pull_checkpoints with the injected trusted
//    clock; exactly 24 h is still fresh (PROMO_STALE_AFTER_MS), tested at
//    23h59m (fresh) and 24h01m (stale) as the design says.
//  - Checkpoint rows are written with the owner connection (the edge worker's
//    own writer is covered elsewhere).
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  CoreError,
  idr,
  outletIdSchema,
  tenantIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  catalogFreshnessToDto,
  createCatalogFreshness,
} from "../edge/catalog-freshness.ts";
import {
  installPromoFreshnessProvider,
  PROMO_DISABLED_MESSAGE,
  promosEnabled,
  setPromoGateEdgeModeForTests,
  withPromoFreshness,
} from "../edge/promo-gate.ts";
import {
  PROMO_CHECKPOINT_STREAMS,
  startPromoGate,
  type PromoGateHandle,
} from "../edge/promo-gate-runtime.ts";
import {
  installSalesGateProvider,
  setSalesGateEdgeModeForTests,
  type SalesGateState,
} from "../edge/sales-gate.ts";
import type {
  OrderPromoInput,
  OrderPromoPort,
  OrderPromoQuote,
} from "../services/order-promo-port.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { owner, seededOutletA, seededTenantId } from "./floor-test-helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date("2026-11-11T03:00:00.000Z");
const DISCOUNT = 10_000;

const discounted = (): OrderPromoQuote =>
  ({
    result: { evaluations: [], totalDiscountIdr: idr(DISCOUNT) },
    totalDiscountIdr: idr(DISCOUNT),
  }) as unknown as OrderPromoQuote;

function fakeInner() {
  const quote = vi.fn(async () => discounted());
  const redeem = vi.fn(async () => discounted());
  const release = vi.fn(async () => ({
    released: true,
    releasedDiscountIdr: idr(DISCOUNT),
  }));
  const port: OrderPromoPort = { quote, redeem, release } as OrderPromoPort;
  return { port, quote, redeem, release };
}

const tx = {} as never;
const ctx = {} as never;
const input = (voucherCode: string | null = null): OrderPromoInput =>
  ({
    outletId: randomUUID(),
    channel: "pos",
    lines: [],
    customer: null,
    voucherCode,
    at: NOW,
  }) as unknown as OrderPromoInput;
const redeemInput = (
  voucherCode: string | null = null,
  expectedDiscount?: number,
) =>
  ({
    ...input(voucherCode),
    orderId: randomUUID(),
    actorUserId: null,
    ...(expectedDiscount === undefined
      ? {}
      : {
          expected: {
            evaluations: [],
            totalDiscountIdr: idr(expectedDiscount),
          },
        }),
  }) as never;

const handles: PromoGateHandle[] = [];

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterEach(() => {
  while (handles.length) handles.pop()!.stop();
  installPromoFreshnessProvider(null);
  setPromoGateEdgeModeForTests(null);
  installSalesGateProvider(null);
  setSalesGateEdgeModeForTests(null);
});

afterAll(async () => {
  await owner.end();
});

describe("legend-10nex promos on an edge with no freshness provider", () => {
  it("quote without a code gives no discount and does not reach the promo engine", async () => {
    setPromoGateEdgeModeForTests(() => true);
    const inner = fakeInner();
    const result = await withPromoFreshness(inner.port).quote(tx, ctx, input());
    expect(Number(result.totalDiscountIdr)).toBe(0);
    expect(inner.quote).not.toHaveBeenCalled();
    expect(promosEnabled()).toBe(false);
  });
});

describe("legend-10nex promos on an edge whose provider says stale", () => {
  const stale = () => {
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => false);
    return fakeInner();
  };

  it("quote without a code gives no discount and does not reach the promo engine", async () => {
    const inner = stale();
    const result = await withPromoFreshness(inner.port).quote(tx, ctx, input());
    expect(Number(result.totalDiscountIdr)).toBe(0);
    expect(inner.quote).not.toHaveBeenCalled();
  });

  it("redeem without a code gives no discount", async () => {
    const inner = stale();
    const result = await withPromoFreshness(inner.port).redeem(
      tx,
      ctx,
      redeemInput(),
    );
    expect(Number(result.totalDiscountIdr)).toBe(0);
    expect(inner.redeem).not.toHaveBeenCalled();
  });

  it("redeem with a voucher code is refused with the clear message", async () => {
    const inner = stale();
    const attempt = withPromoFreshness(inner.port).redeem(
      tx,
      ctx,
      redeemInput("VOUCHER10"),
    );
    await expect(attempt).rejects.toBeInstanceOf(CoreError);
    await expect(attempt).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: PROMO_DISABLED_MESSAGE,
    });
    expect(inner.redeem).not.toHaveBeenCalled();
  });

  it("redeem that expects a discount the order can no longer have is a conflict", async () => {
    const inner = stale();
    await expect(
      withPromoFreshness(inner.port).redeem(
        tx,
        ctx,
        redeemInput(null, DISCOUNT),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(inner.redeem).not.toHaveBeenCalled();
  });

  it("the message tells the cashier promos are off and the normal price applies", () => {
    expect(PROMO_DISABLED_MESSAGE).toContain("Promo dan voucher dimatikan");
    expect(PROMO_DISABLED_MESSAGE).toContain("harga normal");
  });
});

describe("legend-10nex promos on an edge whose provider says fresh", () => {
  it("lets the engine's discount through for quote and redeem", async () => {
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => true);
    const inner = fakeInner();
    const wrapped = withPromoFreshness(inner.port);
    expect(promosEnabled()).toBe(true);
    expect(
      Number((await wrapped.quote(tx, ctx, input())).totalDiscountIdr),
    ).toBe(DISCOUNT);
    expect(
      Number((await wrapped.redeem(tx, ctx, redeemInput())).totalDiscountIdr),
    ).toBe(DISCOUNT);
    expect(inner.quote).toHaveBeenCalledTimes(1);
    expect(inner.redeem).toHaveBeenCalledTimes(1);
  });

  it("a provider that throws counts as off", () => {
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => {
      throw new Error("broken");
    });
    expect(promosEnabled()).toBe(false);
  });
});

describe("legend-10nex promos in the cloud", () => {
  it("always reach the engine, whatever the provider says", async () => {
    setPromoGateEdgeModeForTests(() => false);
    installPromoFreshnessProvider(() => false);
    const inner = fakeInner();
    const wrapped = withPromoFreshness(inner.port);
    expect(promosEnabled()).toBe(true);
    expect(
      Number((await wrapped.quote(tx, ctx, input())).totalDiscountIdr),
    ).toBe(DISCOUNT);
    expect(
      Number(
        (await wrapped.redeem(tx, ctx, redeemInput("VOUCHER10")))
          .totalDiscountIdr,
      ),
    ).toBe(DISCOUNT);
  });

  it("apply with no provider installed", () => {
    setPromoGateEdgeModeForTests(() => false);
    expect(promosEnabled()).toBe(true);
  });
});

describe("legend-10nex the owner override of the sales hold does not open stale promos", () => {
  it("promosEnabled stays false while an override lets sales through", async () => {
    setPromoGateEdgeModeForTests(() => true);
    setSalesGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => false);
    const state: SalesGateState = {
      blocked: false,
      stale24h: true,
      reason: "CATALOG_STALE_24H",
      staleSince: new Date(NOW.getTime() - 30 * HOUR),
      staleStreams: ["catalog:prices"],
      override: {
        id: randomUUID(),
        grantedBy: randomUUID(),
        grantedAt: new Date(NOW.getTime() - MIN),
        untilAt: new Date(NOW.getTime() + 4 * HOUR),
        reason: "Internet toko mati",
      },
    };
    installSalesGateProvider(() => state);
    expect(promosEnabled()).toBe(false);
    const inner = fakeInner();
    const result = await withPromoFreshness(inner.port).quote(tx, ctx, input());
    expect(Number(result.totalDiscountIdr)).toBe(0);
  });
});

type Rig = {
  context: ReturnType<typeof establishScopedTenantContext>;
  outletId: string;
  edgeNodeId: string;
};

async function newEdge(): Promise<Rig> {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji promo', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletId, `PG${outletId.slice(0, 8)}`.toUpperCase(), seededOutletA],
  );
  const base = (source: "session" | "device") =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(seededTenantId),
        brandId: null,
        source,
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
    );
  const registered = await registerEdgeNode(
    base("session"),
    randomUUID() as never,
    { outletId, role: "standby", label: "Mini PC uji promo" } as never,
  );
  return {
    context: base("device"),
    outletId,
    edgeNodeId: registered.edgeNode.id as string,
  };
}

async function checkpoint(rig: Rig, stream: string, lastSuccessAt: Date) {
  await owner.query(
    `INSERT INTO edge_pull_checkpoints (tenant_id, outlet_id, edge_node_id, stream, watermark, last_success_at)
     VALUES ($1, $2, $3, $4, NULL, $5)`,
    [seededTenantId, rig.outletId, rig.edgeNodeId, stream, lastSuccessAt],
  );
}

/** Rows are written before the gate starts so its first read sees them. */
async function startGate(
  rig: Rig,
  rows: Partial<Record<(typeof PROMO_CHECKPOINT_STREAMS)[number], Date>>,
  now: Date = NOW,
) {
  for (const [stream, at] of Object.entries(rows))
    if (at) await checkpoint(rig, stream, at);
  setPromoGateEdgeModeForTests(() => true);
  const handle = startPromoGate({
    context: rig.context,
    edgeNodeId: rig.edgeNodeId,
    clock: { now: () => now },
  });
  handles.push(handle);
  await handle.refresh();
  return handle;
}

describe("legend-10nex startPromoGate reads the pull checkpoints", () => {
  it("is off when no promo or voucher stream has ever synced", async () => {
    await startGate(await newEdge(), {});
    expect(promosEnabled()).toBe(false);
  });

  it("is on when both streams synced 23h59m ago", async () => {
    const at = new Date(NOW.getTime() - (23 * HOUR + 59 * MIN));
    await startGate(await newEdge(), {
      "catalog:promotions": at,
      "catalog:vouchers": at,
    });
    expect(promosEnabled()).toBe(true);
  });

  it("is off when both streams synced 24h01m ago", async () => {
    const at = new Date(NOW.getTime() - (24 * HOUR + MIN));
    await startGate(await newEdge(), {
      "catalog:promotions": at,
      "catalog:vouchers": at,
    });
    expect(promosEnabled()).toBe(false);
  });

  it("is off when only one of the two streams is fresh", async () => {
    const fresh = new Date(NOW.getTime() - HOUR);
    await startGate(await newEdge(), { "catalog:promotions": fresh });
    expect(promosEnabled()).toBe(false);

    handles.pop()!.stop();
    await startGate(await newEdge(), {
      "catalog:promotions": fresh,
      "catalog:vouchers": new Date(NOW.getTime() - 25 * HOUR),
    });
    expect(promosEnabled()).toBe(false);
  });

  it("ages by the injected trusted clock: fresh now, stale a day later", async () => {
    const rig = await newEdge();
    let now = NOW;
    const at = new Date(NOW.getTime() - HOUR);
    await checkpoint(rig, "catalog:promotions", at);
    await checkpoint(rig, "catalog:vouchers", at);
    setPromoGateEdgeModeForTests(() => true);
    const handle = startPromoGate({
      context: rig.context,
      edgeNodeId: rig.edgeNodeId,
      clock: { now: () => now },
    });
    handles.push(handle);
    await handle.refresh();
    expect(promosEnabled()).toBe(true);
    now = new Date(NOW.getTime() + 24 * HOUR); // 25 h since the sync
    expect(promosEnabled()).toBe(false);
  });

  it("stop removes the provider, so an edge fails closed", async () => {
    const at = new Date(NOW.getTime() - HOUR);
    const handle = await startGate(await newEdge(), {
      "catalog:promotions": at,
      "catalog:vouchers": at,
    });
    expect(promosEnabled()).toBe(true);
    handle.stop();
    expect(promosEnabled()).toBe(false);
  });
});

describe("legend-10nex a stale discount is not applied end to end", () => {
  it("gives a total discount of 0 through the wrapper, and a refused voucher", async () => {
    const old = new Date(NOW.getTime() - 30 * HOUR);
    await startGate(await newEdge(), {
      "catalog:promotions": old,
      "catalog:vouchers": old,
    });
    const inner = fakeInner();
    const wrapped = withPromoFreshness(inner.port);
    const quoted = await wrapped.quote(tx, ctx, input());
    expect(Number(quoted.totalDiscountIdr)).toBe(0);
    expect(Number(quoted.result.totalDiscountIdr)).toBe(0);
    const redeemed = await wrapped.redeem(tx, ctx, redeemInput());
    expect(Number(redeemed.totalDiscountIdr)).toBe(0);
    await expect(
      wrapped.redeem(tx, ctx, redeemInput("VOUCHER10")),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(inner.quote).not.toHaveBeenCalled();
    expect(inner.redeem).not.toHaveBeenCalled();
  });

  it("a fresh gate lets the discount through", async () => {
    const at = new Date(NOW.getTime() - HOUR);
    await startGate(await newEdge(), {
      "catalog:promotions": at,
      "catalog:vouchers": at,
    });
    const quoted = await withPromoFreshness(fakeInner().port).quote(
      tx,
      ctx,
      input(),
    );
    expect(Number(quoted.totalDiscountIdr)).toBe(DISCOUNT);
  });
});

describe("legend-10nex the status DTO reports disabled promos", () => {
  const snapshot = () =>
    createCatalogFreshness({
      now: () => NOW,
      timeZone: "Asia/Jakarta",
    }).snapshot();
  const open: SalesGateState = {
    blocked: false,
    stale24h: false,
    reason: null,
    staleSince: null,
    staleStreams: [],
    override: null,
  };

  it("salesGate.promoDisabled is true when promos are off, false when on", () => {
    setPromoGateEdgeModeForTests(() => true);
    installPromoFreshnessProvider(() => false);
    expect(
      catalogFreshnessToDto(snapshot(), open).salesGate?.promoDisabled,
    ).toBe(true);
    installPromoFreshnessProvider(() => true);
    expect(
      catalogFreshnessToDto(snapshot(), open).salesGate?.promoDisabled,
    ).toBe(false);
  });

  it("is true on an edge with no provider and false in the cloud", () => {
    setPromoGateEdgeModeForTests(() => true);
    expect(
      catalogFreshnessToDto(snapshot(), open).salesGate?.promoDisabled,
    ).toBe(true);
    setPromoGateEdgeModeForTests(() => false);
    expect(
      catalogFreshnessToDto(snapshot(), open).salesGate?.promoDisabled,
    ).toBe(false);
  });
});
