// Payments and tax family sources (WS-11 F4, bead legend-hpc4s; contract
// docs/briefs/268-ws11-family-common.md and 268a-ws11-traffic-menu-payments.md,
// DECISIONS 2026-11-10 points 1, 5 and 6). Covers: figures from seeded
// orders, tenant and outlet isolation, split rows plus the ledger residual add
// up to the ledger total, a day without stored rows is never final, and the
// backfill (`recomputeMetricsDaily`) is idempotent.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  idr,
  outletIdSchema,
  outletIdsForQuery,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  accountIdSchema,
  type JournalLineInput,
  type JournalSourceType,
} from "@starter/shared/accounting";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  postJournalInTransaction,
  reverseJournalInTransaction,
} from "../services/accounting-journal.service";
import {
  assertRegistry,
  dailyReaders,
  metricSourceOf,
  metricSplitOf,
} from "../services/metric-sources";
import {
  allocateByWeight,
  netSalesByMethodReader,
  PAYMENT_METHOD_UNASSIGNED,
} from "../services/metric-sources/payments-tax";
import {
  recomputeMetricsDaily,
  refreshMetricsDaily,
} from "../services/metrics-daily.service";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
} from "../services/metrics-query.service";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type World = {
  tenantId: string;
  entityId: string;
  outlet1: string;
  outlet2: string;
  cash: string;
  revenue: string;
};

/** One instant long after every test date: all of them are settled. */
const LATE = new Date("2025-12-20T05:00:00Z");
const FAMILY_READERS = dailyReaders().filter(
  ({ family }) => family === "payments-tax",
);

let world: World;
let other: World;

function context(tenantId: string, outletIds?: string[]): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
  return establishScopedTenantContext(
    tenant,
    outletIds
      ? {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        }
      : { kind: "tenant" },
  );
}

const date = (value: string) => businessDateSchema.parse(value);

