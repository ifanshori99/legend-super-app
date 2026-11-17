// Employee PPh 21 receivable as an accounting open item (bead legend-itph,
// brief docs/briefs/972-payroll-sisa.md; founder decision B8; account 1204).
// Fail-first: written before the feature exists.
//
// RULES UNDER TEST
//  1. A payslip with `tax.pph21ReceivableIdr` > 0 of a live (locked) run gives
//     exactly ONE open item per employee and run: kind `receivable`,
//     counterparty type `employee`, counterparty id = the employee id,
//     original amount = the raised receivable. An employee without a raised
//     receivable gets none.
//  2. No double receivable: syncing again (also concurrently), simulating a
//     later run again, locking, reversing: never a second item for the same
//     slip, never an outstanding amount that differs from the payslip balance
//     `pph21ReceivableBalance` (raised minus collected "pph21_receivable"
//     lines).
//  3. A later run that collects the receivable (lock) settles the item;
//     a partial collection leaves the rest outstanding and visible to finance
//     (the remaining receivable of an employee, also one who left).
//  4. Reversing the run that raised the receivable leaves no outstanding item
//     and the item does not come back. A reversal blocked by a later
//     collection changes nothing.
//  5. Tenant isolation (TEN-01): rows are filtered by tenant in SQL and by RLS
//     (role legend_app); another tenant's run is not found.
//
// EXPECTED INTERFACE (the engineer builds exactly this; names are the test's
// contract, the spec is silent)
//  - shared: `counterpartyTypeSchema` (packages/shared/src/accounting/
//    payables.ts) gains "employee"; the DB CHECK on
//    accounting_open_items.counterparty_type accepts 'employee' (migration).
//  - NEW file apps/api/src/services/payroll-pph21-receivable-open-items.service.ts
//    exports `syncPph21ReceivableOpenItemsInTransaction(tx, scope,
//    payrollRunId): Promise<void>`. Idempotent. For a run that is locked or
//    paid it (a) creates the item of each slip that raises a receivable and
//    (b) records the settlement of the open item(s) of that employee for the
//    "pph21_receivable" lines the run collected. For a reversed run it leaves
//    nothing outstanding (item removed or voided) and never recreates it. A
//    run of another tenant is a 404 (status 404). A run that is not
//    locked/paid (draft, simulated, approved) creates and changes nothing.
//  - Lock calls the sync after sealing; reversal calls it after reversing.
//    Simulate never touches open items.
//  - Read side is the existing finance endpoint
//    GET /api/accounting/open-items?legalEntityId=..&kind=receivable
//    (&counterpartyId=<employee id>), rows with counterpartyType "employee".
//
// ASSUMPTIONS (spec silent)
//  - A receivable is raised on a locked payslip by tampering with its sealed
//    calculation (same fixture as payroll-run-followup-guards.test.ts,
//    `seedOpenReceivable`), then calling the sync once by hand, because the
//    engine cannot raise one in a cheap fixture. The lock and reversal hooks
//    are tested for the later steps without calling the sync by hand.
//  - documentDate of the item = pay date of the run that raised it.
//  - counterpartyName = the employee name.
//  - Items are not hidden for employees who left (no offboarding filter):
//    finance sees every outstanding item.
//  - The item is not "outstanding" in the list once fully settled or voided.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  payrollRunIdSchema,
  pph21ReceivableBalance,
} from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { userIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  openPayrollValue,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  approveSimulatedRun,
  deleteStatutoryTables,
  insertDraftRun,
  insertEmployee,
  insertPolicy,
  insertSalary,
  publishStatutoryTables,
} from "./payroll-simulate-kit.ts";

const logStream = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
const app = createApp({
  logger: createLogger({ level: "debug", destination: logStream }),
  storageRuntime: {
    storage: new FakeObjectStorage(),
    scanner: new NoopMalwareScanner(),
    fileSigner: async () => null,
    hrisDocumentSigner: async () => null,
  },
});

const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = cafeLegendPlatformFixtures.outlets[0];
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdRuns: string[] = [];
const createdEntities: string[] = [];
const createdPolicies: string[] = [];
const otherTenantIds: string[] = [];
const otherEntityIds: string[] = [];

