// AI-01 menu recommendation tables (legend-ptd): menu_recommendation_rules and
// menu_recommendation_item_rules are tenant + outlet owned and forced through
// RLS; the documented defaults and CHECK/unique constraints hold. Written from
// the brief contract, not from the migration. Raw checks run as the
// restricted legend_app role; fixtures as the migration owner with tenant
// settings (FORCE RLS). Ids are written as uuid text from a ULID, the way the
// repo stores time-ordered ids (ulidToUuid).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const RULES = "menu_recommendation_rules";
const ITEM_RULES = "menu_recommendation_item_rules";
const newId = () => ulidToUuid(createUlid());

type World = IsolatedTenant & { outlet2: string; itemId: string };
let a: World;
let b: World;

async function asAppRole<T>(
  settings: { tenant: string; outlets: string },
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [settings.tenant, settings.outlets],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function asOwner(
  tenant: string,
  text: string,
  params: unknown[] = [],
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function makeWorld(label: string): Promise<World> {
  const t = await createIsolatedTenant(`${label}-${randomUUID().slice(0, 6)}`);
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `R2-${randomUUID().slice(0, 8)}`.toUpperCase(), t.outletId],
  );
  const category = randomUUID();
  const itemId = randomUUID();
  await asOwner(
    t.tenantId,
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'RLS')`,
    [category, t.tenantId, t.brandId],
  );
  await asOwner(
    t.tenantId,
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, $4, 'Item RLS')`,
    [itemId, t.tenantId, t.brandId, category],
  );
  return { ...t, outlet2, itemId };
}

const insertRule = (w: World, outletId: string) =>
  asOwner(
    w.tenantId,
    `INSERT INTO ${RULES} (id, tenant_id, outlet_id) VALUES ($1, $2, $3)`,
    [newId(), w.tenantId, outletId],
  );
const insertItemRule = (
  w: World,
  outletId: string,
  from: number | null,
  to: number | null,
  itemId = w.itemId,
) =>
  asOwner(
    w.tenantId,
    `INSERT INTO ${ITEM_RULES} (id, tenant_id, outlet_id, menu_item_id, blocked, hour_from, hour_to)
     VALUES ($1, $2, $3, $4, false, $5, $6)`,
    [newId(), w.tenantId, outletId, itemId, from, to],
  );

beforeAll(async () => {
  a = await makeWorld("rra");
  b = await makeWorld("rrb");
  await insertRule(a, a.outletId);
  await insertRule(a, a.outlet2);
  await insertRule(b, b.outletId);
  await insertItemRule(a, a.outletId, 9, 17);
  await insertItemRule(a, a.outlet2, null, null);
  await insertItemRule(b, b.outletId, null, null);
});

afterAll(async () => {
  await owner.end();
});

async function rejects(promise: Promise<unknown>, pattern?: RegExp) {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, "expected the statement to be refused").toBeDefined();
  if (pattern) expect(String((error as Error).message)).toMatch(pattern);
}

describe("AI-01 menu recommendation tables: RLS", () => {
  for (const table of [RULES, ITEM_RULES]) {
    it(`${table} has row security enabled and forced`, async () => {
      const result = await owner.query(
        `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = $1`,
        [table],
      );
      expect(result.rows).toEqual([{ enabled: true, forced: true }]);
    });

    it(`${table}: tenant A sees only its rows, tenant B only its own`, async () => {
      const asA = await asAppRole({ tenant: a.tenantId, outlets: "*" }, (c) =>
        c.query(`SELECT DISTINCT tenant_id FROM ${table}`),
      );
      expect(asA.rows).toEqual([{ tenant_id: a.tenantId }]);
      const asB = await asAppRole({ tenant: b.tenantId, outlets: "*" }, (c) =>
        c.query(`SELECT DISTINCT tenant_id FROM ${table}`),
      );
      expect(asB.rows).toEqual([{ tenant_id: b.tenantId }]);
    });

    it(`${table}: an outlet scope hides the other outlet's rows`, async () => {
      const scoped = await asAppRole(
        { tenant: a.tenantId, outlets: JSON.stringify([a.outletId]) },
        (c) => c.query(`SELECT DISTINCT outlet_id FROM ${table}`),
      );
      expect(scoped.rows).toEqual([{ outlet_id: a.outletId }]);
      const none = await asAppRole(
        { tenant: a.tenantId, outlets: JSON.stringify([randomUUID()]) },
        (c) => c.query(`SELECT 1 FROM ${table}`),
      );
      expect(none.rows).toEqual([]);
    });

    it(`${table}: tenant B cannot update or delete tenant A rows`, async () => {
      const result = await asAppRole(
        { tenant: b.tenantId, outlets: "*" },
        async (c) => {
          const upd = await c.query(
            `UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1`,
            [a.tenantId],
          );
          const del = await c.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
            a.tenantId,
          ]);
          return [upd.rowCount, del.rowCount];
        },
      );
      expect(result).toEqual([0, 0]);
      const left = await asOwner(
        a.tenantId,
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
        [a.tenantId],
      );
      expect(left.rows[0].n).toBeGreaterThan(0);
    });
  }

  it("the app role cannot write a rule row for another tenant or an out-of-scope outlet", async () => {
    await rejects(
      asAppRole({ tenant: b.tenantId, outlets: "*" }, (c) =>
        c.query(
          `INSERT INTO ${RULES} (id, tenant_id, outlet_id) VALUES ($1, $2, $3)`,
          [newId(), a.tenantId, a.outletId],
        ),
      ),
    );
    await rejects(
      asAppRole(
        { tenant: a.tenantId, outlets: JSON.stringify([a.outletId]) },
        (c) =>
          c.query(
            `INSERT INTO ${RULES} (id, tenant_id, outlet_id)
             VALUES ($1, $2, $3)`,
            [newId(), a.tenantId, a.outlet2],
          ),
      ),
    );
    await rejects(
      asAppRole({ tenant: b.tenantId, outlets: "*" }, (c) =>
        c.query(
          `INSERT INTO ${ITEM_RULES} (id, tenant_id, outlet_id, menu_item_id)
           VALUES ($1, $2, $3, $4)`,
          [newId(), a.tenantId, a.outletId, a.itemId],
        ),
      ),
    );
  });

  it("an item rule cannot point at a menu item or outlet of another tenant", async () => {
    await rejects(insertItemRule(a, a.outletId, null, null, b.itemId));
    await rejects(
      asOwner(
        a.tenantId,
        `INSERT INTO ${RULES} (id, tenant_id, outlet_id) VALUES ($1, $2, $3)`,
        [newId(), a.tenantId, b.outletId],
      ),
    );
  });
});

