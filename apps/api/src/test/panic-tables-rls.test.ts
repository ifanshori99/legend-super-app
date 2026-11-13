// Emergency button tables (legend-bod, design docs/design/edge-emergency.md
// D-08, D-10; part E3 of the test brief). Fail-first: none of the four tables
// exists on milestone/m1, so the table-existence assertions are the red
// reason. Written from the design, not from the implementation.
//
// Covered per table (panic_alerts, panic_press_events,
// panic_receiver_sessions, panic_alert_deliveries):
//   - the table exists, tenant_id and outlet_id are NOT NULL
//   - FORCED RLS with restrictive tenant_isolation and outlet_isolation
//   - a row is visible to its tenant+outlet only (other tenant / other outlet
//     read 0 rows, cross-tenant insert is denied)
// Covered for panic_alerts only (D-08 trigger): DELETE refused, identity /
// snapshot / received_at columns immutable, acknowledged_* and resolved_*
// set once, press_count and delivered_count stay writable.
//
// ASSUMPTIONS (the design fixes the table names and the columns named below,
// not every other column):
// - Rows are built generically: every NOT NULL column without a default that
//   this file does not set explicitly gets a dummy value picked from the
//   column's data_type (information_schema), so a column the design does not
//   name does not break the fixture. CHECK-constrained text columns are set
//   explicitly: kind = 'press', origin = 'edge'.
// - Fixture rows are inserted with session_replication_role = replica (foreign
//   keys and the immutability trigger are skipped for the INSERT only), as the
//   other edge tests do for fixtures. Behavior checks run with triggers ON.
// - The allowlists in db/rls.test.ts and db/outlet-rls.test.ts list EXCEPTIONS
//   and are NOT edited: the new tables must not appear there. The last test
//   below proves it from the catalogue, independent of those files.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const otherTenant = randomUUID();

const TABLES = [
  "panic_alerts",
  "panic_press_events",
  "panic_receiver_sessions",
  "panic_alert_deliveries",
] as const;
type PanicTable = (typeof TABLES)[number];

/** Explicit values where a CHECK or the design fixes the vocabulary. */
const EXPLICIT: Record<string, unknown> = {
  kind: "press",
  origin: "edge",
};

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

type ColumnInfo = {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
};

async function tableExists(table: string): Promise<boolean> {
  const { rows } = await owner.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind = 'r'`,
    [table],
  );
  return rows.length === 1;
}

async function columnsOf(table: string): Promise<ColumnInfo[]> {
  const { rows } = await owner.query<ColumnInfo>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return rows;
}

function dummyValue(column: ColumnInfo, variant: string): unknown {
  switch (column.data_type) {
    case "uuid":
      return randomUUID();
    case "bytea":
      return randomBytes(32);
    case "boolean":
      return false;
    case "integer":
    case "bigint":
    case "smallint":
    case "numeric":
      return 1;
    case "timestamp with time zone":
    case "timestamp without time zone":
      return new Date(Date.now() - 3_600_000);
    case "jsonb":
    case "json":
      return "{}";
    default:
      return `${variant}-${randomBytes(3).toString("hex")}`;
  }
}

/** Inserts one row (as the migration owner, FK and triggers skipped). */
async function insertRow(
  table: PanicTable,
  where: { tenant: string; outlet: string },
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (!(await tableExists(table)))
    throw new Error(`Table ${table} does not exist yet`);
  const columns = await columnsOf(table);
  const values: Record<string, unknown> = {};
  for (const column of columns) {
    const name = column.column_name;
    if (name === "tenant_id") values[name] = where.tenant;
    else if (name === "outlet_id") values[name] = where.outlet;
    else if (name in overrides) values[name] = overrides[name];
    else if (name === "id") values[name] = randomUUID();
    else if (name in EXPLICIT) values[name] = EXPLICIT[name];
    else if (column.is_nullable === "NO" && column.column_default === null)
      values[name] = dummyValue(column, name);
  }
  const names = Object.keys(values);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [where.tenant],
    );
    await client.query(
      `INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(", ")})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => values[n]),
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return values;
}

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

/** The alert row used by the trigger tests: a stable id + received_at. */
const alertRow: Record<string, unknown> = {};
const seeded: Partial<Record<PanicTable, Record<string, unknown>>> = {};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  for (const table of TABLES) {
    if (await tableExists(table))
      seeded[table] = await insertRow(table, {
        tenant: tenantId,
        outlet: outletA,
      });
  }
  if (seeded.panic_alerts) Object.assign(alertRow, seeded.panic_alerts);
});

