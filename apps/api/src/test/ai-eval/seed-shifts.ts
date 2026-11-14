import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { roleTemplate } from "@starter/shared/access";
import { roleGroupTemplate, type EvalCase } from "./types.ts";

type ShiftEvalOptions = {
  tenantId: string;
  outletId: string;
  actorUserId: string;
  entries: readonly EvalCase[];
  caseUsers: ReadonlyMap<string, string>;
  /** Optional case id -> employee id; looked up by user id when absent. */
  employeeIds?: ReadonlyMap<string, string>;
};

/** First day of W1..W5 in dataset.ts (March 2031). */
const WEEK_STARTS = [
  "2031-03-01",
  "2031-03-08",
  "2031-03-15",
  "2031-03-22",
  "2031-03-29",
] as const;

const MANAGER_EMPLOYEE_NO = "EV-SH-MGR";

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

const hour = (value: number) => String(value).padStart(2, "0");

/** Asia/Jakarta (+07:00) wall clock as an instant, like the roster stores it. */
const instant = (date: string, startHour: number) =>
  new Date(`${date}T${hour(startHour)}:00:00+07:00`).toISOString();

/**
 * The HRIS roster service reads roles from the database, while the eval keeps
 * only an in-memory access snapshot: give each manager and employee case user
 * the same role template, bound to the outlet like the snapshot.
 */
async function grantOutletTemplates(
  client: PoolClient,
  options: ShiftEvalOptions,
): Promise<void> {
  const { tenantId, outletId, caseUsers } = options;
  const granted = new Set<string>();
  for (const entry of options.entries) {
    const userId = caseUsers.get(entry.id);
    const usesShifts =
      entry.expectTool?.name === "get_shift_schedule" ||
      entry.forbiddenTool?.name === "get_shift_schedule";
    if (
      !userId ||
      !usesShifts ||
      (entry.roleGroup !== "manager" && entry.roleGroup !== "employee") ||
      granted.has(userId)
    )
      continue;
    granted.add(userId);
    const key = roleGroupTemplate[entry.roleGroup];
    const template = roleTemplate(key);
    await client.query(
      `INSERT INTO roles
         (tenant_id, name, is_template, template_key, permissions,
          mfa_required, allowed_scope_types)
       VALUES ($1, $2, true, $3, $4::jsonb, false, $5::jsonb)
       ON CONFLICT (tenant_id, template_key) DO NOTHING`,
      [
        tenantId,
        `Eval ${key}`,
        key,
        JSON.stringify(template.permissions),
        JSON.stringify(template.allowedScopeTypes),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       SELECT $1, $2, id, 'outlet', $4, now() - interval '1 day', $2 FROM roles
        WHERE tenant_id = $1 AND template_key = $3`,
      [tenantId, userId, key, outletId],
    );
  }
}

/**
 * Published shifts for the get_shift_schedule numeric cases: one per week
 * W1..W5 for every employee case, and for a manager one extra employee at
 * the outlet. Start hour and weekday differ per employee and week, so an
 * answer can only quote the right value from the tool output. The caller owns
 * the tenant-scoped transaction; run it after `seedOperationalEval`, which
 * creates the employee rows.
 */
export async function seedShiftEval(
  client: PoolClient,
  options: ShiftEvalOptions,
): Promise<void> {
  const { tenantId, outletId, actorUserId, caseUsers } = options;
  await grantOutletTemplates(client, options);
  const numeric = options.entries.filter(
    (entry) =>
      entry.kind === "numeric" &&
      caseUsers.has(entry.id) &&
      entry.expectTool!.name === "get_shift_schedule",
  );

  const staff: string[] = [];
  for (const entry of numeric.filter((item) => item.roleGroup === "employee")) {
    const known = options.employeeIds?.get(entry.id);
    if (known) {
      staff.push(known);
      continue;
    }
    const found = await client.query<{ id: string }>(
      `SELECT id FROM employees WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, caseUsers.get(entry.id)],
    );
    if (found.rows[0]) staff.push(found.rows[0].id);
  }
  // Every case of the same user reads the same rows: seed each employee once.
  const employeeIds = [...new Set(staff)];

  if (numeric.some((entry) => entry.roleGroup === "manager")) {
    const managed = await client.query<{ id: string }>(
      `INSERT INTO employees
         (id, tenant_id, employee_no, full_name, home_outlet_id,
          employment_type, join_date, status)
       VALUES ($1, $2, $3, 'Staf jadwal evaluasi', $4, 'pkwtt', '2025-01-01', 'active')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [randomUUID(), tenantId, MANAGER_EMPLOYEE_NO, outletId],
    );
    if (managed.rows[0]) employeeIds.push(managed.rows[0].id);
  }

  for (const [index, employeeId] of employeeIds.entries())
    for (const [week, weekStart] of WEEK_STARTS.entries()) {
      const date = addDays(weekStart, (index + week) % 7);
      // 06:00..14:00 start, always an 8 hour shift ending by 22:00.
      const startHour = 6 + ((index + week) % 9);
      await client.query(
        `INSERT INTO shift_assignments
           (id, tenant_id, outlet_id, employee_id, business_date, segments,
            break_minutes, status, source, published_by, published_at,
            created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 60, 'published', 'user',
                 $7, '2031-02-20T00:00:00Z', $7)`,
        [
          randomUUID(),
          tenantId,
          outletId,
          employeeId,
          date,
          JSON.stringify([
            {
              startsAt: instant(date, startHour),
              endsAt: instant(date, startHour + 8),
            },
          ]),
          actorUserId,
        ],
      );
    }
}
