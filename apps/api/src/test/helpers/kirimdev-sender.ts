// Test helper for the platform-written Kirimdev sender mapping (legend-nqxtb,
// legend-52tdq). `kirimdev_sender_mappings` is the only source of the number an
// inbound WhatsApp message is routed by, so every test that configures a
// WhatsApp integration and sends an inbound message must map the
// `phone_number_id` its payloads carry.
//
// Rows are written as the test superuser (the same connection the other
// helpers use for fixtures), not through the platform API: the platform route
// is covered by kirimdev-sender-mapping.test.ts. The table has a write guard
// trigger, so every transaction first sets `app.kirimdev_sender_write`.
import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";

async function inGuardedTransaction(
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.kirimdev_sender_write', 'on', true)",
    );
    await work(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Inserts, or replaces, the sender mapping of one tenant slot: the tenant-wide
 * slot when `outletId` is null, else that outlet's slot. A `phoneNumberId`
 * already mapped to another slot is not stolen: the unique index refuses it.
 */
export async function mapKirimdevSender(
  tenantId: string,
  phoneNumberId: string,
  outletId: string | null = null,
): Promise<void> {
  await inGuardedTransaction(async (client) => {
    await client.query(
      `DELETE FROM kirimdev_sender_mappings
        WHERE tenant_id = $1 AND outlet_id IS NOT DISTINCT FROM $2`,
      [tenantId, outletId],
    );
    try {
      await client.query(
        `INSERT INTO kirimdev_sender_mappings
           (id, tenant_id, outlet_id, phone_number_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), now())`,
        [randomUUID(), tenantId, outletId, phoneNumberId],
      );
    } catch (error) {
      // Never steal a number from a stale row of another tenant: fail loudly.
      if ((error as { code?: string }).code === "23505")
        throw new Error(
          `mapKirimdevSender: phone_number_id ${phoneNumberId} is already mapped to another tenant or outlet (stale test row?)`,
        );
      throw error;
    }
  });
}

/** Removes every sender mapping of the tenant (tenant-wide and per outlet). */
export async function unmapKirimdevSender(tenantId: string): Promise<void> {
  await inGuardedTransaction(async (client) => {
    // A no-op when the tenant has no row.
    await client.query(
      "DELETE FROM kirimdev_sender_mappings WHERE tenant_id = $1",
      [tenantId],
    );
  });
}

/**
 * For test files that share ONE seeded tenant (and so its single tenant-wide
 * WhatsApp integration and sender mapping) and may run in parallel. The tenant
 * has room for one routing number, so the files must agree on it instead of
 * each writing their own: the first file's number wins, later files adopt it.
 *
 * Inserts the active kirimdev integration only when none exists (an existing
 * row keeps its `receivingNumber`), re-reads the number the config actually
 * ends up with, makes sure the tenant-wide mapping points at that number (no
 * write when it already does) and returns it. Callers must use the returned
 * number as the `phone_number_id` of their webhook payloads, and must never
 * unmap or overwrite the integration afterwards: the other file may rely on it.
 */
export async function ensureSharedKirimdevSender(
  tenantId: string,
  preferredNumber: string,
): Promise<string> {
  const pool = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 1,
  });
  try {
    await pool.query(
      `INSERT INTO tenant_integrations (tenant_id, provider, config, credentials_encrypted, status)
       VALUES ($1, 'whatsapp', $2, 'c2VhbGVkLXRlc3Q=', 'active')
       ON CONFLICT DO NOTHING`,
      [
        tenantId,
        JSON.stringify({
          vendor: "kirimdev",
          receivingNumber: preferredNumber,
        }),
      ],
    );
    const { rows } = await pool.query<{
      config: Record<string, unknown> | null;
      status: string;
    }>(
      `SELECT config, status FROM tenant_integrations
        WHERE tenant_id = $1 AND provider = 'whatsapp' AND outlet_id IS NULL`,
      [tenantId],
    );
    const config = rows[0]?.config ?? {};
    const existing =
      typeof config.receivingNumber === "string" ? config.receivingNumber : "";
    const number = existing || preferredNumber;
    // Only repair what is missing (a stale or inactive row); never swap the number.
    if (
      !rows[0] ||
      rows[0].status !== "active" ||
      config.vendor !== "kirimdev" ||
      !existing
    )
      await pool.query(
        `UPDATE tenant_integrations SET config = $2, status = 'active'
          WHERE tenant_id = $1 AND provider = 'whatsapp' AND outlet_id IS NULL`,
        [
          tenantId,
          JSON.stringify({
            ...config,
            vendor: "kirimdev",
            receivingNumber: number,
          }),
        ],
      );

    const mappedTo = async () =>
      (
        await pool.query<{ phone_number_id: string }>(
          `SELECT phone_number_id FROM kirimdev_sender_mappings
            WHERE tenant_id = $1 AND outlet_id IS NULL`,
          [tenantId],
        )
      ).rows[0]?.phone_number_id;
    if ((await mappedTo()) !== number) {
      try {
        await mapKirimdevSender(tenantId, number);
      } catch (error) {
        // The other file mapped the same number at the same moment: fine.
        if ((await mappedTo()) !== number) throw error;
      }
    }
    return number;
  } finally {
    await pool.end();
  }
}

/**
 * Serialises the test files that touch the seeded tenant's WhatsApp state
 * (login challenges, identities, the shared integration). identity-merge's
 * cleanup wipes everything in scope for that tenant, and payslip-pin-wa-reset
 * deletes the shared integration in its 503 test, so the two files must never
 * overlap even when vitest runs them in parallel.
 *
 * Takes a session-level advisory lock on a dedicated connection and waits until
 * it is granted. Call it as the first statement of `beforeAll` (give the hook a
 * generous timeout: it queues behind the other file), and call the returned
 * function last in `afterAll`. Closing the connection also frees the lock, so a
 * crashed run never leaves it held.
 */
export async function holdSeededTenantWhatsappLock(): Promise<
  () => Promise<void>
> {
  const client = new Client({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
  });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('legend-test:seeded-tenant-whatsapp'))",
    );
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return async () => {
    await client
      .query(
        "SELECT pg_advisory_unlock(hashtext('legend-test:seeded-tenant-whatsapp'))",
      )
      .catch(() => undefined);
    await client.end().catch(() => undefined);
  };
}
