// legend-qm4t8 / legend-rudky: kit publication must leave fixed-date payroll
// fixtures free to publish later, regardless of the old random date draw.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { REFERENCE_TER } from "./fixtures/payroll/statutory-tables.ts";
import {
  kitPinnedFrom,
  publishStatutoryTables,
  statutoryIds,
} from "./payroll-simulate-kit.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

it("publishes fixed 2001 and 2002 TER fixtures after kit tables without collisions", async () => {
  const conn = await owner.connect();
  // The old allocator's 480 months starting in 1980 maps 0.55 to 2002-01-01.
  // Force that draw so this is a regression proof, not another probabilistic run.
  const random = vi.spyOn(Math, "random").mockReturnValue(0.55);
  try {
    await conn.query("BEGIN");
    const tenantId = randomUUID();
    await conn.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Payroll kit isolation', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [
        tenantId,
        `payroll-kit-${tenantId}`,
        cafeLegendPlatformFixtures.tenant.id,
      ],
    );
    await conn.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    await publishStatutoryTables(conn, tenantId, "payroll-kit-isolation");

    for (const [index, effectiveFrom] of [
      "2001-01-01",
      "2002-01-01",
    ].entries()) {
      const id = randomUUID();
      await conn.query(
        `INSERT INTO statutory_rates
           (id, tenant_id, type, version, effective_from, status, legal_basis, parameters, created_by)
         VALUES ($1, $2, 'pph21_ter', $3, $4, 'draft', 'Fixed-date payroll test', $5::jsonb, $6)`,
        [
          id,
          tenantId,
          2_000_000_000 + index,
          effectiveFrom,
          JSON.stringify(REFERENCE_TER),
          "payroll-kit-isolation",
        ],
      );
      await conn.query(
        `UPDATE statutory_rates
            SET status = 'published', published_at = now(), published_by = created_by
          WHERE id = $1`,
        [id],
      );
    }

    const tables = await conn.query<{ effective_from: string }>(
      `SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from
         FROM statutory_rates
        WHERE tenant_id = $1 AND type = 'pph21_ter' AND status = 'published'
        ORDER BY effective_from`,
      [tenantId],
    );
    expect(tables.rows.map((row) => row.effective_from)).toEqual(
      [kitPinnedFrom(), "2001-01-01", "2002-01-01"].sort(),
    );
    const kitTables = await conn.query<{ count: string }>(
      "SELECT count(*) FROM statutory_rates WHERE tenant_id = $1 AND id = ANY($2) AND status = 'published'",
      [tenantId, statutoryIds()],
    );
    expect(Number(kitTables.rows[0]?.count)).toBe(statutoryIds().length);
  } finally {
    random.mockRestore();
    await conn.query("ROLLBACK");
    conn.release();
  }
});
