// HRIS PII re-seal after a key rotation (bead legend-33mj). An operator adds a
// key to HRIS_PII_KEYS, raises HRIS_PII_ACTIVE_KEY_VERSION, restarts, and
// queues this job (on demand: no cron, a rotation is rare). It moves every
// `employees`, `employment_contracts`, `employee_pay_components` and `payslips`
// row whose `pii_key_version` differs from the active version: each sealed
// column is opened under the row's old version and sealed under the active one,
// then `pii_key_version` is set. Payroll sealed values ride the same key ring
// (lib/payroll-sealed.ts). Their tables only accept a re-seal inside a
// transaction that sets `app.payroll_reseal` (migration 0248), so every payroll
// batch sets that flag first, plus the target version (app.payroll_reseal_target_version);
// both are transaction-local. Payroll versions only move up, never above the target.
//
// Safe to repeat and to kill. Work is cut into batches ordered by id; each
// batch is one tenant transaction that selects its rows `FOR UPDATE SKIP
// LOCKED` with `pii_key_version <> active` in the WHERE clause, so a second run
// (or a concurrent one) never touches a row that is current or being moved, and
// a crash loses at most the batch in flight (it rolls back whole). A second run
// after a finished one changes 0 rows. `updated_at` is left alone: the data did
// not change, only its key.
//
// Cross-tenant like the other worker sweeps, but over EVERY tenant whatever its
// status (public.tenants, readable by the app role, no RLS): a suspended or
// archived tenant still holds sealed rows, and the old key is retired once the
// job is done, so skipping it would lose its data. Each tenant runs under a
// trusted job context with tenant-wide scope, so RLS still applies. A tenant
// that fails (a value that will not open, a database error) is logged and
// skipped, fail closed; the others still run and the next run retries it.
//
// SKIP LOCKED means a row held by another transaction is passed over. After
// the batches the job counts what is still stale WITHOUT skipping locks; a
// tenant with leftovers is reported incomplete and the queued job fails, so
// pg-boss retries it. The queued job must name the version it targets and is
// refused when that is not this worker's active version (a stale worker would
// otherwise re-seal to the wrong key). Logs carry counts and ids of tenants
// only, never values, keys or row contents.

