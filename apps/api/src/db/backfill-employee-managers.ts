// One-off backfill (bead legend-qhqf8): commit 4b7eb37a limits supervisor and
// outlet_manager to their direct reports (`employees.manager_id` = own employee
// id). Active employees with a NULL manager_id (or a manager who is no longer
// active, or who sits in another outlet) are invisible to them. This script
// proposes the single active outlet_manager of the employee's home outlet as the
// manager, and writes it only for rows that HR has reviewed (--ids).
//
// Only "auto" items are ever written: manager_id NULL, or a manager that is not
// active, where exactly one active outlet_manager (whose home outlet is that
// outlet, and who is not the employee) exists, assigning him creates no cycle,
// and the employee holds only junior roles (JUNIOR_ROLE_KEYS), so a junior is
// never made the manager of someone senior. Everything else is "manual" (a
// manager-level role, no / several outlet managers, a cycle, or a manager in
// another outlet, which may be a legitimate area supervisor) and is
// only listed for a human to resolve in the HR screen. The script never changes
// status or any other column, and has no undo mode: the audit rows hold the
// before values.
//
// Run order, per environment:
//   (a) deploy a build that contains this script.
//   (b) pnpm db:backfill-employee-managers            (dry-run: auto and manual lists)
//   (c) HR lead reviews the auto list with the outlet manager; save the approved
//       employee ids to a file, one per line.
//   (d) pnpm db:backfill-employee-managers --apply --ids <file>
//   (e) dry-run again, expect 0 auto items; resolve the manual list in the HR screen.
//   (f) only then roll out the supervisor / outlet_manager direct-report scope.
//
// Reads MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE (a path to a file
// holding the URL, not both); with neither set it falls back to the local dev
// DATABASE_URL. URLs are never printed. Runs as the migration owner, one
// transaction per tenant so each UPDATE and its audit row commit together.
// Never run by an agent against staging or production.
//
// Output is logged per tenant as soon as that tenant is done (a summary line,
// its auto lines, and for apply an `updated=<n> skipped=<n>` line). If a tenant
// throws, the error propagates (exit 1) after the earlier tenants have already
// committed and been logged; later tenants are not touched. Full names and user
// ids are never printed.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  createUlid,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { recordAudit } from "../services/core-audit.ts";
import {
  JUNIOR_ROLE_KEYS,
  chainReaches,
  isJuniorOnly,
  loadRoleKeys,
} from "../services/hris-manager-rules.ts";
import { databaseError, databaseUrl } from "./connection";
import * as schema from "./schema";

export const BACKFILL_ACTION = "hris.employee_manager_backfill";
export const BACKFILL_REASON = "legend-qhqf8 512 backfill manager_id";

export const USAGE =
  "Usage: db:backfill-employee-managers [--dry-run | --apply] [--ids <file>] [--tenant <uuid>]\n" +
  "  --dry-run         (default) list the employees that would get a manager, write nothing\n" +
  "  --apply           set manager_id and write one audit row per employee\n" +
  "  --ids <file>      reviewed employee ids, one uuid per line (blank and # lines\n" +
  "                    ignored); required for --apply, only these rows are touched\n" +
  "  --tenant <uuid>   only this tenant (default: every tenant)\n" +
  "Run order: (a) deploy a build with this script; (b) dry-run; (c) HR lead reviews the auto\n" +
  "  list with the outlet manager, save the approved ids to a file; (d) --apply --ids <file>;\n" +
  "  (e) dry-run again, expect 0 auto items, resolve the manual list in the HR screen;\n" +
  "  (f) only then roll out the direct-report scope.";

/** Bad arguments or input file; nothing was read or written. Exit code 2. */
export class BackfillUsageError extends Error {}

export type ManagerIssue =
  "no_manager" | "manager_inactive" | "manager_cross_outlet";

// Shared with the manager-change service; re-exported for the tests.
export { JUNIOR_ROLE_KEYS };

export type ManualReason =
  | "holds_manager_role"
  | "no_outlet_manager"
  | "ambiguous_outlet_manager"
  | "would_cycle"
  | "cross_outlet_needs_review";

export type EmployeeRow = {
  id: string;
  employeeNo: string;
  userId: string | null;
  managerId: string | null;
  homeOutletId: string;
  status: string;
  /** template_key of every currently valid role of the user ("custom" if none). */
  roleKeys: string[];
};

/** The employee is already joined from a valid outlet_manager assignment. */
export type OutletManagerRow = {
  outletId: string;
  employeeId: string;
};

