// Cross-tenant isolation for POS orders and the menu (bead legend-wwsa; PRD
// v1.7 TEN-01 tenant, TEN-03 outlet). Tenant A is the seeded Cafe Legend
// tenant, tenant B a throwaway tenant. Every module is proven three ways: the
// real service given a context for one tenant never returns or changes the
// other's rows, the restricted legend_app login (RLS) sees only its own rows,
// and one authenticated HTTP request from a tenant A user never reaches tenant
// B data. Fixtures are written by the migration owner and removed in afterAll.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  deleteCategory,
  listCategories,
  listStations,
  updateCategory,
} from "../services/menu.service.ts";
import {
  getPosOrder,
  listPosOrderEvents,
  listPosOrders,
  mutatePosOrder,
  voidPosOrder,
} from "../services/pos-order.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  asTenant,
  createAppPool,
  createOwnerPool,
  createSecondTenant,
  expectRowsIsolated,
  removeSecondTenant,
  requireDisposableDatabase,
  tenantAId,
  tenantContext,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const NOT_VISIBLE = {
  code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/),
};

const outletAId = cafeLegendPlatformFixtures.outlets[0]!.id;
const hostA = cafeLegendPlatformFixtures.domains[0]!.hostname;

let owner: Pool;
let appPool: Pool;
let app: Express;
let tenantB: SecondTenant;
let brandAId: string;

// ---- Fixture ids ------------------------------------------------------------------

const ulidA = createUlid();
const ulidB = createUlid();
const posA = { orderId: ulidA, orderUuid: ulidToUuid(ulidA), eventId: "" };
const posB = { orderId: ulidB, orderUuid: ulidToUuid(ulidB), eventId: "" };
posA.eventId = ulidToUuid(createUlid());
posB.eventId = ulidToUuid(createUlid());

const menuA = {
  category: randomUUID(),
  item: randomUUID(),
  station: randomUUID(),
};
const menuB = {
  category: randomUUID(),
  item: randomUUID(),
  station: randomUUID(),
};

const roleBId = randomUUID();
const createdUserIds: string[] = [];
// Rows the controls write (replay ledger entries, spare categories): removed in afterAll.
const idempotencyKeys: { tenantId: string; outletId: string; key: string }[] =
  [];
const spareCategories: { tenantId: string; id: string }[] = [];

type Member = { client: ReturnType<typeof agent>; userId: string };
let userA: Member; // owner of tenant A
let userB: Member; // menu manager of tenant B

// ---- Fixtures ---------------------------------------------------------------------

/** Owner-side writes set the tenant local, because RLS is FORCED. */
async function asOwnerTenant<T>(
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

async function insertPosOrder(
  tenantId: string,
  outletId: string,
  order: typeof posA,
): Promise<void> {
  await asOwnerTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
          total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first',
               0, 0, 0, 0, 0, 0, 'sent', '2026-11-09', now())`,
      [order.orderUuid, tenantId, outletId, `ISO-${order.orderId.slice(-10)}`],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
       VALUES ($1, $2, $3, 'pos')`,
      [order.orderUuid, tenantId, outletId],
    );
    await client.query(
      `INSERT INTO order_events
         (id, tenant_id, outlet_id, order_id, sequence, type, payload, occurred_at)
       VALUES ($1, $2, $3, $4, 1, 'order.submitted', '{}', now())`,
      [order.eventId, tenantId, outletId, order.orderUuid],
    );
  });
}

/**
 * order_events is append-only (trigger), so the fixture rows are removed with
 * triggers off for this transaction only (replica role), never for others.
 */
async function removePosOrder(tenantId: string, order: typeof posA) {
  await asOwnerTenant(tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM order_events WHERE order_id = $1", [
      order.orderUuid,
    ]);
    await client.query("DELETE FROM pos_orders WHERE order_id = $1", [
      order.orderUuid,
    ]);
    await client.query("DELETE FROM orders WHERE id = $1", [order.orderUuid]);
  });
}

