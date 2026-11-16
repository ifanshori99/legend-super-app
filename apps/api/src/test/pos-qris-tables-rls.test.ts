// Tenant isolation of the tables that legend-yhia9 adds (design qris.md §5,
// migrations 0368 + 0370): pos_qris_holds and the three customer display
// tables. Each must exist, force RLS with restrictive tenant_isolation and
// outlet_isolation policies, and show nothing to another tenant or outlet.
// The shared allowlist tests (db/rls.test.ts, db/outlet-rls.test.ts) are NOT
// touched: new tables must not be allowlisted. Pattern: edc-rls.test.ts.
// QH-02 here covers only the catalog side of the one-active-hold index; the
// behavior of triggers (QH-20) and concurrent inserts (QH-02 race) live in
// pos-qris-hold.test.ts.
//
// Assumption (design §5): all four tables carry `outlet_id`, so all four get
// `outlet_isolation` besides `tenant_isolation`.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { owner } from "./floor-test-helpers.ts";
import { asCashierTenant } from "./pos-cashier-test-helpers.ts";
import { registerTestDevice } from "./device-seed.ts";
import {
  holdFixture,
  issueQris,
  newSubmittedOrder,
  readHold,
  resetHoldPorts,
} from "./pos-qris-hold-test-helpers.ts";

const seeded = cafeLegendFixtures;
const seededTenantId = seeded.tenant.id;
const seededOutletId = seeded.outlets[0].id;

afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

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