export type Finding = {
  employeeId: string;
  employeeNo: string;
  outletId: string;
  issue: ManagerIssue;
  currentManagerId: string | null;
  proposedManagerId: string | null;
  action: "auto" | "manual";
  manualReason?: ManualReason;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses the --ids file: one uuid per line, blank and `#` lines ignored. */
export function parseIdsFile(text: string): string[] {
  const ids: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (!UUID.test(line))
      throw new BackfillUsageError(
        `--ids file line ${index + 1} is not an employee uuid.`,
      );
    ids.push(line.toLowerCase());
  });
  if (ids.length === 0)
    throw new BackfillUsageError("--ids file lists no employee ids.");
  return [...new Set(ids)];
}

// ----------------------------------------------------------- classification

type Index = {
  byId: Map<string, EmployeeRow>;
  managersByOutlet: Map<string, Set<string>>;
};

function buildIndex(
  employees: EmployeeRow[],
  outletManagers: OutletManagerRow[],
): Index {
  const byId = new Map(employees.map((row) => [row.id, row]));
  const managersByOutlet = new Map<string, Set<string>>();
  for (const row of outletManagers) {
    const set = managersByOutlet.get(row.outletId) ?? new Set<string>();
    set.add(row.employeeId);
    managersByOutlet.set(row.outletId, set);
  }
  return { byId, managersByOutlet };
}

/** True when the manager chain above `startId` reaches `employeeId`. */
function indexChainReaches(index: Index, startId: string, employeeId: string) {
  return chainReaches(
    (id) => index.byId.get(id)?.managerId,
    startId,
    employeeId,
  );
}

function propose(
  index: Index,
  employee: EmployeeRow,
): { proposedManagerId: string | null; manualReason?: ManualReason } {
  const candidates = [
    ...(index.managersByOutlet.get(employee.homeOutletId) ?? []),
  ].filter((id) => {
    const manager = index.byId.get(id);
    return (
      id !== employee.id &&
      manager?.status === "active" &&
      manager.homeOutletId === employee.homeOutletId
    );
  });
  if (candidates.length === 0)
    return { proposedManagerId: null, manualReason: "no_outlet_manager" };
  if (candidates.length > 1)
    return {
      proposedManagerId: null,
      manualReason: "ambiguous_outlet_manager",
    };
  const proposed = candidates[0]!;
  if (indexChainReaches(index, proposed, employee.id))
    return { proposedManagerId: proposed, manualReason: "would_cycle" };
  return { proposedManagerId: proposed };
}

function classifyOne(index: Index, employee: EmployeeRow): Finding | null {
  if (employee.status !== "active") return null;
  const manager = employee.managerId
    ? index.byId.get(employee.managerId)
    : undefined;
  let issue: ManagerIssue;
  if (!employee.managerId) issue = "no_manager";
  else if (!manager || manager.status !== "active") issue = "manager_inactive";
  else if (manager.homeOutletId !== employee.homeOutletId)
    issue = "manager_cross_outlet";
  else return null;

  const base = {
    employeeId: employee.id,
    employeeNo: employee.employeeNo,
    outletId: employee.homeOutletId,
    issue,
    currentManagerId: employee.managerId,
  };
  const proposal = propose(index, employee);
  // An area supervisor may legitimately span outlets: a human decides.
  if (issue === "manager_cross_outlet")
    return {
      ...base,
      proposedManagerId: proposal.proposedManagerId,
      action: "manual",
      manualReason: "cross_outlet_needs_review",
    };
  // Never put a senior (or unknown custom role) under an outlet manager.
  if (!isJuniorOnly(employee.roleKeys))
    return {
      ...base,
      proposedManagerId: null,
      action: "manual",
      manualReason: "holds_manager_role",
    };
  if (proposal.manualReason)
    return {
      ...base,
      proposedManagerId: proposal.proposedManagerId,
      action: "manual",
      manualReason: proposal.manualReason,
    };
  return {
    ...base,
    proposedManagerId: proposal.proposedManagerId,
    action: "auto",
  };
}

/** Pure: which active employees lack a usable manager, and who could be it. */
export function classifyEmployees(input: {
  employees: EmployeeRow[];
  outletManagers: OutletManagerRow[];
}): { findings: Finding[] } {
  const index = buildIndex(input.employees, input.outletManagers);
  const findings: Finding[] = [];
  for (const employee of input.employees) {
    const finding = classifyOne(index, employee);
    if (finding) findings.push(finding);
  }
  return { findings };
}

// ----------------------------------------------------------------------- db

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function tenantContext(tenantId: string): ScopedTenantContext {
  // The same context the worker builds per tenant (worker/production-config.ts
  // resolveContext): job source, tenant-wide scope.
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantId as TenantId,
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );
}

