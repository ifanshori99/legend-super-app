import { describe, expect, it } from "vitest";
import { roleTemplate } from "@starter/shared/access";

describe("legend-rog1x supervisor management entry", () => {
  it("grants the supervisor entry permission without granting it to ordinary staff", () => {
    expect(roleTemplate("supervisor").permissions).toContain(
      "dashboard.management.view",
    );
    for (const role of [
      "employee",
      "cashier",
      "waiter",
      "barista_cook",
    ] as const) {
      expect(roleTemplate(role).permissions).not.toContain(
        "dashboard.management.view",
      );
    }
  });
});

it("backfills existing supervisor templates idempotently without changing another role", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { Pool } = await import("pg");
  const { cafeLegendPlatformFixtures } =
    await import("@starter/shared/platform");
  const pool = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 1,
  });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const tenantId = cafeLegendPlatformFixtures.tenant.id;
    const code = "dashboard.management.view";
    await db.query(
      "UPDATE roles SET permissions = permissions - $2 WHERE tenant_id = $1 AND is_template AND template_key = 'supervisor'",
      [tenantId, code],
    );
    const before = await db.query<{ id: string; permissions: string[] }>(
      "SELECT id, permissions FROM roles WHERE tenant_id = $1 AND template_key = 'cashier' AND is_template",
      [tenantId],
    );
    expect(before.rows).toHaveLength(1);
    const migration = readFileSync(
      resolve(import.meta.dirname, "../../drizzle/0406_hris_u4.sql"),
      "utf8",
    );
    const backfill = migration
      .split("--> statement-breakpoint")
      .find((statement) => /UPDATE\s+public\.roles/.test(statement));
    expect(backfill).toBeDefined();
    await db.query(backfill!);
    await db.query(backfill!);
    const supervisor = await db.query<{ permissions: string[] }>(
      "SELECT permissions FROM roles WHERE tenant_id = $1 AND template_key = 'supervisor' AND is_template",
      [tenantId],
    );
    expect(supervisor.rows).toHaveLength(1);
    expect(
      supervisor.rows[0]!.permissions.filter(
        (permission) => permission === code,
      ),
    ).toHaveLength(1);
    const after = await db.query<{ permissions: string[] }>(
      "SELECT permissions FROM roles WHERE id = $1",
      [before.rows[0]!.id],
    );
    expect(after.rows[0]!.permissions).toEqual(before.rows[0]!.permissions);
  } finally {
    await db.query("ROLLBACK");
    db.release();
    await pool.end();
  }
});
