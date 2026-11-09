// legend-aiksz: pickup_calls and expo_assignments are tenant + outlet owned,
// forced through RLS, and guarded by unique keys, CHECK constraints and
// BEFORE UPDATE/DELETE triggers. Fixtures are written as the migration owner
// (with tenant settings, FORCE RLS). Every behaviour check runs as the
// restricted legend_app role inside a rolled-back transaction, so nothing a
// check inserts outlives it.
//
// Assumptions: legend_app holds INSERT/UPDATE/DELETE on both tables (the
// delete-guard test deletes as legend_app); trigger errors are asserted by
// SQLSTATE 23514 only, since the trigger message text is not part of the
// contract.
// Round 2: the BEFORE INSERT order/outlet trigger (errcode 23503) fires before
// the RLS WITH CHECK and before the composite order FK. Cases with the trigger
// on therefore assert exactly 23503. Round 3: the FK and the RLS WITH CHECK are
// proven separately, inside an owner transaction that is ROLLED BACK, with the
// trigger disabled (ALTER TABLE ... DISABLE TRIGGER is transactional). Guard-
// trigger update cases keep every other CHECK satisfied so only the guard can
// refuse.
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  asTenant,
  createAppPool,
  createOwnerPool,
  createSecondTenant,
  expectRowsIsolated,
  removeSecondTenant,
  requireDisposableDatabase,
  tenantAId,
  type SecondTenant,
} from "./tenant-isolation-harness";

const outletA1 = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletA2 = cafeLegendPlatformFixtures.outlets[1]!.id;

// A date no seed data uses, so unique keys never collide with other suites.
const DAY = "2031-03-15";
const OTHER_DAY = "2031-03-16";
const T_ASSIGNED = "2031-03-15T09:00:00.000Z";
const T_CALLED = "2031-03-15T10:00:00.000Z";
const T_LATER = "2031-03-15T10:30:00.000Z";
const T_EARLIER = "2031-03-15T08:00:00.000Z";

let owner: Pool;
let appPool: Pool;
let tenantB: SecondTenant;

// Persisted fixtures (committed by the owner).
const pcA = randomUUID();
const pcB = randomUUID();
const exA = randomUUID();
const exB = randomUUID();
const persistedOrders: { tenantId: string; id: string }[] = [];

// Orders used by rolled-back checks (never reused across tenants).
let order1: string;
let order2: string;
let order3OutletA2: string;
let orderB: string;

/**
 * Rolled-back owner transaction with the table's BEFORE INSERT order/outlet
 * trigger disabled, so only the composite FK and RLS can refuse an insert.
 * `asRole: "owner"` keeps the owner (tenant GUCs set, FORCE RLS applies);
 * `asRole: "app"` switches to legend_app so the RLS WITH CHECK is exercised.
 */
async function withOrderTriggerDisabled<T>(
  table: string,
  session: {
    tenantId: string;
    outletIds?: "*" | string[];
    asRole: "owner" | "app";
  },
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `ALTER TABLE ${table} DISABLE TRIGGER ${table}_order_outlet_trg`,
    );
    // Report an FK violation at the INSERT, not at COMMIT.
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    if (session.asRole === "app")
      await client.query("SET LOCAL ROLE legend_app");
    const outletIds = session.outletIds ?? "*";
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [session.tenantId, outletIds === "*" ? "*" : JSON.stringify(outletIds)],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Owner transaction with tenant settings (orders/pickup tables are FORCE RLS). */
async function asOwnerOf<T>(
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

async function seedOrder(tenantId: string, outletId: string): Promise<string> {
  const id = randomUUID();
  await asOwnerOf(tenantId, (client) =>
    client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', 10000, 0, 0, 0, 0, 10000,
         'sent', $5, $6)`,
      [id, tenantId, outletId, `PK-${id.slice(0, 8)}`, DAY, T_ASSIGNED],
    ),
  );
  persistedOrders.push({ tenantId, id });
  return id;
}

interface PickupInput {
  id?: string;
  tenantId?: string;
  outletId?: string;
  orderId: string;
  channel?: string;
  number: number;
  businessDate?: string;
  status?: string;
  calledAt?: string | null;
  pickedUpAt?: string | null;
}

function insertPickup(client: PoolClient, input: PickupInput) {
  return client.query(
    `INSERT INTO pickup_calls
       (id, tenant_id, outlet_id, order_id, channel, number, business_date,
        status, called_at, picked_up_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.id ?? randomUUID(),
      input.tenantId ?? tenantAId,
      input.outletId ?? outletA1,
      input.orderId,
      input.channel ?? "takeaway",
      input.number,
      input.businessDate ?? DAY,
      input.status ?? "assigned",
      input.calledAt ?? null,
      input.pickedUpAt ?? null,
    ],
  );
}