/** Owner connections are subject to FORCE RLS: install the tenant like `withTenant`. */
async function enterTenant(tx: Tx, tenantId: string) {
  await tx.execute(
    sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.outlet_ids', '*', true)`,
  );
}

async function loadTenantState(tx: Tx, tenantId: string, now: Date) {
  const employeeRows = await tx.execute(
    sql`SELECT id, employee_no, user_id, manager_id, home_outlet_id, status
        FROM employees WHERE tenant_id = ${tenantId}::uuid ORDER BY employee_no, id`,
  );
  const roleKeysByEmployee = await loadRoleKeys(tx, tenantId, null, now);
  const employees: EmployeeRow[] = employeeRows.rows.map((row) => {
    const userId = row.user_id == null ? null : String(row.user_id);
    const id = String(row.id);
    return {
      id,
      employeeNo: String(row.employee_no),
      userId,
      managerId: row.manager_id == null ? null : String(row.manager_id),
      homeOutletId: String(row.home_outlet_id),
      status: String(row.status),
      roleKeys: roleKeysByEmployee.get(id) ?? [],
    };
  });
  const managerRows = await tx.execute(
    sql`SELECT DISTINCT ra.scope_id AS outlet_id, e.id AS employee_id
        FROM role_assignments ra
        JOIN roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        JOIN employees e ON e.tenant_id = ra.tenant_id AND e.user_id = ra.user_id
        WHERE ra.tenant_id = ${tenantId}::uuid
          AND ra.scope_type = 'outlet'
          AND r.template_key = 'outlet_manager'
          AND ra.valid_from <= ${now}
          AND (ra.valid_until IS NULL OR ra.valid_until > ${now})`,
  );
  const outletManagers: OutletManagerRow[] = managerRows.rows.map((row) => ({
    outletId: String(row.outlet_id),
    employeeId: String(row.employee_id),
  }));
  return { employees, outletManagers };
}

export type BackfillResult = {
  apply: boolean;
  /** Every finding of the read pass, across the tenants that were read. */
  findings: Finding[];
  /** Employees whose manager_id was written (apply only). */
  applied: number;
  /** Ids from --ids that were no longer an auto item with the same proposal; never touched. */
  skipped: string[];
  /** Findings that need a human decision; never touched. */
  manual: Finding[];
};