describe("AI-01 menu recommendation tables: defaults and constraints", () => {
  it("a rules row gets the documented defaults", async () => {
    const w = await makeWorld("rrd");
    await insertRule(w, w.outletId);
    const row = (
      await asOwner(
        w.tenantId,
        `SELECT min_margin_bps, exclude_out_of_stock, max_suggestions, min_pair_support,
                lookback_days, member_history_enabled, enabled
           FROM ${RULES} WHERE outlet_id = $1`,
        [w.outletId],
      )
    ).rows[0];
    expect(row).toEqual({
      min_margin_bps: 2000,
      exclude_out_of_stock: true,
      max_suggestions: 5,
      min_pair_support: 3,
      lookback_days: 90,
      member_history_enabled: true,
      enabled: true,
    });
  });

  it("one rules row per tenant and outlet", async () => {
    await rejects(insertRule(a, a.outletId), /unique|duplicate/i);
  });

  it("one item rule per item and outlet", async () => {
    await rejects(insertItemRule(a, a.outletId, null, null), /unique|duplicate/i);
  });

  for (const [column, bad] of [
    ["min_margin_bps", [-1, 10_001]],
    ["max_suggestions", [0, 21]],
    ["min_pair_support", [0, 1]],
    ["lookback_days", [6, 366]],
  ] as const) {
    it(`${column} refuses out-of-range values`, async () => {
      for (const value of bad) {
        const w = await makeWorld("rrc");
        await rejects(
          asOwner(
            w.tenantId,
            `INSERT INTO ${RULES} (id, tenant_id, outlet_id, ${column}) VALUES ($1, $2, $3, $4)`,
            [newId(), w.tenantId, w.outletId, value],
          ),
          /check|constraint/i,
        );
      }
    });
  }

  it("accepts the boundary values", async () => {
    const w = await makeWorld("rrk");
    await asOwner(
      w.tenantId,
      `INSERT INTO ${RULES} (id, tenant_id, outlet_id, min_margin_bps, max_suggestions, min_pair_support, lookback_days)
       VALUES ($1, $2, $3, 10000, 20, 2, 365)`,
      [newId(), w.tenantId, w.outletId],
    );
    await asOwner(
      w.tenantId,
      `INSERT INTO ${RULES} (id, tenant_id, outlet_id, min_margin_bps, max_suggestions, lookback_days)
       VALUES ($1, $2, $3, 0, 1, 7)`,
      [newId(), w.tenantId, w.outlet2],
    );
  });

  it("an item rule refuses only hour_from", async () => {
    const w = await makeWorld("rrh");
    await rejects(insertItemRule(w, w.outletId, 9, null), /check|constraint/i);
  });

  it("an item rule refuses only hour_to", async () => {
    const w = await makeWorld("rri");
    await rejects(insertItemRule(w, w.outletId, null, 17), /check|constraint/i);
  });

  it("an item rule accepts a midnight-crossing window", async () => {
    const w = await makeWorld("rrj");
    await insertItemRule(w, w.outletId, 22, 2);
  });
});
