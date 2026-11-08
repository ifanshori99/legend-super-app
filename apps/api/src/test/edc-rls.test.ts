// TEN-01/TEN-02 EDC-01: edc_transactions is tenant + outlet owned and forced
// through RLS. Raw checks run as the restricted legend_app role with explicit
// settings; fixtures as the migration owner.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const otherTenant = randomUUID();
const terminalRowId = randomUUID();
const txId = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
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

/** Fixtures as the migration owner with the tenant settings (FORCE RLS). */
async function asOwner(text: string, params: unknown[] = []) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

const insertSql = `INSERT INTO edc_transactions
  (tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
   request_fingerprint, amount_idr, method, status, trace)
  VALUES ($1, $2, $3, 'bca', $4, $5, 'fp', 25000, 'card', 'pending', $6)`;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await asOwner(
    `INSERT INTO payment_edc_terminals
       (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
        connection, supported_methods, status)
     VALUES ($1, $2, $3, 'bca', $4, 'MID-RLS', 'Verifone', 'lan',
             ARRAY['card','qris'], 'active')`,
    [terminalRowId, tenantId, outletA, `TID-${terminalRowId.slice(0, 8)}`],
  );
  await asOwner(
    `INSERT INTO edc_transactions
       (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
        request_fingerprint, amount_idr, method, status, trace)
     VALUES ($1, $2, $3, $4, 'bca', 'REF-RLS-1', 'KEY-RLS-1', 'fp', 25000,
             'card', 'pending', 'TRACERLS0001')`,
    [txId, tenantId, outletA, terminalRowId],
  );
});

afterAll(async () => {
  await owner.end();
});

describe("EDC-01 edc_transactions RLS", () => {
  it("TEN-02 EDC-01 edc_transactions has forced restrictive tenant and outlet policies", async () => {
    const result = await owner.query(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'tenant_isolation' AND NOT p.polpermissive) AS tenant,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'outlet_isolation' AND NOT p.polpermissive) AS outlet
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'edc_transactions'`,
    );
    expect(result.rows).toEqual([
      { enabled: true, forced: true, tenant: true, outlet: true },
    ]);
  });

  it("TEN-01 EDC-01 the owning tenant and outlet see the row", async () => {
    const own = await asAppRole({ tenant: tenantId, outlets: "*" }, (c) =>
      c.query("SELECT id FROM edc_transactions WHERE id = $1", [txId]),
    );
    expect(own.rows).toEqual([{ id: txId }]);
  });

  it("TEN-01 EDC-01 another tenant and another outlet see no rows", async () => {
    const other = await asAppRole({ tenant: otherTenant, outlets: "*" }, (c) =>
      c.query("SELECT id FROM edc_transactions"),
    );
    expect(other.rows).toEqual([]);
    const outletOnlyB = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletB]) },
      (c) => c.query("SELECT id FROM edc_transactions WHERE id = $1", [txId]),
    );
    expect(outletOnlyB.rows).toEqual([]);
  });

  it("TEN-01 EDC-01 cross-tenant and cross-outlet inserts are denied", async () => {
    await expect(
      asAppRole({ tenant: otherTenant, outlets: "*" }, (c) =>
        c.query(insertSql, [
          tenantId,
          outletA,
          terminalRowId,
          "REF-X1",
          "KEY-X1",
          "TRACEX000001",
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asAppRole({ tenant: tenantId, outlets: JSON.stringify([outletB]) }, (c) =>
        c.query(insertSql, [
          tenantId,
          outletA,
          terminalRowId,
          "REF-X2",
          "KEY-X2",
          "TRACEX000002",
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("EDC-03 at most one approved row per reference", async () => {
    await asOwner(
      `UPDATE edc_transactions SET status = 'approved', completed_at = now() WHERE id = $1`,
      [txId],
    );
    await expect(
      asOwner(
        `INSERT INTO edc_transactions
           (tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
            request_fingerprint, amount_idr, method, status, trace, completed_at)
         VALUES ($1, $2, $3, 'bca', 'REF-RLS-1', 'KEY-RLS-2', 'fp', 25000,
                 'card', 'approved', 'TRACERLS0002', now())`,
        [tenantId, outletA, terminalRowId],
      ),
    ).rejects.toThrow(/edc_transactions_approved_reference_key/);
  });

  it("EDC-01 completed_at is set exactly for final statuses", async () => {
    await expect(
      asOwner(`UPDATE edc_transactions SET completed_at = NULL WHERE id = $1`, [
        txId,
      ]),
    ).rejects.toThrow(/edc_transactions_completed_check/);
  });
});
