// WS-12 read tools TL-01..TL-06 against PostgreSQL (bead legend-mfyo; PRD v1.7
// TL-01..06, AIG-01, TEN-01..03). Runs the real handlers with the restricted
// app role (RLS enforced). Every test tenant is created here (own brand,
// legal entity, outlets), so numbers never depend on other suites' rows. The
// access snapshots are resolved in memory from the real role templates.
// Test data is left behind on purpose: the test PostgreSQL is disposable and
// orders, journals and refunds are append-only.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleTemplate, type RoleTemplateKey } from "@starter/shared/access";
import { roleAssignmentSchema } from "@starter/shared/access";
import { establishTenantContext } from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  AI_TOOL_IO,
  getFinancialStatementOutputSchema,
  getFoodCostOutputSchema,
  getLaborSummaryOutputSchema,
  getMenuPerformanceOutputSchema,
  getSalesSummaryOutputSchema,
  getStockLevelsOutputSchema,
} from "@starter/shared/ai";
import { resolveAccessSnapshot } from "../services/permission-resolver.ts";
import type { AiToolContext } from "../services/ai-tools/types.ts";
import { readToolsA } from "../services/ai-tools/read-a/index.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const NOW = new Date("2031-06-01T05:00:00.000Z");
const D10 = "2031-03-10";
const D11 = "2031-03-11";

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

type TestTenant = {
  id: string;
  brandId: string;
  entityId: string;
  outlets: { id: string; name: string }[];
};

const platformTenantId = cafeLegendPlatformFixtures.tenant.id;

async function createTenant(label: string, outletCount: number) {
  const tenant: TestTenant = {
    id: randomUUID(),
    brandId: randomUUID(),
    entityId: randomUUID(),
    outlets: Array.from({ length: outletCount }, (_, index) => ({
      id: randomUUID(),
      name: `${label} Outlet ${index + 1}`,
    })),
  };
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, $4, plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [
      tenant.id,
      `ai-read-a-${tenant.id.slice(0, 8)}`,
      platformTenantId,
      `AI read A ${label}`,
    ],
  );
  await asOwner(tenant.id, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
      [tenant.brandId, tenant.id],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Test', false)`,
      [tenant.entityId, tenant.id],
    );
    for (const [index, outlet] of tenant.outlets.entries())
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Test', 'Asia/Jakarta',
                 '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
        [
          outlet.id,
          tenant.id,
          tenant.brandId,
          tenant.entityId,
          `R${index + 1}-${tenant.id.slice(0, 6).toUpperCase()}`,
          outlet.name,
        ],
      );
  });
  return tenant;
}

// ---- access ----------------------------------------------------------------

type Scope = "tenant" | string;

type Grant = {
  readonly role: RoleTemplateKey;
  readonly scope?: Scope | { readonly type: "brand"; readonly id: string };
  readonly extraPermissions?: readonly string[];
  /** Replaces the template permissions (to build a narrower grant). */
  readonly permissions?: readonly string[];
};

function contextForGrants(
  tenant: TestTenant,
  grants: readonly Grant[],
): AiToolContext {
  const userId = randomUUID();
  const roles = grants.map((grant) => {
    const template = roleTemplate(grant.role);
    return {
      id: randomUUID(),
      permissions: grant.permissions
        ? [...grant.permissions]
        : [...template.permissions, ...(grant.extraPermissions ?? [])],
      mfaRequired: false,
      templateKey: grant.role,
      allowedScopeTypes: [...template.allowedScopeTypes],
    };
  });
  const assignments = grants.map((grant, index) => {
    const scope = grant.scope ?? "tenant";
    return roleAssignmentSchema.parse({
      id: randomUUID(),
      tenantId: tenant.id,
      userId,
      roleId: roles[index]!.id,
      scope:
        typeof scope === "object"
          ? scope
          : scope === "tenant"
            ? { type: "tenant", id: null }
            : { type: "outlet", id: scope },
      validFrom: "2030-01-01T00:00:00.000Z",
      validUntil: null,
      assignedBy: randomUUID(),
      assignedAt: "2030-01-01T00:00:00.000Z",
    });
  });
  const access = resolveAccessSnapshot({
    tenant: establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
    userId,
    assignments,
    roles: roles as never,
    org: {
      brands: [{ id: tenant.brandId }],
      outlets: tenant.outlets.map((outlet) => ({
        id: outlet.id,
        brandId: tenant.brandId,
      })),
      stations: [],
    } as never,
    mfaVerified: false,
    now: NOW,
  });
  return { access, channel: "tanya_ai", mcpClientId: null, now: NOW };
}