const key = () => `oi-972-${randomUUID()}`;
const SALARY = 15_000_000;
const X = 50_000;

const tenantScope = (tenantId: string = tenant.id): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
  raw = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (raw) await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function grantRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `OI972 ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await conn.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, userId, roleId],
    );
  });
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let hr: Client;
let finance: Client;
let lockerUserId: string;
let approverUserId: string;

let counter = 0;
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};

type World = { entityId: string; policyId: string };
type Emp = { id: string; name: string };

async function makeWorld(): Promise<World> {
  const world = { entityId: randomUUID(), policyId: randomUUID() };
  createdEntities.push(world.entityId);
  createdPolicies.push(world.policyId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [world.entityId, tenant.id, `PT Piutang ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, lockerUserId);
  });
  return world;
}

/** An active pkwtt employee TK/0 with a NPWP and a bank account, gross scheme. */
async function makeEmployee(world: World): Promise<Emp> {
  const emp: Emp = { id: randomUUID(), name: `Karyawan Piutang ${++counter}` };
  createdEmployees.push(emp.id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: outlet.id,
      entityId: world.entityId,
      id: emp.id,
      name: emp.name,
      joinDate: "2025-03-01",
      ptkpStatus: "TK/0",
      taxScheme: "gross",
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: emp.id,
      amount: SALARY,
      scheme: "gross",
      createdBy: lockerUserId,
    });
  });
  const put = await hr
    .put(`/api/hris/employees/${emp.id}/pii`)
    .set(originHeader)
    .send({
      nik: digits(16),
      npwp: digits(15),
      bankAccount: digits(12),
      idempotencyKey: key(),
    });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return emp;
}

type RunDates = { periodStart: string; periodEnd: string; payDate: string };

/** Month `m` (1-12) of `year`, paid on the 28th. */
const monthDates = (m: number, year = 2026): RunDates => {
  const mm = String(m).padStart(2, "0");
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return {
    periodStart: `${year}-${mm}-01`,
    periodEnd: `${year}-${mm}-${last}`,
    payDate: `${year}-${mm}-28`,
  };
};

async function draftRun(world: World, dates: RunDates): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  await asTenant((conn) =>
    insertDraftRun(conn, {
      tenantId: tenant.id,
      runId,
      entityId: world.entityId,
      policyId: world.policyId,
      ...dates,
    }),
  );
  return runId;
}

async function simulateRun(runId: string) {
  const { simulatePayrollRunInTransaction } =
    await import("../services/payroll-run-simulate.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    simulatePayrollRunInTransaction(
      tx,
      tenantScope(),
      lockerUserId,
      payrollRunIdSchema.parse(runId),
    ),
  );
}

async function lockRun(runId: string) {
  const { lockPayrollRunInTransaction } =
    await import("../services/payroll-run-lock.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    lockPayrollRunInTransaction(tx, tenantScope(), lockerUserId, {
      payrollRunId: payrollRunIdSchema.parse(runId),
    }),
  );
}

async function reverseRun(runId: string) {
  const {
    requestPayrollRunReversalInTransaction,
    decidePayrollRunReversalInTransaction,
  } = await import("../services/payroll-run-reversal.service.ts");
  const id = payrollRunIdSchema.parse(runId);
  await withTenant(db, tenantScope(), (tx) =>
    requestPayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      lockerUserId,
      id,
      "Salah hitung, dibatalkan",
    ),
  );
  await withTenant(db, tenantScope(), (tx) =>
    decidePayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      approverUserId,
      id,
      "approve",
    ),
  );
}

/** The new service of this card (does not exist yet: fail-first). */
async function syncItems(
  runId: string,
  scope: ScopedTenantContext = tenantScope(),
) {
  const { syncPph21ReceivableOpenItemsInTransaction } =
    await import("../services/payroll-pph21-receivable-open-items.service.ts");
  return withTenant(db, scope, (tx) =>
    syncPph21ReceivableOpenItemsInTransaction(
      tx,
      scope,
      payrollRunIdSchema.parse(runId),
    ),
  );
}

