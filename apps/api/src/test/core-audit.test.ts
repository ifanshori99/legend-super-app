import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { cafeLegendAuditFixtures } from "@starter/shared/audit";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { recordAudit } from "../services/core-audit";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const db = drizzle(pool, { schema });
const tenantA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tenantB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const context = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
const event = {
  ...cafeLegendAuditFixtures[0],
  tenantId: tenantA,
  outletId: null,
};
/** Drizzle wraps the PostgreSQL error; assert on the database's own message. */
async function rejectsWith(run: Promise<unknown>, pattern: RegExp) {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  const cause = (error as Error & { cause?: unknown }).cause;
  expect(cause instanceof Error ? cause.message : String(error)).toMatch(
    pattern,
  );
}
afterAll(async () => {
  await pool.end();
});

describe("audit log", () => {
  it("TEN-01 TEN-02 isolates audit records and rejects a mismatched tenant", async () => {
    await withTenant(db, context(tenantA), (tx) =>
      recordAudit(tx, context(tenantA), event),
    );
    await withTenant(db, context(tenantB), async (tx) => {
      expect(
        (await tx.execute(sql`SELECT * FROM audit_logs`)).rows,
      ).toHaveLength(0);
      await expect(recordAudit(tx, context(tenantB), event)).rejects.toThrow();
    });
  });
  it("PRD §6 audit records are append-only", async () => {
    // A real column, so the rejection comes from the guard, not a bad query.
    await rejectsWith(
      withTenant(db, context(tenantA), async (tx) => {
        await tx.execute(
          sql`UPDATE audit_logs SET retention_class = 'audit_2y'`,
        );
      }),
      /permission denied/,
    );
    await rejectsWith(
      withTenant(db, context(tenantA), async (tx) => {
        await tx.execute(sql`DELETE FROM audit_logs`);
      }),
      /permission denied/,
    );
    // The table owner is still blocked from rewriting recent history.
    const owner = new Pool({
      connectionString: process.env.MIGRATION_DATABASE_URL,
    });
    try {
      await expect(
        owner.query(
          "UPDATE audit_logs SET retention_class = 'audit_2y' WHERE tenant_id = $1",
          [tenantA],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        owner.query("DELETE FROM audit_logs WHERE tenant_id = $1", [tenantA]),
      ).rejects.toThrow(/append-only/);
    } finally {
      await owner.end();
    }
  });
  it("PRD §4 rejects unmasked changes and sensitive access without a reason", async () => {
    await expect(
      withTenant(db, context(tenantA), (tx) =>
        recordAudit(tx, context(tenantA), {
          ...event,
          maskedChanges: { before: null, after: { password: "secret" } },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(db, context(tenantA), (tx) =>
        recordAudit(tx, context(tenantA), {
          ...event,
          sensitiveAccess: true,
          reason: null,
        }),
      ),
    ).rejects.toThrow();
  });
  it("PRD §3 retention cannot be shortened by backdating a new row", async () => {
    await withTenant(db, context(tenantA), async (tx) => {
      const result = await tx.execute(
        sql`INSERT INTO audit_logs (tenant_id, id, outlet_id, event, retention_class, created_at) VALUES (${tenantA}::uuid, gen_random_uuid(), NULL, ${JSON.stringify(event)}::jsonb, 'audit_2y', '2000-01-01'::timestamptz) RETURNING created_at`,
      );
      expect(
        new Date(String(result.rows[0]?.created_at)).getTime(),
      ).toBeGreaterThan(Date.now() - 60000);
    });
  });
  it("TEN-03 rejects audit records outside the caller outlet scope", async () => {
    const scoped = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenantA),
        brandId: null,
        source: "domain",
      }),
      {
        kind: "outlets",
        outletIds: [
          outletIdSchema.parse("11111111-1111-4111-8111-111111111111"),
        ],
      },
    );
    await expect(
      withTenant(db, scoped, (tx) => recordAudit(tx, scoped, event)),
    ).rejects.toThrow();
  });
  it("PRD §3 retention hook denies application callers and keeps recent rows", async () => {
    await expect(
      withTenant(db, context(tenantA), (tx) =>
        tx.execute(sql`SELECT app.purge_expired_audit_logs(${tenantA}::uuid)`),
      ),
    ).rejects.toThrow();
    const owner = new Pool({
      connectionString: process.env.MIGRATION_DATABASE_URL,
    });
    try {
      const result = await owner.query(
        "SELECT app.purge_expired_audit_logs($1::uuid) AS count",
        [tenantA],
      );
      expect(Number(result.rows[0].count)).toBe(0);
    } finally {
      await owner.end();
    }
  });
});