import { and, asc, eq, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import type * as schema from "../db/schema/index.ts";
import { employees, employmentContracts } from "../db/schema/hris.ts";
import {
  employeePayComponents,
  payrollRunResults,
  payslipBankSnapshots,
  payslips,
} from "../db/schema/payroll.ts";
import {
  payrollRapels,
  payrollRapelItems,
} from "../db/schema/payroll-rapel.ts";
import { withTenant } from "../db/tenant.ts";
import {
  HRIS_PII_KEY_VERSION,
  openHrisPii,
  sealHrisPii,
  type HrisEmployeePiiField,
  type HrisPiiBinding,
} from "../lib/hris-pii.ts";
import {
  openPayrollAmount,
  openPayrollValue,
  sealPayrollAmount,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";

type Database = NodePgDatabase<typeof schema>;

export const HRIS_PII_RESEAL_QUEUE = "hris-pii-reseal";
export const HRIS_PII_RESEAL_BATCH = 200;
/** One run may be long on a big tenant; pg-boss must not expire it early. */
const HRIS_PII_RESEAL_EXPIRE_SECONDS = 60 * 60;

type ResealTable =
  | "employees"
  | "employment_contracts"
  | "employee_pay_components"
  | "payslips"
  | "payslip_bank_snapshots"
  | "payroll_run_results"
  | "payroll_rapels"
  | "payroll_rapel_items";

export type HrisPiiResealResult = {
  tenants: number;
  employees: number;
  contracts: number;
  payComponents: number;
  payslips: number;
  bankSnapshots: number;
  runResults: number;
  rapels: number;
  rapelItems: number;
  failedTenants: number;
  /** Tenants that still hold stale rows after the run (locked by others). */
  incompleteTenants: number;
  /** True when the abort signal stopped the run before it was done. */
  aborted: boolean;
};

export type HrisPiiResealOptions = {
  database?: Database;
  log?: Pick<Console, "error">;
  /** Rows per batch (one transaction each). */
  batchSize?: number;
  /** Version to move rows to; defaults to the configured active version. */
  activeKeyVersion?: number;
  now?: Date;
  /** Stops the run cleanly between batches (shutdown, test). */
  signal?: AbortSignal;
  /** Called after each committed batch; a throw fails that tenant's run. */
  afterBatch?: (batch: {
    tenantId: string;
    table: ResealTable;
    count: number;
  }) => void | Promise<void>;
  /** Test hook; defaults to every tenant, whatever its status. */
  listTenantIds?: () => Promise<string[]>;
};

/** Sealed column of each employee field, as in services/hris-employee.service.ts. */
const EMPLOYEE_COLUMNS = [
  ["nik", "nikEncrypted"],
  ["npwp", "npwpEncrypted"],
  ["bpjsKesNo", "bpjsKesNoEncrypted"],
  ["bpjsTkNo", "bpjsTkNoEncrypted"],
  ["bankAccount", "bankAccountEncrypted"],
  ["emergencyContactName", "emergencyContactNameEncrypted"],
  ["emergencyContactPhone", "emergencyContactPhoneEncrypted"],
] as const satisfies readonly (readonly [
  HrisEmployeePiiField,
  keyof typeof employees.$inferSelect,
])[];

/** Every tenant id, suspended and archived included (ids only, no RLS table). */
export async function listAllTenantIds(
  database: Database = db,
): Promise<string[]> {
  const result = await database.execute(
    sql`SELECT id FROM public.tenants ORDER BY id`,
  );
  return result.rows.map((row) => String(row.id));
}

/** Stale rows of a tenant, counted without SKIP LOCKED: locked rows count. */
async function countStale(
  database: Database,
  context: ScopedTenantContext,
  active: number,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    const [staleEmployees] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          ne(employees.piiKeyVersion, active),
        ),
      );
    const [staleContracts] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(employmentContracts)
      .where(
        and(
          eq(employmentContracts.tenantId, tenantId),
          ne(employmentContracts.piiKeyVersion, active),
        ),
      );
    const [stalePayComponents] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(employeePayComponents)
      .where(
        and(
          eq(employeePayComponents.tenantId, tenantId),
          ne(employeePayComponents.piiKeyVersion, active),
        ),
      );
    const [stalePayslips] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payslips)
      .where(
        and(
          eq(payslips.tenantId, tenantId),
          ne(payslips.piiKeyVersion, active),
        ),
      );
    const [staleBankSnapshots] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payslipBankSnapshots)
      .where(
        and(
          eq(payslipBankSnapshots.tenantId, tenantId),
          ne(payslipBankSnapshots.piiKeyVersion, active),
        ),
      );
    const [staleRapels] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollRapels)
      .where(
        and(
          eq(payrollRapels.tenantId, tenantId),
          ne(payrollRapels.piiKeyVersion, active),
        ),
      );
    const [staleRapelItems] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollRapelItems)
      .where(
        and(
          eq(payrollRapelItems.tenantId, tenantId),
          ne(payrollRapelItems.piiKeyVersion, active),
        ),
      );
    const [staleRunResults] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollRunResults)
      .where(
        and(
          eq(payrollRunResults.tenantId, tenantId),
          ne(payrollRunResults.piiKeyVersion, active),
        ),
      );
    return (
      Number(staleEmployees?.n ?? 0) +
      Number(staleContracts?.n ?? 0) +
      Number(stalePayComponents?.n ?? 0) +
      Number(stalePayslips?.n ?? 0) +
      Number(staleBankSnapshots?.n ?? 0) +
      Number(staleRunResults?.n ?? 0) +
      Number(staleRapels?.n ?? 0) +
      Number(staleRapelItems?.n ?? 0)
    );
  });
}

function jobContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
}