async function makeWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `mpt-${label}-${randomUUID().slice(0, 6)}`,
  );
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  const cash = randomUUID();
  const revenue = randomUUID();
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue')`,
    [cash, revenue, tenant.tenantId, tenant.legalEntityId],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'sales_revenue', $3) ON CONFLICT DO NOTHING`,
    [tenant.tenantId, tenant.legalEntityId, revenue],
  );
  return {
    tenantId: tenant.tenantId,
    entityId: tenant.legalEntityId,
    outlet1: tenant.outletId,
    outlet2,
    cash,
    revenue,
  };
}

function line(
  accountId: string,
  debit: number,
  credit: number,
  outletId: string,
): JournalLineInput {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: outletIdSchema.parse(outletId),
    costCenter: null,
  };
}

async function postSale(w: World, day: string, outlet: string, amount: number) {
  const ctx = context(w.tenantId);
  await withTenant(db, ctx, (tx) =>
    postJournalInTransaction(tx, ctx, {
      legalEntityId: w.entityId,
      outletId: outletIdSchema.parse(outlet),
      entryDate: date(day),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Uji sumber pembayaran",
      lines: [
        line(w.cash, amount, 0, outlet),
        line(w.revenue, 0, amount, outlet),
      ],
      postedBy: null,
      idempotencyKey: `ms-payments-tax-${randomUUID()}`,
    }),
  );
}

type OrderSeed = {
  outlet?: string;
  day: string;
  subtotal: number;
  discount?: number;
  status?: string;
  training?: boolean;
  pos?: boolean;
  tenders?: { method: string; amount: number; status?: string }[];
  intentMethod?: string;
};

/** One exclusive-price order (no tax or service) with its tenders. */
async function seedOrder(w: World, seed: OrderSeed): Promise<string> {
  const orderId = randomUUID();
  const outlet = seed.outlet ?? w.outlet1;
  const discount = seed.discount ?? 0;
  const total = seed.subtotal - discount;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [w.tenantId],
    );
    let intentId: string | null = null;
    if (seed.intentMethod) {
      const linkId = randomUUID();
      intentId = randomUUID();
      await client.query(
        `INSERT INTO payment_links
           (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'uji')`,
        [
          linkId,
          w.tenantId,
          outlet,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          `PL-${linkId.slice(0, 8)}`,
          total,
        ],
      );
      await client.query(
        `INSERT INTO payment_intents
           (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider,
            amount_idr, idempotency_key, status, instructions, paid_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'duitku', $7, $8, 'paid', '{}'::jsonb,
                 now(), now() + interval '1 day')`,
        [
          intentId,
          w.tenantId,
          outlet,
          linkId,
          orderId,
          seed.intentMethod,
          total,
          randomUUID(),
        ],
      );
    }
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at, payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, 'takeaway', 'pay_first', $6, $7, 0, 0, 0, $8,
               $9, $10, now(), $11)`,
      [
        orderId,
        w.tenantId,
        outlet,
        `MPT-${orderId.slice(0, 8)}`,
        seed.pos === false || seed.intentMethod ? "qr" : "pos",
        seed.subtotal,
        discount,
        total,
        seed.status ?? "completed",
        seed.day,
        intentId,
      ],
    );
    if (seed.pos !== false && !seed.intentMethod) {
      await client.query(
        `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training)
         VALUES ($1, $2, $3, 'pos', $4)`,
        [orderId, w.tenantId, outlet, seed.training ?? false],
      );
      for (const tender of seed.tenders ?? []) {
        const isCash = tender.method === "cash";
        const status = tender.status ?? "captured";
        await client.query(
          `INSERT INTO pos_order_tenders
             (tenant_id, outlet_id, order_id, method, provider, amount_idr,
              received_idr, change_idr, status, requested_at, resolved_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
          [
            w.tenantId,
            outlet,
            orderId,
            tender.method,
            isCash ? "manual" : "duitku",
            tender.amount,
            isCash ? tender.amount : null,
            isCash ? 0 : null,
            status,
          ],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return orderId;
}

/** A closed shift of one cashier with a count variance (triggers off for the seed). */
async function seedClosedShift(
  w: World,
  day: string,
  cashier: string,
  variance: number,
  outlet: string = w.outlet1,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO pos_shifts
         (tenant_id, outlet_id, device_id, cashier_id, business_date, status,
          opened_at, opening_float_idr, expected_idr, counted_idr, variance_idr,
          variance_note, counts, approved_by, approval_request_id,
          approval_override_id, approved_at, closed_at, closed_by, open_key,
          open_fingerprint, close_key, close_fingerprint, count_id)
       VALUES ($1, $2, $3, $4, $5, 'closed', now(), 100000, 100000, $6, $7,
               'uji', '[]'::jsonb, $8, $9, $10, now(), now(), $8, $11, $12, $13, $12, $14)`,
      [
        w.tenantId,
        outlet,
        randomUUID(),
        cashier,
        day,
        100000 + variance,
        variance,
        `approver-${randomUUID().slice(0, 8)}`,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        "0".repeat(64),
        randomUUID(),
        randomUUID(),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Row = {
  id: string;
  metric_code: string;
  dimension_key: string | null;
  dimension_value: string | null;
  value_int: string | null;
  finality: string;
  updated_at: Date;
};

async function rowsOf(
  tenantId: string,
  outletId: string,
  day: string,
  code?: string,
): Promise<Row[]> {
  const { rows } = await owner.query<Row>(
    `SELECT id, metric_code, dimension_key, dimension_value,
            value_int::text AS value_int, finality, updated_at
       FROM metrics_daily
      WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3
        AND ($4::text IS NULL OR metric_code = $4)
      ORDER BY metric_code, dimension_key NULLS FIRST, dimension_value NULLS FIRST`,
    [tenantId, outletId, day, code ?? null],
  );
  return rows;
}

/** The net-sales-by-method rows of one outlet-day (reader unregistered, see its header). */
async function computeNetSales(
  w: World,
  day: string,
  outlet: string = w.outlet1,
): Promise<[string | null, number][]> {
  const values = await withTenant(db, context(w.tenantId), (tx) =>
    netSalesByMethodReader.compute({
      tx,
      tenantId: w.tenantId,
      outletId: outlet,
      businessDate: date(day),
      now: new Date(),
    }),
  );
  return values.map((value) => [
    value.dimension?.value ?? null,
    (value.value as { valueIdr: number }).valueIdr,
  ]);
}

const shape = (rows: Row[]) =>
  rows.map((r) => [r.metric_code, r.dimension_value, Number(r.value_int)]);

function refresh(w: World, day: string, outlet: string = w.outlet1) {
  return refreshMetricsDaily(
    context(w.tenantId),
    { outletId: outlet, businessDate: date(day) },
    LATE,
    { readers: FAMILY_READERS },
  );
}

function evaluate(
  w: World,
  request: {
    metricCodes: string[];
    start: string;
    end: string;
    bucket?: "total" | "day";
    groupBy?: string[];
  },
  outletIds?: string[],
): Promise<EvaluatedMetrics> {
  const ctx = context(w.tenantId, outletIds);
  return withTenantSnapshot(ctx, (tx) =>
    evaluateMetrics(
      tx,
      ctx,
      {
        metricCodes: request.metricCodes,
        period: { start: date(request.start), end: date(request.end) },
        bucket: request.bucket ?? "total",
        outletFilter: outletIdsForQuery(ctx.outletScope),
        groupBy: (request.groupBy ?? []) as never,
        filters: [],
        comparePrevious: false,
        viewer: "full",
      },
      LATE,
    ),
  );
}

function native(point: { value: unknown } | undefined): number | null {
  const value = point?.value as
    | { unit: "idr"; valueIdr: number }
    | { unit: string; value: number | string }
    | null
    | undefined;
  if (value == null) return null;
  return "valueIdr" in value ? value.valueIdr : Number(value.value);
}

/** Split value (or null for the total) to the figure of the only point. */
function figures(result: EvaluatedMetrics, code: string) {
  const out = new Map<
    string | null,
    { value: number | null; final: boolean }
  >();
  for (const series of result.series.filter((s) => s.metricCode === code)) {
    const extra = series.dimensions.find((d) => d.key !== "outlet");
    out.set(extra?.value ?? null, {
      value: native(series.points[0]),
      final: series.points[0]?.finality === "final",
    });
  }
  return out;
}

beforeAll(async () => {
  world = await makeWorld("a");
  other = await makeWorld("b");
});

afterAll(async () => {
  await owner.end();
});

describe("registry of the payments-tax family", () => {
  it("stays a valid registry and claims the daily readers, no net_sales split", () => {
    expect(() => assertRegistry()).not.toThrow();
    // Sales (F1) owns the net_sales split readers; two readers would clash.
    expect(metricSplitOf("net_sales", "payment_method")).not.toBeNull();
    expect(
      dailyReaders().find(
        ({ reader }) =>
          reader === metricSplitOf("net_sales", "payment_method")!.reader,
      )?.family,
    ).toBe("sales");
    expect(
      FAMILY_READERS.flatMap(({ reader }) => reader.metricCodes),
    ).not.toContain("net_sales");
    expect(metricSourceOf("failed_payment_count").kind).toBe("daily");
    expect(metricSourceOf("cash_variance").kind).toBe("daily");
  });

  it("answers unavailable for what has no data source in the schema", () => {
    for (const code of ["gateway_settlement", "edc_settlement"])
      expect(metricSourceOf(code), code).toMatchObject({
        kind: "unavailable",
        reason: "source_not_built",
      });
    // payment_fee stays a ledger metric with no payment-method split.
    expect(metricSourceOf("payment_fee").kind).toBe("gl");
    expect(metricSplitOf("payment_fee", "payment_method")).toBeNull();
  });
});

describe("allocateByWeight", () => {
  it("adds up to the amount and is deterministic", () => {
    expect(allocateByWeight(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateByWeight(100, [30, 70])).toEqual([30, 70]);
    expect(allocateByWeight(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocateByWeight(0, [5, 5])).toEqual([0, 0]);
    expect(allocateByWeight(50, [])).toEqual([]);
  });

  it("hands the largest remainder to the right part at 2.5e15 (double rounding picks another)", () => {
    expect(
      allocateByWeight(
        2_580_504_321_110_331,
        [6_037_246_936_248, 733_589_185_989, 2_080_086_771_925],
      ),
    ).toEqual([
      1_760_171_452_501_744, 213_879_398_453_810, 606_453_470_154_777,
    ]);
  });

  it("stays exact for amounts and weights beyond double precision", () => {
    const amount = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
    const weights = [
      3_000_000_000_001, 7_000_000_000_003, 5, 1_234_567_891_011,
    ];
    const parts = allocateByWeight(amount, weights);
    expect(parts.every(Number.isSafeInteger)).toBe(true);
    expect(parts.reduce((sum, part) => sum + BigInt(part), 0n)).toBe(
      BigInt(amount),
    );
    // Independent BigInt oracle: floors plus one rupiah to each largest remainder.
    const total = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
    const shares = weights.map((weight) => ({
      floor: (BigInt(amount) * BigInt(weight)) / total,
      rest: (BigInt(amount) * BigInt(weight)) % total,
    }));
    let left = BigInt(amount) - shares.reduce((sum, x) => sum + x.floor, 0n);
    const expected = shares.map((share) => share.floor);
    [...shares.keys()]
      .sort((x, y) =>
        shares[x]!.rest === shares[y]!.rest
          ? x - y
          : shares[x]!.rest > shares[y]!.rest
            ? -1
            : 1,
      )
      .forEach((at) => {
        if (left > 0n) {
          expected[at]! += 1n;
          left -= 1n;
        }
      });
    expect(parts.map(BigInt)).toEqual(expected);
    const negative = allocateByWeight(-amount, weights);
    expect(negative.reduce((sum, part) => sum + BigInt(part), 0n)).toBe(
      -BigInt(amount),
    );
  });
});

describe("payments.methods: net sales by payment method", () => {
  it("the unregistered reader splits completed orders by captured tender and paid intent", async () => {
    const day = "2025-08-01";
    await seedOrder(world, {
      day,
      subtotal: 100_000,
      tenders: [{ method: "cash", amount: 100_000 }],
    });
    await seedOrder(world, {
      day,
      subtotal: 50_000,
      discount: 5_000,
      tenders: [{ method: "qris", amount: 45_000 }],
    });
    // Mixed tender: the order's 100,000 follows the tender amounts 30/70.
    await seedOrder(world, {
      day,
      subtotal: 100_000,
      tenders: [
        { method: "cash", amount: 30_000 },
        { method: "qris", amount: 70_000 },
      ],
    });
    await seedOrder(world, { day, subtotal: 20_000, intentMethod: "va" });
    // No tender at all: its own row, never dropped or spread.
    await seedOrder(world, { day, subtotal: 7_000 });
    // Not a sale: open order, training order, failed tender only.
    await seedOrder(world, {
      day,
      subtotal: 999_000,
      status: "sent",
      tenders: [{ method: "cash", amount: 999_000 }],
    });
    await seedOrder(world, {
      day,
      subtotal: 888_000,
      training: true,
      tenders: [{ method: "cash", amount: 888_000 }],
    });

    expect(await computeNetSales(world, day)).toEqual([
      [null, 272_000],
      ["cash", 130_000],
      ["qris", 115_000],
      [PAYMENT_METHOD_UNASSIGNED, 7_000],
      ["va", 20_000],
    ]);
  });

  it("writes a zero total and no split rows on a day without sales", async () => {
    expect(await computeNetSales(world, "2025-08-02")).toEqual([[null, 0]]);
  });

  it("payments.methods reads the sales split; split plus residual is the ledger total", async () => {
    const day = "2025-08-03";
    await seedOrder(world, {
      day,
      subtotal: 60_000,
      tenders: [{ method: "cash", amount: 60_000 }],
    });
    await postSale(world, day, world.outlet1, 60_000);
    await refresh(world, day);
    const split = await evaluate(world, {
      metricCodes: ["net_sales"],
      start: day,
      end: day,
      groupBy: ["payment_method"],
    });
    // Sales owns the split (ca6a9498); without its rows the residual row
    // still makes the split add up to the ledger total.
    expect(split.availability[0]).toMatchObject({ status: "available" });
    expect(
      [...figures(split, "net_sales").values()].reduce(
        (sum, entry) => sum + (entry.value ?? 0),
        0,
      ),
    ).toBe(60_000);
    expect(
      native(
        (
          await evaluate(world, {
            metricCodes: ["net_sales"],
            start: day,
            end: day,
          })
        ).series[0]!.points[0],
      ),
    ).toBe(60_000);
  });
});

describe("failed payments and cash variance", () => {
  it("counts failed tenders by method on the order's business date", async () => {
    const day = "2025-08-05";
    await seedOrder(world, {
      day,
      subtotal: 10_000,
      tenders: [
        { method: "qris", amount: 10_000, status: "failed" },
        { method: "cash", amount: 10_000 },
      ],
    });
    await seedOrder(world, {
      day,
      subtotal: 10_000,
      status: "sent",
      tenders: [{ method: "qris", amount: 10_000, status: "failed" }],
    });
    // A failed tender of a training order is not a real failure.
    await seedOrder(world, {
      day,
      subtotal: 10_000,
      training: true,
      tenders: [{ method: "qris", amount: 10_000, status: "failed" }],
    });
    await refresh(world, day);
    expect(
      shape(
        await rowsOf(
          world.tenantId,
          world.outlet1,
          day,
          "failed_payment_count",
        ),
      ),
    ).toEqual([
      ["failed_payment_count", null, 2],
      ["failed_payment_count", "qris", 2],
    ]);
  });

  it("sums closed shift variance per cashier id, signed", async () => {
    const day = "2025-08-06";
    await seedClosedShift(world, day, "kasir-a", -5_000);
    await seedClosedShift(world, day, "kasir-a", 2_000);
    await seedClosedShift(world, day, "kasir-b", 10_000);
    await refresh(world, day);
    const rows = await rowsOf(
      world.tenantId,
      world.outlet1,
      day,
      "cash_variance",
    );
    expect(shape(rows)).toEqual([
      ["cash_variance", null, 7_000],
      ["cash_variance", "kasir-a", -3_000],
      ["cash_variance", "kasir-b", 10_000],
    ]);
    // A point-of-sale figure is final only after the day close exists.
    expect(rows.every((row) => row.finality === "estimate")).toBe(true);
  });
});

describe("isolation", () => {
  it("keeps tenant and outlet figures apart", async () => {
    const day = "2025-08-07";
    await seedOrder(world, {
      day,
      subtotal: 11_000,
      tenders: [{ method: "cash", amount: 11_000 }],
    });
    await seedOrder(world, {
      outlet: world.outlet2,
      day,
      subtotal: 22_000,
      tenders: [{ method: "qris", amount: 22_000 }],
    });
    await seedOrder(other, {
      day,
      subtotal: 33_000,
      tenders: [{ method: "edc_card", amount: 33_000 }],
    });
    expect(await computeNetSales(world, day)).toEqual([
      [null, 11_000],
      ["cash", 11_000],
    ]);
    expect(await computeNetSales(world, day, world.outlet2)).toEqual([
      [null, 22_000],
      ["qris", 22_000],
    ]);
    expect(await computeNetSales(other, day, other.outlet1)).toEqual([
      [null, 33_000],
      ["edc_card", 33_000],
    ]);
    // The job's rows of the family stay per tenant and outlet too.
    await refresh(world, day);
    await refresh(world, day, world.outlet2);
    await refresh(other, day, other.outlet1);
    expect(
      await rowsOf(world.tenantId, world.outlet1, day, "cash_variance"),
    ).toHaveLength(1);
    expect(
      await rowsOf(other.tenantId, world.outlet1, day, "cash_variance"),
    ).toEqual([]);
  });

  it("a tenant or outlet context cannot compute another outlet-day", async () => {
    const day = "2025-08-08";
    await seedOrder(world, {
      outlet: world.outlet2,
      day,
      subtotal: 5_000,
      tenders: [{ method: "cash", amount: 5_000 }],
    });
    // Tenant B asks for tenant A's outlet; an outlet-scoped context asks for
    // the sibling outlet. Either may reject or no-op: nothing is written.
    await refreshMetricsDaily(
      context(other.tenantId),
      { outletId: world.outlet2, businessDate: date(day) },
      LATE,
      { readers: FAMILY_READERS },
    ).catch(() => undefined);
    await refreshMetricsDaily(
      context(world.tenantId, [world.outlet1]),
      { outletId: world.outlet2, businessDate: date(day) },
      LATE,
      { readers: FAMILY_READERS },
    ).catch(() => undefined);
    expect(await rowsOf(world.tenantId, world.outlet2, day)).toEqual([]);

    // Reading: an outlet-scoped viewer sees only its outlet's split rows.
    await refresh(world, day, world.outlet2);
    const scoped = await evaluate(
      world,
      {
        metricCodes: ["failed_payment_count"],
        start: day,
        end: day,
      },
      [world.outlet1],
    );
    expect(native(scoped.series[0]?.points[0])).toBeNull();
  });
});

describe("a day without data is not final", () => {
  it("keeps a bucket an estimate while one of its days has no total row", async () => {
    await seedOrder(world, {
      day: "2025-08-10",
      subtotal: 1_000,
      tenders: [{ method: "qris", amount: 1_000, status: "failed" }],
    });
    await refresh(world, "2025-08-10");
    // 2025-08-11 was never computed.
    const one = figures(
      await evaluate(world, {
        metricCodes: ["failed_payment_count"],
        start: "2025-08-10",
        end: "2025-08-10",
      }),
      "failed_payment_count",
    );
    expect(one.get(null)).toEqual({ value: 1, final: true });
    const two = figures(
      await evaluate(world, {
        metricCodes: ["failed_payment_count"],
        start: "2025-08-10",
        end: "2025-08-11",
      }),
      "failed_payment_count",
    );
    expect(two.get(null)?.value).toBe(1);
    expect(two.get(null)?.final).toBe(false);
  });
});

describe("backfill is idempotent", () => {
  it("recomputeMetricsDaily twice leaves the same rows and updated_at", async () => {
    const days = ["2025-08-20", "2025-08-21"];
    for (const day of days)
      await seedOrder(world, {
        day,
        subtotal: 12_000,
        tenders: [
          { method: "cash", amount: 4_000 },
          { method: "qris", amount: 8_000, status: "failed" },
        ],
      });
    const run = () =>
      recomputeMetricsDaily(
        context(world.tenantId),
        world.outlet1,
        date(days[0]!),
        date(days[1]!),
        { readers: FAMILY_READERS, now: LATE },
      );
    const first = await run();
    expect(first.failedFamilies).toEqual([]);
    expect(first.written).toBeGreaterThan(0);
    const before = await Promise.all(
      days.map((day) => rowsOf(world.tenantId, world.outlet1, day)),
    );
    const second = await run();
    expect(second).toMatchObject({ written: 0, deleted: 0 });
    expect(second.unchanged).toBe(first.written);
    const after = await Promise.all(
      days.map((day) => rowsOf(world.tenantId, world.outlet1, day)),
    );
    expect(after.map((rows) => rows.map((r) => r.id))).toEqual(
      before.map((rows) => rows.map((r) => r.id)),
    );
    expect(
      after.map((rows) => rows.map((r) => r.updated_at.getTime())),
    ).toEqual(before.map((rows) => rows.map((r) => r.updated_at.getTime())));
    expect(
      shape(
        await rowsOf(
          world.tenantId,
          world.outlet1,
          days[0]!,
          "failed_payment_count",
        ),
      ),
    ).toEqual([
      ["failed_payment_count", null, 1],
      ["failed_payment_count", "qris", 1],
    ]);
  });
});

describe("the 12 ledger metrics are unchanged by this family", () => {
  it("still resolves every ledger code to a gl source", () => {
    for (const code of [
      "net_sales",
      "cogs",
      "gross_profit",
      "net_profit",
      "discount_amount",
      "waste_cost",
      "gross_payroll",
      "payment_fee",
      "food_cost_pct",
      "labor_cost_pct",
      "prime_cost_pct",
      "gross_margin_pct",
      "tax_collected",
      "service_charge_collected",
      "tax_payable",
    ])
      expect(metricSourceOf(code).kind, code).toBe("gl");
  });
});

describe("tax and service charge from the ledger (legend-iwsrp 8)", () => {
  let tax: World;
  let pbjt: string;
  let service: string;

  const post = (
    day: string,
    outlet: string,
    sourceType: Exclude<JournalSourceType, "reversal">,
    lines: JournalLineInput[],
  ) => {
    const ctx = context(tax.tenantId);
    return withTenant(db, ctx, (tx) =>
      postJournalInTransaction(tx, ctx, {
        legalEntityId: tax.entityId,
        outletId: outletIdSchema.parse(outlet),
        entryDate: date(day),
        sourceType,
        sourceId: randomUUID(),
        description: "Uji pajak buku besar",
        lines,
        postedBy: null,
        idempotencyKey: `ms-payments-tax-gl-${randomUUID()}`,
      }),
    );
  };

  beforeAll(async () => {
    tax = await makeWorld("tax");
    pbjt = randomUUID();
    service = randomUUID();
    await owner.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $3, $4, '2201', 'Utang PBJT', 'liability', 'current_liability'),
              ($2, $3, $4, '2202', 'Service charge', 'liability', 'current_liability')`,
      [pbjt, service, tax.tenantId, tax.entityId],
    );
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'tax_payable_pbjt', $3), ($1, $2, 'service_charge', $4)
       ON CONFLICT DO NOTHING`,
      [tax.tenantId, tax.entityId, pbjt, service],
    );
    const o1 = tax.outlet1;
    const o2 = tax.outlet2;
    // 1 Sep, outlet 1: sale 100k + PBJT 10k + service charge 5k.
    await post("2025-09-01", o1, "sale", [
      line(tax.cash, 115_000, 0, o1),
      line(tax.revenue, 0, 100_000, o1),
      line(pbjt, 0, 10_000, o1),
      line(service, 0, 5_000, o1),
    ]);
    // 10 Sep, outlet 1: the PBJT of outlet 1 is paid to the tax office.
    await post("2025-09-10", o1, "manual", [
      line(pbjt, 10_000, 0, o1),
      line(tax.cash, 0, 10_000, o1),
    ]);
    // 15 Sep, outlet 2: sale 200k + PBJT 20k + service charge 10k.
    await post("2025-09-15", o2, "sale", [
      line(tax.cash, 230_000, 0, o2),
      line(tax.revenue, 0, 200_000, o2),
      line(pbjt, 0, 20_000, o2),
      line(service, 0, 10_000, o2),
    ]);
  });

  const byOutlet = (result: EvaluatedMetrics, code: string) =>
    new Map(
      result.series
        .filter((series) => series.metricCode === code)
        .map((series) => [
          series.dimensions[0]?.value ?? null,
          native(series.points[0]),
        ]),
    );

  it("tax_collected and service_charge_collected are the period movement", async () => {
    const codes = ["tax_collected", "service_charge_collected"];
    const early = await evaluate(tax, {
      metricCodes: codes,
      start: "2025-09-01",
      end: "2025-09-05",
    });
    expect(early.availability.map((entry) => entry.status)).toEqual([
      "available",
      "available",
    ]);
    expect(native(early.series[0]!.points[0])).toBe(10_000);
    expect(native(early.series[1]!.points[0])).toBe(5_000);
    const late = await evaluate(tax, {
      metricCodes: codes,
      start: "2025-09-11",
      end: "2025-09-30",
      groupBy: ["outlet"],
    });
    expect(byOutlet(late, "tax_collected")).toEqual(
      new Map([[tax.outlet2, 20_000]]),
    );
    expect(byOutlet(late, "service_charge_collected")).toEqual(
      new Map([[tax.outlet2, 10_000]]),
    );
  });

  it("collected counts sales net of refunds, never the PBJT remittance or the payroll payout (S9)", async () => {
    const o1 = tax.outlet1;
    // October, outlet 1: a sale, a refund, a voided sale (reversal), then the
    // PBJT paid to the tax office and the service charge paid through payroll.
    await post("2025-10-01", o1, "sale", [
      line(tax.cash, 345_000, 0, o1),
      line(tax.revenue, 0, 300_000, o1),
      line(pbjt, 0, 30_000, o1),
      line(service, 0, 15_000, o1),
    ]);
    await post("2025-10-02", o1, "refund", [
      line(tax.revenue, 30_000, 0, o1),
      line(pbjt, 3_000, 0, o1),
      line(service, 1_500, 0, o1),
      line(tax.cash, 0, 34_500, o1),
    ]);
    const voided = await post("2025-10-03", o1, "sale", [
      line(tax.cash, 92_000, 0, o1),
      line(tax.revenue, 0, 80_000, o1),
      line(pbjt, 0, 8_000, o1),
      line(service, 0, 4_000, o1),
    ]);
    const ctx = context(tax.tenantId);
    await withTenant(db, ctx, (tx) =>
      reverseJournalInTransaction(tx, ctx, voided.id, {
        entryDate: date("2025-10-04"),
        reason: "Uji void penjualan",
        idempotencyKey: `ms-payments-tax-gl-${randomUUID()}`,
        postedBy: null,
      }),
    );
    await post("2025-10-20", o1, "manual", [
      line(pbjt, 27_000, 0, o1),
      line(tax.cash, 0, 27_000, o1),
    ]);
    await post("2025-10-25", o1, "payroll", [
      line(service, 13_500, 0, o1),
      line(tax.cash, 0, 13_500, o1),
    ]);
    const october = await evaluate(tax, {
      metricCodes: ["tax_collected", "service_charge_collected", "tax_payable"],
      start: "2025-10-01",
      end: "2025-10-31",
    });
    const value = (code: string) =>
      native(
        october.series.find((series) => series.metricCode === code)!.points[0],
      );
    // Sale − refund (the voided sale nets to zero).
    expect(value("tax_collected")).toBe(27_000);
    expect(value("service_charge_collected")).toBe(13_500);
    // The balance still counts the remittance: 20k open from September.
    expect(value("tax_payable")).toBe(20_000);
  });

  it("tax_payable is the balance through the period end, not the movement", async () => {
    const through = async (start: string, end: string) =>
      native(
        (
          await evaluate(tax, {
            metricCodes: ["tax_payable"],
            start,
            end,
          })
        ).series[0]!.points[0],
      );
    expect(await through("2025-09-01", "2025-09-05")).toBe(10_000);
    // Lines before the period count; the payment on 10 Sep clears outlet 1.
    expect(await through("2025-09-11", "2025-09-12")).toBe(0);
    expect(await through("2025-09-11", "2025-09-30")).toBe(20_000);
    // Day buckets: each one is the balance at its own end.
    const days = await evaluate(tax, {
      metricCodes: ["tax_payable"],
      start: "2025-09-09",
      end: "2025-09-11",
      bucket: "day",
    });
    expect(days.series[0]!.points.map(native)).toEqual([10_000, 0, 0]);
  });

  it("tax_payable per outlet is not supported: a remittance may carry no outlet (R-A 4)", async () => {
    // A PBJT remittance is a manual (or supplier payment) journal whose
    // lines may be entity-level, so an outlet balance would be wrong.
    const period = { start: "2025-09-11", end: "2025-09-30" };
    const split = await evaluate(tax, {
      metricCodes: ["tax_payable"],
      ...period,
      groupBy: ["outlet"],
    });
    const scoped = await evaluate(
      tax,
      { metricCodes: ["tax_payable"], ...period },
      [tax.outlet2],
    );
    for (const result of [split, scoped]) {
      expect(result.availability[0]).toMatchObject({
        status: "unavailable",
        reason: "dimension_not_supported",
      });
      expect(result.series.every((series) => !series.points[0]?.value)).toBe(
        true,
      );
    }
    // The tenant figure without an outlet filter stays.
    const tenant = await evaluate(tax, {
      metricCodes: ["tax_payable"],
      ...period,
    });
    expect(native(tenant.series[0]!.points[0])).toBe(20_000);
  });

  it("tax_collected by menu_category has no split: dimension_not_supported", async () => {
    const result = await evaluate(tax, {
      metricCodes: ["tax_collected"],
      start: "2025-09-01",
      end: "2025-09-30",
      groupBy: ["menu_category"],
    });
    expect(result.availability[0]).toMatchObject({
      status: "unavailable",
      reason: "dimension_not_supported",
    });
  });
});
