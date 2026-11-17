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
import { randomUUID } from "node:crypto";
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
});