const scalar = (sqlText: string, params: unknown[]) =>
  asTenant(async (conn) => (await conn.query(sqlText, params)).rows[0]);

const runStatus = async (runId: string) =>
  (
    await scalar(
      "SELECT status FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, runId],
    )
  ).status as string;

async function lockedRun(world: World, dates: RunDates) {
  const runId = await draftRun(world, dates);
  await simulateRun(runId);
  await asTenant((conn) => approveSimulatedRun(conn, runId));
  await lockRun(runId);
  expect(await runStatus(runId)).toBe("locked");
  return runId;
}

type CollectLine = { category: string; amountIdr: number };
type Calc = {
  netIdr: number;
  lines: CollectLine[];
  tax: { pph21ReceivableIdr?: number };
};

const openSlip = (row: {
  id: string;
  calculation_encrypted: Buffer;
  pii_key_version: number;
}) =>
  JSON.parse(
    openPayrollValue(
      row.calculation_encrypted,
      {
        tenantId: tenant.id,
        table: "payslips",
        rowId: row.id,
        field: "calculation",
      },
      row.pii_key_version,
    ),
  ) as Calc;

const slipsOf = (runIds: readonly string[], emp: Emp) =>
  asTenant(async (conn) =>
    (
      await conn.query(
        `SELECT id, calculation_encrypted, pii_key_version
           FROM payslips
          WHERE tenant_id = $1 AND payroll_run_id = ANY($2) AND employee_id = $3`,
        [tenant.id, runIds, emp.id],
      )
    ).rows.map(openSlip),
  );

const collectedIn = (calcs: readonly Calc[]) =>
  calcs.reduce(
    (total, calc) =>
      total +
      calc.lines
        .filter((l) => l.category === "pph21_receivable")
        .reduce((sum, l) => sum + l.amountIdr, 0),
    0,
  );

/**
 * Raises a PPh 21 receivable on the employee's slip of a locked run by
 * tampering with its sealed calculation (replica role: immutability triggers
 * are off for this fixture only). Same shape as the fixture of
 * payroll-run-followup-guards.test.ts (identity pph21Idr = W + receivable).
 * `amount` omitted: part of the withheld tax becomes the receivable.
 */
async function raiseReceivable(
  runId: string,
  emp: Emp,
  amount?: number,
): Promise<number> {
  return asTenant(async (conn) => {
    const row = (
      await conn.query(
        `SELECT id, calculation_encrypted, pii_key_version FROM payslips
          WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3`,
        [tenant.id, runId, emp.id],
      )
    ).rows[0];
    const calc = openSlip(row) as Calc & {
      deductionsIdr: number;
      pph21Idr: number;
      tax: { pph21WithheldIdr: number; pph21Idr: number };
    };
    const withheld = calc.tax.pph21WithheldIdr;
    expect(withheld, "the seed slip withheld tax").toBeGreaterThan(0);
    const receivable = amount ?? Math.min(X, withheld);
    const tampered =
      amount === undefined
        ? {
            ...calc,
            lines: calc.lines.map((l) =>
              l.category === "pph21"
                ? { ...l, amountIdr: l.amountIdr - receivable }
                : l,
            ),
            deductionsIdr: calc.deductionsIdr - receivable,
            netIdr: calc.netIdr + receivable,
            tax: {
              ...calc.tax,
              pph21WithheldIdr: withheld - receivable,
              pph21ReceivableIdr: receivable,
            },
          }
        : {
            ...calc,
            pph21Idr: calc.pph21Idr + receivable,
            tax: {
              ...calc.tax,
              pph21Idr: calc.tax.pph21Idr + receivable,
              pph21ReceivableIdr: receivable,
            },
          };
    // legend-2fk79: a slip sealed with the open-balance field carries the
    // balance later runs trust (fast path of the loader). Keep it consistent
    // with the raised receivable, as seedOpenReceivable of
    // payroll-run-followup-guards.test.ts does; without it a later run sees 0.
    const OPEN_AFTER = "pph21ReceivableOpenAfterIdr";
    if (OPEN_AFTER in calc)
      (tampered as Record<string, unknown>)[OPEN_AFTER] =
        Number((calc as unknown as Record<string, unknown>)[OPEN_AFTER]) +
        receivable;
    await conn.query(
      `UPDATE payslips SET calculation_encrypted = $3, pii_key_version = $4
        WHERE tenant_id = $1 AND id = $2`,
      [
        tenant.id,
        row.id,
        sealPayrollValue(JSON.stringify(tampered), {
          tenantId: tenant.id,
          table: "payslips",
          rowId: row.id,
          field: "calculation",
        }),
        PAYROLL_SEAL_KEY_VERSION,
      ],
    );
    return receivable;
  }, true);
}

