// Backfill of the employee PPh 21 receivable open item (bead legend-i848k,
// brief docs/briefs/983-hr-sisa.md card A; follows 972 / legend-itph).
// Fail-first: written before the backfill exists.
//
// A receivable raised before the open item of 972 existed has NO item in
// accounting_open_items. The backfill gives it one.
//
// RULES UNDER TEST (money: never more than what the employee really owes)
//  1. An employee whose latest live payslip still carries an open receivable
//     (balance = `pph21ReceivableBalance`, raised minus collected) and who has
//     no item gets exactly ONE item: kind `receivable`, counterparty type
//     `employee`, counterparty id = the employee id, outstanding
//     (original - settled) = that remaining balance. Never more than it.
//     An employee without a receivable gets none.
//  2. Idempotent: running the backfill twice (or three times) gives the same
//     rows: same ids, same amounts, no second item.
//  3. An item that already exists (made by the 972 sync, partly or fully
//     settled) is not changed and not duplicated.
//  4. A balance of 0 (fully collected) never gets an item.
//
// EXPECTED INTERFACE (the engineer builds ONE of these; the brief leaves the
// form open: "migrasi data nomor 0555, atau fungsi SQL yang dipanggil test")
//  - A: `apps/api/drizzle/0555_*.sql`, run statement by statement as the
//    runtime role scoped to the tenant (helpers/migration-replay.ts, same as
//    the other data-migration tests); or
//  - B: `apps/api/src/services/payroll-pph21-receivable-backfill.service.ts`
//    exporting `backfillPph21ReceivableOpenItemsInTransaction(tx, scope):
//    Promise<void>` (needed when the sealed payslip cannot be read in SQL).
//    B wins when the file exists.
//
// ASSUMPTIONS (spec silent)
//  - "Before 972" is simulated by building the world with the real services
//    (lock hooks may create items), then deleting every open item and
//    settlement of the test's legal entity, then running the backfill.
//  - Only the outstanding amount (original - settled) is asserted; how the
//    engineer splits original and settled for a partly collected balance is
//    free, as long as outstanding equals the balance.
//  - The backfill spans every legal entity of the tenant; this test only looks
//    at its own entities.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { type ScopedTenantContext } from "@starter/shared/core";
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
import { replayMigrationForTenant } from "./helpers/migration-replay.ts";
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

const key = () => `bf-983-${randomUUID()}`;
const SALARY = 15_000_000;
const X = 50_000;

