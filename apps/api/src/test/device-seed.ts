import type { PoolClient } from "pg";

/**
 * Registers a POS device in the tenant's device registry (legend-495 H1).
 *
 * A signed device token is only current while the registry knows the device
 * and the token is not older than its latest issue (`token_issued_at`), so a
 * test that signs a device token must register that device first. The token
 * must be signed after this call: `token_issued_at` is set one minute back.
 */
export async function registerTestDevice(
  owner: { connect(): Promise<PoolClient> },
  input: {
    tenantId: string;
    outletId: string;
    deviceId: string;
    label?: string;
  },
): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [input.tenantId],
    );
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')
       ON CONFLICT (id) DO NOTHING`,
      [
        input.deviceId,
        input.tenantId,
        input.outletId,
        input.label ?? "Kasir Uji",
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
