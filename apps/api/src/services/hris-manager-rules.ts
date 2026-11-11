// Shared rules for "who may be whose manager" (bead legend-f4uvg). Used by the
// manager-change service and by the one-off backfill script
// (db/backfill-employee-managers.ts), so both apply the same role and cycle
// logic.

import { sql, type SQL } from "drizzle-orm";

/** Roles that are safe to put under an outlet manager; any other role blocks auto. */
export const JUNIOR_ROLE_KEYS: readonly string[] = [
  "cashier",
  "waiter",
  "barista_cook",
  "facility_attendant",
  "kitchen_lead",
  "warehouse",
  "employee",
];

/** Deepest manager chain we follow before giving up (data is cyclic or corrupt). */
export const MAX_MANAGER_CHAIN_DEPTH = 1000;

/**
 * True when every key is a junior role. An empty list is vacuously junior; a
 * custom role (key "custom") or any template outside JUNIOR_ROLE_KEYS is not.
 */
export function isJuniorOnly(keys: readonly string[]): boolean {
  return keys.every((key) => JUNIOR_ROLE_KEYS.includes(key));
}

/**
 * True when the manager chain above `startId` (following `managerOf` upward,
 * any depth) reaches `employeeId`. A loop that does not contain `employeeId`
 * ends the walk with false; so does exceeding `maxDepth`.
 */
export function chainReaches(
  managerOf: (id: string) => string | null | undefined,
  startId: string,
  employeeId: string,
  maxDepth = MAX_MANAGER_CHAIN_DEPTH,
): boolean {
  const seen = new Set<string>([startId]);
  let current = managerOf(startId) ?? null;
  let depth = 0;
  while (current) {
    if (current === employeeId) return true;
    if (seen.has(current) || ++depth > maxDepth) return false;
    seen.add(current);
    current = managerOf(current) ?? null;
  }
  return false;
}

/** Anything with a node-postgres style `execute` (drizzle transaction). */
type Executor = {
  execute: (query: SQL) => PromiseLike<{ rows: Record<string, unknown>[] }>;
};

/**
 * Currently valid role template keys per employee (custom roles count as
 * "custom"), joined through employees.user_id. `employeeIds` null means every
 * employee of the tenant. Employees without roles map to [].
 */
export async function loadRoleKeys(
  tx: Executor,
  tenantId: string,
  employeeIds: readonly string[] | null,
  now: Date,
): Promise<Map<string, string[]>> {
  const keysByEmployee = new Map<string, string[]>();
  if (employeeIds !== null && employeeIds.length === 0) return keysByEmployee;
  const filter =
    employeeIds === null
      ? sql``
      : sql`AND e.id IN (${sql.join(
          employeeIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const rows = await tx.execute(
    sql`SELECT DISTINCT e.id AS employee_id, COALESCE(r.template_key, 'custom') AS role_key
        FROM role_assignments ra
        JOIN roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        JOIN employees e ON e.tenant_id = ra.tenant_id AND e.user_id = ra.user_id
        WHERE ra.tenant_id = ${tenantId}::uuid
          AND ra.valid_from <= ${now}
          AND (ra.valid_until IS NULL OR ra.valid_until > ${now})
          ${filter}`,
  );
  for (const row of rows.rows) {
    const id = String(row.employee_id);
    const keys = keysByEmployee.get(id) ?? [];
    keys.push(String(row.role_key));
    keysByEmployee.set(id, keys);
  }
  return keysByEmployee;
}