async function removeIdempotencyKeys(tenantId: string): Promise<void> {
  const keys = idempotencyKeys
    .filter((entry) => entry.tenantId === tenantId)
    .map((entry) => entry.key);
  if (keys.length === 0) return;
  await asOwnerTenant(tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM pos_order_idempotency WHERE tenant_id = $1 AND key = ANY($2::text[])",
      [tenantId, keys],
    );
  });
}

async function insertMenu(
  tenantId: string,
  brandId: string,
  outletId: string,
  ids: typeof menuA,
  label: string,
): Promise<void> {
  await asOwnerTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 0)`,
      [ids.category, tenantId, brandId, `Kategori ISO ${label}`],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [
        ids.item,
        tenantId,
        brandId,
        ids.category,
        `Item ISO ${label}`,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, $4, 'hot_kitchen')`,
      [ids.station, tenantId, outletId, `Stasiun ISO ${label}`],
    );
  });
}

/** Inserts a spare category the controls may change or delete. */
async function insertSpareCategory(
  tenantId: string,
  brandId: string,
  label: string,
): Promise<string> {
  const id = randomUUID();
  spareCategories.push({ tenantId, id });
  await asOwnerTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 0)`,
      [id, tenantId, brandId, `Kategori ISO cadangan ${label}`],
    );
  });
  return id;
}

async function removeMenu(tenantId: string, ids: typeof menuA): Promise<void> {
  const spares = spareCategories
    .filter((entry) => entry.tenantId === tenantId)
    .map((entry) => entry.id);
  const aggregates = [ids.category, ids.item, ids.station, ...spares];
  await asOwnerTenant(tenantId, async (client) => {
    // The controls' own-row changes appended menu events to the outbox.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = ANY($2::uuid[])",
      [tenantId, aggregates],
    );
    await client.query("DELETE FROM stations WHERE id = $1", [ids.station]);
    await client.query("DELETE FROM menu_items WHERE id = $1", [ids.item]);
    await client.query(
      "DELETE FROM menu_categories WHERE id = ANY($1::uuid[])",
      [[ids.category, ...spares]],
    );
  });
}

async function memberOf(
  tenantId: string,
  roleId: string,
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  return { client, userId };
}

function caller(userId: string) {
  return {
    userId: userIdSchema.parse(userId),
    deviceId: null,
    expectedVersion: null,
  };
}

beforeAll(async () => {
  requireDisposableDatabase();
  owner = createOwnerPool();
  appPool = createAppPool();
  app = createApp();
  tenantB = await createSecondTenant(owner, "posmenu");
  const brand = await owner.query<{ brand_id: string }>(
    "SELECT brand_id FROM outlets WHERE id = $1 AND tenant_id = $2",
    [outletAId, tenantAId],
  );
  brandAId = brand.rows[0]!.brand_id;

  // Tenant A actor: the seeded owner template. Tenant B actor: a custom role.
  const ownerRole = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenantAId],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Menu Uji B', false, NULL, $3, false, '["tenant"]')`,
    [
      roleBId,
      tenantB.tenantId,
      JSON.stringify(["menu.item.view", "menu.item.manage", "order.view"]),
    ],
  );
  userA = await memberOf(tenantAId, ownerRole.rows[0]!.id, "Isolation A");
  userB = await memberOf(tenantB.tenantId, roleBId, "Isolation B");

  await insertPosOrder(tenantAId, outletAId, posA);
  await insertPosOrder(tenantB.tenantId, tenantB.outletId, posB);
  await insertMenu(tenantAId, brandAId, outletAId, menuA, "A");
  await insertMenu(
    tenantB.tenantId,
    tenantB.brandId,
    tenantB.outletId,
    menuB,
    "B",
  );
});