export async function run(options: {
  pool: Pool;
  apply: boolean;
  now: Date;
  log: (line: string) => void;
  /** Reviewed employee ids; required for apply, rows outside it are never touched. */
  ids?: string[];
  /** Only this tenant; default every tenant. */
  tenantId?: string;
}): Promise<BackfillResult> {
  const { pool, apply, now, log } = options;
  const ids = options.ids?.map((id) => id.toLowerCase());
  if (apply && !ids)
    throw new BackfillUsageError("--apply requires --ids <file>.");
  if (ids?.some((id) => !UUID.test(id)))
    throw new BackfillUsageError("--ids holds a value that is not a uuid.");
  if (options.tenantId && !UUID.test(options.tenantId))
    throw new BackfillUsageError("--tenant is not a uuid.");
  const idSet = ids ? new Set(ids) : undefined;
  const db = drizzle(pool, { schema });
  const tenantIds = (
    options.tenantId
      ? await db.execute(
          sql`SELECT id FROM tenants WHERE id = ${options.tenantId}::uuid`,
        )
      : await db.execute(sql`SELECT id FROM tenants ORDER BY id`)
  ).rows.map((row) => String(row.id));

  const allFindings: Finding[] = [];
  const allManual: Finding[] = [];
  const skipped: string[] = [];
  let applied = 0;
  const manualLines: string[] = [];
  const autoIds: string[] = [];

  for (const tenantId of tenantIds) {
    // Read pass: read-only, nothing is written here.
    const findings = await db.transaction(
      async (tx) => {
        await enterTenant(tx, tenantId);
        return classifyEmployees(await loadTenantState(tx, tenantId, now))
          .findings;
      },
      { accessMode: "read only" },
    );
    allFindings.push(...findings);
    const counts: Record<ManagerIssue, number> = {
      no_manager: 0,
      manager_inactive: 0,
      manager_cross_outlet: 0,
    };
    const tenantAutoLines: string[] = [];
    let tenantManual = 0;
    for (const finding of findings) {
      counts[finding.issue] += 1;
      if (finding.action === "manual") {
        tenantManual += 1;
        allManual.push(finding);
        manualLines.push(
          `${tenantId},${finding.employeeId},${finding.employeeNo},${finding.outletId},${finding.issue},${finding.manualReason ?? ""}`,
        );
      } else if (!idSet || idSet.has(finding.employeeId)) {
        autoIds.push(finding.employeeId);
        tenantAutoLines.push(
          `tenant=${tenantId} employee=${finding.employeeId} no=${finding.employeeNo} outlet=${finding.outletId} issue=${finding.issue} current=${finding.currentManagerId ?? "-"} proposed=${finding.proposedManagerId ?? "-"}`,
        );
      }
    }
    log(
      `tenant=${tenantId} findings=${findings.length} auto=${findings.length - tenantManual} manual=${tenantManual} ` +
        `no_manager=${counts.no_manager} manager_inactive=${counts.manager_inactive} ` +
        `manager_cross_outlet=${counts.manager_cross_outlet}`,
    );
    for (const line of tenantAutoLines) log(line);
    if (!apply) continue;

    const candidates = findings.filter(
      (finding) => finding.action === "auto" && idSet!.has(finding.employeeId),
    );
    // Reviewed ids that are employees of THIS tenant: whatever is not written
    // below is reported as skipped for this tenant.
    const reviewedHere = await db.transaction(
      async (tx) => {
        await enterTenant(tx, tenantId);
        const rows = await tx.execute(
          sql`SELECT id FROM employees
              WHERE tenant_id = ${tenantId}::uuid AND id IN (${sql.join(
                [...idSet!].map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`,
        );
        return rows.rows.map((row) => String(row.id));
      },
      { accessMode: "read only" },
    );
    const writtenIds = new Set<string>();
    const logTenantResult = () => {
      const notWritten = reviewedHere.filter((id) => !writtenIds.has(id));
      skipped.push(...notWritten.filter((id) => !skipped.includes(id)));
      log(
        `tenant=${tenantId} updated=${writtenIds.size} skipped=${notWritten.length}`,
      );
    };
    if (candidates.length === 0) {
      logTenantResult();
      continue;
    }
    const context = tenantContext(tenantId);
    const tenantApplied = await db.transaction(async (tx) => {
      await enterTenant(tx, tenantId);
      // Same per-tenant lock as the online "ubah atasan" endpoint
      // (hris-employee-manager.service.ts), so the two can never close a cycle
      // together.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`hris.employee_manager:${tenantId}`}))`,
      );
      // Lock first, then classify again on the locked state: a row may have
      // changed since the read pass.
      await tx.execute(
        sql`SELECT id FROM employees
            WHERE tenant_id = ${tenantId}::uuid AND id IN (${sql.join(
              candidates.map((finding) => sql`${finding.employeeId}::uuid`),
              sql`, `,
            )})
            ORDER BY id FOR UPDATE`,
      );
      const state = await loadTenantState(tx, tenantId, now);
      const index = buildIndex(state.employees, state.outletManagers);
      let count = 0;
      for (const candidate of candidates) {
        const employee = index.byId.get(candidate.employeeId);
        // Re-evaluated against the rows already updated in this transaction,
        // so two updates can never close a cycle together.
        const fresh = employee ? classifyOne(index, employee) : null;
        if (
          !employee ||
          !fresh ||
          fresh.action !== "auto" ||
          fresh.currentManagerId !== candidate.currentManagerId ||
          fresh.proposedManagerId !== candidate.proposedManagerId ||
          !fresh.proposedManagerId
        ) {
          continue;
        }
        const updated = await tx.execute(
          sql`UPDATE employees SET manager_id = ${fresh.proposedManagerId}::uuid, updated_at = ${now}
              WHERE tenant_id = ${tenantId}::uuid AND id = ${employee.id}::uuid
                AND status = 'active'
                AND manager_id IS NOT DISTINCT FROM ${fresh.currentManagerId}::uuid
              RETURNING id`,
        );
        if (updated.rowCount !== 1) continue;
        index.byId.set(employee.id, {
          ...employee,
          managerId: fresh.proposedManagerId,
        });
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(now.getTime()),
            tenantId,
            outletId: employee.homeOutletId,
            actorType: "system",
            actorId: null,
            deviceId: null,
            action: BACKFILL_ACTION,
            objectType: "employee",
            objectId: employee.id,
            reason: BACKFILL_REASON,
            maskedChanges: {
              before: { managerId: fresh.currentManagerId },
              after: { managerId: fresh.proposedManagerId },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: now.toISOString(),
          },
          ["managerId"],
        );
        writtenIds.add(employee.id);
        count += 1;
      }
      return count;
    });
    applied += tenantApplied;
    logTenantResult();
  }

  // Ids named in --ids that were never an auto item at all.
  if (idSet) {
    const autoSeen = new Set(
      allFindings
        .filter((finding) => finding.action === "auto")
        .map((finding) => finding.employeeId),
    );
    for (const id of idSet)
      if (!autoSeen.has(id) && !skipped.includes(id)) skipped.push(id);
  }

  log(
    `Total: findings=${allFindings.length} auto=${allFindings.length - allManual.length} manual=${allManual.length}`,
  );
  for (const id of skipped)
    log(
      `SKIPPED employee=${id}: listed in --ids but no longer an auto item with the same proposal.`,
    );
  log(
    "# MANUAL LIST (csv: tenant_id,employee_id,employee_no,outlet_id,issue,reason)",
  );
  for (const line of manualLines) log(line);
  if (!apply) {
    if (autoIds.length > 0) {
      log("# Ids for review (save approved to a file for --ids)");
      for (const id of autoIds) log(id);
      log("Dry-run: nothing written. Add --apply --ids <file>.");
    }
  } else {
    log(`Updated ${applied} employee(s), ${applied} audit row(s) written.`);
  }
  return {
    apply,
    findings: allFindings,
    applied,
    skipped,
    manual: allManual,
  };
}