const tenantScope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
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
        `BF983 ${roleId.slice(0, 8)}`,
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
      [world.entityId, tenant.id, `PT Backfill ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, lockerUserId);
  });
  return world;
}

/** An active pkwtt employee TK/0 with a NPWP and a bank account, gross scheme. */
async function makeEmployee(world: World): Promise<Emp> {
  const emp: Emp = { id: randomUUID(), name: `Karyawan Backfill ${++counter}` };
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

/** Reversal request by the locker, approval by a second user. */
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

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; message: string };
  }
  throw new Error("Expected a failure");
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
 * are off for this fixture only). Same fixture as
 * payroll-pph21-receivable-open-item-972.test.ts.
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
    // Keep the open-balance field of the sealed slip consistent with the
    // raised receivable (later runs trust it).
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

/** Creates the 972 item of a run by hand (the pre-existing item of rule 3). */
async function syncItems(runId: string) {
  const { syncPph21ReceivableOpenItemsInTransaction } =
    await import("../services/payroll-pph21-receivable-open-items.service.ts");
  const scope = tenantScope();
  return withTenant(db, scope, (tx) =>
    syncPph21ReceivableOpenItemsInTransaction(
      tx,
      scope,
      payrollRunIdSchema.parse(runId),
    ),
  );
}

/** The pre-972 state: no open item and no settlement for the entity. */
async function stripItems(world: World) {
  await owner.query(
    `DELETE FROM accounting_open_item_settlements s
      USING accounting_open_items i
      WHERE s.tenant_id = i.tenant_id AND s.kind = i.kind AND s.open_item_id = i.id
        AND i.legal_entity_id = $1`,
    [world.entityId],
  );
  await owner.query(
    "DELETE FROM accounting_open_items WHERE legal_entity_id = $1",
    [world.entityId],
  );
}

type RawItem = {
  id: string;
  kind: string;
  counterparty_type: string;
  original: number;
  settled: number;
  outstanding: number;
};

/** Raw rows incl. settled ones: a duplicate cannot hide behind "settled". */
async function rawItems(world: World, emp: Emp): Promise<RawItem[]> {
  return (
    await owner.query<RawItem>(
      `SELECT id, kind, counterparty_type,
              original_idr::int AS original, settled_idr::int AS settled,
              (original_idr - settled_idr)::int AS outstanding
         FROM accounting_open_items
        WHERE tenant_id = $1 AND legal_entity_id = $2
          AND counterparty_type = 'employee' AND counterparty_id = $3
        ORDER BY id`,
      [tenant.id, world.entityId, emp.id],
    )
  ).rows;
}

type ItemRow = { counterpartyId: string; outstandingIdr: number };

async function financeList(world: World, emp: Emp): Promise<ItemRow[]> {
  const res = await finance.get(
    `/api/accounting/open-items?legalEntityId=${world.entityId}&kind=receivable&limit=100&counterpartyId=${emp.id}`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as ItemRow[];
}

/** The shared payslip oracle: raised minus collected, over the live runs. */
async function slipBalance(runIds: readonly string[], emp: Emp) {
  return pph21ReceivableBalance(
    (await slipsOf(runIds, emp)) as Parameters<
      typeof pph21ReceivableBalance
    >[0],
  );
}

const SERVICE_FILE = resolve(
  import.meta.dirname,
  "../services/payroll-pph21-receivable-backfill.service.ts",
);
const DRIZZLE_DIR = resolve(import.meta.dirname, "../../drizzle");

/** Runs the backfill once (form B if its service exists, else form A). */
async function runBackfill(): Promise<void> {
  if (existsSync(SERVICE_FILE)) {
    const { backfillPph21ReceivableOpenItemsInTransaction } =
      await import("../services/payroll-pph21-receivable-backfill.service.ts");
    const scope = tenantScope();
    await withTenant(db, scope, (tx) =>
      backfillPph21ReceivableOpenItemsInTransaction(tx, scope),
    );
    return;
  }
  const file = readdirSync(DRIZZLE_DIR).find((name) =>
    /^0555_.*\.sql$/.test(name),
  );
  expect(
    file,
    "backfill missing: expected drizzle/0555_*.sql or services/payroll-pph21-receivable-backfill.service.ts",
  ).toBeDefined();
  await replayMigrationForTenant(
    owner,
    readFileSync(resolve(DRIZZLE_DIR, file!), "utf8"),
    tenant.id,
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("BF983 locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  lockerUserId = lock.userId;
  const approver = await signedInClient("BF983 approver");
  await grantRole(approver.userId, ["payroll.view", "payroll.cancel.approve"]);
  approverUserId = approver.userId;
  const hrUser = await signedInClient("BF983 HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  const fin = await signedInClient("BF983 finance");
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
  await asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
});

afterAll(async () => {
  await owner.query(
    `DELETE FROM accounting_open_item_settlements s
      USING accounting_open_items i
      WHERE s.tenant_id = i.tenant_id AND s.kind = i.kind AND s.open_item_id = i.id
        AND i.legal_entity_id = ANY($1::uuid[])`,
    [createdEntities],
  );
  await owner.query(
    "DELETE FROM accounting_open_items WHERE legal_entity_id = ANY($1::uuid[])",
    [createdEntities],
  );
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'bf-983-%'",
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

describe("legend-i848k: backfill of the employee PPh 21 receivable open item", () => {
  it("a pre-972 receivable without item gets one item equal to the remaining balance, not more", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const clean = await makeEmployee(world);
    // Jul 2025 raises a big receivable, Nov 2026 collects only part of it.
    const jul = await lockedRun(world, monthDates(7, 2025));
    const open = 40_000_000;
    expect(await raiseReceivable(jul, owes, open)).toBe(open);
    const nov = await draftRun(world, monthDates(11));
    await simulateRun(nov);
    await asTenant((conn) => approveSimulatedRun(conn, nov));
    await lockRun(nov);
    const collected = collectedIn(await slipsOf([nov], owes));
    expect(collected, "Nov collects part of the receivable").toBeGreaterThan(0);
    expect(collected).toBeLessThan(open);
    const balance = await slipBalance([jul, nov], owes);
    expect(balance).toBe(open - collected);

    await stripItems(world);
    expect(await rawItems(world, owes)).toEqual([]);

    await runBackfill();

    const items = await rawItems(world, owes);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "receivable",
      counterparty_type: "employee",
    });
    // Exactly the remaining balance: never more, never less.
    expect(items[0]!.outstanding).toBeLessThanOrEqual(balance);
    expect(items[0]!.outstanding).toBe(balance);
    // An employee without a receivable gets nothing.
    expect(await rawItems(world, clean)).toEqual([]);
    // Finance sees it in the receivable list.
    const rows = await financeList(world, owes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      counterpartyId: owes.id,
      outstandingIdr: balance,
    });
  }, 900_000);

  it("running the backfill again gives the same rows: same ids, same amounts, no second item", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jan = await lockedRun(world, monthDates(1, 2026));
    expect(await raiseReceivable(jan, owes)).toBe(X);
    await stripItems(world);

    await runBackfill();
    const first = await rawItems(world, owes);
    expect(first).toHaveLength(1);
    expect(first[0]!.outstanding).toBe(await slipBalance([jan], owes));

    await runBackfill();
    await runBackfill();
    expect(await rawItems(world, owes)).toEqual(first);
    expect(
      (await financeList(world, owes)).map((r) => r.outstandingIdr),
    ).toEqual([X]);
  }, 600_000);

  it("an item that already exists is not changed and not duplicated", async () => {
    const world = await makeWorld();
    const partly = await makeEmployee(world);
    const fully = await makeEmployee(world);
    // partly: item from the 972 sync, partly collected by a later run.
    const jul = await lockedRun(world, monthDates(7, 2025));
    const open = 40_000_000;
    expect(await raiseReceivable(jul, partly, open)).toBe(open);
    expect(await raiseReceivable(jul, fully)).toBe(X);
    await syncItems(jul);
    const nov = await draftRun(world, monthDates(11));
    await simulateRun(nov);
    await asTenant((conn) => approveSimulatedRun(conn, nov));
    await lockRun(nov); // the hook settles what it collects
    expect(collectedIn(await slipsOf([nov], partly))).toBeGreaterThan(0);
    expect(collectedIn(await slipsOf([nov], fully))).toBe(X);

    const partlyBefore = await rawItems(world, partly);
    const fullyBefore = await rawItems(world, fully);
    expect(partlyBefore).toHaveLength(1);
    expect(fullyBefore).toHaveLength(1);
    expect(fullyBefore[0]!.outstanding).toBe(0);

    await runBackfill();
    await runBackfill();

    // Same id, same original, same settled: untouched, one row each.
    expect(await rawItems(world, partly)).toEqual(partlyBefore);
    expect(await rawItems(world, fully)).toEqual(fullyBefore);
  }, 900_000);

  it("a receivable fully collected (balance 0) never gets an item", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jan = await lockedRun(world, monthDates(1, 2026));
    expect(await raiseReceivable(jan, owes)).toBe(X);
    await syncItems(jan);
    const mar = await draftRun(world, monthDates(3, 2026));
    await simulateRun(mar);
    await asTenant((conn) => approveSimulatedRun(conn, mar));
    await lockRun(mar);
    expect(collectedIn(await slipsOf([mar], owes))).toBe(X);
    expect(await slipBalance([jan, mar], owes)).toBe(0);

    await stripItems(world);
    await runBackfill();
    await runBackfill();

    expect(await rawItems(world, owes)).toEqual([]);
    expect(await financeList(world, owes)).toEqual([]);
  }, 900_000);

  it("the report splits the result per legal entity and shows what was already open there", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jul = await lockedRun(world, monthDates(7, 2025));
    const open = 40_000_000;
    expect(await raiseReceivable(jul, owes, open)).toBe(open);
    await stripItems(world);

    const { backfillPph21ReceivableOpenItemsInTransaction } =
      await import("../services/payroll-pph21-receivable-backfill.service.ts");
    const scope = tenantScope();
    const run = () =>
      withTenant(db, scope, (tx) =>
        backfillPph21ReceivableOpenItemsInTransaction(tx, scope),
      );
    const mine = (report: Awaited<ReturnType<typeof run>>) =>
      report.entities.filter((e) => e.legalEntityId === world.entityId);

    const first = await run();
    expect(mine(first)).toEqual([
      {
        legalEntityId: world.entityId,
        created: 1,
        createdIdr: open,
        existingIdr: 0,
      },
    ]);
    // Second run: the item exists, nothing to add, and it is shown as existing.
    const second = await run();
    expect(mine(second)).toEqual([
      {
        legalEntityId: world.entityId,
        created: 0,
        createdIdr: 0,
        existingIdr: open,
      },
    ]);
    expect(
      second.entities.reduce((sum, e) => sum + e.created, 0),
      "totals equal the sum of the entities",
    ).toBe(second.created);
  }, 900_000);

  it("a database error while reading a payslip aborts the run; it is not reported as an unreadable payslip", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jul = await lockedRun(world, monthDates(7, 2025));
    expect(await raiseReceivable(jul, owes, 40_000_000)).toBe(40_000_000);
    await stripItems(world);

    const { backfillPph21ReceivableOpenItemsInTransaction } =
      await import("../services/payroll-pph21-receivable-backfill.service.ts");
    const scope = tenantScope();
    const dbError = new Error("simulated: connection terminated");
    await expect(
      withTenant(db, scope, (tx) => {
        // Only the payslip read of the balance oracle (the one that selects
        // the sealed calculation) fails, like a dropped connection would.
        const failing = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop !== "select") return Reflect.get(target, prop, receiver);
            return (fields?: Record<string, unknown>) => {
              if (fields && "calculationEncrypted" in fields) throw dbError;
              return target.select(fields as never);
            };
          },
        });
        return backfillPph21ReceivableOpenItemsInTransaction(failing, scope);
      }),
    ).rejects.toBe(dbError);
    expect(await rawItems(world, owes), "nothing was written").toEqual([]);
  }, 900_000);

  it("reversing a run that raised a receivable is refused while a backfill item of the employee exists", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jan = await lockedRun(world, monthDates(1, 2026));
    expect(await raiseReceivable(jan, owes)).toBe(X);
    await stripItems(world);
    await runBackfill();
    const before = await rawItems(world, owes);
    expect(before, "the backfill made the item").toHaveLength(1);
    expect(before[0]!.outstanding).toBe(X);

    // ASSUMPTION: refused with a 4xx (HttpError); the brief only says "tolak".
    // Reversing would remove the receivable from the slips but leave the
    // backfilled item: finance would list more than the slips say.
    const refused = await failure(reverseRun(jan));
    expect(refused.status ?? 0, refused.message).toBeGreaterThanOrEqual(400);
    expect(refused.status ?? 0, refused.message).toBeLessThan(500);
    expect(await runStatus(jan), "the run stays locked").toBe("locked");
    expect(await rawItems(world, owes), "the item is untouched").toEqual(
      before,
    );
    expect(
      (await financeList(world, owes)).map((r) => r.outstandingIdr),
    ).toEqual([X]);
  }, 600_000);

  it("reversing a run that only COLLECTS a receivable is refused while a backfill item of the employee exists", async () => {
    const world = await makeWorld();
    const owes = await makeEmployee(world);
    const jan = await lockedRun(world, monthDates(1, 2026));
    expect(await raiseReceivable(jan, owes)).toBe(X);
    await stripItems(world);
    await runBackfill();
    expect(
      await rawItems(world, owes),
      "the backfill made the item",
    ).toHaveLength(1);

    // March collects the whole receivable and raises nothing new.
    const mar = await lockedRun(world, monthDates(3, 2026));
    const slips = await slipsOf([mar], owes);
    expect(collectedIn(slips), "March collects the receivable").toBe(X);
    const raisedInMar = slips.reduce(
      (total, calc) => total + (calc.tax.pph21ReceivableIdr ?? 0),
      0,
    );
    expect(raisedInMar, "and raises none").toBe(0);
    const before = await rawItems(world, owes);
    expect(before, "still one item, no duplicate").toHaveLength(1);

    // ASSUMPTION: refused with a 4xx (HttpError); the brief only says "tolak".
    // Un-collecting the receivable would put the balance back on the slips
    // while the backfilled item stays as it is (settled or not): finance and
    // the slips would disagree. The guard looks at runs that raise OR collect.
    const refused = await failure(reverseRun(mar));
    expect(refused.status ?? 0, refused.message).toBeGreaterThanOrEqual(400);
    expect(refused.status ?? 0, refused.message).toBeLessThan(500);
    expect(await runStatus(mar), "the run stays locked").toBe("locked");
    expect(await rawItems(world, owes), "the item is untouched").toEqual(
      before,
    );
  }, 900_000);
});

// ---------------------------------------------------------------------------
// legend-wxvt9: release rehearsal on a disposable database (no staging yet).
// Legacy data (pre-972 receivables, positive/zero/negative, departed employee,
// reversed run, unreadable slip, existing items, two tenants) is built with the
// real services, then the operator command itself is run as a child process:
// dry-run (zero writes, proven by row fingerprints incl. xmin), killed mid-run,
// real run, repeat, two at once, rollback SQL of the runbook, and a later
// payroll run that must collect exactly once. Runbook:
// docs/release/pph21-backfill-rehearsal.md.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const REHEARSAL_CLI = [
  "--filter",
  "@starter/api",
  "payroll:backfill-pph21-receivable",
];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type CliResult = {
  code: number | null;
  signal: string | null;
  out: string;
  err: string;
};
type CliLine = {
  tenantId?: string;
  created?: number;
  createdIdr?: number;
  held?: { legalEntityId: string; employeeId: string; reason: string }[];
  dryRun?: number;
  summary?: { tenants: number; created: number; held: number };
};

/** The operator command exactly as the runbook prints it. */
function spawnCli(args: string[]) {
  const child = spawn("pnpm", [...REHEARSAL_CLI, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise<CliResult>((finish) => {
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code, signal) => finish({ code, signal, out, err }));
  });
  return { child, done };
}

const cliLines = (out: string): CliLine[] =>
  out
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as CliLine);
const tenantLine = (result: CliResult, tenantId: string) => {
  const line = cliLines(result.out).find((l) => l.tenantId === tenantId);
  if (!line) throw new Error(`no report line for the tenant: ${result.out}`);
  return line;
};

describe("legend-wxvt9: release rehearsal of the PPh 21 receivable backfill", () => {
  const otherTenant = {
    id: "",
    entityId: randomUUID(),
    employeeId: randomUUID(),
    runIds: [] as string[],
  };

  /** A tenant id that sorts after the seeded one: it is processed second. */
  const laterTenantId = () => {
    for (;;) {
      const id = randomUUID();
      if (id > tenant.id) return id;
    }
  };

  async function rewriteSlip(
    runId: string,
    emp: Emp,
    change: (calc: Record<string, unknown>) => Record<string, unknown>,
  ) {
    await asTenant(async (conn) => {
      const row = (
        await conn.query(
          `SELECT id, calculation_encrypted, pii_key_version FROM payslips
            WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3`,
          [tenant.id, runId, emp.id],
        )
      ).rows[0];
      const next = change(openSlip(row) as unknown as Record<string, unknown>);
      await conn.query(
        `UPDATE payslips SET calculation_encrypted = $3, pii_key_version = $4
          WHERE tenant_id = $1 AND id = $2`,
        [
          tenant.id,
          row.id,
          sealPayrollValue(JSON.stringify(next), {
            tenantId: tenant.id,
            table: "payslips",
            rowId: row.id,
            field: "calculation",
          }),
          PAYROLL_SEAL_KEY_VERSION,
        ],
      );
    }, true);
  }

  /** Slips written before the carry field existed. */
  const stripCarry = (runIds: string[], emp: Emp) =>
    Promise.all(
      runIds.map((runId) =>
        rewriteSlip(runId, emp, (calc) => {
          const rest = { ...calc };
          delete rest.pph21ReceivableOpenAfterIdr;
          return rest;
        }),
      ),
    );

  async function insertItem(
    entityId: string,
    emp: Emp,
    original: number,
    documentNumber: string,
  ) {
    await owner.query(
      `INSERT INTO accounting_open_items
         (tenant_id, kind, id, legal_entity_id, counterparty_type, counterparty_id,
          counterparty_name, document_number, document_date, due_on, original_idr)
       VALUES ($1, 'receivable', $2, $3, 'employee', $4, $5, $6, '2026-01-28', '2026-02-27', $7)`,
      [
        tenant.id,
        randomUUID(),
        entityId,
        emp.id,
        emp.name,
        documentNumber,
        original,
      ],
    );
  }

  /**
   * Copies one employee and the given runs' payslips of that employee into the
   * other tenant (new ids, slips resealed for the other tenant).
   */
  async function cloneToOtherTenant(srcRunIds: string[], src: Emp) {
    otherTenant.id = laterTenantId();
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Rehearsal wxvt9 tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant.id, `wxvt9-${randomUUID().slice(0, 8)}`, tenant.id],
    );
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Rehearsal lain', false)",
        [otherTenant.entityId, otherTenant.id],
      );
      await client.query(
        `INSERT INTO employees
           SELECT (jsonb_populate_record(NULL::employees, to_jsonb(e) || jsonb_build_object(
             'id', $2::text, 'tenant_id', $3::text, 'legal_entity_id', $4::text))).*
           FROM employees e WHERE e.tenant_id = $1 AND e.id = $5`,
        [
          tenant.id,
          otherTenant.employeeId,
          otherTenant.id,
          otherTenant.entityId,
          src.id,
        ],
      );
      for (const srcRun of srcRunIds) {
        const newRun = randomUUID();
        otherTenant.runIds.push(newRun);
        await client.query(
          `INSERT INTO payroll_runs
             SELECT (jsonb_populate_record(NULL::payroll_runs, to_jsonb(r) || jsonb_build_object(
               'id', $3::text, 'tenant_id', $4::text, 'legal_entity_id', $5::text))).*
             FROM payroll_runs r WHERE r.tenant_id = $1 AND r.id = $2`,
          [tenant.id, srcRun, newRun, otherTenant.id, otherTenant.entityId],
        );
        const slip = (
          await client.query(
            `SELECT id, calculation_encrypted, pii_key_version FROM payslips
              WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3`,
            [tenant.id, srcRun, src.id],
          )
        ).rows[0];
        const calc = { ...openSlip(slip), employeeId: otherTenant.employeeId };
        const newSlip = randomUUID();
        const sealed = sealPayrollValue(JSON.stringify(calc), {
          tenantId: otherTenant.id,
          table: "payslips",
          rowId: newSlip,
          field: "calculation",
        });
        await client.query(
          `INSERT INTO payslips
             SELECT (jsonb_populate_record(NULL::payslips, to_jsonb(p) || jsonb_build_object(
               'id', $4::text, 'tenant_id', $5::text, 'payroll_run_id', $6::text,
               'employee_id', $7::text, 'calculation_encrypted', $8::text,
               'pii_key_version', $9::int))).*
             FROM payslips p WHERE p.tenant_id = $1 AND p.payroll_run_id = $2 AND p.employee_id = $3`,
          [
            tenant.id,
            srcRun,
            src.id,
            newSlip,
            otherTenant.id,
            newRun,
            otherTenant.employeeId,
            `\\x${Buffer.from(sealed).toString("hex")}`,
            PAYROLL_SEAL_KEY_VERSION,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Row fingerprints (content + xmin: an UPDATE or rewrite shows up too). */
  async function fingerprint(entityIds: string[], employeeIds: string[]) {
    const tenantIds = [tenant.id, otherTenant.id];
    const hash = async (sqlText: string, params: unknown[]) =>
      (await owner.query(sqlText, params)).rows[0] as { n: number; h: string };
    return {
      items: await hash(
        `SELECT count(*)::int AS n, coalesce(md5(string_agg(row_to_json(i)::text || ':' || i.xmin::text, '|'
                 ORDER BY i.tenant_id, i.kind, i.id)), '') AS h
           FROM accounting_open_items i WHERE i.legal_entity_id = ANY($1::uuid[])`,
        [entityIds],
      ),
      settlements: await hash(
        `SELECT count(*)::int AS n, coalesce(md5(string_agg(row_to_json(s)::text || ':' || s.xmin::text, '|'
                 ORDER BY s.id)), '') AS h
           FROM accounting_open_item_settlements s
           JOIN accounting_open_items i
             ON i.tenant_id = s.tenant_id AND i.kind = s.kind AND i.id = s.open_item_id
          WHERE i.legal_entity_id = ANY($1::uuid[])`,
        [entityIds],
      ),
      payslips: await hash(
        `SELECT count(*)::int AS n, coalesce(md5(string_agg(row_to_json(p)::text || ':' || p.xmin::text, '|'
                 ORDER BY p.id)), '') AS h
           FROM payslips p JOIN payroll_runs r
             ON r.tenant_id = p.tenant_id AND r.id = p.payroll_run_id
          WHERE r.legal_entity_id = ANY($1::uuid[])`,
        [entityIds],
      ),
      runs: await hash(
        `SELECT count(*)::int AS n, coalesce(md5(string_agg(row_to_json(r)::text || ':' || r.xmin::text, '|'
                 ORDER BY r.id)), '') AS h
           FROM payroll_runs r WHERE r.legal_entity_id = ANY($1::uuid[])`,
        [entityIds],
      ),
      employees: await hash(
        `SELECT count(*)::int AS n, coalesce(md5(string_agg(row_to_json(e)::text || ':' || e.xmin::text, '|'
                 ORDER BY e.id)), '') AS h
           FROM employees e WHERE e.id = ANY($1::uuid[]) AND e.tenant_id = ANY($2::uuid[])`,
        [employeeIds, tenantIds],
      ),
    };
  }

  type ItemSummary = {
    tenant_id: string;
    legal_entity_id: string;
    counterparty_id: string;
    id: string;
    document_number: string;
    original: number;
    settled: number;
  };
  const itemsOf = async (entityIds: string[]) =>
    (
      await owner.query<ItemSummary>(
        `SELECT tenant_id, legal_entity_id, counterparty_id, id, document_number,
                original_idr::int AS original, settled_idr::int AS settled
           FROM accounting_open_items
          WHERE legal_entity_id = ANY($1::uuid[]) AND kind = 'receivable'
          ORDER BY counterparty_id, id`,
        [entityIds],
      )
    ).rows;
  const outstandingOf = (items: ItemSummary[], emp: { id: string }) =>
    items
      .filter((item) => item.counterparty_id === emp.id)
      .reduce((total, item) => total + item.original - item.settled, 0);

  afterAll(async () => {
    if (!otherTenant.id) return;
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const table of [
        "accounting_open_item_settlements",
        "accounting_open_items",
        "payslips",
        "payroll_runs",
        "employees",
        "legal_entities",
      ])
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          otherTenant.id,
        ]);
      await client.query("DELETE FROM tenants WHERE id = $1", [otherTenant.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  it("legacy data: dry-run writes nothing, a killed run leaves nothing, the real run and a repeat and two at once end in the same rows, and the next payroll run collects once", async () => {
    // --- Legacy world: two legal entities of the seeded tenant. The lower
    // entity id is processed first, so a lock on the higher one stops the
    // process after the lower one was already written (kill test).
    const worlds = [await makeWorld(), await makeWorld()].sort((a, b) =>
      a.entityId < b.entityId ? -1 : 1,
    );
    const lo = worlds[0]!;
    const hi = worlds[1]!;
    const pos = await makeEmployee(lo);
    const zero = await makeEmployee(lo);
    const none = await makeEmployee(lo);
    const legacy = await makeEmployee(lo);
    const departed = await makeEmployee(lo);
    const neg = await makeEmployee(lo);
    const corrupt = await makeEmployee(lo);
    const exceeds = await makeEmployee(lo);
    const partial = await makeEmployee(lo);
    const reversed = await makeEmployee(lo);
    const pos2 = await makeEmployee(hi);
    const part2 = await makeEmployee(hi);

    const OPEN = 40_000_000;
    const julLo = await lockedRun(lo, monthDates(7, 2025));
    for (const emp of [pos, legacy, departed, corrupt, exceeds, partial])
      expect(await raiseReceivable(julLo, emp, OPEN)).toBe(OPEN);
    expect(await raiseReceivable(julLo, zero, 3_000_000)).toBe(3_000_000);
    // A run that raised a receivable and was reversed: its debt does not exist.
    const augLo = await lockedRun(lo, monthDates(8, 2025));
    await raiseReceivable(augLo, reversed, 7_000_000);
    await reverseRun(augLo);
    expect(await runStatus(augLo)).toBe("reversed");
    const sepLo = await lockedRun(lo, monthDates(9));
    const liveLo = [julLo, sepLo];

    const julHi = await lockedRun(hi, monthDates(7, 2025));
    for (const emp of [pos2, part2])
      expect(await raiseReceivable(julHi, emp, OPEN)).toBe(OPEN);
    const sepHi = await lockedRun(hi, monthDates(9));

    const balance = {
      pos: await slipBalance(liveLo, pos),
      legacy: await slipBalance(liveLo, legacy),
      departed: await slipBalance(liveLo, departed),
      partial: await slipBalance(liveLo, partial),
      exceeds: await slipBalance(liveLo, exceeds),
      zero: await slipBalance(liveLo, zero),
      none: await slipBalance(liveLo, none),
      reversed: await slipBalance(liveLo, reversed),
      pos2: await slipBalance([julHi, sepHi], pos2),
      part2: await slipBalance([julHi, sepHi], part2),
    };
    for (const key of [
      "pos",
      "legacy",
      "departed",
      "partial",
      "exceeds",
      "pos2",
      "part2",
    ] as const) {
      expect(balance[key], `${key}: Sep collected part of it`).toBeGreaterThan(
        0,
      );
      expect(balance[key]).toBeLessThan(OPEN);
    }
    expect(balance.zero, "fully collected").toBe(0);
    expect(balance.none).toBe(0);
    expect(balance.reversed, "the reversed run left no debt").toBe(0);
    const PRE_EXISTING = 10_000_000;
    expect(balance.partial).toBeGreaterThan(PRE_EXISTING);
    expect(balance.part2).toBeGreaterThan(PRE_EXISTING);
    const EXCEEDING_ITEM = 60_000_000;

    // --- Make the slips look like the oldest data.
    // (a) before the carry field: the slow path must give the same balance;
    await stripCarry(liveLo, legacy);
    await stripCarry(liveLo, zero);
    await stripCarry(liveLo, none);
    // (b) a negative balance (collection without a raise): unreadable, held;
    await stripCarry(liveLo, neg);
    const collectLine = (await slipsOf([sepLo], pos))
      .flatMap((calc) => calc.lines)
      .find((line) => line.category === "pph21_receivable");
    expect(collectLine, "template of a collection line").toBeDefined();
    await rewriteSlip(sepLo, neg, (calc) => ({
      ...calc,
      lines: [
        ...(calc.lines as unknown[]),
        { ...collectLine, amountIdr: 3_000_000 },
      ],
    }));
    // (c) a corrupted slip of an employee who really owes money;
    await asTenant(
      (conn) =>
        conn.query(
          `UPDATE payslips SET calculation_encrypted = $3
            WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $4`,
          [tenant.id, sepLo, randomBytes(64), corrupt.id],
        ),
      true,
    );
    // (d) an employee who left after the receivable was raised.
    await asTenant((conn) =>
      conn.query(
        `UPDATE employees SET status = 'terminated', end_date = '2026-09-30'
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, departed.id],
      ),
    );

    // --- Pre-972 state: no items, then the items that exist before the run.
    await stripItems(lo);
    await stripItems(hi);
    await insertItem(lo.entityId, exceeds, EXCEEDING_ITEM, "LEGACY-EXCEEDS");
    await insertItem(lo.entityId, partial, PRE_EXISTING, "LEGACY-PARTIAL");
    await insertItem(hi.entityId, part2, PRE_EXISTING, "LEGACY-PARTIAL-2");

    // --- Second tenant with the same kind of debt (isolation).
    await cloneToOtherTenant([julLo, sepLo], pos);
    const other = { id: otherTenant.employeeId };

    const entityIds = [lo.entityId, hi.entityId, otherTenant.entityId];
    const employeeIds = [
      ...[pos, zero, none, legacy, departed, neg, corrupt, exceeds, partial]
        .concat([reversed, pos2, part2])
        .map((emp) => emp.id),
      other.id,
    ];
    const before = await fingerprint(entityIds, employeeIds);
    const itemsBefore = await itemsOf(entityIds);
    expect(itemsBefore, "only the three pre-existing items").toHaveLength(3);

    const expectedHeld = [
      {
        legalEntityId: lo.entityId,
        employeeId: neg.id,
        reason: "payslip_unreadable",
      },
      {
        legalEntityId: lo.entityId,
        employeeId: corrupt.id,
        reason: "payslip_unreadable",
      },
      {
        legalEntityId: lo.entityId,
        employeeId: exceeds.id,
        reason: "item_exceeds_balance",
      },
    ].sort((a, b) => (a.employeeId < b.employeeId ? -1 : 1));
    const heldMine = (line: CliLine) =>
      (line.held ?? [])
        .filter((h) => [lo.entityId, hi.entityId].includes(h.legalEntityId))
        .sort((a, b) => (a.employeeId < b.employeeId ? -1 : 1));
    const gaps = {
      a:
        balance.pos +
        balance.legacy +
        balance.departed +
        (balance.partial - PRE_EXISTING) +
        balance.pos2 +
        (balance.part2 - PRE_EXISTING),
      b: balance.pos,
    };

    // --- 1. Dry run: the exact command of the bead, no `--`.
    const dry = await spawnCli(["--dry-run"]).done;
    expect(dry.code, dry.err).toBe(0);
    const dryA = tenantLine(dry, tenant.id);
    const dryB = tenantLine(dry, otherTenant.id);
    expect(dryA.dryRun).toBe(1);
    expect(dryA.created).toBeGreaterThanOrEqual(6);
    expect(dryA.createdIdr).toBeGreaterThanOrEqual(gaps.a);
    expect(heldMine(dryA)).toEqual(expectedHeld);
    expect(dryB).toMatchObject({ created: 1, createdIdr: gaps.b, held: [] });
    expect(cliLines(dry.out).at(-1)?.summary?.tenants).toBeGreaterThanOrEqual(
      2,
    );
    expect(
      await fingerprint(entityIds, employeeIds),
      "dry run: zero writes (rows and xmin identical)",
    ).toEqual(before);

    // --- 2. Killed in the middle: the process holds the writes of the lower
    // entity, waits for the lock of the higher one, then dies.
    const gate = await owner.connect();
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `payroll-pph21-receivable:${tenant.id}:${hi.entityId}`,
    ]);
    const victim = spawnCli([]);
    let waitingPid: number | undefined;
    for (let i = 0; i < 240 && waitingPid === undefined; i++) {
      await sleep(500);
      // Only the wait for the key held by `gate`: never another test's backend.
      waitingPid = (
        await owner.query<{ pid: number }>(
          `WITH k AS (SELECT hashtextextended($1, 0) AS h)
           SELECT pid FROM pg_locks, k
            WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
              AND classid = ((h >> 32) & 4294967295)::bigint::oid
              AND objid = (h & 4294967295)::bigint::oid
            LIMIT 1`,
          [`payroll-pph21-receivable:${tenant.id}:${hi.entityId}`],
        )
      ).rows[0]?.pid;
    }
    expect(waitingPid, "the command reached the second entity").toBeDefined();
    process.kill(-victim.child.pid!, "SIGKILL");
    await owner.query("SELECT pg_terminate_backend($1)", [waitingPid]);
    await gate.query("COMMIT");
    gate.release();
    const killed = await victim.done;
    expect(killed.signal).toBe("SIGKILL");
    for (let i = 0; i < 40; i++) {
      const rows = (
        await owner.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [
          waitingPid,
        ])
      ).rows;
      if (rows.length === 0) break;
      await sleep(250);
    }
    expect(
      await fingerprint(entityIds, employeeIds),
      "killed run: nothing of the interrupted tenant was written",
    ).toEqual(before);

    // --- 3. Real run.
    const real = await spawnCli([]).done;
    expect(real.code, real.err).toBe(0);
    const realA = tenantLine(real, tenant.id);
    const realB = tenantLine(real, otherTenant.id);
    expect(realA.dryRun).toBe(0);
    expect(realA.created).toBeGreaterThanOrEqual(6);
    expect(heldMine(realA)).toEqual(expectedHeld);
    expect(realB).toMatchObject({ created: 1, createdIdr: gaps.b, held: [] });
    const afterReal = await fingerprint(entityIds, employeeIds);
    for (const same of [
      "settlements",
      "payslips",
      "runs",
      "employees",
    ] as const)
      expect(afterReal[same], `${same} untouched by the backfill`).toEqual(
        before[same],
      );
    const items = await itemsOf(entityIds);
    const backfilled = items.filter((i) =>
      i.document_number.startsWith("PPH21-BACKFILL-"),
    );
    expect(backfilled).toHaveLength(7);
    expect(backfilled.reduce((t, i) => t + i.original, 0)).toBe(
      gaps.a + gaps.b,
    );
    // Debt per person equals the slips; never above; none for the rest.
    expect(outstandingOf(items, pos)).toBe(balance.pos);
    expect(outstandingOf(items, legacy)).toBe(balance.legacy);
    expect(outstandingOf(items, departed)).toBe(balance.departed);
    expect(outstandingOf(items, partial)).toBe(balance.partial);
    expect(outstandingOf(items, pos2)).toBe(balance.pos2);
    expect(outstandingOf(items, part2)).toBe(balance.part2);
    expect(outstandingOf(items, exceeds), "held: not lowered").toBe(
      EXCEEDING_ITEM,
    );
    for (const emp of [zero, none, neg, corrupt, reversed])
      expect(outstandingOf(items, emp), "no debt, no item").toBe(0);
    // Tenants never mix.
    expect(items.filter((i) => i.tenant_id === otherTenant.id)).toEqual([
      expect.objectContaining({
        counterparty_id: other.id,
        legal_entity_id: otherTenant.entityId,
        original: balance.pos,
      }),
    ]);
    expect(
      items.filter(
        (i) => i.tenant_id === tenant.id && i.counterparty_id === other.id,
      ),
    ).toEqual([]);

    // --- 4. Repeat: nothing changes (same rows, same xmin).
    const repeat = await spawnCli([]).done;
    expect(repeat.code, repeat.err).toBe(0);
    expect(tenantLine(repeat, otherTenant.id)).toMatchObject({ created: 0 });
    expect(heldMine(tenantLine(repeat, tenant.id))).toEqual(expectedHeld);
    expect(
      await fingerprint(entityIds, employeeIds),
      "repeat: zero writes",
    ).toEqual(afterReal);

    // --- 5. Rollback of the runbook, then two commands at the same time.
    await owner.query(
      `DELETE FROM accounting_open_items i
        WHERE i.tenant_id = $1 AND i.kind = 'receivable'
          AND i.counterparty_type = 'employee'
          AND i.document_number LIKE 'PPH21-BACKFILL-%'
          AND i.settled_idr = 0
          AND NOT EXISTS (
            SELECT 1 FROM accounting_open_item_settlements s
             WHERE s.tenant_id = i.tenant_id AND s.kind = i.kind AND s.open_item_id = i.id)`,
      [otherTenant.id],
    );
    await owner.query(
      `DELETE FROM accounting_open_items
        WHERE tenant_id = $1 AND legal_entity_id = ANY($2::uuid[])
          AND document_number LIKE 'PPH21-BACKFILL-%' AND settled_idr = 0`,
      [tenant.id, [lo.entityId, hi.entityId]],
    );
    const rolledBack = await itemsOf(entityIds);
    expect(rolledBack.map((i) => i.id).sort()).toEqual(
      itemsBefore.map((i) => i.id).sort(),
    );
    const pair = await Promise.all([spawnCli([]).done, spawnCli([]).done]);
    for (const result of pair) expect(result.code, result.err).toBe(0);
    const createdByPair = pair.map(
      (r) => tenantLine(r, otherTenant.id).created,
    );
    expect(
      createdByPair.reduce((t, n) => t! + n!, 0),
      "exactly one of the two made the item of the other tenant",
    ).toBe(1);
    const afterPair = await itemsOf(entityIds);
    expect(afterPair, "same ids and amounts as the single run").toEqual(items);
    expect(
      afterPair.filter((i) => i.document_number.startsWith("PPH21-BACKFILL-")),
    ).toHaveLength(7);

    // --- 6. Nobody is charged twice: the next payroll run of the higher
    // entity collects once, the item and the slips agree afterwards.
    const octHi = await lockedRun(hi, monthDates(10));
    const hiRuns = [julHi, sepHi, octHi];
    for (const emp of [pos2, part2]) {
      const collected = collectedIn(await slipsOf([octHi], emp));
      expect(collected, "Oct collects").toBeGreaterThan(0);
      const open = await slipBalance(hiRuns, emp);
      expect(open).toBe(
        (emp === pos2 ? balance.pos2 : balance.part2) - collected,
      );
      expect(
        outstandingOf(await itemsOf([hi.entityId]), emp),
        "finance list = payslips, no double charge",
      ).toBe(open);
    }
    expect(
      (await itemsOf([lo.entityId, otherTenant.entityId])).map(
        (i) => `${i.id}:${i.original}:${i.settled}`,
      ),
      "other entities and the other tenant are not touched by that run",
    ).toEqual(
      afterPair
        .filter((i) => i.legal_entity_id !== hi.entityId)
        .map((i) => `${i.id}:${i.original}:${i.settled}`),
    );
  }, 2_400_000);

  // Bead wxvt9 says "isian 0558": the migration of that number was squashed;
  // today it is drizzle/0454_payroll_overtime_correction_activations.sql
  // (brief 983 round 2, R1). Its data step is replayed on legacy data inside a
  // transaction that is rolled back, so the shared database is not changed.
  it("the overtime-correction activation fill (brief 0558) on legacy data: a tenant with runs gets one row, one without none, a second pass adds nothing, RLS stays forced", async () => {
    const file = readdirSync(DRIZZLE_DIR).find((name) =>
      /^\d+_payroll_overtime_correction_activations\.sql$/.test(name),
    );
    expect(file, "the migration file").toBeDefined();
    const fill = readFileSync(resolve(DRIZZLE_DIR, file!), "utf8")
      .split("--> statement-breakpoint")
      .find((part) =>
        /INSERT INTO public\.payroll_overtime_correction_activations/.test(
          part,
        ),
      );
    expect(fill, "the INSERT ... SELECT statement").toBeDefined();
    const bare = randomUUID();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'Rehearsal wxvt9 no runs', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [bare, `wxvt9-${randomUUID().slice(0, 8)}`, tenant.id],
      );
      const withRuns = [tenant.id, otherTenant.id].filter(Boolean);
      const ids = [...withRuns, bare];
      // The state before the migration: no activation rows at all.
      await client.query(
        "DELETE FROM payroll_overtime_correction_activations WHERE tenant_id = ANY($1::uuid[])",
        [ids],
      );
      const first = await client.query(fill!);
      expect(first.rowCount ?? 0).toBeGreaterThanOrEqual(withRuns.length);
      const rows = (
        await client.query<{ tenant_id: string; fresh: boolean }>(
          `SELECT tenant_id, activated_at >= now() - interval '1 minute' AS fresh
             FROM payroll_overtime_correction_activations
            WHERE tenant_id = ANY($1::uuid[])`,
          [ids],
        )
      ).rows;
      expect(rows.map((r) => r.tenant_id).sort()).toEqual(withRuns.sort());
      expect(rows.every((r) => r.fresh)).toBe(true);
      expect(
        rows.some((r) => r.tenant_id === bare),
        "a tenant without runs stays without a row (every run eligible)",
      ).toBe(false);
      expect(
        (
          await client.query(
            `SELECT 1 FROM (SELECT DISTINCT tenant_id FROM payroll_runs) r
              WHERE NOT EXISTS (SELECT 1 FROM payroll_overtime_correction_activations a
                                 WHERE a.tenant_id = r.tenant_id)`,
          )
        ).rowCount,
        "every tenant with a run has its row",
      ).toBe(0);
      const second = await client.query(fill!);
      expect(second.rowCount, "second pass: ON CONFLICT adds nothing").toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    // What the migration must leave behind (checked on the migrated database).
    const role = decodeURIComponent(
      new URL(process.env.APP_DATABASE_URL!).username,
    );
    const rls = (name: string) =>
      owner.query<{ on: boolean; forced: boolean }>(
        "SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass",
        [name],
      );
    expect((await rls("public.payroll_runs")).rows[0]).toEqual({
      on: true,
      forced: true,
    });
    expect(
      (await rls("public.payroll_overtime_correction_activations")).rows[0],
    ).toEqual({ on: true, forced: true });
    const privilege = async (kind: string) =>
      (
        await owner.query<{ ok: boolean }>(
          "SELECT has_table_privilege($1, 'public.payroll_overtime_correction_activations', $2) AS ok",
          [role, kind],
        )
      ).rows[0]!.ok;
    expect(await privilege("SELECT")).toBe(true);
    for (const kind of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"])
      expect(await privilege(kind), `${kind} revoked from the app role`).toBe(
        false,
      );
  }, 120_000);

  // Found in the rehearsal: the production image has no pnpm, tsx or src, only
  // dist/. The command must be a tsup entry whose wrapper always runs (no
  // "am I the entry file" guard, which exited 0 silently when called by path).
  it("the command can run from the production image: tsup builds the always-running wrapper as an entry", async () => {
    const { default: tsupConfig } = await import("../../tsup.config.ts");
    const config = Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig;
    const entries = (config as { entry?: Record<string, string> }).entry ?? {};
    expect(entries["payroll-pph21-receivable-backfill"]).toBe(
      "src/cli/payroll-pph21-receivable-backfill.ts",
    );
    const script = readFileSync(
      resolve(
        import.meta.dirname,
        "../scripts/payroll-pph21-receivable-backfill.ts",
      ),
      "utf8",
    );
    expect(script, "no entry-file guard in the module").not.toContain(
      "isCliEntry",
    );
  }, 60_000);
});
