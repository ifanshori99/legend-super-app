// legend-495 G2: grantRoleAssignment only gives a role to someone who already
// belongs to the tenant (an assignment in force, or an active HRIS employee
// record). Tests that grant to a fresh account seed it as a new hire: an
// `employees` row linked to the account, with no role assignment.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export async function seedHire(
  owner: Pool,
  input: {
    tenantId: string;
    userId: string;
    outletId: string;
    status?: "onboarding" | "active";
  },
): Promise<string> {
  const id = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [input.tenantId],
    );
    await client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Baru Uji', $5, 'pkwtt', '2025-03-01', $6)`,
      [
        id,
        input.tenantId,
        input.userId,
        `NH-${id.slice(0, 8).toUpperCase()}`,
        input.outletId,
        input.status ?? "active",
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return id;
}

export async function deleteHires(
  owner: Pool,
  tenantId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, ids],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
