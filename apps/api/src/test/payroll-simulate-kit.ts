// Shared SQL fixtures for the payroll simulate-then-lock tests (design
// docs/briefs/sub-payroll-followups-design.md section 7). Plain functions over a
// `pg` client that already carries the tenant GUCs (asTenant of each test file).
// Not a test file: vitest only runs *.test.ts.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { idr } from "@starter/shared/core";
import {
  cafeLegendPayrollFixtures,
  STATUTORY_TABLE_TYPES,
} from "@starter/shared/hris/payroll";
import {
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollAmount,
} from "../lib/payroll-sealed.ts";
import {
  REFERENCE_PPH21_ANNUAL,
  REFERENCE_PTKP,
  REFERENCE_TER,
} from "./fixtures/payroll/statutory-tables.ts";

// Published tables are unique per (tenant, type, effective_from) and every test
// file shares one tenant. Each file therefore publishes its own tables on its own
// first-of-month date, well before any test pay date (2026), picked at publish
// time among dates no published row of the tenant uses. Reserve 1900-1949 for
// this kit so fixed-date fixtures (for example TER/Coretax in 2001-2002) never
// collide with it. Allocation and publication share a transaction lock, so
// concurrent files cannot both choose the same free date. Every file publishes
// the same parameters, so whichever table is in force gives the same result.
const PINNED_FROM_MONTHS = 600; // 1900-01 .. 1949-12
function pinnedFromDate(monthIndex: number) {
  const year = 1900 + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}
let pinnedFrom: string | null = null;
export const kitPinnedFrom = () => pinnedFrom;
export const KIT_CREATOR = randomUUID();
export const KIT_HR_APPROVER = randomUUID();
export const KIT_FINANCE_APPROVER = randomUUID();

// One id per statutory type for this test file (module state is per file).
const STATUTORY_IDS: Record<string, string> = Object.fromEntries(
  STATUTORY_TABLE_TYPES.map((type) => [type, randomUUID()]),
);
export const statutoryIds = () => Object.values(STATUTORY_IDS);

// (tenant, type, version) is unique and every test file shares one tenant, so a
// fixed version collides with another file's rows (parallel files, or rows left
// by an aborted run). A random base per file, one step per type, avoids it.
const VERSION_BASE = 1_000_000 + Math.floor(Math.random() * 100_000_000) * 10;

/**
 * Publishes every statutory table type for the tenant, effective long before
 * any test date so it is the one in force. PTKP, TER and annual use the
 * reference tables; the rest use the illustrative fixture parameters. ASSUMPTION:
 * simulate picks the published version in force on the pay date.
 */