function reseal(
  sealed: Buffer,
  binding: HrisPiiBinding,
  from: number,
  to: number,
): Buffer {
  return sealHrisPii(openHrisPii(sealed, binding, from), binding, to);
}

/** One batch of employees; returns the number of rows moved. */
async function resealEmployeeBatch(
  database: Database,
  context: ScopedTenantContext,
  batchSize: number,
  active: number,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    const rows = await tx
      .select()
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, tenantId),
          ne(employees.piiKeyVersion, active),
        ),
      )
      .orderBy(asc(employees.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      const values: Partial<typeof employees.$inferInsert> = {};
      for (const [field, column] of EMPLOYEE_COLUMNS) {
        const sealed = row[column];
        if (sealed === null) continue;
        values[column] = reseal(
          sealed,
          { tenantId, table: "employees", rowId: row.id, field },
          row.piiKeyVersion,
          active,
        );
      }
      await tx
        .update(employees)
        .set({ ...values, piiKeyVersion: active })
        .where(
          and(
            eq(employees.tenantId, tenantId),
            eq(employees.id, row.id),
            ne(employees.piiKeyVersion, active),
          ),
        );
    }
    return rows.length;
  });
}

/** One batch of employment contracts; returns the number of rows moved. */
async function resealContractBatch(
  database: Database,
  context: ScopedTenantContext,
  batchSize: number,
  active: number,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    const rows = await tx
      .select()
      .from(employmentContracts)
      .where(
        and(
          eq(employmentContracts.tenantId, tenantId),
          ne(employmentContracts.piiKeyVersion, active),
        ),
      )
      .orderBy(asc(employmentContracts.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      const sealed = row.salarySnapshotEncrypted;
      await tx
        .update(employmentContracts)
        .set({
          ...(sealed === null
            ? {}
            : {
                salarySnapshotEncrypted: reseal(
                  sealed,
                  {
                    tenantId,
                    table: "employment_contracts",
                    rowId: row.id,
                    field: "salarySnapshot",
                  },
                  row.piiKeyVersion,
                  active,
                ),
              }),
          piiKeyVersion: active,
        })
        .where(
          and(
            eq(employmentContracts.tenantId, tenantId),
            eq(employmentContracts.id, row.id),
            ne(employmentContracts.piiKeyVersion, active),
          ),
        );
    }
    return rows.length;
  });
}

/** One batch of employee pay components; returns the number of rows moved. */
async function resealPayComponentBatch(
  database: Database,
  context: ScopedTenantContext,
  batchSize: number,
  active: number,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    // The payroll tables reject a key change unless this flag is on (0248).
    await tx.execute(sql`SELECT set_config('app.payroll_reseal', 'on', true)`);
    await tx.execute(
      sql`SELECT set_config('app.payroll_reseal_target_version', ${String(active)}, true)`,
    );
    const rows = await tx
      .select()
      .from(employeePayComponents)
      .where(
        and(
          eq(employeePayComponents.tenantId, tenantId),
          lt(employeePayComponents.piiKeyVersion, active),
        ),
      )
      .orderBy(asc(employeePayComponents.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      const binding = {
        tenantId,
        table: "employee_pay_components",
        rowId: row.id,
        field: "amount",
      } as const;
      const amountEncrypted = sealPayrollAmount(
        openPayrollAmount(row.amountEncrypted, binding, row.piiKeyVersion),
        binding,
        active,
      );
      await tx
        .update(employeePayComponents)
        .set({ amountEncrypted, piiKeyVersion: active })
        .where(
          and(
            eq(employeePayComponents.tenantId, tenantId),
            eq(employeePayComponents.id, row.id),
            lt(employeePayComponents.piiKeyVersion, active),
          ),
        );
    }
    return rows.length;
  });
}