function contextFor(
  tenant: TestTenant,
  roleKey: RoleTemplateKey,
  scope: Scope = "tenant",
  extraPermissions: readonly string[] = [],
): AiToolContext {
  return contextForGrants(tenant, [{ role: roleKey, scope, extraPermissions }]);
}

const call = (
  code: keyof typeof readToolsA,
  ctx: AiToolContext,
  input: object,
) => readToolsA[code]!(ctx, input);

const forbidden = { code: "AI_TOOL_FORBIDDEN" };

// ---- seeding -----------------------------------------------------------------

async function seedOrder(
  client: PoolClient,
  tenant: TestTenant,
  outletId: string,
  order: {
    number: string;
    channel?: string;
    subtotal: number;
    discount?: number;
    status?: string;
    date: string;
  },
): Promise<string> {
  const id = randomUUID();
  const discount = order.discount ?? 0;
  await client.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
       subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
       status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, $5, 'dine_in', 'pay_first', $6, $7, 0, 0, 0, $8, $9, $10, $11)`,
    [
      id,
      tenant.id,
      outletId,
      order.number,
      order.channel ?? "pos",
      order.subtotal,
      discount,
      order.subtotal - discount,
      order.status ?? "completed",
      order.date,
      `${order.date}T05:00:00.000Z`,
    ],
  );
  return id;
}

async function seedItem(
  client: PoolClient,
  tenant: TestTenant,
  outletId: string,
  orderId: string,
  item: {
    menuItemId: string;
    name: string;
    quantity: number;
    unitPrice: number;
    cost: number;
    status?: string;
    date: string;
  },
) {
  await client.query(
    `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
       unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status,
       reserved_business_date, cost_snapshot_idr)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, 'fired', $10, $11, $12)`,
    [
      randomUUID(),
      tenant.id,
      outletId,
      orderId,
      item.menuItemId,
      item.name,
      item.quantity,
      item.unitPrice,
      item.unitPrice * item.quantity,
      item.status ?? "served",
      item.date,
      item.cost,
    ],
  );
}

let tx: TestTenant; // main tenant: two outlets
let ty: TestTenant; // other tenant: one outlet
let tz: TestTenant; // row-cap tenant: one outlet
let x1: string;
let x2: string;
let m1: string;
let m2: string;

beforeAll(async () => {
  tx = await createTenant("X", 2);
  ty = await createTenant("Y", 1);
  tz = await createTenant("Z", 1);
  x1 = tx.outlets[0]!.id;
  x2 = tx.outlets[1]!.id;
  m1 = randomUUID();
  m2 = randomUUID();

  // --- tenant X: menu, orders, refund
  await asOwner(tx.id, async (client) => {
    const categoryId = randomUUID();
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Minuman')`,
      [categoryId, tx.id, tx.brandId],
    );
    for (const [id, name] of [
      [m1, "Kopi Susu"],
      [m2, "Nasi Goreng"],
    ] as const)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, $4, $5)`,
        [id, tx.id, tx.brandId, categoryId, name],
      );
    const a = await seedOrder(client, tx, x1, {
      number: "A1",
      subtotal: 100_000,
      discount: 10_000,
      date: D10,
    });
    const b = await seedOrder(client, tx, x1, {
      number: "A2",
      subtotal: 50_000,
      date: D10,
    });
    const c = await seedOrder(client, tx, x1, {
      number: "A3",
      subtotal: 30_000,
      date: D11,
    });
    await seedOrder(client, tx, x1, {
      number: "A4",
      subtotal: 999_000,
      status: "awaiting_payment",
      date: D10,
    });
    const e = await seedOrder(client, tx, x2, {
      number: "B1",
      channel: "gofood",
      subtotal: 200_000,
      date: D10,
    });
    await seedItem(client, tx, x1, a, {
      menuItemId: m1,
      name: "Kopi Susu",
      quantity: 2,
      unitPrice: 32_000,
      cost: 19_200,
      date: D10,
    });
    await seedItem(client, tx, x1, a, {
      menuItemId: m2,
      name: "Nasi Goreng",
      quantity: 1,
      unitPrice: 36_000,
      cost: 12_000,
      status: "voided",
      date: D10,
    });
    await seedItem(client, tx, x1, b, {
      menuItemId: m2,
      name: "Nasi Goreng",
      quantity: 1,
      unitPrice: 50_000,
      cost: 20_000,
      date: D10,
    });
    await seedItem(client, tx, x1, c, {
      menuItemId: m1,
      name: "Kopi Susu",
      quantity: 1,
      unitPrice: 30_000,
      cost: 0,
      date: D11,
    });
    await seedItem(client, tx, x2, e, {
      menuItemId: m1,
      name: "Kopi Susu",
      quantity: 4,
      unitPrice: 32_000,
      cost: 38_400,
      date: D10,
    });
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel) VALUES ($1, $2, $3, 'pos')`,
      [a, tx.id, x1],
    );
    await client.query(
      `INSERT INTO pos_order_refunds (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note,
         lines, requested_by, approved_by, approval_request_id, refunded_at)
       VALUES ($1, $2, $3, 5000, 'other', 'test', '[{"method":"cash","amountIdr":5000,"reference":null}]'::jsonb,
         'cashier-1', 'supervisor-1', $4, $5)`,
      [tx.id, x1, a, randomUUID(), `${D10}T06:00:00.000Z`],
    );
  });

  // --- tenant X: inventory
  await asOwner(tx.id, async (client) => {
    const uomId = randomUUID();
    await client.query(
      `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, 'kg', 'Kilogram')`,
      [uomId, tx.id],
    );
    const locations = new Map<string, string>();
    for (const outletId of [x1, x2]) {
      const locationId = randomUUID();
      locations.set(outletId, locationId);
      await client.query(
        `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Gudang', 'warehouse')`,
        [locationId, tx.id, outletId],
      );
    }
    const items: [string, string | null, [string, string][]][] = [
      [
        "Beras",
        "10",
        [
          [x1, "4"],
          [x2, "3"],
        ],
      ],
      ["Gula", "10", [[x1, "8"]]],
      ["Kopi", "5", [[x1, "20"]]],
      ["Teh", null, [[x1, "0"]]],
    ];
    for (const [name, parMin, balances] of items) {
      const itemId = randomUUID();
      await client.query(
        `INSERT INTO inventory_items (id, tenant_id, name, category, base_uom_id, par_min)
         VALUES ($1, $2, $3, 'bahan', $4, $5)`,
        [itemId, tx.id, name, uomId, parMin],
      );
      for (const [outletId, quantity] of balances)
        await client.query(
          `INSERT INTO stock_balances (tenant_id, outlet_id, location_id, inventory_item_id, quantity, avg_cost_idr)
           VALUES ($1, $2, $3, $4, $5, 1000)`,
          [tx.id, outletId, locations.get(outletId), itemId, quantity],
        );
    }
  });

  // --- tenant X: staff and overtime
  await asOwner(tx.id, async (client) => {
    const staff: [string, string, string, string | null][] = [
      ["E1", x1, "active", null],
      ["E2", x1, "active", null],
      ["E3", x1, "resigned", "2031-01-31"],
      ["E4", x2, "active", null],
    ];
    const ids = new Map<string, string>();
    for (const [no, outletId, status, endDate] of staff) {
      const id = randomUUID();
      ids.set(no, id);
      await client.query(
        `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id, employment_type,
           join_date, end_date, status)
         VALUES ($1, $2, $3, $4, $5, 'pkwt', '2030-01-01', $6, $7)`,
        [id, tx.id, no, `Staff ${no}`, outletId, endDate, status],
      );
    }
    const overtime: [string, string, number, string][] = [
      ["E1", x1, 90, "approved"],
      ["E2", x1, 60, "pending"],
      ["E4", x2, 30, "approved"],
    ];
    for (const [no, outletId, minutes, status] of overtime)
      await client.query(
        `INSERT INTO overtime_requests (tenant_id, outlet_id, employee_id, date, minutes, day_type, reason, status, requested_by)
         VALUES ($1, $2, $3, $4, $5, 'workday', 'test', $6, 'requester')`,
        [tx.id, outletId, ids.get(no), D10, minutes, status],
      );
  });

  // --- tenant X: books (Feb closed, Mar open)
  await asOwner(tx.id, async (client) => {
    const account = new Map<string, string>();
    const accounts: [string, string, string, string][] = [
      ["1100", "Kas", "asset", "cash_and_equivalents"],
      ["3100", "Modal", "equity", "equity"],
      ["4100", "Penjualan", "revenue", "revenue"],
      ["5100", "HPP", "expense", "cogs"],
      ["6100", "Biaya Operasional", "expense", "operating_expense"],
    ];
    for (const [code, name, type, group] of accounts) {
      const id = randomUUID();
      account.set(code, id);
      await client.query(
        `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tx.id, tx.entityId, code, name, type, group],
      );
    }
    const feb = randomUUID();
    const mar = randomUUID();
    for (const [id, period] of [
      [feb, "2031-02"],
      [mar, "2031-03"],
    ] as const)
      await client.query(
        `INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period) VALUES ($1, $2, $3, $4)`,
        [id, tx.id, tx.entityId, period],
      );
    const post = async (
      periodId: string,
      date: string,
      lines: [string, number, number][],
    ) => {
      const entryId = randomUUID();
      await client.query(
        `INSERT INTO journal_entries (id, tenant_id, legal_entity_id, entry_date, fiscal_period_id,
           source_type, description, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4, $5, 'manual', 'test', $6, $7)`,
        [
          entryId,
          tx.id,
          tx.entityId,
          date,
          periodId,
          randomUUID(),
          "f".repeat(64),
        ],
      );
      for (const [index, [code, debit, credit]] of lines.entries())
        await client.query(
          `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tx.id, entryId, account.get(code), index + 1, debit, credit],
        );
    };
    await post(feb, "2031-02-15", [
      ["1100", 1_000_000, 0],
      ["3100", 0, 1_000_000],
    ]);
    await post(feb, "2031-02-16", [
      ["1100", 500_000, 0],
      ["4100", 0, 500_000],
    ]);
    await post(feb, "2031-02-17", [
      ["5100", 200_000, 0],
      ["1100", 0, 200_000],
    ]);
    await post(mar, "2031-03-10", [
      ["1100", 300_000, 0],
      ["4100", 0, 300_000],
    ]);
    await post(mar, "2031-03-11", [
      ["6100", 50_000, 0],
      ["1100", 0, 50_000],
    ]);
    await client.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = 'closer', closed_at = now(), version = version + 1
       WHERE id = $1`,
      [feb],
    );
  });

  // --- tenant Y: one big order (must never leak into X)
  await asOwner(ty.id, async (client) => {
    await seedOrder(client, ty, ty.outlets[0]!.id, {
      number: "Y1",
      subtotal: 777_000,
      date: D10,
    });
  });

  // --- tenant Z: 205 days of sales for the row cap
  await asOwner(tz.id, async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       SELECT gen_random_uuid(), $1, $2, 'Z' || n, 'pos', 'dine_in', 'pay_first',
         1000, 0, 0, 0, 0, 1000, 'completed',
         (DATE '2031-01-01' + n), (DATE '2031-01-01' + n)::timestamptz
       FROM generate_series(0, 204) AS n`,
      [tz.id, tz.outlets[0]!.id],
    );
  });
});