type ItemRow = {
  id: string;
  counterpartyType: string;
  counterpartyId: string;
  counterpartyName: string;
  documentNumber: string;
  documentDate: string;
  originalIdr: number;
  settledIdr: number;
  outstandingIdr: number;
};

/** What finance sees: outstanding receivables, optionally of one employee. */
async function financeList(
  client: Client,
  world: { entityId: string },
  emp?: Emp,
): Promise<ItemRow[]> {
  const res = await client.get(
    `/api/accounting/open-items?legalEntityId=${world.entityId}&kind=receivable&limit=100` +
      (emp ? `&counterpartyId=${emp.id}` : ""),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as ItemRow[];
}

const owed = (rows: readonly ItemRow[]) =>
  rows.reduce((total, row) => total + row.outstandingIdr, 0);

/** Raw rows incl. settled ones: a duplicate cannot hide behind "settled". */
const rawItemCount = async (world: World, emp: Emp) =>
  Number(
    (
      await owner.query(
        `SELECT count(*)::int AS n FROM accounting_open_items
          WHERE tenant_id = $1 AND legal_entity_id = $2
            AND counterparty_type = 'employee' AND counterparty_id = $3`,
        [tenant.id, world.entityId, emp.id],
      )
    ).rows[0].n,
  );

/** The shared payslip oracle: raised minus collected, over the live runs. */
async function slipBalance(runIds: readonly string[], emp: Emp) {
  return pph21ReceivableBalance(
    (await slipsOf(runIds, emp)) as Parameters<
      typeof pph21ReceivableBalance
    >[0],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("OI972 locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  lockerUserId = lock.userId;
  const approver = await signedInClient("OI972 approver");
  await grantRole(approver.userId, ["payroll.view", "payroll.cancel.approve"]);
  approverUserId = approver.userId;
  const hrUser = await signedInClient("OI972 HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  // A finance user (role template), as in accounting-open-items-list.test.ts.
  const fin = await signedInClient("OI972 finance");
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenant.id],
  );
  if (!rows[0]) throw new Error("No finance role template");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenant.id, fin.userId, rows[0].id],
  );
  finance = fin.client;
  // No tenant PPh 21 policy version: the default policy applies.
  await asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
});