/** One batch of payslips; returns the number of rows moved. */
async function resealPayslipBatch(
  database: Database,
  context: ScopedTenantContext,
  batchSize: number,
  active: number,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    await tx.execute(sql`SELECT set_config('app.payroll_reseal', 'on', true)`);
    await tx.execute(
      sql`SELECT set_config('app.payroll_reseal_target_version', ${String(active)}, true)`,
    );
    const rows = await tx
      .select()
      .from(payslips)
      .where(
        and(
          eq(payslips.tenantId, tenantId),
          lt(payslips.piiKeyVersion, active),
        ),
      )
      .orderBy(asc(payslips.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      const binding = {
        tenantId,
        table: "payslips",
        rowId: row.id,
        field: "calculation",
      } as const;
      const calculationEncrypted = sealPayrollValue(
        openPayrollValue(row.calculationEncrypted, binding, row.piiKeyVersion),
        binding,
        active,
      );
      await tx
        .update(payslips)
        .set({ calculationEncrypted, piiKeyVersion: active })
        .where(
          and(
            eq(payslips.tenantId, tenantId),
            eq(payslips.id, row.id),
            lt(payslips.piiKeyVersion, active),
          ),
        );
    }
    return rows.length;
  });
}

/** legend-89cl7: frozen payee bank snapshots ride the same key ring. */
async function resealBankSnapshotBatch(
  database: Database,
  context: ScopedTenantContext,
  batchSize: number,
  active: number,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    await tx.execute(sql`SELECT set_config('app.payroll_reseal', 'on', true)`);
    await tx.execute(
      sql`SELECT set_config('app.payroll_reseal_target_version', ${String(active)}, true)`,
    );
    const rows = await tx
      .select()
      .from(payslipBankSnapshots)
      .where(
        and(
          eq(payslipBankSnapshots.tenantId, tenantId),
          lt(payslipBankSnapshots.piiKeyVersion, active),
        ),
      )
      .orderBy(asc(payslipBankSnapshots.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      const binding = {
        tenantId,
        table: "payslip_bank_snapshots",
        rowId: row.id,
        field: "bankSnapshot",
      } as const;
      const snapshotEncrypted = sealPayrollValue(
        openPayrollValue(row.snapshotEncrypted, binding, row.piiKeyVersion),
        binding,
        active,
      );
      await tx
        .update(payslipBankSnapshots)
        .set({ snapshotEncrypted, piiKeyVersion: active })
        .where(
          and(
            eq(payslipBankSnapshots.tenantId, tenantId),
            eq(payslipBankSnapshots.id, row.id),
            lt(payslipBankSnapshots.piiKeyVersion, active),
          ),
        );
    }
    return rows.length;
  });
}

/**
 * legend-m6zdl: sealed simulation results of a payroll run ride the same key
 * ring. The table has no id column: the seal is bound to the payslip id
 * (unique per tenant), as payroll-run-lock.service.ts opens it.
 */
async function resealRunResultBatch(
  database: Database,
  context: ScopedTenantContext,
  batchSize: number,
  active: number,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.payroll_reseal', 'on', true), set_config('app.payroll_reseal_target_version', ${String(active)}, true)`,
    );
    const rows = await tx
      .select()
      .from(payrollRunResults)
      .where(
        and(
          eq(payrollRunResults.tenantId, tenantId),
          lt(payrollRunResults.piiKeyVersion, active),
        ),
      )
      .orderBy(asc(payrollRunResults.payslipId))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      const binding = {
        tenantId,
        table: "payroll_run_results",
        rowId: row.payslipId,
        field: "result",
      } as const;
      const resultEncrypted = sealPayrollValue(
        openPayrollValue(row.resultEncrypted, binding, row.piiKeyVersion),
        binding,
        active,
      );
      await tx
        .update(payrollRunResults)
        .set({ resultEncrypted, piiKeyVersion: active })
        .where(
          and(
            eq(payrollRunResults.tenantId, tenantId),
            eq(payrollRunResults.payslipId, row.payslipId),
            lt(payrollRunResults.piiKeyVersion, active),
          ),
        );
    }
    return rows.length;
  });
}