afterAll(async () => {
  await owner.end();
});

// ---- TL-01 -------------------------------------------------------------------

describe("TL-01 get_sales_summary", () => {
  const period = { from: D10, to: D11 };

  it("sums paid orders net of discount and refunds, per day", async () => {
    const ctx = contextFor(tx, "owner");
    const out = getSalesSummaryOutputSchema.parse(
      await call("TL-01", ctx, { period, outletIds: [x1] }),
    );
    expect(
      out.rows.map((r) => [
        r.key,
        r.grossSalesIdr,
        r.netSalesIdr,
        r.transactionCount,
      ]),
    ).toEqual([
      [D10, 150_000, 135_000, 2],
      [D11, 30_000, 30_000, 1],
    ]);
    expect(out.totals).toMatchObject({
      grossSalesIdr: 180_000,
      netSalesIdr: 165_000,
      transactionCount: 3,
    });
    expect(out.truncated).toBe(false);
    expect(out.sources[0]).toMatchObject({
      metricCode: "net_sales",
      finality: "final",
    });
    expect(out.sources[0]!.link).toContain("startDate=2031-03-10");
  });

  it("owner without filter covers every outlet; outlet grouping names outlets", async () => {
    const out = getSalesSummaryOutputSchema.parse(
      await call("TL-01", contextFor(tx, "owner"), {
        period,
        groupBy: "outlet",
      }),
    );
    expect(out.totals.netSalesIdr).toBe(365_000);
    expect(out.rows.map((r) => r.label).sort()).toEqual(
      tx.outlets.map((o) => o.name).sort(),
    );
  });

  it("groups by channel", async () => {
    const out = getSalesSummaryOutputSchema.parse(
      await call("TL-01", contextFor(tx, "owner"), {
        period,
        groupBy: "channel",
      }),
    );
    expect(out.rows.map((r) => [r.key, r.netSalesIdr])).toEqual([
      ["gofood", 200_000],
      ["pos", 165_000],
    ]);
  });

  it("marks a period that includes today as estimate", async () => {
    const out = getSalesSummaryOutputSchema.parse(
      await call("TL-01", contextFor(tx, "owner"), {
        period: { from: D10, to: "2031-06-01" },
        outletIds: [x1],
      }),
    );
    expect(out.sources[0]!.finality).toBe("estimate");
  });

  it("AIG-01 outlet manager sees only the assigned outlet and is denied another", async () => {
    const ctx = contextFor(tx, "outlet_manager", x1);
    const out = getSalesSummaryOutputSchema.parse(
      await call("TL-01", ctx, { period }),
    );
    expect(out.totals.netSalesIdr).toBe(165_000);
    await expect(
      call("TL-01", ctx, { period, outletIds: [x2] }),
    ).rejects.toMatchObject(forbidden);
  });

  it("AIG-01 denies a role that is not in the tool's roles", async () => {
    await expect(
      call("TL-01", contextFor(tx, "kitchen_lead", x1), { period }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      call("TL-01", contextFor(tx, "employee"), { period }),
    ).rejects.toMatchObject(forbidden);
  });

  it("AIG-01 never returns another tenant's data", async () => {
    const ownerY = contextFor(ty, "owner");
    const out = getSalesSummaryOutputSchema.parse(
      await call("TL-01", ownerY, { period }),
    );
    expect(out.totals.netSalesIdr).toBe(777_000);
    // Tenant X's owner cannot name tenant Y's outlet.
    await expect(
      call("TL-01", contextFor(tx, "owner"), {
        period,
        outletIds: [ty.outlets[0]!.id],
      }),
    ).rejects.toMatchObject(forbidden);
  });

  it("caps rows at the tool limit and flags truncation", async () => {
    const out = getSalesSummaryOutputSchema.parse(
      await call("TL-01", contextFor(tz, "owner"), {
        period: { from: "2031-01-01", to: "2031-07-24" },
      }),
    );
    expect(out.rows).toHaveLength(200);
    expect(out.truncated).toBe(true);
    expect(out.totals.transactionCount).toBe(205);
  });
});

// ---- TL-02 -------------------------------------------------------------------

describe("TL-02 get_menu_performance", () => {
  const period = { from: D10, to: D11 };

  it("ranks items and shows margin to a caller who also holds cost permission", async () => {
    const out = getMenuPerformanceOutputSchema.parse(
      await call(
        "TL-02",
        contextFor(tx, "outlet_manager", x1, ["inventory.cost.view"]),
        {
          period,
          outletIds: [x1],
          sortBy: "margin",
        },
      ),
    );
    // Voided line is excluded; Kopi Susu = 2x32.000 + 1x30.000.
    expect(
      out.items.map((i) => [i.name, i.qtySold, i.revenueIdr, i.marginIdr]),
    ).toEqual([
      ["Kopi Susu", 3, 94_000, 94_000 - 19_200],
      ["Nasi Goreng", 1, 50_000, 30_000],
    ]);
  });

  it("hides margin from a kitchen lead (menu.item.view only)", async () => {
    const out = getMenuPerformanceOutputSchema.parse(
      await call("TL-02", contextFor(tx, "kitchen_lead", x1), {
        period,
        sortBy: "margin",
        limit: 1,
      }),
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.marginIdr).toBeNull();
    expect(out.truncated).toBe(true);
  });

  it("denies an outlet outside the caller's scope and other tenants", async () => {
    await expect(
      call("TL-02", contextFor(tx, "kitchen_lead", x1), {
        period,
        outletIds: [x2],
      }),
    ).rejects.toMatchObject(forbidden);
    const out = getMenuPerformanceOutputSchema.parse(
      await call("TL-02", contextFor(ty, "marketing"), { period }),
    );
    expect(out.items).toEqual([]);
  });

  it("denies a role outside the tool's roles", async () => {
    await expect(
      call("TL-02", contextFor(tx, "cashier", x1), { period }),
    ).rejects.toMatchObject(forbidden);
  });

  it("checks a role override through that role only: kitchen_lead@x1 + cashier@x2 cannot read x2", async () => {
    const ctx = contextForGrants(tx, [
      { role: "kitchen_lead", scope: x1 },
      { role: "cashier", scope: x2 },
    ]);
    await expect(
      call("TL-02", ctx, { period, outletIds: [x2] }),
    ).rejects.toMatchObject(forbidden);
    const out = getMenuPerformanceOutputSchema.parse(
      await call("TL-02", ctx, { period }),
    );
    // Only x1's Kopi Susu (3), never x2's 4.
    expect(out.items.find((i) => i.name === "Kopi Susu")?.qtySold).toBe(3);
  });

  it("covers outlets granted through different roles with one context that reaches all", async () => {
    const ctx = contextForGrants(tx, [
      { role: "outlet_manager", scope: x1 },
      { role: "kitchen_lead", scope: x2 },
    ]);
    const out = getMenuPerformanceOutputSchema.parse(
      await call("TL-02", ctx, { period }),
    );
    expect(out.items.find((i) => i.name === "Kopi Susu")?.qtySold).toBe(7);
  });

  it("denies rather than under-reports when no single grant reaches every selected outlet", async () => {
    const ctx = contextForGrants(tx, [
      { role: "outlet_manager", scope: x1, permissions: ["report.sales.view"] },
      { role: "kitchen_lead", scope: x2, permissions: ["menu.item.view"] },
    ]);
    await expect(call("TL-02", ctx, { period })).rejects.toMatchObject(
      forbidden,
    );
    await expect(
      call("TL-02", ctx, { period, outletIds: [x1, x2] }),
    ).rejects.toMatchObject(forbidden);
    const x2Only = getMenuPerformanceOutputSchema.parse(
      await call("TL-02", ctx, { period, outletIds: [x2] }),
    );
    expect(x2Only.items.find((i) => i.name === "Kopi Susu")?.qtySold).toBe(4);
  });
});

// ---- TL-03 -------------------------------------------------------------------

describe("TL-03 get_stock_levels", () => {
  it("returns on hand, par and status per item", async () => {
    const out = getStockLevelsOutputSchema.parse(
      await call("TL-03", contextFor(tx, "warehouse", x1), {}),
    );
    expect(
      out.items.map((i) => [
        i.name,
        i.onHandQty,
        i.parLevelQty,
        i.status,
        i.unit,
      ]),
    ).toEqual([
      ["Beras", "4.0000", "10.0000", "critical", "kg"],
      ["Gula", "8.0000", "10.0000", "low", "kg"],
      ["Kopi", "20.0000", "5.0000", "ok", "kg"],
      ["Teh", "0.0000", null, "out", "kg"],
    ]);
  });

  it("filters below par and by search", async () => {
    const ctx = contextFor(tx, "warehouse", x1);
    const below = getStockLevelsOutputSchema.parse(
      await call("TL-03", ctx, { onlyBelowPar: true }),
    );
    expect(below.items.map((i) => i.name)).toEqual(["Beras", "Gula"]);
    const found = getStockLevelsOutputSchema.parse(
      await call("TL-03", ctx, { search: "ber" }),
    );
    expect(found.items.map((i) => i.name)).toEqual(["Beras"]);
  });

  it("scopes by outlet: purchasing sees another outlet, warehouse does not", async () => {
    const out = getStockLevelsOutputSchema.parse(
      await call("TL-03", contextFor(tx, "purchasing"), { outletIds: [x2] }),
    );
    expect(out.items.map((i) => [i.name, i.onHandQty])).toEqual([
      ["Beras", "3.0000"],
    ]);
    await expect(
      call("TL-03", contextFor(tx, "warehouse", x1), { outletIds: [x2] }),
    ).rejects.toMatchObject(forbidden);
  });

  it("denies other roles and never shows other tenants' stock", async () => {
    await expect(
      call("TL-03", contextFor(tx, "cashier", x1), {}),
    ).rejects.toMatchObject(forbidden);
    const out = getStockLevelsOutputSchema.parse(
      await call("TL-03", contextFor(ty, "purchasing"), {}),
    );
    expect(out.items).toEqual([]);
  });
});

// ---- TL-04 -------------------------------------------------------------------

describe("TL-04 get_food_cost", () => {
  const period = { from: D10, to: D11 };

  it("computes food cost percent per outlet from cost snapshots", async () => {
    const out = getFoodCostOutputSchema.parse(
      await call("TL-04", contextFor(tx, "finance"), {
        period,
        outletIds: [x1],
      }),
    );
    expect(out).toMatchObject({
      foodCostIdr: 39_200,
      netSalesIdr: 165_000,
      foodCostPct: "23.7576",
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      outletName: tx.outlets[0]!.name,
      foodCostPct: "23.7576",
    });
    // Accounting month 2031-03 is open: not final.
    expect(out.sources[0]).toMatchObject({
      metricCode: "food_cost_pct",
      finality: "estimate",
    });
  });

  it("lets a kitchen lead read its outlet only", async () => {
    const ctx = contextFor(tx, "kitchen_lead", x1);
    const out = getFoodCostOutputSchema.parse(
      await call("TL-04", ctx, { period }),
    );
    expect(out.foodCostIdr).toBe(39_200);
    await expect(
      call("TL-04", ctx, { period, outletIds: [x2] }),
    ).rejects.toMatchObject(forbidden);
  });

  it("is zero for a tenant without sales and denied for other roles", async () => {
    const out = getFoodCostOutputSchema.parse(
      await call("TL-04", contextFor(ty, "owner"), { period }),
    );
    expect(out.foodCostIdr).toBe(0);
    expect(out.foodCostPct).toBe("0.0000");
    await expect(
      call("TL-04", contextFor(tx, "warehouse", x1), { period }),
    ).rejects.toMatchObject(forbidden);
  });
});

// ---- TL-05 -------------------------------------------------------------------

describe("TL-05 get_labor_summary", () => {
  const period = { from: D10, to: D11 };

  it("returns aggregate headcount and approved overtime hours only", async () => {
    const out = getLaborSummaryOutputSchema.parse(
      await call("TL-05", contextFor(tx, "owner"), { period, outletIds: [x1] }),
    );
    expect(out.headcount).toBe(2);
    expect(out.overtimeHours).toBe("1.5000");
    // No attendance data exists. Labor cost is NULL, never 0: the request is
    // outlet-filtered (a payroll run has no outlet split) and tenant X has no
    // locked payroll run (legend-39d.4). Computed values: ai-labor-cost-payroll.test.ts.
    expect(out).toMatchObject({
      laborCostIdr: null,
      laborCostPct: null,
      workedHours: "0.0000",
    });
    expect(Object.keys(out).sort()).toEqual(
      [
        "headcount",
        "laborCostIdr",
        "laborCostPct",
        "overtimeHours",
        "scheduledHours",
        "sources",
        "workedHours",
      ].sort(),
    );
  });

  it("HR sees the whole tenant, an outlet manager only the assigned outlet", async () => {
    const hr = getLaborSummaryOutputSchema.parse(
      await call("TL-05", contextFor(tx, "hr"), { period }),
    );
    expect(hr.headcount).toBe(3);
    expect(hr.overtimeHours).toBe("2.0000");
    // HR may view payroll, but tenant X has no locked run: null, not 0.
    expect(hr.laborCostIdr).toBeNull();
    expect(hr.laborCostPct).toBeNull();
    const ctx = contextFor(tx, "outlet_manager", x1);
    const manager = getLaborSummaryOutputSchema.parse(
      await call("TL-05", ctx, { period }),
    );
    expect(manager.headcount).toBe(2);
    // An outlet manager has no payroll permission: cost is hidden, not 0.
    expect(manager.laborCostIdr).toBeNull();
    expect(manager.laborCostPct).toBeNull();
    await expect(
      call("TL-05", ctx, { period, outletIds: [x2] }),
    ).rejects.toMatchObject(forbidden);
  });

  it("denies other roles and other tenants' staff", async () => {
    await expect(
      call("TL-05", contextFor(tx, "employee"), { period }),
    ).rejects.toMatchObject(forbidden);
    const out = getLaborSummaryOutputSchema.parse(
      await call("TL-05", contextFor(ty, "hr"), { period }),
    );
    expect(out.headcount).toBe(0);
  });
});

// ---- TL-06 -------------------------------------------------------------------

describe("TL-06 get_financial_statement", () => {
  const lines = (out: {
    lines: { accountCode: string; amountIdr: number }[];
  }) => out.lines.map((l) => [l.accountCode, l.amountIdr]);

  it("builds a profit and loss from posted journal lines (open period = estimate)", async () => {
    const out = getFinancialStatementOutputSchema.parse(
      await call("TL-06", contextFor(tx, "finance"), {
        statement: "profit_loss",
        period: { from: "2031-03-01", to: "2031-03-31" },
      }),
    );
    expect(lines(out)).toEqual([
      ["4100", 300_000],
      ["6100", 50_000],
    ]);
    expect(out).toMatchObject({ periodClosed: false, finality: "estimate" });
  });

  it("is final when every month is closed", async () => {
    const out = getFinancialStatementOutputSchema.parse(
      await call("TL-06", contextFor(tx, "owner"), {
        statement: "profit_loss",
        period: { from: "2031-02-01", to: "2031-02-28" },
      }),
    );
    expect(lines(out)).toEqual([
      ["4100", 500_000],
      ["5100", 200_000],
    ]);
    expect(out).toMatchObject({ periodClosed: true, finality: "final" });
  });

  it("balances the balance sheet with current earnings under equity", async () => {
    const out = getFinancialStatementOutputSchema.parse(
      await call("TL-06", contextFor(tx, "finance"), {
        statement: "balance_sheet",
        period: { from: "2031-02-01", to: "2031-02-28" },
      }),
    );
    const byCode = new Map(out.lines.map((l) => [l.accountCode, l.amountIdr]));
    expect(byCode.get("1100")).toBe(1_300_000);
    expect((byCode.get("3100") ?? 0) + (byCode.get("0") ?? 0)).toBe(1_300_000);
  });

  it("reports cash movement for a cash flow", async () => {
    const out = getFinancialStatementOutputSchema.parse(
      await call("TL-06", contextFor(tx, "finance"), {
        statement: "cash_flow",
        period: { from: "2031-03-01", to: "2031-03-31" },
      }),
    );
    expect(lines(out)).toEqual([["1100", 250_000]]);
  });

  it("shows a shareholder closed periods only", async () => {
    const ctx = contextFor(tx, "shareholder");
    const march = getFinancialStatementOutputSchema.parse(
      await call("TL-06", ctx, {
        statement: "profit_loss",
        period: { from: "2031-03-01", to: "2031-03-31" },
      }),
    );
    expect(march.lines).toEqual([]);
    const both = getFinancialStatementOutputSchema.parse(
      await call("TL-06", ctx, {
        statement: "profit_loss",
        period: { from: "2031-02-01", to: "2031-03-31" },
      }),
    );
    expect(lines(both)).toEqual([
      ["4100", 500_000],
      ["5100", 200_000],
    ]);
    expect(both.periodClosed).toBe(false);
    const feb = getFinancialStatementOutputSchema.parse(
      await call("TL-06", ctx, {
        statement: "profit_loss",
        period: { from: "2031-02-01", to: "2031-02-28" },
      }),
    );
    expect(feb).toMatchObject({ periodClosed: true, finality: "final" });
  });

  it("keeps a shareholder@tenant on closed periods even beside finance@brand", async () => {
    // Only the shareholder grant reaches tenant scope, so it mints the context
    // and its closed-period rule applies; finance@brand must not lift it.
    const ctx = contextForGrants(tx, [
      { role: "shareholder" },
      { role: "finance", scope: { type: "brand", id: tx.brandId } },
    ]);
    const march = getFinancialStatementOutputSchema.parse(
      await call("TL-06", ctx, {
        statement: "profit_loss",
        period: { from: "2031-03-01", to: "2031-03-31" },
      }),
    );
    expect(march.lines).toEqual([]);
  });

  it("uses the full grant when finance also holds tenant scope", async () => {
    const ctx = contextForGrants(tx, [
      { role: "shareholder" },
      { role: "finance" },
    ]);
    const march = getFinancialStatementOutputSchema.parse(
      await call("TL-06", ctx, {
        statement: "profit_loss",
        period: { from: "2031-03-01", to: "2031-03-31" },
      }),
    );
    expect(lines(march)).toEqual([
      ["4100", 300_000],
      ["6100", 50_000],
    ]);
  });

  it("denies other roles and never mixes tenants", async () => {
    const input = {
      statement: "profit_loss",
      period: { from: "2031-02-01", to: "2031-03-31" },
    };
    await expect(
      call("TL-06", contextFor(tx, "outlet_manager", x1), input),
    ).rejects.toMatchObject(forbidden);
    await expect(
      call("TL-06", contextFor(tx, "kitchen_lead", x1), input),
    ).rejects.toMatchObject(forbidden);
    const other = getFinancialStatementOutputSchema.parse(
      await call("TL-06", contextFor(ty, "owner"), input),
    );
    expect(other.lines).toEqual([]);
  });
});

describe("contract", () => {
  it("fills exactly TL-01..TL-06 with handlers", () => {
    expect(Object.keys(readToolsA).sort()).toEqual([
      "TL-01",
      "TL-02",
      "TL-03",
      "TL-04",
      "TL-05",
      "TL-06",
    ]);
    for (const code of Object.keys(readToolsA))
      expect(AI_TOOL_IO).toHaveProperty(code);
  });
});
