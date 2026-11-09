// WS-11 metrics_daily table (migration 0176; design §2.3): tenant and outlet
// RLS isolation, the unit/value/dimension/finality checks and the NULLS NOT
// DISTINCT key. Raw SQL through a legend_app session, the same pattern as
// src/db/outlet-rls.test.ts.
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const otherTenant = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const definitionId = "11111111-1111-4111-8111-111111111111";
const metricDate = "2026-11-01";

const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

async function inOwnerTx<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
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

/** A raw legend_app session (no BYPASSRLS) with explicit local settings. */
async function asAppRole<T>(
  settings: { tenant?: string; outlets?: string },
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    if (settings.tenant !== undefined)
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        settings.tenant,
      ]);
    if (settings.outlets !== undefined)
      await client.query("SELECT set_config('app.outlet_ids', $1, true)", [
        settings.outlets,
      ]);
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

type Row = {
  outlet?: string;
  date?: string;
  code?: string;
  dimensionKey?: string | null;
  dimensionValue?: string | null;
  unit?: string;
  valueInt?: string | null;
  valueDecimal?: string | null;
  finality?: string;
  version?: number;
};

const insertRow = (client: PoolClient, row: Row = {}) => {
  const unit = row.unit ?? "idr";
  const decimalUnit = unit === "percent" || unit === "decimal";
  return client.query(
    `INSERT INTO metrics_daily
       (tenant_id, outlet_id, metric_date, metric_code, definition_id,
        definition_version, dimension_key, dimension_value, unit, value_int,
        value_decimal, finality, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     RETURNING id`,
    [
      tenantId,
      row.outlet ?? outletA,
      row.date ?? metricDate,
      row.code ?? "sales.net_sales",
      definitionId,
      row.version ?? 1,
      row.dimensionKey ?? null,
      row.dimensionValue ?? null,
      unit,
      row.valueInt === undefined ? (decimalUnit ? null : "100") : row.valueInt,
      row.valueDecimal === undefined
        ? decimalUnit
          ? "12.5"
          : null
        : row.valueDecimal,
      row.finality ?? "estimate",
    ],
  );
};

/** Runs an insert that must fail, inside a savepoint so the tx stays usable. */
async function expectCheckViolation(row: Row, constraint: string) {
  await inOwnerTx(async (client) => {
    await client.query("SAVEPOINT attempt");
    await expect(insertRow(client, row)).rejects.toMatchObject({
      code: "23514",
      constraint,
    });
    await client.query("ROLLBACK TO SAVEPOINT attempt");
  });
}