afterAll(async () => {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of TABLES) {
      if (await tableExists(table))
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          tenantId,
        ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

describe.each(TABLES)("EM-04 %s tenant and outlet isolation", (table) => {
  it(`EM-04 ${table} exists with tenant_id and outlet_id NOT NULL`, async () => {
    expect(await tableExists(table), `${table} must exist`).toBe(true);
    const columns = await columnsOf(table);
    const byName = new Map(columns.map((c) => [c.column_name, c]));
    expect(byName.get("tenant_id")?.is_nullable).toBe("NO");
    expect(byName.get("outlet_id")?.is_nullable).toBe("NO");
  });

  it(`EM-04 ${table} has forced restrictive tenant and outlet policies`, async () => {
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
    expect(result.rows).toEqual([
      { enabled: true, forced: true, tenant: true, outlet: true },
    ]);
  });

  it(`EM-04 ${table} the owning tenant and outlet see the row`, async () => {
    expect(await tableExists(table), `${table} must exist`).toBe(true);
    const own = await asAppRole({ tenant: tenantId, outlets: "*" }, (c) =>
      c.query(`SELECT 1 FROM ${table} WHERE outlet_id = $1`, [outletA]),
    );
    expect(own.rows).toHaveLength(1);
    const ownOutletOnly = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletA]) },
      (c) => c.query(`SELECT 1 FROM ${table} WHERE outlet_id = $1`, [outletA]),
    );
    expect(ownOutletOnly.rows).toHaveLength(1);
  });

  it(`EM-04 ${table} another tenant and another outlet read 0 rows`, async () => {
    expect(await tableExists(table), `${table} must exist`).toBe(true);
    const otherTenantRows = await asAppRole(
      { tenant: otherTenant, outlets: "*" },
      (c) => c.query(`SELECT 1 FROM ${table}`),
    );
    expect(otherTenantRows.rows).toEqual([]);
    const outletOnlyB = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletB]) },
      (c) => c.query(`SELECT 1 FROM ${table} WHERE outlet_id = $1`, [outletA]),
    );
    expect(outletOnlyB.rows).toEqual([]);
  });

  it(`EM-04 ${table} cross-tenant and cross-outlet inserts are denied`, async () => {
    expect(await tableExists(table), `${table} must exist`).toBe(true);
    const columns = await columnsOf(table);
    const build = (where: { tenant: string; outlet: string }) => {
      const values: Record<string, unknown> = {};
      for (const column of columns) {
        const name = column.column_name;
        if (name === "tenant_id") values[name] = where.tenant;
        else if (name === "outlet_id") values[name] = where.outlet;
        else if (name in EXPLICIT) values[name] = EXPLICIT[name];
        else if (column.is_nullable === "NO" && column.column_default === null)
          values[name] = dummyValue(column, name);
      }
      return values;
    };
    const insert = (c: PoolClient, values: Record<string, unknown>) => {
      const names = Object.keys(values);
      return c.query(
        `INSERT INTO ${table} (${names.map((n) => `"${n}"`).join(", ")})
         VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
        names.map((n) => values[n]),
      );
    };
    await expect(
      asAppRole({ tenant: otherTenant, outlets: "*" }, (c) =>
        insert(c, build({ tenant: tenantId, outlet: outletA })),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asAppRole({ tenant: tenantId, outlets: JSON.stringify([outletB]) }, (c) =>
        insert(c, build({ tenant: tenantId, outlet: outletA })),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("EM-04 panic tables are never allowlisted", () => {
  it("EM-04 every public table named panic_% with a tenant_id has forced RLS, and exactly the four design tables exist", async () => {
    const { rows } = await owner.query<{ name: string; forced: boolean }>(
      `SELECT c.relname AS name, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'panic\\_%'
        ORDER BY c.relname`,
    );
    expect(rows.map((r) => r.name)).toEqual([...TABLES].sort());
    expect(rows.filter((r) => !r.forced)).toEqual([]);
  });
});

describe("EM-04 panic_alerts immutability trigger (D-08)", () => {
  const IMMUTABLE = [
    "id",
    "outlet_id",
    "device_id",
    "unit_id",
    "first_device_event_id",
    "unit_code_snapshot",
    "facility_name_snapshot",
    "device_label_snapshot",
    "kind",
    "triggered_at",
    "received_at",
    "origin",
  ] as const;

  async function currentRow() {
    const { rows } = await owner.query(
      "SELECT * FROM panic_alerts WHERE tenant_id = $1 AND id = $2",
      [tenantId, alertRow.id],
    );
    return rows[0] as Record<string, unknown> | undefined;
  }

  async function updateAsOwner(sql: string, params: unknown[]) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      const result = await client.query(sql, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("EM-04 panic_alerts DELETE is refused and the row stays", async () => {
    expect(await tableExists("panic_alerts"), "panic_alerts must exist").toBe(
      true,
    );
    expect(await currentRow()).toBeDefined();
    await expect(
      updateAsOwner("DELETE FROM panic_alerts WHERE tenant_id = $1", [
        tenantId,
      ]),
    ).rejects.toThrow();
    expect(await currentRow()).toBeDefined();
  });

  it("EM-04 panic_alerts DELETE through the application role is refused too", async () => {
    expect(await tableExists("panic_alerts"), "panic_alerts must exist").toBe(
      true,
    );
    await expect(
      asAppRole({ tenant: tenantId, outlets: "*" }, (c) =>
        c.query("DELETE FROM panic_alerts WHERE id = $1", [alertRow.id]),
      ),
    ).rejects.toThrow();
    expect(await currentRow()).toBeDefined();
  });

  for (const name of IMMUTABLE) {
    it(`EM-04 panic_alerts.${name} cannot be changed after insert`, async () => {
      expect(await tableExists("panic_alerts"), "panic_alerts must exist").toBe(
        true,
      );
      const columns = await columnsOf("panic_alerts");
      const column = columns.find((c) => c.column_name === name);
      // The design names this column: a missing one is a red test.
      expect(column, `panic_alerts.${name} must exist`).toBeDefined();
      const before = await currentRow();
      expect(before).toBeDefined();
      const next =
        name in EXPLICIT
          ? name === "kind"
            ? "test"
            : "cloud"
          : column!.data_type.startsWith("timestamp")
            ? new Date(Date.now() - 7_200_000)
            : dummyValue(column!, `changed-${name}`);
      await expect(
        updateAsOwner(
          `UPDATE panic_alerts SET "${name}" = $1 WHERE tenant_id = $2 AND id = $3`,
          [next, tenantId, alertRow.id],
        ),
      ).rejects.toThrow();
      expect((await currentRow())?.[name]).toEqual(before![name]);
    });
  }

  it("EM-04 press_count and delivered_count stay writable", async () => {
    expect(await tableExists("panic_alerts"), "panic_alerts must exist").toBe(
      true,
    );
    await updateAsOwner(
      `UPDATE panic_alerts SET press_count = 3, delivered_count = 2
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, alertRow.id],
    );
    const row = await currentRow();
    expect(row?.press_count).toBe(3);
    expect(row?.delivered_count).toBe(2);
  });

  it("EM-04 acknowledged_* is set once: first write works, a different second write is refused", async () => {
    expect(await tableExists("panic_alerts"), "panic_alerts must exist").toBe(
      true,
    );
    const columns = await columnsOf("panic_alerts");
    const ackDevice = columns.find((c) => c.column_name === "ack_device_id");
    expect(ackDevice, "panic_alerts.ack_device_id must exist").toBeDefined();
    const staff = `staff-${randomBytes(3).toString("hex")}`;
    const device = randomUUID();
    await updateAsOwner(
      `UPDATE panic_alerts SET acknowledged_at = now(), acknowledged_by = $3, ack_device_id = $4
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, alertRow.id, staff, device],
    );
    const first = await currentRow();
    expect(first?.acknowledged_by).toBe(staff);
    await expect(
      updateAsOwner(
        `UPDATE panic_alerts SET acknowledged_by = $3 WHERE tenant_id = $1 AND id = $2`,
        [tenantId, alertRow.id, `other-${randomBytes(3).toString("hex")}`],
      ),
    ).rejects.toThrow();
    await expect(
      updateAsOwner(
        `UPDATE panic_alerts SET acknowledged_at = now() + interval '1 hour' WHERE tenant_id = $1 AND id = $2`,
        [tenantId, alertRow.id],
      ),
    ).rejects.toThrow();
    const after = await currentRow();
    expect(after?.acknowledged_by).toBe(staff);
    expect(after?.acknowledged_at).toEqual(first?.acknowledged_at);
  });

  it("EM-04 resolved_* is set once: first write works, a different second write is refused", async () => {
    expect(await tableExists("panic_alerts"), "panic_alerts must exist").toBe(
      true,
    );
    const manager = `manager-${randomBytes(3).toString("hex")}`;
    await updateAsOwner(
      `UPDATE panic_alerts
          SET resolved_at = now(), resolved_by = $3, resolution_note = 'Aman, tamu sudah dibantu'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, alertRow.id, manager],
    );
    expect((await currentRow())?.resolved_by).toBe(manager);
    await expect(
      updateAsOwner(
        `UPDATE panic_alerts SET resolution_note = 'diubah' WHERE tenant_id = $1 AND id = $2`,
        [tenantId, alertRow.id],
      ),
    ).rejects.toThrow();
    expect((await currentRow())?.resolution_note).toBe(
      "Aman, tamu sudah dibantu",
    );
  });

  it("EM-04 resolution_note is capped at 500 characters", async () => {
    expect(await tableExists("panic_alerts"), "panic_alerts must exist").toBe(
      true,
    );
    const other = await insertRow("panic_alerts", {
      tenant: tenantId,
      outlet: outletA,
    });
    await expect(
      updateAsOwner(
        `UPDATE panic_alerts SET resolved_at = now(), resolved_by = 'm1', resolution_note = $3
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, other.id, "x".repeat(501)],
      ),
    ).rejects.toThrow();
  });
});