export async function publishStatutoryTables(
  conn: PoolClient,
  tenantId: string,
  publisherId: string,
) {
  // Callers already opened a tenant transaction. Keep this lock until they
  // commit, including every draft-to-published update below.
  await conn.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `test:payroll-simulate-kit:statutory:${tenantId}`,
  ]);
  const { rows } = await conn.query<{ id: string; effective_from: string }>(
    `SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
       FROM statutory_rates
      WHERE tenant_id = $1 AND status = 'published'
        AND effective_from >= '1900-01-01' AND effective_from < '1950-01-01'`,
    [tenantId],
  );
  const ownIds = new Set(statutoryIds());
  // Re-read our persisted date instead of trusting module state: a previous
  // caller may have rolled back after choosing a date another file then took.
  pinnedFrom = rows.find((row) => ownIds.has(row.id))?.effective_from ?? null;
  if (pinnedFrom === null) {
    const used = new Set(rows.map((row) => row.effective_from));
    for (let step = 0; step < PINNED_FROM_MONTHS; step++) {
      const candidate = pinnedFromDate(step);
      if (!used.has(candidate)) {
        pinnedFrom = candidate;
        break;
      }
    }
    if (pinnedFrom === null)
      throw new Error("no free effective_from for kit statutory tables");
  }
  const override: Record<string, unknown> = {
    ptkp: REFERENCE_PTKP,
    pph21_ter: REFERENCE_TER,
    pph21_annual: REFERENCE_PPH21_ANNUAL,
  };
  for (const [index, type] of STATUTORY_TABLE_TYPES.entries()) {
    const version = VERSION_BASE + index;
    const fixture = cafeLegendPayrollFixtures.statutoryTables.find(
      (row) => row.type === type && row.status === "published",
    );
    const parameters = override[type] ?? fixture?.parameters;
    await conn.query(
      `INSERT INTO statutory_rates
         (id, tenant_id, type, version, effective_from, status, legal_basis, parameters, created_by)
       VALUES ($1, $2, $3, $4, $5, 'draft', 'Uji simulasi payroll', $6::jsonb, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        STATUTORY_IDS[type],
        tenantId,
        type,
        version,
        pinnedFrom,
        JSON.stringify(parameters),
        publisherId,
      ],
    );
    await conn.query(
      `UPDATE statutory_rates
          SET status = 'published', published_at = now(), published_by = $2
        WHERE id = $1 AND status = 'draft'`,
      [STATUTORY_IDS[type], publisherId],
    );
  }
}

/**
 * Intentionally a no-op. The kit tables are identical in every test file
 * (fixed ids, inserted with ON CONFLICT DO NOTHING) and payroll runs of other
 * files can be pinned to them, so one file must not delete them.
 */
export async function deleteStatutoryTables(
  conn: PoolClient,
  tenantId: string,
) {
  void conn;
  void tenantId;
}

/** A payroll policy whose group covers `pkwtt` and whose cycle is monthly. */
export async function insertPolicy(
  conn: PoolClient,
  tenantId: string,
  entityId: string,
  policyId: string,
) {
  const code = `K${policyId.replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  await conn.query(
    `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                   employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
     VALUES ($1, $2, $3, 'Kebijakan uji simulasi', $4, $5,
             '{"frequency":"monthly","cutoffDay":null,"payDay":null,"payMonthOffset":0}',
             'none', 'low', '[]')`,
    [
      policyId,
      tenantId,
      entityId,
      code,
      JSON.stringify({
        code,
        name: "Kelompok uji simulasi",
        employmentTypes: ["pkwtt"],
      }),
    ],
  );
}

/**
 * An active pkwtt employee with a PTKP status (null = missing) and one
 * active contract carrying the PPh 21 `taxScheme` (default gross). Simulate
 * reads the scheme from the latest non-draft contract starting on or before
 * the pay date and answers 422 when there is none, so every employee needs
 * one. Pass `taxScheme: null` to seed no contract (the missing-scheme case).
 */
export async function insertEmployee(
  conn: PoolClient,
  input: {
    tenantId: string;
    outletId: string;
    entityId: string;
    id: string;
    name: string;
    joinDate?: string;
    ptkpStatus?: string | null;
    taxScheme?: "gross" | "gross_up" | "net" | null;
  },
) {
  await conn.query(
    `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                            legal_entity_id, employment_type, join_date, status, ptkp_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', $7, 'active', $8)`,
    [
      input.id,
      input.tenantId,
      `SM-${input.id.slice(0, 8).toUpperCase()}`,
      input.name,
      input.outletId,
      input.entityId,
      input.joinDate ?? "2025-03-01",
      input.ptkpStatus === undefined ? "TK/0" : input.ptkpStatus,
    ],
  );
  if (input.taxScheme !== null)
    await insertContract(conn, {
      tenantId: input.tenantId,
      employeeId: input.id,
      taxScheme: input.taxScheme ?? "gross",
    });
}

/**
 * An active pkwtt contract for the employee. It starts long before any test
 * pay date (2026), so it is the latest non-draft contract in force.
 */
export async function insertContract(
  conn: PoolClient,
  input: {
    tenantId: string;
    employeeId: string;
    taxScheme: "gross" | "gross_up" | "net";
    startDate?: string;
    status?: "active" | "draft";
  },
) {
  await conn.query(
    `INSERT INTO employment_contracts
       (id, tenant_id, employee_id, type, tax_scheme, start_date,
        reminder_days_before, status)
     VALUES ($1, $2, $3, 'pkwtt', $4, $5, 30, $6)`,
    [
      randomUUID(),
      input.tenantId,
      input.employeeId,
      input.taxScheme,
      input.startDate ?? "2025-01-01",
      input.status ?? "active",
    ],
  );
}

/**
 * A fixed base-salary component for the employee (gross = `amount`). Its
 * `scheme` is the component's own PPh 21 scheme; the employee's scheme for
 * simulate is the contract's (see insertEmployee).
 */
export async function insertSalary(
  conn: PoolClient,
  input: {
    tenantId: string;
    employeeId: string;
    amount: number;
    scheme?: "gross" | "gross_up" | "net";
    createdBy: string;
    effectiveFrom?: string;
  },
): Promise<string> {
  const componentId = randomUUID();
  const rowId = randomUUID();
  const code = `SM_${componentId.replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  await conn.query(
    `INSERT INTO pay_components (id, tenant_id, code, name, category, kind,
       recurrence, taxable, tax_scheme, bpjs_base, overtime_base, thr_base)
     VALUES ($1, $2, $3, 'Gaji pokok uji', 'base_salary', 'earning',
       'fixed', true, $4, true, true, true)`,
    [componentId, input.tenantId, code, input.scheme ?? "gross"],
  );
  await conn.query(
    `INSERT INTO employee_pay_components (id, tenant_id, employee_id, component_id,
       amount_encrypted, pii_key_version, effective_from, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      rowId,
      input.tenantId,
      input.employeeId,
      componentId,
      sealPayrollAmount(idr(input.amount), {
        tenantId: input.tenantId,
        table: "employee_pay_components",
        rowId,
        field: "amount",
      }),
      PAYROLL_SEAL_KEY_VERSION,
      input.effectiveFrom ?? "2025-01-01",
      input.createdBy,
    ],
  );
  return componentId;
}

/** A draft run row (the DB only allows that), regular or THR. */
export async function insertDraftRun(
  conn: PoolClient,
  input: {
    tenantId: string;
    runId: string;
    entityId: string;
    policyId: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    thr?: boolean;
  },
): Promise<string | null> {
  let thrScheduleId: string | null = null;
  if (input.thr) {
    thrScheduleId = randomUUID();
    await conn.query(
      `INSERT INTO thr_schedules (id, tenant_id, legal_entity_id, name, holiday_name,
                                  holiday_date, tenure_as_of_date, pay_date, created_by)
       VALUES ($1, $2, $3, 'THR uji simulasi', 'Hari raya uji', $4, $4, $4, 'simulate-test')`,
      [thrScheduleId, input.tenantId, input.entityId, input.payDate],
    );
  }
  await conn.query(
    `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                               period_start, period_end, pay_date, thr_schedule_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.runId,
      input.tenantId,
      input.entityId,
      input.policyId,
      input.thr ? "thr" : "regular",
      input.periodStart,
      input.periodEnd,
      input.payDate,
      thrScheduleId,
      KIT_CREATOR,
    ],
  );
  return thrScheduleId;
}

/** simulated -> hr_approved -> approved (the approval routes do not exist yet). */
export async function approveSimulatedRun(conn: PoolClient, runId: string) {
  await conn.query(
    `UPDATE payroll_runs SET status = 'hr_approved', approved_by_hr = $2, approved_by_hr_at = now()
      WHERE id = $1`,
    [runId, KIT_HR_APPROVER],
  );
  await conn.query(
    `UPDATE payroll_runs SET status = 'approved', approved_by_finance = $2, approved_by_finance_at = now()
      WHERE id = $1`,
    [runId, KIT_FINANCE_APPROVER],
  );
}

/** approved -> draft (return_to_draft), the way the reducer clears the run. */
export async function returnRunToDraft(conn: PoolClient, runId: string) {
  await conn.query(
    `UPDATE payroll_runs SET status = 'draft', simulation_count = 0, last_simulated_at = NULL,
            totals = NULL, config_snapshot = NULL, approved_by_hr = NULL,
            approved_by_hr_at = NULL, approved_by_finance = NULL,
            approved_by_finance_at = NULL
      WHERE id = $1`,
    [runId],
  );
}