/** Rapel targets and deltas are salary data on the same rotating key ring. */
async function resealRapelBatch(
  database: Database,
  context: ScopedTenantContext,
  batchSize: number,
  active: number,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.payroll_reseal', 'on', true), set_config('app.payroll_reseal_target_version', ${String(active)}, true)`,
    );
    const rows = await tx
      .select()
      .from(payrollRapels)
      .where(
        and(
          eq(payrollRapels.tenantId, tenantId),
          lt(payrollRapels.piiKeyVersion, active),
        ),
      )
      .orderBy(asc(payrollRapels.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      const binding = {
        tenantId,
        table: "payroll_rapels",
        rowId: row.id,
        field: "amount",
      } as const;
      const newAmountEncrypted = sealPayrollAmount(
        openPayrollAmount(row.newAmountEncrypted, binding, row.piiKeyVersion),
        binding,
        active,
      );
      await tx
        .update(payrollRapels)
        .set({ newAmountEncrypted, piiKeyVersion: active })
        .where(
          and(
            eq(payrollRapels.tenantId, tenantId),
            eq(payrollRapels.id, row.id),
            lt(payrollRapels.piiKeyVersion, active),
          ),
        );
    }
    return rows.length;
  });
}

async function resealRapelItemBatch(
  database: Database,
  context: ScopedTenantContext,
  batchSize: number,
  active: number,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.payroll_reseal', 'on', true), set_config('app.payroll_reseal_target_version', ${String(active)}, true)`,
    );
    const rows = await tx
      .select()
      .from(payrollRapelItems)
      .where(
        and(
          eq(payrollRapelItems.tenantId, tenantId),
          lt(payrollRapelItems.piiKeyVersion, active),
        ),
      )
      .orderBy(asc(payrollRapelItems.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      const binding = {
        tenantId,
        table: "payroll_rapel_items",
        rowId: row.id,
        field: "amount",
      } as const;
      const amountEncrypted = sealPayrollAmount(
        openPayrollAmount(row.amountEncrypted, binding, row.piiKeyVersion),
        binding,
        active,
      );
      await tx
        .update(payrollRapelItems)
        .set({ amountEncrypted, piiKeyVersion: active })
        .where(
          and(
            eq(payrollRapelItems.tenantId, tenantId),
            eq(payrollRapelItems.id, row.id),
            lt(payrollRapelItems.piiKeyVersion, active),
          ),
        );
    }
    return rows.length;
  });
}