interface ExpoInput {
  id?: string;
  tenantId?: string;
  outletId?: string;
  orderId: string;
  runnerId?: string | null;
  runnerAssignedAt?: string;
  assignedBy?: string | null;
  deliveredAt?: string | null;
  deliveredBy?: string | null;
}

function insertExpo(client: PoolClient, input: ExpoInput) {
  return client.query(
    `INSERT INTO expo_assignments
       (id, tenant_id, outlet_id, order_id, runner_id, runner_assigned_at,
        assigned_by, delivered_at, delivered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id ?? randomUUID(),
      input.tenantId ?? tenantAId,
      input.outletId ?? outletA1,
      input.orderId,
      input.runnerId === undefined ? randomUUID() : input.runnerId,
      input.runnerAssignedAt ?? T_ASSIGNED,
      input.assignedBy ?? null,
      input.deliveredAt ?? null,
      input.deliveredBy ?? null,
    ],
  );
}

beforeAll(async () => {
  requireDisposableDatabase();
  owner = createOwnerPool();
  appPool = createAppPool();
  tenantB = await createSecondTenant(owner, "expickup");

  order1 = await seedOrder(tenantAId, outletA1);
  order2 = await seedOrder(tenantAId, outletA1);
  order3OutletA2 = await seedOrder(tenantAId, outletA2);
  orderB = await seedOrder(tenantB.tenantId, tenantB.outletId);
  const pcOrderA = await seedOrder(tenantAId, outletA1);
  const pcOrderB = await seedOrder(tenantB.tenantId, tenantB.outletId);
  const exOrderA = await seedOrder(tenantAId, outletA1);
  const exOrderB = await seedOrder(tenantB.tenantId, tenantB.outletId);

  // Same number, same business date, under both tenants: allowed per tenant.
  await asOwnerOf(tenantAId, (c) =>
    insertPickup(c, { id: pcA, orderId: pcOrderA, number: 501 }),
  );
  await asOwnerOf(tenantB.tenantId, (c) =>
    insertPickup(c, {
      id: pcB,
      tenantId: tenantB.tenantId,
      outletId: tenantB.outletId,
      orderId: pcOrderB,
      number: 501,
    }),
  );
  await asOwnerOf(tenantAId, (c) =>
    insertExpo(c, { id: exA, orderId: exOrderA }),
  );
  await asOwnerOf(tenantB.tenantId, (c) =>
    insertExpo(c, {
      id: exB,
      tenantId: tenantB.tenantId,
      outletId: tenantB.outletId,
      orderId: exOrderB,
    }),
  );
});

afterAll(async () => {
  if (!owner) return;
  for (const tenantId of [tenantAId, tenantB.tenantId]) {
    await asOwnerOf(tenantId, async (c) => {
      await c.query("DELETE FROM pickup_calls WHERE tenant_id = $1", [
        tenantId,
      ]);
      await c.query("DELETE FROM expo_assignments WHERE tenant_id = $1", [
        tenantId,
      ]);
      const ids = persistedOrders
        .filter((o) => o.tenantId === tenantId)
        .map((o) => o.id);
      await c.query(
        "DELETE FROM orders WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, ids],
      );
    });
  }
  await removeSecondTenant(owner, tenantB);
  await owner.end();
  await appPool.end();
});

describe.each([
  {
    table: "pickup_calls",
    rowA: () => pcA,
    rowB: () => pcB,
    insertForeign: (c: PoolClient, tenantId: string, outletId: string) =>
      insertPickup(c, {
        tenantId,
        outletId,
        orderId: order1,
        number: 11,
      }),
  },
  {
    table: "expo_assignments",
    rowA: () => exA,
    rowB: () => exB,
    insertForeign: (c: PoolClient, tenantId: string, outletId: string) =>
      insertExpo(c, { tenantId, outletId, orderId: order1 }),
  },
])("$table RLS", ({ table, rowA, rowB, insertForeign }) => {
  it("has row level security enabled and forced", async () => {
    const result = await owner.query(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1`,
      [table],
    );
    expect(result.rows).toEqual([{ enabled: true, forced: true }]);
  });

  it("each tenant sees only its own row and cannot update or delete the other's", async () => {
    await expectRowsIsolated(
      appPool,
      {
        table,
        updateSet: "updated_at = now()",
        tenantA: { tenantId: tenantAId, rowId: rowA() },
        tenantB: { tenantId: tenantB.tenantId, rowId: rowB() },
      },
      owner,
    );
  });

  it("a session without tenant context is refused", async () => {
    await expect(
      asTenant(appPool, null, (c) => c.query(`SELECT id FROM ${table}`)),
    ).rejects.toThrow(/tenant context is required/);
  });

  it("inserting a row for another tenant is refused by the order/outlet trigger (23503)", async () => {
    // Trigger on: tenant B's session cannot see tenant A's order, so the
    // BEFORE INSERT trigger refuses first.
    await expect(
      asTenant(appPool, tenantB.tenantId, (c) =>
        insertForeign(c, tenantAId, outletA1),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("RLS WITH CHECK refuses inserting a row for another tenant (trigger disabled)", async () => {
    await expect(
      withOrderTriggerDisabled(
        table,
        { tenantId: tenantB.tenantId, asRole: "app" },
        (c) => insertForeign(c, tenantAId, outletA1),
      ),
    ).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/row-level security/),
    });
  });

  it("RLS WITH CHECK refuses inserting into an outlet outside app.outlet_ids (trigger disabled)", async () => {
    // order1 belongs to outlet A1, so the order/outlet match would hold.
    await expect(
      withOrderTriggerDisabled(
        table,
        { tenantId: tenantAId, outletIds: [outletA2], asRole: "app" },
        (c) => insertForeign(c, tenantAId, outletA1),
      ),
    ).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/row-level security/),
    });
  });

  it("a session limited to another outlet cannot see the row", async () => {
    const hidden = await asTenant(
      appPool,
      tenantAId,
      (c) => c.query(`SELECT id FROM ${table} WHERE id = $1`, [rowA()]),
      [outletA2],
    );
    expect(hidden.rows).toEqual([]);
    const visible = await asTenant(
      appPool,
      tenantAId,
      (c) => c.query(`SELECT id FROM ${table} WHERE id = $1`, [rowA()]),
      [outletA1],
    );
    expect(visible.rows).toEqual([{ id: rowA() }]);
  });

  it("a row cannot point at another tenant's order", async () => {
    // FK (tenant_id, order_id) -> orders(tenant_id, id): tenant B cannot
    // reference tenant A's order even with its own tenant context.
    await expect(
      asTenant(appPool, tenantB.tenantId, (c) =>
        table === "pickup_calls"
          ? insertPickup(c, {
              tenantId: tenantB.tenantId,
              outletId: tenantB.outletId,
              orderId: order1,
              number: 12,
            })
          : insertExpo(c, {
              tenantId: tenantB.tenantId,
              outletId: tenantB.outletId,
              orderId: order1,
            }),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe.each([
  {
    table: "pickup_calls",
    insertRow: (c: PoolClient, outletId: string, orderId: string) =>
      insertPickup(c, { outletId, orderId, number: 7 }),
  },
  {
    table: "expo_assignments",
    insertRow: (c: PoolClient, outletId: string, orderId: string) =>
      insertExpo(c, { outletId, orderId }),
  },
])("$table order/outlet match trigger", ({ table, insertRow }) => {
  it("accepts a row whose outlet equals its order's outlet", async () => {
    await asTenant(appPool, tenantAId, async (c) => {
      await insertRow(c, outletA1, order1);
    });
    await asTenant(appPool, tenantAId, async (c) => {
      await insertRow(c, outletA2, order3OutletA2);
    });
  });

  it("refuses an outlet A2 row pointing at an outlet A1 order", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) => insertRow(c, outletA2, order1)),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses an outlet A1 row pointing at an outlet A2 order", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertRow(c, outletA1, order3OutletA2),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses a row pointing at an order that does not exist", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) => insertRow(c, outletA1, randomUUID())),
    ).rejects.toMatchObject({ code: "23503" });
  });

  // Tenant B's row pointing at tenant A's order is covered above
  // ("a row cannot point at another tenant's order", 23503).
  it("refuses an order the session cannot see (limited to another outlet)", async () => {
    // Session sees only outlet A2; order1 belongs to outlet A1 and is hidden.
    await expect(
      asTenant(appPool, tenantAId, (c) => insertRow(c, outletA2, order1), [
        outletA2,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses an outlet A1 row with an outlet A1 order when the session sees only outlet A2", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) => insertRow(c, outletA1, order1), [
        outletA2,
      ]),
    ).rejects.toMatchObject({
      code: "23503",
      message: expect.stringMatching(/must belong to the outlet of its order/),
    });
  });

  it("composite order FK refuses another tenant's order (trigger disabled)", async () => {
    // Tenant A row, tenant B's order: (tenant_id, order_id) matches no order.
    await expect(
      withOrderTriggerDisabled(
        table,
        { tenantId: tenantAId, asRole: "owner" },
        (c) => insertRow(c, outletA1, orderB),
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: `${table}_order_fk`,
    });
  });

  it("composite order FK refuses an order id that does not exist (trigger disabled)", async () => {
    await expect(
      withOrderTriggerDisabled(
        table,
        { tenantId: tenantAId, asRole: "owner" },
        (c) => insertRow(c, outletA1, randomUUID()),
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: `${table}_order_fk`,
    });
  });
});