afterAll(async () => {
  // beforeAll may have failed before tenant B existed.
  const created = tenantB as SecondTenant | undefined;
  const errors: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    if (created) {
      await step(() => removeMenu(created.tenantId, menuB));
      await step(() => removeIdempotencyKeys(created.tenantId));
      await step(() => removePosOrder(created.tenantId, posB));
    }
    await step(() => removeMenu(tenantAId, menuA));
    await step(() => removeIdempotencyKeys(tenantAId));
    await step(() => removePosOrder(tenantAId, posA));
    if (createdUserIds.length > 0) {
      await step(() =>
        owner.query(
          "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
          [createdUserIds],
        ),
      );
      await step(() =>
        owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
          createdUserIds,
        ]),
      );
    }
    await step(() => owner.query("DELETE FROM roles WHERE id = $1", [roleBId]));
    if (created) await step(() => removeSecondTenant(owner, created));
  } finally {
    await step(() => appPool?.end());
    await step(() => owner?.end());
  }
  if (errors.length > 0) throw errors[0];
});

// ---- POS orders -------------------------------------------------------------------

describe("POS orders isolation (legend-wwsa)", () => {
  it("TEN-01 the order list of one tenant never contains the other's orders", async () => {
    const outletA = outletIdSchema.parse(outletAId);
    const outletB = outletIdSchema.parse(tenantB.outletId);
    const listedA = await listPosOrders(tenantContext(tenantAId), outletA, {
      limit: 100,
    });
    const idsA = listedA.data.map((order) => order.id);
    expect(idsA).toContain(posA.orderId);
    expect(idsA).not.toContain(posB.orderId);
    expect(listedA.data.every((order) => order.tenantId === tenantAId)).toBe(
      true,
    );

    const listedB = await listPosOrders(
      tenantContext(tenantB.tenantId),
      outletB,
      { limit: 100 },
    );
    expect(listedB.data.map((order) => order.id)).toEqual([posB.orderId]);

    // Naming the other tenant's outlet is refused, never answered with rows.
    await expect(
      listPosOrders(tenantContext(tenantAId), outletB, { limit: 100 }),
    ).rejects.toMatchObject(NOT_VISIBLE);
    await expect(
      listPosOrders(tenantContext(tenantB.tenantId), outletA, { limit: 100 }),
    ).rejects.toMatchObject(NOT_VISIBLE);
  });

  it("TEN-01 reading another tenant's order or its events is refused", async () => {
    const outletA = outletIdSchema.parse(outletAId);
    const outletB = outletIdSchema.parse(tenantB.outletId);
    const ctxA = tenantContext(tenantAId);
    const ctxB = tenantContext(tenantB.tenantId);
    const own = await getPosOrder(ctxA, outletA, posA.orderId);
    expect(own.detail.id).toBe(posA.orderId);

    for (const [ctx, outlet, orderId] of [
      [ctxA, outletB, posB.orderId], // B's order through B's outlet
      [ctxA, outletA, posB.orderId], // B's order through A's outlet
      [ctxB, outletA, posA.orderId],
      [ctxB, outletB, posA.orderId],
    ] as const) {
      await expect(getPosOrder(ctx, outlet, orderId)).rejects.toMatchObject(
        NOT_VISIBLE,
      );
      await expect(
        listPosOrderEvents(ctx, outlet, orderId, { limit: 50 }),
      ).rejects.toMatchObject(NOT_VISIBLE);
    }

    const events = await listPosOrderEvents(ctxA, outletA, posA.orderId, {
      limit: 50,
    });
    expect(events.data.map((event) => event.orderId)).toEqual([posA.orderId]);
    expect(events.data.every((event) => event.tenantId === tenantAId)).toBe(
      true,
    );
  });

  it("TEN-01 a void or mutation of another tenant's order is refused and the order is unchanged", async () => {
    const ctxA = tenantContext(tenantAId);
    const ctxB = tenantContext(tenantB.tenantId);
    const voidInput = {
      idempotencyKey: randomUUID(),
      reason: "wrong_order",
      reasonNote: "Uji isolasi tenant",
      approvedBy: userA.userId,
      overrideId: createUlid(),
      expectedStatus: "sent",
    } as unknown as Parameters<typeof voidPosOrder>[4];
    // Positive control: each tenant's actor reaches `run` on its OWN order, so
    // the refusals below can only come from tenant scoping.
    const mutateOwn = async (
      ctx: typeof ctxA,
      who: Member,
      tenantId: string,
      outletId: string,
      orderId: string,
    ) => {
      const key = randomUUID();
      idempotencyKeys.push({ tenantId, outletId, key });
      let reached = false;
      const result = await mutatePosOrder(
        ctx,
        caller(who.userId),
        {
          outletId: outletIdSchema.parse(outletId),
          orderId,
          key,
          operation: "order.test",
          request: {},
        },
        async () => {
          reached = true;
          return { ok: true };
        },
      );
      expect(reached).toBe(true);
      expect(result).toEqual({ ok: true });
    };
    await mutateOwn(ctxA, userA, tenantAId, outletAId, posA.orderId);
    await mutateOwn(
      ctxB,
      userB,
      tenantB.tenantId,
      tenantB.outletId,
      posB.orderId,
    );

    let ran = false;
    for (const [ctx, who, outletId, orderId] of [
      [ctxA, userA, tenantB.outletId, posB.orderId],
      [ctxA, userA, outletAId, posB.orderId],
      [ctxB, userB, outletAId, posA.orderId],
      [ctxB, userB, tenantB.outletId, posA.orderId],
    ] as const) {
      const outlet = outletIdSchema.parse(outletId);
      await expect(
        voidPosOrder(ctx, caller(who.userId), outlet, orderId, voidInput),
      ).rejects.toMatchObject(NOT_VISIBLE);
      await expect(
        mutatePosOrder(
          ctx,
          caller(who.userId),
          {
            outletId: outlet,
            orderId,
            key: randomUUID(),
            operation: "order.test",
            request: {},
          },
          async () => {
            ran = true;
            return null;
          },
        ),
      ).rejects.toMatchObject(NOT_VISIBLE);
    }
    expect(ran).toBe(false);

    for (const order of [posA, posB]) {
      const row = await owner.query<{
        status: string;
        voided_at: Date | null;
        version: number;
        events: string;
      }>(
        `SELECT o.status, o.voided_at, p.version,
                (SELECT count(*)::text FROM order_events e WHERE e.order_id = o.id) AS events
         FROM orders o JOIN pos_orders p ON p.order_id = o.id AND p.tenant_id = o.tenant_id
         WHERE o.id = $1`,
        [order.orderUuid],
      );
      expect(row.rows[0]).toMatchObject({
        status: "sent",
        voided_at: null,
        version: 0,
        events: "1",
      });
    }
  });

  it("TEN-01 RLS gives each tenant only its own POS rows, for reads, updates and deletes", async () => {
    const tenants = {
      tenantA: { tenantId: tenantAId, rowId: posA.orderUuid },
      tenantB: { tenantId: tenantB.tenantId, rowId: posB.orderUuid },
    };
    await expectRowsIsolated(
      appPool,
      { table: "orders", updateSet: "note = 'diubah'", ...tenants },
      owner,
    );
    await expectRowsIsolated(
      appPool,
      {
        table: "pos_orders",
        idColumn: "order_id",
        updateSet: "version = version + 1",
        ...tenants,
      },
      owner,
    );
    // order_events is append-only for legend_app (no UPDATE or DELETE grant),
    // so only the read side and the missing-context case are checked here.
    for (const [self, other] of [
      [
        { tenantId: tenantAId, rowId: posA.eventId },
        { tenantId: tenantB.tenantId, rowId: posB.eventId },
      ],
      [
        { tenantId: tenantB.tenantId, rowId: posB.eventId },
        { tenantId: tenantAId, rowId: posA.eventId },
      ],
    ] as const)
      await asTenant(appPool, self.tenantId, async (client) => {
        const seen = await client.query<{ id: string }>(
          "SELECT id::text AS id FROM order_events WHERE id = ANY($1::uuid[])",
          [[self.rowId, other.rowId]],
        );
        expect(seen.rows.map((row) => row.id)).toEqual([self.rowId]);
      });
    // Without a tenant context only the RLS errors (unset or invalid setting)
    // or an empty result count as "sees nothing"; anything else is a failure.
    await asTenant(appPool, null, async (client) => {
      let rowCount: number | null = null;
      try {
        rowCount = (
          await client.query("SELECT 1 FROM order_events WHERE id = $1", [
            posA.eventId,
          ])
        ).rowCount;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (!["22P02", "42501", "42704"].includes(code ?? "")) throw error;
        rowCount = 0;
      }
      expect(rowCount).toBe(0);
    });
  });

  it("TEN-03 a context scoped to a different outlet sees no POS rows, its own outlet and '*' see them", async () => {
    const rows = [
      ["orders", "id", posA.orderUuid],
      ["pos_orders", "order_id", posA.orderUuid],
      ["order_events", "id", posA.eventId],
    ] as const;
    const countFor = (outletIds: "*" | string[]) =>
      asTenant(
        appPool,
        tenantAId,
        async (client) => {
          const counts: Record<string, string> = {};
          for (const [table, column, id] of rows) {
            const { rows: found } = await client.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM ${table} WHERE ${column} = $1`,
              [id],
            );
            counts[table] = found[0]!.count;
          }
          return counts;
        },
        outletIds,
      );
    const visible = { orders: "1", pos_orders: "1", order_events: "1" };
    expect(await countFor([outletAId])).toEqual(visible);
    expect(await countFor("*")).toEqual(visible);
    expect(await countFor([tenantB.outletId])).toEqual({
      orders: "0",
      pos_orders: "0",
      order_events: "0",
    });
  });

  it("TEN-01 a tenant A user listing POS orders only gets tenant A orders; tenant B's outlet and order are refused", async () => {
    const base = (outletId: string) =>
      `/api/outlets/${encodeURIComponent(outletId)}/pos/orders`;
    const listed = await userA.client
      .get(`${base(outletAId)}?limit=100`)
      .set({ Host: hostA })
      .set(originHeader);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const listedIds = (listed.body.data as { id: string }[]).map(
      (order) => order.id,
    );
    expect(listedIds).toContain(posA.orderId);
    expect(listedIds).not.toContain(posB.orderId);

    const foreignList = await userA.client
      .get(base(tenantB.outletId))
      .set({ Host: hostA })
      .set(originHeader);
    expect([403, 404]).toContain(foreignList.status);
    expect(JSON.stringify(foreignList.body)).not.toContain(posB.orderId);

    // Positive control: the same two routes answer 200 for the user's OWN
    // order (same role, same host), so the refusals below come from tenancy.
    const ownOrder = await userA.client
      .get(`${base(outletAId)}/${posA.orderId}`)
      .set({ Host: hostA })
      .set(originHeader);
    expect(ownOrder.status, JSON.stringify(ownOrder.body)).toBe(200);
    const ownEvents = await userA.client
      .get(`${base(outletAId)}/${posA.orderId}/events`)
      .set({ Host: hostA })
      .set(originHeader);
    expect(ownEvents.status, JSON.stringify(ownEvents.body)).toBe(200);

    for (const outletId of [tenantB.outletId, outletAId]) {
      const foreignOrder = await userA.client
        .get(`${base(outletId)}/${posB.orderId}`)
        .set({ Host: hostA })
        .set(originHeader);
      expect([403, 404]).toContain(foreignOrder.status);
      expect(JSON.stringify(foreignOrder.body)).not.toContain(posB.orderId);
      const foreignEvents = await userA.client
        .get(`${base(outletId)}/${posB.orderId}/events`)
        .set({ Host: hostA })
        .set(originHeader);
      expect([403, 404]).toContain(foreignEvents.status);
      expect(JSON.stringify(foreignEvents.body)).not.toContain(posB.eventId);
    }
  });
});

// ---- Menu -------------------------------------------------------------------------

describe("Menu isolation (legend-wwsa)", () => {
  it("TEN-01 category and station lists of one tenant never contain the other's rows", async () => {
    const ctxA = tenantContext(tenantAId);
    const ctxB = tenantContext(tenantB.tenantId);
    const categoriesA = await listCategories(ctxA, userA.userId, {
      limit: 100,
    });
    const idsA = categoriesA.data.map((category) => category.id);
    expect(idsA).toContain(menuA.category);
    expect(idsA).not.toContain(menuB.category);

    const categoriesB = await listCategories(ctxB, userB.userId, {
      limit: 100,
    });
    expect(categoriesB.data.map((category) => category.id)).toEqual([
      menuB.category,
    ]);

    const stationsA = await listStations(ctxA, userA.userId, { limit: 100 });
    const stationIdsA = stationsA.data.map((station) => station.id);
    expect(stationIdsA).toContain(menuA.station);
    expect(stationIdsA).not.toContain(menuB.station);

    const stationsB = await listStations(ctxB, userB.userId, { limit: 100 });
    expect(stationsB.data.map((station) => station.id)).toEqual([
      menuB.station,
    ]);

    // Naming the other tenant's brand or outlet never returns its rows.
    // The same filters with the tenant's OWN brand and outlet answer with its
    // rows, so the foreign ones below are refused or empty because of tenancy.
    const ownBrand = await listCategories(ctxA, userA.userId, {
      limit: 100,
      brandId: brandAId,
    });
    expect(ownBrand.data.map((category) => category.id)).toContain(
      menuA.category,
    );
    const ownOutlet = await listStations(ctxA, userA.userId, {
      limit: 100,
      outletId: outletAId,
    });
    expect(ownOutlet.data.map((station) => station.id)).toContain(
      menuA.station,
    );
    await expect(
      listCategories(ctxA, userA.userId, {
        limit: 100,
        brandId: tenantB.brandId,
      }),
    ).rejects.toMatchObject(NOT_VISIBLE);
    const foreignOutlet = await listStations(ctxA, userA.userId, {
      limit: 100,
      outletId: tenantB.outletId,
    });
    expect(foreignOutlet.data).toEqual([]);
  });

  it("TEN-01 updating or deleting another tenant's category is refused and the row is unchanged", async () => {
    const ctxA = tenantContext(tenantAId);
    const ctxB = tenantContext(tenantB.tenantId);
    // Positive control: each actor may change and delete its OWN category, so
    // the refusals below can only come from tenant scoping (same permission).
    const own = await updateCategory(ctxA, userA.userId, menuA.category, {
      name: "Kategori ISO A",
    });
    expect(own.id).toBe(menuA.category);
    const ownB = await updateCategory(ctxB, userB.userId, menuB.category, {
      name: "Kategori ISO B",
    });
    expect(ownB.id).toBe(menuB.category);
    const spareA = await insertSpareCategory(tenantAId, brandAId, "A");
    await deleteCategory(ctxA, userA.userId, spareA);
    const spareB = await insertSpareCategory(
      tenantB.tenantId,
      tenantB.brandId,
      "B",
    );
    await deleteCategory(ctxB, userB.userId, spareB);
    const spares = await owner.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM menu_categories WHERE id = ANY($1::uuid[])",
      [[spareA, spareB]],
    );
    expect(spares.rows).toHaveLength(2);
    expect(spares.rows.every((row) => row.deleted_at !== null)).toBe(true);

    for (const [ctx, who, categoryId] of [
      [ctxA, userA, menuB.category],
      [ctxB, userB, menuA.category],
    ] as const) {
      await expect(
        updateCategory(ctx, who.userId, categoryId, { name: "Dibajak" }),
      ).rejects.toMatchObject(NOT_VISIBLE);
      await expect(
        deleteCategory(ctx, who.userId, categoryId),
      ).rejects.toMatchObject(NOT_VISIBLE);
    }
    const rows = await owner.query<{
      id: string;
      name: string;
      deleted_at: Date | null;
    }>(
      "SELECT id, name, deleted_at FROM menu_categories WHERE id = ANY($1::uuid[]) ORDER BY name",
      [[menuA.category, menuB.category]],
    );
    expect(rows.rows.map((row) => row.name)).toEqual([
      "Kategori ISO A",
      "Kategori ISO B",
    ]);
    expect(rows.rows.every((row) => row.deleted_at === null)).toBe(true);
  });

  it("TEN-01 RLS gives each tenant only its own menu rows, for reads, updates and deletes", async () => {
    for (const [table, id] of [
      ["menu_categories", "category"],
      ["menu_items", "item"],
      ["stations", "station"],
    ] as const)
      await expectRowsIsolated(
        appPool,
        {
          table,
          updateSet: "name = name || ' diubah'",
          tenantA: { tenantId: tenantAId, rowId: menuA[id] },
          tenantB: { tenantId: tenantB.tenantId, rowId: menuB[id] },
        },
        owner,
      );
  });

  it("TEN-03 a context scoped to another outlet sees no stations of this outlet, its own outlet and '*' see it", async () => {
    const countFor = (outletIds: "*" | string[]) =>
      asTenant(
        appPool,
        tenantAId,
        async (client) => {
          const { rows } = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM stations WHERE id = $1",
            [menuA.station],
          );
          return rows[0]?.count;
        },
        outletIds,
      );
    expect(await countFor([outletAId])).toBe("1");
    expect(await countFor("*")).toBe("1");
    expect(await countFor([tenantB.outletId])).toBe("0");
  });

  it("TEN-01 a tenant A user lists only tenant A categories and cannot read, change or delete tenant B's", async () => {
    const listed = await userA.client
      .get("/api/menu/categories?limit=100")
      .set(originHeader);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const listedIds = (listed.body.data as { id: string }[]).map(
      (category) => category.id,
    );
    expect(listedIds).toContain(menuA.category);
    expect(listedIds).not.toContain(menuB.category);

    // Positive control: the same PATCH and DELETE succeed on tenant A's OWN
    // rows with the same user, so the refusals below come from tenancy.
    const ownPatch = await userA.client
      .patch(`/api/menu/categories/${menuA.category}`)
      .set(originHeader)
      .send({ name: "Kategori ISO A" });
    expect(ownPatch.status, JSON.stringify(ownPatch.body)).toBe(200);
    const spare = await insertSpareCategory(tenantAId, brandAId, "rute");
    const ownDelete = await userA.client
      .delete(`/api/menu/categories/${spare}`)
      .set(originHeader);
    expect(ownDelete.status, JSON.stringify(ownDelete.body)).toBeLessThan(300);

    const patched = await userA.client
      .patch(`/api/menu/categories/${menuB.category}`)
      .set(originHeader)
      .send({ name: "Dibajak" });
    expect([403, 404]).toContain(patched.status);
    const deleted = await userA.client
      .delete(`/api/menu/categories/${menuB.category}`)
      .set(originHeader);
    expect([403, 404]).toContain(deleted.status);

    const row = await owner.query<{ name: string; deleted_at: Date | null }>(
      "SELECT name, deleted_at FROM menu_categories WHERE id = $1",
      [menuB.category],
    );
    expect(row.rows[0]).toMatchObject({
      name: "Kategori ISO B",
      deleted_at: null,
    });
  });
});