/** Re-seal every stale row of every tenant. */
export async function runHrisPiiReseal(
  options: HrisPiiResealOptions = {},
): Promise<HrisPiiResealResult> {
  const database = options.database ?? db;
  const log = options.log ?? console;
  const batchSize = options.batchSize ?? HRIS_PII_RESEAL_BATCH;
  const active = options.activeKeyVersion ?? HRIS_PII_KEY_VERSION;
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new RangeError("batchSize must be a positive integer");

  // A listing failure is not tenant-specific: let it fail the job so pg-boss
  // records it and a retry picks up from the database state.
  const tenantIds = await (
    options.listTenantIds ?? (() => listAllTenantIds(database))
  )();
  const result: HrisPiiResealResult = {
    tenants: tenantIds.length,
    employees: 0,
    contracts: 0,
    payComponents: 0,
    payslips: 0,
    bankSnapshots: 0,
    runResults: 0,
    rapels: 0,
    rapelItems: 0,
    failedTenants: 0,
    incompleteTenants: 0,
    aborted: false,
  };

  const steps: [ResealTable, typeof resealEmployeeBatch][] = [
    ["employees", resealEmployeeBatch],
    ["employment_contracts", resealContractBatch],
    ["employee_pay_components", resealPayComponentBatch],
    ["payslips", resealPayslipBatch],
    ["payslip_bank_snapshots", resealBankSnapshotBatch],
    ["payroll_run_results", resealRunResultBatch],
    ["payroll_rapels", resealRapelBatch],
    ["payroll_rapel_items", resealRapelItemBatch],
  ];
  for (const tenantId of tenantIds) {
    if (options.signal?.aborted) {
      result.aborted = true;
      break;
    }
    const context = jobContext(tenantId);
    assertTrustedScopedContext(context);
    try {
      for (const [table, runBatch] of steps) {
        for (;;) {
          if (options.signal?.aborted) {
            result.aborted = true;
            break;
          }
          const count = await runBatch(database, context, batchSize, active);
          if (count === 0) break;
          if (table === "employees") result.employees += count;
          else if (table === "employment_contracts") result.contracts += count;
          else if (table === "employee_pay_components")
            result.payComponents += count;
          else if (table === "payslips") result.payslips += count;
          else if (table === "payslip_bank_snapshots")
            result.bankSnapshots += count;
          else if (table === "payroll_run_results") result.runResults += count;
          else if (table === "payroll_rapels") result.rapels += count;
          else result.rapelItems += count;
          await options.afterBatch?.({ tenantId, table, count });
        }
        if (result.aborted) break;
      }
      if (
        !result.aborted &&
        (await countStale(database, context, active)) > 0
      ) {
        result.incompleteTenants += 1;
        log.error(
          `HRIS PII re-seal incomplete for tenant ${tenantId}: rows still stale (locked by another transaction, or on a key version above the active one)`,
        );
      }
    } catch (error) {
      result.failedTenants += 1;
      log.error(
        `HRIS PII re-seal failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    if (result.aborted) break;
  }
  return result;
}

type HrisPiiResealBoss = {
  createQueue(
    name: string,
    options?: { policy?: string; expireInSeconds?: number },
  ): Promise<void>;
  work(
    name: string,
    handler: (jobs: { data: unknown }[]) => Promise<void>,
  ): Promise<unknown>;
};

/** Job payload: the key version the operator meant to move rows to. */
function assertTargetKeyVersion(data: unknown, active: number): void {
  const target =
    typeof data === "object" && data !== null
      ? (data as { targetKeyVersion?: unknown }).targetKeyVersion
      : undefined;
  if (target !== active)
    throw new Error(
      "HRIS PII re-seal refused: job targetKeyVersion is missing or differs from this worker's active key version",
    );
}

/**
 * Call after the boss has started. On demand only: queue a job named
 * `hris-pii-reseal` with data `{ targetKeyVersion }` after a rotation.
 * `exclusive` keeps two runs apart.
 */
export async function registerHrisPiiResealJob(options: {
  boss: HrisPiiResealBoss;
  database?: Database;
  log?: Pick<Console, "error" | "info">;
  /** Test hook; defaults to every tenant. */
  listTenantIds?: () => Promise<string[]>;
}): Promise<void> {
  const { boss } = options;
  const log = options.log ?? console;
  await boss.createQueue(HRIS_PII_RESEAL_QUEUE, {
    policy: "exclusive",
    expireInSeconds: HRIS_PII_RESEAL_EXPIRE_SECONDS,
  });
  await boss.work(HRIS_PII_RESEAL_QUEUE, async (jobs) => {
    try {
      // Refuse before any write when a job targets another version.
      for (const job of jobs)
        assertTargetKeyVersion(job.data, HRIS_PII_KEY_VERSION);
      const result = await runHrisPiiReseal({
        log,
        ...(options.database ? { database: options.database } : {}),
        ...(options.listTenantIds
          ? { listTenantIds: options.listTenantIds }
          : {}),
      });
      log.info(`HRIS PII re-seal finished ${JSON.stringify(result)}`);
      // A failed or incomplete tenant fails the job so pg-boss records it and
      // retries; a rerun is safe and only touches the rows still stale.
      if (result.failedTenants > 0)
        throw new Error(
          `HRIS PII re-seal failed for ${result.failedTenants} tenant(s)`,
        );
      if (result.incompleteTenants > 0)
        throw new Error(
          `HRIS PII re-seal incomplete for ${result.incompleteTenants} tenant(s): rows still stale`,
        );
    } catch (error) {
      log.error(
        `HRIS PII re-seal job failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      throw error;
    }
  });
}