describe("pickup_calls unique keys", () => {
  it("one pickup call per order", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await insertPickup(c, { orderId: order1, number: 7 });
        await insertPickup(c, { orderId: order1, number: 8 });
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "pickup_calls_tenant_order_key",
    });
  });

  it("one number per outlet per business date", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await insertPickup(c, { orderId: order1, number: 7 });
        await insertPickup(c, { orderId: order2, number: 7 });
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "pickup_calls_outlet_day_number_key",
    });
  });

  it("the same number is allowed on another day or at another outlet", async () => {
    await asTenant(appPool, tenantAId, async (c) => {
      await insertPickup(c, { orderId: order1, number: 7 });
      await insertPickup(c, {
        orderId: order2,
        number: 7,
        businessDate: OTHER_DAY,
      });
      await insertPickup(c, {
        orderId: order3OutletA2,
        outletId: outletA2,
        number: 7,
      });
    });
  });

  it("the same number is allowed under another tenant", async () => {
    // Persisted fixtures: tenant A and B both hold number 501 on DAY.
    // Both inserts succeeded in beforeAll; confirm through each tenant.
    for (const [tenantId, id] of [
      [tenantAId, pcA],
      [tenantB.tenantId, pcB],
    ] as const) {
      const rows = await asTenant(appPool, tenantId, (c) =>
        c.query(
          "SELECT number, business_date::text AS day FROM pickup_calls WHERE id = $1",
          [id],
        ),
      );
      expect(rows.rows).toEqual([{ number: 501, day: DAY }]);
    }
  });
});

