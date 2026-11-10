// Guard for the provisioning-default overwrite (bead legend-z1qk8). The import
// may replace default tax settings / the SC-DINE-IN rule in place only while the
// tenant has not started trading: no transaction and no registered edge device.
// Afterwards a silent change would alter money already computed or synced to
// edge devices, so the owner must change it by hand.
import { sql } from "drizzle-orm";
import type { ConfigTx } from "./tenant-config-types.ts";

// Transaction tables (all carry tenant_id).
const TRANSACTION_TABLES = [
  "pos_orders",
  "orders",
  "tax_snapshots",
  "payment_intents",
  "payment_refunds",
  "cash_movements",
  "pos_shifts",
  "pos_receipts",
  "edc_transactions",
  // A platform order is ingested without a pos_orders row.
  "delivery_channel_orders",
  "pos_daily_closes",
] as const;
// Registered edge nodes and devices, any status: a revoked one still ran.
const EDGE_TABLES = ["edge_nodes", "devices"] as const;

export const TRADING_GUARD_HINT = "ubah manual di Pengaturan";

const existsIn = (table: string, tenantId: string) =>
  sql`EXISTS (SELECT 1 FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId})`;

/** True when the tenant has a transaction or a registered edge node/device. */
export async function tenantHasStartedTrading(
  tx: ConfigTx,
  tenantId: string,
): Promise<boolean> {
  const checks = [...TRANSACTION_TABLES, ...EDGE_TABLES].map((table) =>
    existsIn(table, tenantId),
  );
  const result = await tx.execute(
    sql`SELECT (${sql.join(checks, sql` OR `)}) AS started`,
  );
  const row = result.rows[0] as { started: boolean } | undefined;
  return row?.started === true;
}
