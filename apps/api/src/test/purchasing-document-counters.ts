// Shared test setup (not a test file): lifts a tenant's GR/RT document counters.
import type { Pool } from "pg";

/**
 * Goods receipts and returns are append-only and keep their numbers, but other
 * suites reset the tenant's GR/RT counters when they clean up. A counter that
 * restarted at 1 would reissue a number a surviving document already holds
 * (goods_receipts_tenant_number_key), so lift each counter to the highest
 * number in use before a suite creates documents. Call it from beforeAll.
 */
export async function liftDocumentCounters(
  owner: Pool,
  tenantId: string,
): Promise<void> {
  for (const [kind, table] of [
    ["GR", "goods_receipts"],
    ["RT", "purchase_returns"],
  ] as const)
    await owner.query(
      `INSERT INTO purchasing_document_sequences (tenant_id, kind, period, last_value)
       SELECT tenant_id, $2, split_part(number, '/', 2), max(split_part(number, '/', 3)::int)
         FROM ${table}
        WHERE tenant_id = $1 AND number ~ '^${kind}/[0-9]{6}/[0-9]+$'
        GROUP BY tenant_id, split_part(number, '/', 2)
       ON CONFLICT (tenant_id, kind, period) DO UPDATE
         SET last_value = GREATEST(purchasing_document_sequences.last_value, EXCLUDED.last_value)`,
      [tenantId, kind],
    );
}