// ---------------------------------------------------------------------- cli

/**
 * MIGRATION_DATABASE_URL or _FILE (not both). The dev path falls back to the
 * local DATABASE_URL.
 */
function migrationDatabaseUrl(requireMigrationUrl: boolean) {
  const direct = process.env.MIGRATION_DATABASE_URL;
  const file = process.env.MIGRATION_DATABASE_URL_FILE;
  if (direct && file)
    throw new BackfillUsageError(
      "Set MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE, not both.",
    );
  if (file) {
    let value: string;
    try {
      value = readFileSync(file, "utf8").trim();
    } catch {
      throw new BackfillUsageError(
        "Cannot read the file named by MIGRATION_DATABASE_URL_FILE.",
      );
    }
    return databaseUrl(value);
  }
  if (!direct && requireMigrationUrl)
    throw new BackfillUsageError(
      "MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL_FILE is required.",
    );
  return direct ? databaseUrl(direct) : databaseUrl();
}

/** Parses the CLI arguments and reads the --ids file. Throws BackfillUsageError. */
export function parseArgs(args: string[]) {
  let apply = false;
  let dryRun = false;
  let idsFile: string | undefined;
  let tenantId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--ids" && args[i + 1] && !idsFile) idsFile = args[++i];
    else if (arg === "--tenant" && args[i + 1] && !tenantId) {
      tenantId = args[++i]!.toLowerCase();
      if (!UUID.test(tenantId))
        throw new BackfillUsageError("--tenant is not a uuid.");
    } else throw new BackfillUsageError("Unknown or repeated argument.");
  }
  if (apply && dryRun)
    throw new BackfillUsageError("Use --apply or --dry-run, not both.");
  let ids: string[] | undefined;
  if (idsFile) {
    let text: string;
    try {
      text = readFileSync(idsFile, "utf8");
    } catch {
      throw new BackfillUsageError("Cannot read the --ids file.");
    }
    ids = parseIdsFile(text);
  }
  if (apply && !ids)
    throw new BackfillUsageError("--apply requires --ids <file>.");
  return { apply, ids, tenantId };
}

/**
 * The CLI behind `pnpm db:backfill-employee-managers` (tsx, `loadEnv: true`).
 * Returns the exit code: 2 usage, 1 error, 0 ok. Never prints a URL.
 */
export async function cli(
  args: string[],
  options: { loadEnv: boolean },
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    if (!(error instanceof BackfillUsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.loadEnv) await import("../load-env");
  let pool: Pool | undefined;
  try {
    pool = new Pool({
      connectionString: migrationDatabaseUrl(!options.loadEnv),
      max: 1,
    });
    await run({
      pool,
      ...parsed,
      now: new Date(),
      log: (line) => console.log(line),
    });
    return 0;
  } catch (error) {
    if (error instanceof BackfillUsageError) {
      console.error(`${error.message}\n${USAGE}`);
      return 2;
    }
    console.error(databaseError(error));
    return 1;
  } finally {
    await pool?.end();
  }
}

// tsx entry point only: the file name check keeps a bundler that inlines this
// module from running the CLI twice.
const entry = process.argv[1];
if (
  entry &&
  /backfill-employee-managers\.ts$/.test(entry) &&
  import.meta.url === pathToFileURL(entry).href
)
  process.exitCode = await cli(process.argv.slice(2), { loadEnv: true });