describe("metrics_daily schema (WS-11 migration 0176)", () => {
  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    await inOwnerTx((client) =>
      client.query("DELETE FROM metrics_daily WHERE definition_id = $1", [
        definitionId,
      ]),
    );
  });

  afterAll(async () => {
    await inOwnerTx((client) =>
      client.query("DELETE FROM metrics_daily WHERE definition_id = $1", [
        definitionId,
      ]),
    );
    await ownerPool.end();
  });

  it("forces RLS with the restrictive tenant and outlet policies", async () => {
    const result = await ownerPool.query<{ name: string; permissive: boolean }>(
      `SELECT p.polname AS name, p.polpermissive AS permissive
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relname = 'metrics_daily' AND c.relrowsecurity AND c.relforcerowsecurity
         AND NOT p.polpermissive
       ORDER BY 1`,
    );
    expect(result.rows).toEqual([
      { name: "outlet_isolation", permissive: false },
      { name: "tenant_isolation", permissive: false },
    ]);
  });

  describe("RLS isolation", () => {
    let idA = "";
    let idB = "";

    beforeAll(async () => {
      await inOwnerTx(async (client) => {
        idA = (await insertRow(client, { outlet: outletA })).rows[0].id;
        idB = (await insertRow(client, { outlet: outletB })).rows[0].id;
      });
    });

    const selectBoth = (client: PoolClient) =>
      client.query<{ id: string }>(
        "SELECT id FROM metrics_daily WHERE id = ANY($1::uuid[]) ORDER BY outlet_id",
        [[idA, idB]],
      );

    it("fails closed without tenant context", async () => {
      await expect(asAppRole({}, selectBoth)).rejects.toThrow();
    });

    it("hides tenant A rows from tenant B", async () => {
      const rows = await asAppRole(
        { tenant: otherTenant, outlets: "*" },
        selectBoth,
      );
      expect(rows.rows).toEqual([]);
    });

    it("rejects a cross-tenant insert", async () => {
      await asAppRole({ tenant: otherTenant, outlets: "*" }, async (client) => {
        await expect(insertRow(client)).rejects.toMatchObject({
          code: "42501",
        });
      });
    });

    it("an outlet-scoped session sees only its own outlet", async () => {
      const rows = await asAppRole(
        { tenant: tenantId, outlets: JSON.stringify([outletA]) },
        selectBoth,
      );
      expect(rows.rows.map((row) => row.id)).toEqual([idA]);
    });

    it("an outlet-scoped session cannot write another outlet", async () => {
      await asAppRole(
        { tenant: tenantId, outlets: JSON.stringify([outletA]) },
        async (client) => {
          const updated = await client.query(
            "UPDATE metrics_daily SET value_int = 1 WHERE id = $1",
            [idB],
          );
          expect(updated.rowCount).toBe(0);
          const deleted = await client.query(
            "DELETE FROM metrics_daily WHERE id = $1",
            [idB],
          );
          expect(deleted.rowCount).toBe(0);
          await expect(
            insertRow(client, { outlet: outletB, code: "sales.other" }),
          ).rejects.toMatchObject({ code: "42501" });
        },
      );
    });

    it("the tenant-wide scope reads every outlet", async () => {
      const rows = await asAppRole(
        { tenant: tenantId, outlets: "*" },
        selectBoth,
      );
      expect(rows.rows.map((row) => row.id).sort()).toEqual([idA, idB].sort());
    });
  });

  describe("CHECK constraints", () => {
    it("accepts a valid integer and a valid decimal row", async () => {
      await inOwnerTx(async (client) => {
        await insertRow(client, { code: "ok.count", unit: "count" });
        await insertRow(client, { code: "ok.seconds", unit: "seconds" });
        await insertRow(client, { code: "ok.percent", unit: "percent" });
        await insertRow(client, { code: "ok.decimal", unit: "decimal" });
        await insertRow(client, {
          code: "ok.dim",
          dimensionKey: "channel",
          dimensionValue: "dine_in",
        });
        const count = await client.query(
          "SELECT count(*)::int AS n FROM metrics_daily WHERE definition_id = $1 AND metric_code LIKE 'ok.%'",
          [definitionId],
        );
        expect(count.rows[0].n).toBe(5);
        await client.query(
          "DELETE FROM metrics_daily WHERE definition_id = $1",
          [definitionId],
        );
      });
    });

    it("rejects an unknown unit", async () => {
      await expectCheckViolation(
        { unit: "bps", valueInt: "1" },
        "metrics_daily_unit_check",
      );
    });

    it("rejects idr/count/seconds with no value_int or with value_decimal", async () => {
      await expectCheckViolation(
        { unit: "idr", valueInt: null },
        "metrics_daily_value_check",
      );
      await expectCheckViolation(
        { unit: "count", valueInt: "1", valueDecimal: "1" },
        "metrics_daily_value_check",
      );
    });

    it("rejects percent/decimal with no value_decimal or with value_int", async () => {
      await expectCheckViolation(
        { unit: "percent", valueDecimal: null },
        "metrics_daily_value_check",
      );
      await expectCheckViolation(
        { unit: "decimal", valueDecimal: "1", valueInt: "1" },
        "metrics_daily_value_check",
      );
    });

    it("rejects a dimension_key without dimension_value and the reverse", async () => {
      await expectCheckViolation(
        { dimensionKey: "channel", dimensionValue: null },
        "metrics_daily_dimension_pair_check",
      );
      await expectCheckViolation(
        { dimensionKey: null, dimensionValue: "dine_in" },
        "metrics_daily_dimension_pair_check",
      );
    });

    it("rejects dimension_key 'outlet'", async () => {
      await expectCheckViolation(
        { dimensionKey: "outlet", dimensionValue: outletA },
        "metrics_daily_dimension_key_check",
      );
    });

    it("rejects a bad finality and a non-positive definition version", async () => {
      await expectCheckViolation(
        { finality: "draft" },
        "metrics_daily_finality_check",
      );
      await expectCheckViolation(
        { version: 0 },
        "metrics_daily_definition_version_check",
      );
    });
  });

  describe("metrics_daily_key (UNIQUE NULLS NOT DISTINCT)", () => {
    it("rejects a duplicate total row (both dimension columns NULL)", async () => {
      await inOwnerTx(async (client) => {
        await insertRow(client, { code: "dup.total" });
        await client.query("SAVEPOINT attempt");
        await expect(
          insertRow(client, { code: "dup.total" }),
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "metrics_daily_key",
        });
        await client.query("ROLLBACK TO SAVEPOINT attempt");
        await client.query(
          "DELETE FROM metrics_daily WHERE definition_id = $1",
          [definitionId],
        );
      });
    });

    it("rejects a duplicate dimension row and accepts a different value", async () => {
      await inOwnerTx(async (client) => {
        const dim = { code: "dup.dim", dimensionKey: "channel" };
        await insertRow(client, { ...dim, dimensionValue: "dine_in" });
        await insertRow(client, { ...dim, dimensionValue: "takeaway" });
        await client.query("SAVEPOINT attempt");
        await expect(
          insertRow(client, { ...dim, dimensionValue: "dine_in" }),
        ).rejects.toMatchObject({
          code: "23505",
          constraint: "metrics_daily_key",
        });
        await client.query("ROLLBACK TO SAVEPOINT attempt");
        await client.query(
          "DELETE FROM metrics_daily WHERE definition_id = $1",
          [definitionId],
        );
      });
    });

    it("accepts the same code on another outlet or date", async () => {
      await inOwnerTx(async (client) => {
        await insertRow(client, { code: "dup.scope" });
        await insertRow(client, { code: "dup.scope", outlet: outletB });
        await insertRow(client, { code: "dup.scope", date: "2026-11-02" });
        await client.query(
          "DELETE FROM metrics_daily WHERE definition_id = $1",
          [definitionId],
        );
      });
    });
  });
});