async function catalog(table: string) {
  const result = await owner.query(
    `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
              AND p.polname = 'tenant_isolation' AND NOT p.polpermissive) AS tenant,
            EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
              AND p.polname = 'outlet_isolation' AND NOT p.polpermissive) AS outlet
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    [table],
  );
  return result.rows;
}

/** Insert one row naming only the columns the design lists; any other NOT
 * NULL column without a default gets a neutral value, so a small difference
 * in the final schema does not turn the isolation proof into a setup error. */
async function seedRow(
  tenantId: string,
  table: string,
  known: Record<string, unknown>,
) {
  await asCashierTenant(tenantId, async (client) => {
    const columns = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`,
      [table],
    );
    expect(
      columns.rows,
      `table public.${table} is missing (migration 0370 not applied)`,
    ).not.toHaveLength(0);
    const values: Record<string, unknown> = {};
    for (const column of columns.rows) {
      if (column.column_name in known)
        values[column.column_name] = known[column.column_name];
      else if (column.is_nullable === "NO" && column.column_default === null)
        values[column.column_name] = filler(column.data_type);
    }
    const names = Object.keys(values);
    await client.query(
      `INSERT INTO ${table} (${names.join(", ")})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => values[n]),
    );
  });
}

function filler(dataType: string): unknown {
  switch (dataType) {
    case "uuid":
      return randomUUID();
    case "bytea":
      return randomBytes(32);
    case "timestamp with time zone":
      return new Date();
    case "bigint":
    case "integer":
    case "smallint":
      return 0;
    case "boolean":
      return false;
    case "jsonb":
    case "json":
      return "{}";
    default:
      return randomUUID().slice(0, 12);
  }
}

async function seedDisplayDevice(label: string) {
  const deviceId = randomUUID();
  await registerTestDevice(owner, {
    tenantId: seededTenantId,
    outletId: seededOutletId,
    deviceId,
    label,
  });
  return deviceId;
}

const displaySeeds: Record<string, () => Promise<void>> = {
  customer_display_pairing_codes: async () => {
    await seedRow(seededTenantId, "customer_display_pairing_codes", {
      tenant_id: seededTenantId,
      id: randomUUID(),
      outlet_id: seededOutletId,
      display_device_id: await seedDisplayDevice("Layar RLS 1"),
      code_hash: randomBytes(32),
      expires_at: new Date(Date.now() + 5 * 60_000),
      consumed_at: null,
      created_at: new Date(),
    });
  },
  customer_display_pairings: async () => {
    await seedRow(seededTenantId, "customer_display_pairings", {
      tenant_id: seededTenantId,
      id: randomUUID(),
      outlet_id: seededOutletId,
      terminal_device_id: await seedDisplayDevice("Kasir RLS 2"),
      display_device_id: await seedDisplayDevice("Layar RLS 2"),
      status: "active",
      paired_at: new Date(),
      paired_by: randomUUID(),
    });
  },
  customer_display_sessions: async () => {
    await seedRow(seededTenantId, "customer_display_sessions", {
      tenant_id: seededTenantId,
      terminal_device_id: await seedDisplayDevice("Kasir RLS 3"),
      outlet_id: seededOutletId,
      selected_order_id: null,
      version: 0,
      updated_at: new Date(),
    });
  },
};

/** pos_qris_holds is seeded through the real flow: a submitted bill and a
 * QRIS tender (which must open the hold, D-01). */
let holdSeed: Promise<{ tenantId: string; outletId: string }> | null = null;
function seedHold() {
  holdSeed ??= (async () => {
    const fx = await holdFixture("qris-rls");
    const order = await newSubmittedOrder(fx, 0);
    await issueQris(fx, order.id);
    const hold = await readHold(fx, order.id);
    expect(hold, "issuing a QRIS tender must create a hold row").not.toBeNull();
    return { tenantId: fx.tenant.tenantId, outletId: fx.tenant.outletId };
  })();
  return holdSeed;
}

async function visibility(
  table: string,
  own: { tenantId: string; outletId: string },
) {
  const count = (client: PoolClient) =>
    client
      .query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)
      .then((r) => r.rows[0]!.n);
  return {
    ownTenant: await asAppRole({ tenant: own.tenantId, outlets: "*" }, count),
    otherTenant: await asAppRole({ tenant: randomUUID(), outlets: "*" }, count),
    otherOutlet: await asAppRole(
      { tenant: own.tenantId, outlets: JSON.stringify([randomUUID()]) },
      count,
    ),
  };
}

const TABLES = [
  "pos_qris_holds",
  "customer_display_pairing_codes",
  "customer_display_pairings",
  "customer_display_sessions",
] as const;

describe("legend-yhia9 new tables: existence and forced RLS (TEN-01/TEN-02)", () => {
  for (const table of TABLES)
    it(`TEN-02 ${table} exists with forced restrictive tenant and outlet policies`, async () => {
      expect(
        await catalog(table),
        `table public.${table} is missing or its RLS is not forced with restrictive tenant_isolation + outlet_isolation`,
      ).toEqual([{ enabled: true, forced: true, tenant: true, outlet: true }]);
    });
});

describe("legend-yhia9 new tables: cross-tenant and cross-outlet reads", () => {
  it("TEN-01 pos_qris_holds: the owner sees its hold, another tenant and another outlet see 0 rows", async () => {
    const own = await seedHold();
    expect(await visibility("pos_qris_holds", own)).toEqual({
      ownTenant: 1,
      otherTenant: 0,
      otherOutlet: 0,
    });
  });

  for (const [table, seed] of Object.entries(displaySeeds))
    it(`TEN-01 ${table}: the owner sees its row, another tenant and another outlet see 0 rows`, async () => {
      await seed();
      expect(
        await visibility(table, {
          tenantId: seededTenantId,
          outletId: seededOutletId,
        }),
      ).toEqual({ ownTenant: 1, otherTenant: 0, otherOutlet: 0 });
    });
});

describe("QH-02 pos_qris_holds catalog: one active hold per bill, state is closed-set", () => {
  it("QH-02 has a partial UNIQUE index on (tenant_id, order_id) for the open and cancelling states only", async () => {
    const { rows } = await owner.query<{
      columns: string[];
      predicate: string | null;
    }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns,
              pg_get_expr(i.indpred, i.indrelid) AS predicate
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE n.nspname = 'public' AND c.relname = 'pos_qris_holds'
          AND i.indisunique AND i.indpred IS NOT NULL
        GROUP BY i.indexrelid, i.indpred, i.indrelid`,
    );
    const active = rows.filter(
      (row) =>
        row.columns.join(",") === "tenant_id,order_id" &&
        /open/.test(row.predicate ?? "") &&
        /cancelling/.test(row.predicate ?? "") &&
        !/'paid'|'closed'/.test(row.predicate ?? ""),
    );
    expect(
      active,
      `pos_qris_holds needs UNIQUE (tenant_id, order_id) WHERE state IN ('open','cancelling'); found ${JSON.stringify(rows)}`,
    ).toHaveLength(1);
  });

  it("QH-02 state is restricted to open, cancelling, paid and closed by a CHECK", async () => {
    const { rows } = await owner.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'pos_qris_holds'
          AND con.contype = 'c'`,
    );
    const stateChecks = rows.filter((row) => /state/.test(row.definition));
    expect(
      stateChecks,
      "pos_qris_holds has no CHECK on state",
    ).not.toHaveLength(0);
    const text = stateChecks.map((row) => row.definition).join(" ");
    for (const state of ["open", "cancelling", "paid", "closed"])
      expect(text).toContain(`'${state}'`);
  });
});