describe("pickup_calls checks", () => {
  it("called needs called_at", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertPickup(c, { orderId: order1, number: 7, status: "called" }),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "pickup_calls_called_at_check",
    });
  });

  it("assigned must not have called_at", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertPickup(c, {
          orderId: order1,
          number: 7,
          status: "assigned",
          calledAt: T_CALLED,
        }),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "pickup_calls_called_at_check",
    });
  });

  it("picked_up needs picked_up_at", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertPickup(c, {
          orderId: order1,
          number: 7,
          status: "picked_up",
          calledAt: T_CALLED,
        }),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "pickup_calls_picked_up_at_check",
    });
  });

  it("picked_up_at cannot be before called_at", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertPickup(c, {
          orderId: order1,
          number: 7,
          status: "picked_up",
          calledAt: T_CALLED,
          pickedUpAt: T_EARLIER,
        }),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "pickup_calls_order_check",
    });
  });

  it("rejects an unknown channel", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertPickup(c, { orderId: order1, number: 7, channel: "dinein" }),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it.each(["takeaway", "gofood", "grabfood", "shopeefood"])(
    "accepts channel %s",
    async (channel) => {
      await asTenant(appPool, tenantAId, (c) =>
        insertPickup(c, { orderId: order1, number: 7, channel }),
      );
    },
  );

  it.each([0, 1000, -1])("rejects number %i", async (number) => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertPickup(c, { orderId: order1, number }),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it.each([1, 999])("accepts number %i", async (number) => {
    await asTenant(appPool, tenantAId, (c) =>
      insertPickup(c, { orderId: order1, number }),
    );
  });

  it("rejects an unknown status", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertPickup(c, { orderId: order1, number: 7, status: "ready" }),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("pickup_calls guard trigger", () => {
  const id = randomUUID();

  it("moves forward assigned -> called -> picked_up", async () => {
    await asTenant(appPool, tenantAId, async (c) => {
      await insertPickup(c, { id, orderId: order1, number: 7 });
      const called = await c.query(
        "UPDATE pickup_calls SET status = 'called', called_at = $2 WHERE id = $1",
        [id, T_CALLED],
      );
      expect(called.rowCount).toBe(1);
      const pickedUp = await c.query(
        "UPDATE pickup_calls SET status = 'picked_up', picked_up_at = $2 WHERE id = $1",
        [id, T_LATER],
      );
      expect(pickedUp.rowCount).toBe(1);
    });
  });

  it("refuses picked_up -> called", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await insertPickup(c, {
          id,
          orderId: order1,
          number: 7,
          status: "picked_up",
          calledAt: T_CALLED,
          pickedUpAt: T_LATER,
        });
        await c.query(
          "UPDATE pickup_calls SET status = 'called', picked_up_at = NULL WHERE id = $1",
          [id],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses called -> assigned", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await insertPickup(c, {
          id,
          orderId: order1,
          number: 7,
          status: "called",
          calledAt: T_CALLED,
        });
        await c.query(
          "UPDATE pickup_calls SET status = 'assigned', called_at = NULL WHERE id = $1",
          [id],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses changing called_at once set", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await insertPickup(c, {
          id,
          orderId: order1,
          number: 7,
          status: "called",
          calledAt: T_CALLED,
        });
        await c.query("UPDATE pickup_calls SET called_at = $2 WHERE id = $1", [
          id,
          T_LATER,
        ]);
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses changing picked_up_at once set", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await insertPickup(c, {
          id,
          orderId: order1,
          number: 7,
          status: "picked_up",
          calledAt: T_CALLED,
          pickedUpAt: T_LATER,
        });
        await c.query(
          "UPDATE pickup_calls SET picked_up_at = $2 WHERE id = $1",
          [id, "2031-03-15T11:00:00.000Z"],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    ["order_id", "order_id = $2", () => order2],
    ["outlet_id", "outlet_id = $2", () => outletA2],
    ["number", "number = $2", () => 8],
    ["business_date", "business_date = $2", () => OTHER_DAY],
    ["channel", "channel = $2", () => "gofood"],
  ])("refuses changing %s", async (_column, set, value) => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await insertPickup(c, { id, orderId: order1, number: 7 });
        await c.query(`UPDATE pickup_calls SET ${set} WHERE id = $1`, [
          id,
          value(),
        ]);
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses skipping a step: assigned -> picked_up in one UPDATE", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await insertPickup(c, { id, orderId: order1, number: 7 });
        // called_at and picked_up_at are both valid for the CHECKs, so only
        // the one-step rule can refuse.
        await c.query(
          `UPDATE pickup_calls
              SET status = 'picked_up', called_at = $2, picked_up_at = $3
            WHERE id = $1`,
          [id, T_CALLED, T_LATER],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("allows an UPDATE that keeps the same values", async () => {
    await asTenant(appPool, tenantAId, async (c) => {
      await insertPickup(c, {
        id,
        orderId: order1,
        number: 7,
        status: "picked_up",
        calledAt: T_CALLED,
        pickedUpAt: T_LATER,
      });
      const same = await c.query(
        `UPDATE pickup_calls
            SET status = status, called_at = called_at,
                picked_up_at = picked_up_at, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      expect(same.rowCount).toBe(1);
    });
  });
});

describe("expo_assignments unique keys", () => {
  it("one assignment per order", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await insertExpo(c, { orderId: order1 });
        await insertExpo(c, { orderId: order1 });
      }),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "expo_assignments_tenant_order_key",
    });
  });

  it("the same order id values under another tenant are independent", async () => {
    // Each tenant holds its own assignment (fixtures); a second tenant-B
    // assignment for tenant B's own order is allowed alongside tenant A's.
    await asTenant(appPool, tenantB.tenantId, async (c) => {
      await insertExpo(c, {
        tenantId: tenantB.tenantId,
        outletId: tenantB.outletId,
        orderId: orderB,
      });
    });
    await asTenant(appPool, tenantAId, async (c) => {
      await insertExpo(c, { orderId: order1 });
    });
  });
});

describe("expo_assignments checks", () => {
  it("delivered_at needs delivered_by", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertExpo(c, { orderId: order1, deliveredAt: T_LATER }),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "expo_assignments_delivered_by_check",
    });
  });

  it("delivered_by needs delivered_at", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertExpo(c, { orderId: order1, deliveredBy: randomUUID() }),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "expo_assignments_delivered_by_check",
    });
  });

  it("delivered_at cannot be before runner_assigned_at", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertExpo(c, {
          orderId: order1,
          runnerAssignedAt: T_CALLED,
          deliveredAt: T_EARLIER,
          deliveredBy: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "expo_assignments_delivered_order_check",
    });
  });

  it("a delivered assignment must have a runner (runner_id NOT NULL)", async () => {
    await expect(
      asTenant(appPool, tenantAId, (c) =>
        insertExpo(c, {
          orderId: order1,
          runnerId: null,
          deliveredAt: T_LATER,
          deliveredBy: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ code: "23502" });
  });

  it("an undelivered assignment without assigned_by is valid", async () => {
    await asTenant(appPool, tenantAId, (c) =>
      insertExpo(c, { orderId: order1, assignedBy: null }),
    );
  });
});

describe("expo_assignments guard trigger", () => {
  const id = randomUUID();
  const deliveredBy = randomUUID();
  const delivered = (c: PoolClient) =>
    insertExpo(c, {
      id,
      orderId: order1,
      deliveredAt: T_LATER,
      deliveredBy,
    });

  it("allows reassigning the runner before delivery", async () => {
    await asTenant(appPool, tenantAId, async (c) => {
      await insertExpo(c, { id, orderId: order1 });
      const result = await c.query(
        "UPDATE expo_assignments SET runner_id = $2, runner_assigned_at = $3 WHERE id = $1",
        [id, randomUUID(), T_CALLED],
      );
      expect(result.rowCount).toBe(1);
    });
  });

  it("allows delivering an assignment that is not delivered yet", async () => {
    await asTenant(appPool, tenantAId, async (c) => {
      await insertExpo(c, { id, orderId: order1 });
      const result = await c.query(
        "UPDATE expo_assignments SET delivered_at = $2, delivered_by = $3 WHERE id = $1",
        [id, T_LATER, deliveredBy],
      );
      expect(result.rowCount).toBe(1);
    });
  });

  it("refuses changing the runner after delivery", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await delivered(c);
        await c.query(
          "UPDATE expo_assignments SET runner_id = $2 WHERE id = $1",
          [id, randomUUID()],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses clearing delivered_at after delivery", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await delivered(c);
        // delivered_by is cleared too so the delivered_by check passes and
        // only the guard can refuse.
        await c.query(
          "UPDATE expo_assignments SET delivered_at = NULL, delivered_by = NULL WHERE id = $1",
          [id],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses changing delivered_by after delivery", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await delivered(c);
        await c.query(
          "UPDATE expo_assignments SET delivered_by = $2 WHERE id = $1",
          [id, randomUUID()],
        );
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    ["order_id", "order_id = $2", () => order2],
    ["outlet_id", "outlet_id = $2", () => outletA2],
  ])("refuses changing %s before delivery", async (_column, set, value) => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await insertExpo(c, { id, orderId: order1 });
        await c.query(`UPDATE expo_assignments SET ${set} WHERE id = $1`, [
          id,
          value(),
        ]);
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    ["order_id", "order_id = $2", () => order2],
    ["outlet_id", "outlet_id = $2", () => outletA2],
    ["runner_assigned_at", "runner_assigned_at = $2", () => T_CALLED],
    ["assigned_by", "assigned_by = $2", () => randomUUID()],
  ])("refuses changing %s after delivery", async (_column, set, value) => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await delivered(c);
        // T_CALLED is still <= delivered_at, so the CHECKs pass.
        await c.query(`UPDATE expo_assignments SET ${set} WHERE id = $1`, [
          id,
          value(),
        ]);
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("allows changing assigned_by before delivery", async () => {
    await asTenant(appPool, tenantAId, async (c) => {
      await insertExpo(c, { id, orderId: order1 });
      const result = await c.query(
        "UPDATE expo_assignments SET assigned_by = $2 WHERE id = $1",
        [id, randomUUID()],
      );
      expect(result.rowCount).toBe(1);
    });
  });

  it("refuses deleting a delivered assignment", async () => {
    await expect(
      asTenant(appPool, tenantAId, async (c) => {
        await delivered(c);
        await c.query("DELETE FROM expo_assignments WHERE id = $1", [id]);
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("allows an UPDATE that keeps the same delivered values", async () => {
    await asTenant(appPool, tenantAId, async (c) => {
      await delivered(c);
      const same = await c.query(
        `UPDATE expo_assignments
            SET runner_id = runner_id, delivered_at = delivered_at,
                delivered_by = delivered_by, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      expect(same.rowCount).toBe(1);
    });
  });
});