afterAll(async () => {
  const entities = [...createdEntities, ...otherEntityIds];
  await owner.query(
    `DELETE FROM accounting_open_item_settlements s
      USING accounting_open_items i
      WHERE s.tenant_id = i.tenant_id AND s.kind = i.kind AND s.open_item_id = i.id
        AND i.legal_entity_id = ANY($1::uuid[])`,
    [entities],
  );
  await owner.query(
    "DELETE FROM accounting_open_items WHERE legal_entity_id = ANY($1::uuid[])",
    [entities],
  );
  if (otherTenantIds.length > 0) {
    await owner.query(
      "DELETE FROM legal_entities WHERE tenant_id = ANY($1::uuid[])",
      [otherTenantIds],
    );
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  }
  await asTenant(async (conn) => {
    for (const table of [
      "payroll_run_results",
      "payroll_run_month_priors",
      "payslip_bank_snapshots",
    ])
      if (
        (await conn.query("SELECT to_regclass($1) AS t", [`public.${table}`]))
          .rows[0].t !== null
      )
        await conn.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND payroll_run_id = ANY($2)`,
          [tenant.id, createdRuns],
        );
    await conn.query(
      "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'oi-972-%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
      createdPolicies,
    ]);
    await deleteStatutoryTables(conn, tenant.id);
    await conn.query(
      "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM employment_contracts WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query("DELETE FROM employees WHERE id = ANY($1)", [
      createdEmployees,
    ]);
    await conn.query("DELETE FROM legal_entities WHERE id = ANY($1)", [
      createdEntities,
    ]);
    await conn.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenant.id, createdUsers],
    );
    await conn.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRoles],
    );
  }, true);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("legend-itph: PPh 21 receivable open item per employee", () => {
  it("one employee open item per slip that raises a receivable, none for the others", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const clean = await makeEmployee(world);
    const jun = await lockedRun(world, monthDates(6, 2025));
    // Lock of a run without any receivable creates nothing (hook, no sync by hand).
    expect(await rawItemCount(world, owes)).toBe(0);
    expect(await rawItemCount(world, clean)).toBe(0);
    expect(await financeList(finance, world)).toEqual([]);

    expect(await raiseReceivable(jun, owes)).toBe(X);
    await syncItems(jun);

    expect(await rawItemCount(world, owes)).toBe(1);
    expect(await rawItemCount(world, clean)).toBe(0);
    const rows = await financeList(finance, world, owes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      counterpartyType: "employee",
      counterpartyId: owes.id,
      counterpartyName: owes.name,
      documentDate: monthDates(6, 2025).payDate,
      originalIdr: X,
      settledIdr: 0,
      outstandingIdr: X,
    });
    expect(rows[0]!.documentNumber.length).toBeGreaterThan(0);
    // Entity-wide list: the owing employee only; never in the payable list.
    expect(
      (await financeList(finance, world)).map((r) => r.counterpartyId),
    ).toEqual([owes.id]);
    const payable = await finance.get(
      `/api/accounting/open-items?legalEntityId=${world.entityId}&kind=payable&limit=100`,
    );
    expect(payable.status).toBe(200);
    expect(payable.body.data).toEqual([]);
  }, 600_000);

  it("syncing again, also at the same time, never makes a second item", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jun = await lockedRun(world, monthDates(6, 2025));
    await raiseReceivable(jun, owes);
    await syncItems(jun);
    await syncItems(jun);
    await Promise.all([syncItems(jun), syncItems(jun), syncItems(jun)]);

    expect(await rawItemCount(world, owes)).toBe(1);
    const rows = await financeList(finance, world, owes);
    expect(owed(rows)).toBe(X);
    expect(owed(rows)).toBe(await slipBalance([jun], owes));
  }, 600_000);

  it("simulating a later run again does not touch the item; its lock settles it once", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jan = await lockedRun(world, monthDates(1, 2026));
    expect(await raiseReceivable(jan, owes)).toBe(X);
    await syncItems(jan);

    const mar = await draftRun(world, monthDates(3, 2026));
    await simulateRun(mar);
    await simulateRun(mar);
    await simulateRun(mar);
    // Simulate collects on paper only: the receivable is still fully open.
    expect(await rawItemCount(world, owes)).toBe(1);
    expect(owed(await financeList(finance, world, owes))).toBe(X);

    await asTenant((conn) => approveSimulatedRun(conn, mar));
    await lockRun(mar); // the hook settles, no sync by hand
    const collected = collectedIn(await slipsOf([mar], owes));
    expect(collected, "Mar collects the whole receivable").toBe(X);

    // Fully collected: one item, settled once, nothing outstanding.
    expect(await rawItemCount(world, owes)).toBe(1);
    expect(await financeList(finance, world, owes)).toEqual([]);
    const { rows } = await owner.query(
      `SELECT original_idr::int AS original_idr, settled_idr::int AS settled_idr FROM accounting_open_items
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND counterparty_id = $3`,
      [tenant.id, world.entityId, owes.id],
    );
    expect(rows).toEqual([{ original_idr: X, settled_idr: X }]);
    expect(await slipBalance([jan, mar], owes)).toBe(0);

    // Syncing both runs again must not settle twice nor create a second item.
    await syncItems(mar);
    await syncItems(jan);
    await syncItems(mar);
    expect(await rawItemCount(world, owes)).toBe(1);
    const again = await owner.query(
      `SELECT settled_idr::int AS settled_idr FROM accounting_open_items
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND counterparty_id = $3`,
      [tenant.id, world.entityId, owes.id],
    );
    expect(again.rows).toEqual([{ settled_idr: X }]);
  }, 900_000);

  it("a collection above the room leaves the rest outstanding and visible to finance", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jul = await lockedRun(world, monthDates(7, 2025));
    const open = 40_000_000;
    expect(await raiseReceivable(jul, owes, open)).toBe(open);
    await syncItems(jul);
    expect(owed(await financeList(finance, world, owes))).toBe(open);

    const nov = await draftRun(world, monthDates(11));
    await simulateRun(nov);
    await asTenant((conn) => approveSimulatedRun(conn, nov));
    await lockRun(nov);
    const collected = collectedIn(await slipsOf([nov], owes));
    expect(collected).toBeGreaterThan(0);
    expect(collected).toBeLessThan(open);

    const rows = await financeList(finance, world, owes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      originalIdr: open,
      settledIdr: collected,
      outstandingIdr: open - collected,
    });
    // The item always equals the payslip balance: never more, never less.
    expect(rows[0]!.outstandingIdr).toBe(await slipBalance([jul, nov], owes));
    expect(await rawItemCount(world, owes)).toBe(1);
  }, 900_000);

  it("reversing the run that raised the receivable leaves nothing outstanding and nothing comes back", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jun = await lockedRun(world, monthDates(6, 2025));
    await raiseReceivable(jun, owes);
    await syncItems(jun);
    expect(owed(await financeList(finance, world, owes))).toBe(X);

    await reverseRun(jun); // the hook removes or voids, no sync by hand
    expect(await runStatus(jun)).toBe("reversed");
    expect(await financeList(finance, world, owes)).toEqual([]);

    await syncItems(jun);
    await syncItems(jun);
    expect(await financeList(finance, world, owes)).toEqual([]);
    expect(await financeList(finance, world)).toEqual([]);
  }, 600_000);

  it("a reversal blocked by a later collection changes nothing", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jun = await lockedRun(world, monthDates(6, 2025));
    await raiseReceivable(jun, owes);
    await syncItems(jun);
    const nov = await draftRun(world, monthDates(11));
    await simulateRun(nov);
    await asTenant((conn) => approveSimulatedRun(conn, nov));
    await lockRun(nov);
    expect(await financeList(finance, world, owes)).toEqual([]);

    await expect(reverseRun(jun)).rejects.toMatchObject({
      status: 409,
      code: "PAYROLL_RUN_REVERSAL_BLOCKED",
    });
    expect(await runStatus(jun)).toBe("locked");
    expect(await rawItemCount(world, owes)).toBe(1);
    const { rows } = await owner.query(
      `SELECT original_idr::int AS original_idr, settled_idr::int AS settled_idr FROM accounting_open_items
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND counterparty_id = $3`,
      [tenant.id, world.entityId, owes.id],
    );
    expect(rows).toEqual([{ original_idr: X, settled_idr: X }]);
  }, 900_000);

  it("a manual AR settlement of an employee item is refused and changes nothing", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jun = await lockedRun(world, monthDates(6, 2025));
    await raiseReceivable(jun, owes);
    await syncItems(jun);
    const [row] = await financeList(finance, world, owes);
    const { settleReceivableInTransaction } =
      await import("../services/accounting-ar.service.ts");
    const manual = (method: "payment" | "write_off") =>
      withTenant(db, tenantScope(), (tx) =>
        settleReceivableInTransaction(
          tx,
          tenantScope(),
          {
            invoiceId: row!.id,
            method,
            receiptId: method === "payment" ? randomUUID() : null,
            settledOn: "2025-07-05",
            amountIdr: X,
            journalEntryId: randomUUID(),
            reason: method === "write_off" ? "Coba hapus" : null,
            idempotencyKey: key(),
          },
          userIdSchema.parse(lockerUserId),
        ),
      );
    for (const method of ["payment", "write_off"] as const)
      await expect(manual(method)).rejects.toMatchObject({
        status: 409,
        code: "PAYROLL_EMPLOYEE_RECEIVABLE_NOT_SETTLEABLE",
      });
    const { rows } = await owner.query(
      `SELECT original_idr::int AS original_idr, settled_idr::int AS settled_idr FROM accounting_open_items
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND counterparty_id = $3`,
      [tenant.id, world.entityId, owes.id],
    );
    expect(rows).toEqual([{ original_idr: X, settled_idr: 0 }]);
  }, 600_000);

  it("TEN-01 an open item is visible only inside its own tenant: SQL filter and RLS", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jun = await lockedRun(world, monthDates(6, 2025));
    await raiseReceivable(jun, owes);
    await syncItems(jun);

    // Another tenant with an employee-party item of its own (this also proves
    // the CHECK accepts party 'employee').
    const otherTenant = randomUUID();
    const otherEntity = randomUUID();
    const otherEmployee = randomUUID();
    otherTenantIds.push(otherTenant);
    otherEntityIds.push(otherEntity);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'OI972 other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `oi972-${randomUUID().slice(0, 8)}`, tenant.id],
    );
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, 'Other entity')",
      [otherEntity, otherTenant],
    );
    await owner.query(
      `INSERT INTO accounting_open_items
         (tenant_id, kind, id, legal_entity_id, counterparty_type, counterparty_id,
          counterparty_name, document_number, document_date, due_on, original_idr)
       VALUES ($1, 'receivable', $2, $3, 'employee', $2, 'Karyawan tenant lain',
               'PPH21-OTHER', '2026-09-01', '2026-09-30', 777)`,
      [otherTenant, otherEmployee, otherEntity],
    );

    // HTTP: the foreign entity is not found; our list never carries its row.
    const foreign = await finance.get(
      `/api/accounting/open-items?legalEntityId=${otherEntity}&kind=receivable`,
    );
    expect(foreign.status).toBe(404);
    const mine = await financeList(finance, world);
    expect(mine.map((r) => r.counterpartyId)).toEqual([owes.id]);
    expect(JSON.stringify(mine)).not.toContain("Karyawan tenant lain");
    const anonymous = await agent(app).get(
      `/api/accounting/open-items?legalEntityId=${world.entityId}&kind=receivable`,
    );
    expect(anonymous.status).toBe(401);

    // Service boundary: another tenant cannot sync our run, nothing changes.
    await expect(
      syncItems(jun, tenantScope(otherTenant)),
    ).rejects.toMatchObject({ status: 404 });
    expect(await rawItemCount(world, owes)).toBe(1);

    // RLS: role legend_app bound to our tenant sees our item, never theirs,
    // and cannot write into theirs.
    const appPool = new Pool({
      connectionString: process.env.APP_DATABASE_URL,
      max: 1,
    });
    try {
      await appPool.query("BEGIN");
      await appPool.query("SET LOCAL ROLE legend_app");
      await appPool.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.id],
      );
      const theirs = await appPool.query(
        "SELECT 1 FROM accounting_open_items WHERE tenant_id = $1 AND counterparty_type = 'employee'",
        [otherTenant],
      );
      expect(theirs.rows).toEqual([]);
      const ours = await appPool.query(
        "SELECT 1 FROM accounting_open_items WHERE counterparty_type = 'employee' AND counterparty_id = $1",
        [owes.id],
      );
      expect(ours.rows).toHaveLength(1);
      await expect(
        appPool.query(
          `INSERT INTO accounting_open_items
             (tenant_id, kind, id, legal_entity_id, counterparty_type, counterparty_id,
              counterparty_name, document_number, document_date, due_on, original_idr)
           VALUES ($1, 'receivable', $2, $3, 'employee', $2, 'x', 'X', '2026-09-01', '2026-09-30', 1)`,
          [otherTenant, randomUUID(), otherEntity],
        ),
      ).rejects.toThrow(/row-level security/);
      await appPool.query("ROLLBACK");
    } finally {
      await appPool.end();
    }
  }, 600_000);
});
