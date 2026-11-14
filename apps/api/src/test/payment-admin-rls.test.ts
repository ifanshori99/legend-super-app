// TEN-02: all five WS-05 administration tables must be forced through RLS.
import { Pool } from "pg";
import { afterAll, expect, it } from "vitest";

const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

afterAll(async () => pool.end());

it("TEN-02 payment admin tables have forced restrictive tenant policies", async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const names = [
    "payment_admin_idempotency",
    "payment_cashier_defaults",
    "payment_edc_terminals",
    "payment_reconciliation_cases",
    "payment_reconciliation_corrections",
    "payment_refunds",
  ];
  const result = await pool.query<{
    name: string;
    enabled: boolean;
    forced: boolean;
    restrictive: boolean;
  }>(
    `SELECT c.relname AS name, c.relrowsecurity AS enabled,
            c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
              AND p.polname = 'tenant_isolation' AND NOT p.polpermissive) AS restrictive
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
     ORDER BY c.relname`,
    [names],
  );
  expect(result.rows).toEqual(
    names.map((name) => ({
      name,
      enabled: true,
      forced: true,
      restrictive: true,
    })),
  );
});
