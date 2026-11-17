// legend-2ln9t (brief 1007, SO 971 finding): undoing a payroll run that
// COLLECTED an employee PPh 21 receivable must not DELETE the settlement. The
// application role legend_app has no DELETE or UPDATE on
// accounting_open_item_settlements (RLS migration 0058, append-only ledger), so
// the undo needs an append-only reversal row. Fail-first: written before the
// feature exists (migration 0623).
//
// RULES UNDER TEST (every action runs through the legend_app connection: the
// service pool `db` is the application role and withTenant refuses any other;
// direct SQL goes through SET LOCAL ROLE legend_app)
//  1. Reversing the run that collected a receivable (Mar) succeeds: the
//     payment settlement stays, ONE reversal settlement is appended
//     (method 'reversal', reversal_of = the payment, same open item, same
//     source run, same amount), the item's settled amount drops back and the
//     full receivable is outstanding again. The other employee's item of the
//     same run gets its own single reversal.
//  2. The earlier run that raised the receivable (Jan) cannot be reversed while
//     a collection is active (409 PAYROLL_RUN_REVERSAL_BLOCKED) but can be
//     reversed once the collection itself is reversed.
//  3. Idempotent: syncing the reversed run (also concurrently) or any other run
//     never adds a second reversal nor changes the item.
//  4. After the reversal a later run collects the receivable again exactly once
//     (3 settlement rows: payment, reversal, payment; net settled = receivable).
//  5. legend_app still cannot UPDATE or DELETE settlements; it can append a
//     valid reversal once; malformed reversals (wrong amount, no target,
//     target of another item/tenant, reversal of a reversal, second reversal of
//     the same payment, method/column mismatch) are rejected by the database.
//  6. Tenant isolation: another tenant's open item and settlements are never
//     touched, and its payment cannot be reversed from our tenant.
//
// ASSUMPTIONS (spec silent; from the brief decision of card 2ln9t)
//  - Contract: new nullable column accounting_open_item_settlements.reversal_of
//    (uuid, composite FK to (tenant_id, id)); method accepts 'reversal';
//    CHECK (method = 'reversal') = (reversal_of IS NOT NULL); amount > 0;
//    one reversal per payment (unique); reversal row carries the payment's
//    open_item_id, kind, source_id and amount.
//  - After Jan is reversed the item may be kept (voided) or removed, so only
//    "nothing outstanding for finance, nothing comes back" is asserted.
//  - Trigger-raised rejections are asserted as "rejected" (SQLSTATE of the
//    trigger is not in the brief); constraint ones assert 23514/23505/42501.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { sql } from "drizzle-orm";
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
import type { ScopedTenantContext } from "@starter/shared/core";
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

const key = () => `oi-2ln9t-${randomUUID()}`;
const SALARY = 15_000_000;
const X = 50_000;

const tenantScope = (tenantId: string = tenant.id): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

/** Owner connection bound to our tenant: fixtures and read-back only. */
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

/**
 * The application database role (the API's path). Always rolls back, so a
 * probe never leaves rows behind; the caller returns what it needs.
 */
async function asAppRoleRollback<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

type PgFailure = { code?: string; message?: string };
/** Runs `run` as legend_app in a rolled-back transaction; returns the failure. */
const appRoleFailure = (run: (client: PoolClient) => Promise<unknown>) =>
  asAppRoleRollback(run).then(
    () => null,
    (error: unknown) => error as PgFailure,
  );

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
        `OI2ln9t ${roleId.slice(0, 8)}`,
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
      [world.entityId, tenant.id, `PT Pembalik ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, lockerUserId);
  });
  return world;
}

/** An active pkwtt employee TK/0 with a NPWP and a bank account, gross scheme. */
async function makeEmployee(world: World): Promise<Emp> {
  const emp: Emp = { id: randomUUID(), name: `Karyawan Pembalik ${++counter}` };
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

/** Proof that the service path is the application role, not the owner. */
async function serviceRole() {
  return withTenant(db, tenantScope(), async (tx) => {
    const res = await tx.execute(sql`
      SELECT current_user::text AS who,
             pg_has_role(current_user, 'legend_app', 'MEMBER') AS is_app,
             (SELECT rolsuper OR rolbypassrls FROM pg_roles
               WHERE rolname = current_user) AS bypass
    `);
    return res.rows[0] as { who: string; is_app: boolean; bypass: boolean };
  });
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
 * tampering with its sealed calculation (same fixture as the 972 test:
 * replica role, immutability triggers off for this fixture only).
 */
async function raiseReceivable(runId: string, emp: Emp): Promise<number> {
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
      tax: { pph21WithheldIdr: number };
    };
    const withheld = calc.tax.pph21WithheldIdr;
    expect(withheld, "the seed slip withheld tax").toBeGreaterThan(0);
    const receivable = Math.min(X, withheld);
    const tampered: Record<string, unknown> = {
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
    };
    // The sealed open-balance field (legend-2fk79) must match the raised amount.
    const OPEN_AFTER = "pph21ReceivableOpenAfterIdr";
    if (OPEN_AFTER in calc)
      tampered[OPEN_AFTER] =
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

type ItemRow = { counterpartyId: string; outstandingIdr: number };

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

/** The shared payslip oracle: raised minus collected, over the live runs. */
async function slipBalance(runIds: readonly string[], emp: Emp) {
  return pph21ReceivableBalance(
    (await slipsOf(runIds, emp)) as Parameters<
      typeof pph21ReceivableBalance
    >[0],
  );
}

/** Raw item row (incl. settled ones). */
const itemOf = async (world: World, emp: Emp) =>
  (
    await owner.query<{ original_idr: number; settled_idr: number }>(
      `SELECT original_idr::int AS original_idr, settled_idr::int AS settled_idr
         FROM accounting_open_items
        WHERE tenant_id = $1 AND legal_entity_id = $2
          AND counterparty_type = 'employee' AND counterparty_id = $3`,
      [tenant.id, world.entityId, emp.id],
    )
  ).rows;

type Settlement = {
  id: string;
  open_item_id: string;
  method: string;
  source_id: string | null;
  amount_idr: number;
  settled_on: string;
  reversal_of: string | null;
};

/** Every settlement row of the employee's item, oldest first. */
async function settlementsOf(world: World, emp: Emp): Promise<Settlement[]> {
  return (
    await owner.query<Settlement>(
      `SELECT s.id::text AS id, s.open_item_id::text AS open_item_id, s.method,
              s.source_id::text AS source_id, s.amount_idr::int AS amount_idr,
              s.settled_on::text AS settled_on, s.reversal_of::text AS reversal_of
         FROM accounting_open_item_settlements s
         JOIN accounting_open_items i
           ON i.tenant_id = s.tenant_id AND i.kind = s.kind AND i.id = s.open_item_id
        WHERE i.tenant_id = $1 AND i.legal_entity_id = $2
          AND i.counterparty_type = 'employee' AND i.counterparty_id = $3
        ORDER BY s.created_at, CASE s.method WHEN 'payment' THEN 0 ELSE 1 END, s.id`,
      [tenant.id, world.entityId, emp.id],
    )
  ).rows;
}

const byMethod = (rows: readonly Settlement[], method: string) =>
  rows.filter((r) => r.method === method);

/** Net amount still counted as settled: payments minus their reversals. */
const netSettled = (rows: readonly Settlement[]) =>
  byMethod(rows, "payment").reduce((s, r) => s + r.amount_idr, 0) -
  byMethod(rows, "reversal").reduce((s, r) => s + r.amount_idr, 0);

/** Jan raises for each employee (synced), Mar locks and collects. */
async function janRaiseMarCollect(world: World, emps: readonly Emp[]) {
  const jan = await lockedRun(world, monthDates(1));
  for (const emp of emps) expect(await raiseReceivable(jan, emp)).toBe(X);
  await syncItems(jan);
  const mar = await lockedRun(world, monthDates(3));
  for (const emp of emps)
    expect(
      collectedIn(await slipsOf([mar], emp)),
      "Mar collects the whole receivable",
    ).toBe(X);
  return { jan, mar };
}

/** Another tenant with a collected employee item of its own. */
async function makeOtherTenant() {
  const other = {
    tenantId: randomUUID(),
    entityId: randomUUID(),
    itemId: randomUUID(),
    paymentId: randomUUID(),
  };
  otherTenantIds.push(other.tenantId);
  otherEntityIds.push(other.entityId);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'OI2ln9t other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [other.tenantId, `oi2ln9t-${randomUUID().slice(0, 8)}`, tenant.id],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, 'Other entity')",
    [other.entityId, other.tenantId],
  );
  await owner.query(
    `INSERT INTO accounting_open_items
       (tenant_id, kind, id, legal_entity_id, counterparty_type, counterparty_id,
        counterparty_name, document_number, document_date, due_on, original_idr, settled_idr)
     VALUES ($1, 'receivable', $2, $3, 'employee', $4, 'Karyawan tenant lain',
             'PPH21-OTHER', '2026-01-28', '2026-02-27', 777, 500)`,
    [other.tenantId, other.itemId, other.entityId, randomUUID()],
  );
  await owner.query(
    `INSERT INTO accounting_open_item_settlements
       (id, tenant_id, kind, open_item_id, method, settled_on, amount_idr)
     VALUES ($1, $2, 'receivable', $3, 'payment', '2026-03-28', 500)`,
    [other.paymentId, other.tenantId, other.itemId],
  );
  return other;
}

/** Everything of the other tenant's item, to prove it stays untouched. */
const otherSnapshot = async (other: { tenantId: string }) =>
  (
    await owner.query(
      `SELECT i.id::text AS item, i.original_idr::int AS original,
              i.settled_idr::int AS settled,
              (SELECT coalesce(json_agg(json_build_object(
                        'id', s.id, 'method', s.method,
                        'amount', s.amount_idr::int) ORDER BY s.id), '[]'::json)
                 FROM accounting_open_item_settlements s
                WHERE s.tenant_id = i.tenant_id) AS settlements
         FROM accounting_open_items i WHERE i.tenant_id = $1`,
      [other.tenantId],
    )
  ).rows;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("OI2ln9t locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  lockerUserId = lock.userId;
  const approver = await signedInClient("OI2ln9t approver");
  await grantRole(approver.userId, ["payroll.view", "payroll.cancel.approve"]);
  approverUserId = approver.userId;
  const hrUser = await signedInClient("OI2ln9t HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  const fin = await signedInClient("OI2ln9t finance");
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
  // One statement: the self-referencing reversal_of FK is checked at its end.
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'oi-2ln9t-%'",
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

describe("legend-2ln9t: reversing a PPh 21 collector run appends a reversal settlement", () => {
  it("the service path is the application role, not the owner", async () => {
    const role = await serviceRole();
    expect(role.is_app).toBe(true);
    expect(role.bypass).toBe(false);
  });

  it("reversing the collecting run appends one reversal per item, deletes nothing, and the receivable is outstanding again", async () => {
    const world = await makeWorld();
    const a = await makeEmployee(world);
    const b = await makeEmployee(world);
    const other = await makeOtherTenant();
    const otherBefore = await otherSnapshot(other);
    const { jan, mar } = await janRaiseMarCollect(world, [a, b]);

    // Collected: item settled, nothing outstanding, one payment row each.
    for (const emp of [a, b]) {
      expect(await itemOf(world, emp)).toEqual([
        { original_idr: X, settled_idr: X },
      ]);
      expect(await financeList(finance, world, emp)).toEqual([]);
      const rows = await settlementsOf(world, emp);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        method: "payment",
        source_id: mar,
        amount_idr: X,
        reversal_of: null,
      });
    }
    // Jan cannot go while a collection is active; nothing changes.
    await expect(reverseRun(jan)).rejects.toMatchObject({
      status: 409,
      code: "PAYROLL_RUN_REVERSAL_BLOCKED",
    });
    expect(await runStatus(jan)).toBe("locked");
    const paymentIds = new Map<string, string>();
    for (const emp of [a, b])
      paymentIds.set(emp.id, (await settlementsOf(world, emp))[0]!.id);

    await reverseRun(mar); // hook undoes the collection, no sync by hand
    expect(await runStatus(mar)).toBe("reversed");

    for (const emp of [a, b]) {
      const rows = await settlementsOf(world, emp);
      // Append-only: the payment is still there, plus exactly one reversal.
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        id: paymentIds.get(emp.id),
        method: "payment",
        source_id: mar,
        amount_idr: X,
        reversal_of: null,
      });
      expect(rows[1]).toMatchObject({
        method: "reversal",
        open_item_id: rows[0]!.open_item_id,
        source_id: mar,
        amount_idr: X,
        reversal_of: paymentIds.get(emp.id),
      });
      expect(netSettled(rows)).toBe(0);
      // Item: settled back to 0, one row only, the full receivable is owed.
      expect(await itemOf(world, emp)).toEqual([
        { original_idr: X, settled_idr: 0 },
      ]);
      const list = await financeList(finance, world, emp);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        counterpartyId: emp.id,
        outstandingIdr: X,
      });
      expect(owed(list)).toBe(await slipBalance([jan], emp));
    }
    expect(owed(await financeList(finance, world))).toBe(2 * X);

    // The application role did all of it: still no UPDATE or DELETE right.
    const denied = await appRoleFailure((conn) =>
      conn.query(
        "DELETE FROM accounting_open_item_settlements WHERE tenant_id = $1",
        [tenant.id],
      ),
    );
    expect(denied?.code).toBe("42501");

    // Another tenant: its sync is a 404 and its item and payment are intact.
    await expect(
      syncItems(mar, tenantScope(other.tenantId)),
    ).rejects.toMatchObject({ status: 404 });
    expect(await otherSnapshot(other)).toEqual(otherBefore);
  }, 900_000);

  it("syncing again, also at the same time, never adds a second reversal", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const other = await makeOtherTenant();
    const otherBefore = await otherSnapshot(other);
    const { jan, mar } = await janRaiseMarCollect(world, [emp]);
    await reverseRun(mar);
    const settled = await settlementsOf(world, emp);
    expect(settled).toHaveLength(2);

    await syncItems(mar);
    await syncItems(mar);
    await Promise.all([
      syncItems(mar),
      syncItems(mar),
      syncItems(jan),
      syncItems(jan),
    ]);

    expect(await settlementsOf(world, emp)).toEqual(settled);
    expect(byMethod(await settlementsOf(world, emp), "reversal")).toHaveLength(
      1,
    );
    expect(await itemOf(world, emp)).toEqual([
      { original_idr: X, settled_idr: 0 },
    ]);
    expect(owed(await financeList(finance, world, emp))).toBe(X);
    expect(await otherSnapshot(other)).toEqual(otherBefore);
  }, 900_000);

  it("a later run collects the receivable again exactly once after the reversal", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const other = await makeOtherTenant();
    const otherBefore = await otherSnapshot(other);
    const { jan, mar } = await janRaiseMarCollect(world, [emp]);
    await reverseRun(mar);

    const apr = await lockedRun(world, monthDates(4)); // the hook settles
    expect(collectedIn(await slipsOf([apr], emp))).toBe(X);

    let rows = await settlementsOf(world, emp);
    expect(rows.map((r) => r.method)).toEqual([
      "payment",
      "reversal",
      "payment",
    ]);
    expect(rows[2]).toMatchObject({
      source_id: apr,
      amount_idr: X,
      reversal_of: null,
    });
    expect(netSettled(rows)).toBe(X);
    expect(await itemOf(world, emp)).toEqual([
      { original_idr: X, settled_idr: X },
    ]);
    expect(await financeList(finance, world, emp)).toEqual([]);
    expect(await slipBalance([jan, apr], emp)).toBe(0);

    // Re-syncing every run changes nothing: no double collection, no second reversal.
    await syncItems(apr);
    await syncItems(mar);
    await syncItems(jan);
    await Promise.all([syncItems(apr), syncItems(apr)]);
    rows = await settlementsOf(world, emp);
    expect(rows.map((r) => r.method)).toEqual([
      "payment",
      "reversal",
      "payment",
    ]);
    expect(netSettled(rows)).toBe(X);
    expect(await itemOf(world, emp)).toEqual([
      { original_idr: X, settled_idr: X },
    ]);
    expect(await otherSnapshot(other)).toEqual(otherBefore);
  }, 900_000);

  it("a fully reversed collection no longer blocks reversing the raising run, and nothing comes back", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const other = await makeOtherTenant();
    const otherBefore = await otherSnapshot(other);
    const { jan, mar } = await janRaiseMarCollect(world, [emp]);
    await expect(reverseRun(jan)).rejects.toMatchObject({
      status: 409,
      code: "PAYROLL_RUN_REVERSAL_BLOCKED",
    });
    await reverseRun(mar);
    const settled = await settlementsOf(world, emp);

    await reverseRun(jan); // blocked before, allowed now
    expect(await runStatus(jan)).toBe("reversed");
    expect(await financeList(finance, world, emp)).toEqual([]);
    expect(await financeList(finance, world)).toEqual([]);

    await syncItems(jan);
    await syncItems(mar);
    await syncItems(jan);
    expect(await financeList(finance, world)).toEqual([]);
    // History is kept (append-only): the item has settlement rows, so it cannot
    // be deleted. Reversing the raising run closes it with exactly one write_off
    // of the full amount; repeated syncs add nothing more.
    const after = await settlementsOf(world, emp);
    expect(after.slice(0, settled.length)).toEqual(settled);
    const added = after.slice(settled.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      method: "write_off",
      source_id: jan,
      amount_idr: settled[0]!.amount_idr,
    });
    expect(await otherSnapshot(other)).toEqual(otherBefore);
  }, 900_000);

  it("the database accepts exactly one valid reversal and rejects malformed ones, as legend_app", async () => {
    const world = await makeWorld();
    const emp = await makeEmployee(world);
    const other2 = await makeEmployee(world);
    const other = await makeOtherTenant();
    const otherBefore = await otherSnapshot(other);
    const { mar } = await janRaiseMarCollect(world, [emp, other2]);
    const [payment] = await settlementsOf(world, emp);
    expect(payment).toMatchObject({ method: "payment", source_id: mar });
    const p = payment!;

    const insertReversal = (
      conn: PoolClient,
      o: Partial<{
        tenantId: string;
        method: string;
        openItemId: string;
        sourceId: string | null;
        amount: number;
        reversalOf: string | null;
      }> = {},
    ) =>
      conn.query(
        `INSERT INTO accounting_open_item_settlements
           (tenant_id, kind, open_item_id, method, source_id, settled_on, amount_idr, reversal_of)
         VALUES ($1, 'receivable', $2, $3, $4, $5, $6, $7)`,
        [
          o.tenantId ?? tenant.id,
          o.openItemId ?? p.open_item_id,
          o.method ?? "reversal",
          o.sourceId === undefined ? p.source_id : o.sourceId,
          p.settled_on,
          o.amount ?? p.amount_idr,
          o.reversalOf === undefined ? p.id : o.reversalOf,
        ],
      );

    // legend_app keeps no UPDATE and no DELETE on the ledger.
    const del = await appRoleFailure((conn) =>
      conn.query(
        "DELETE FROM accounting_open_item_settlements WHERE tenant_id = $1 AND id = $2",
        [tenant.id, p.id],
      ),
    );
    expect(del?.code).toBe("42501");
    const upd = await appRoleFailure((conn) =>
      conn.query(
        "UPDATE accounting_open_item_settlements SET amount_idr = 1 WHERE tenant_id = $1 AND id = $2",
        [tenant.id, p.id],
      ),
    );
    expect(upd?.code).toBe("42501");

    // One valid reversal is accepted; a second one for the same payment is not.
    const second = await asAppRoleRollback(async (conn) => {
      await insertReversal(conn);
      const count = await conn.query(
        `SELECT count(*)::int AS n FROM accounting_open_item_settlements
          WHERE tenant_id = $1 AND reversal_of = $2`,
        [tenant.id, p.id],
      );
      expect(count.rows[0].n).toBe(1);
      return insertReversal(conn).then(
        () => null,
        (error: unknown) => error as PgFailure,
      );
    });
    expect(second?.code).toBe("23505");

    // Malformed rows, one transaction each. Check constraints: 23514.
    const noTarget = await appRoleFailure((conn) =>
      insertReversal(conn, { reversalOf: null }),
    );
    expect(noTarget?.code).toBe("23514");
    const paymentWithTarget = await appRoleFailure((conn) =>
      insertReversal(conn, { method: "payment" }),
    );
    expect(paymentWithTarget?.code).toBe("23514");
    const zero = await appRoleFailure((conn) =>
      insertReversal(conn, { amount: 0 }),
    );
    expect(zero?.code).toBe("23514");
    // Trigger-level rules: rejected (SQLSTATE not in the brief).
    expect(
      await appRoleFailure((conn) =>
        insertReversal(conn, { amount: p.amount_idr - 1 }),
      ),
    ).not.toBeNull();
    expect(
      await appRoleFailure((conn) =>
        insertReversal(conn, { amount: p.amount_idr + 1 }),
      ),
    ).not.toBeNull();
    expect(
      await appRoleFailure((conn) =>
        insertReversal(conn, { sourceId: randomUUID() }),
      ),
    ).not.toBeNull();
    expect(
      await appRoleFailure((conn) =>
        insertReversal(conn, { reversalOf: randomUUID() }),
      ),
    ).not.toBeNull();
    // Our tenant, another open item: the pair (item B, payment of item A) is illegal.
    const otherItem = (await settlementsOf(world, other2))[0]!.open_item_id;
    expect(
      await appRoleFailure((conn) =>
        insertReversal(conn, { openItemId: otherItem }),
      ),
    ).not.toBeNull();
    // Another tenant: its payment cannot be reversed from ours, and we cannot
    // write rows with its tenant id.
    expect(
      await appRoleFailure((conn) =>
        insertReversal(conn, { reversalOf: other.paymentId, amount: 500 }),
      ),
    ).not.toBeNull();
    const rls = await appRoleFailure((conn) =>
      insertReversal(conn, {
        tenantId: other.tenantId,
        openItemId: other.itemId,
        reversalOf: other.paymentId,
        sourceId: null,
        amount: 500,
      }),
    );
    expect(rls).not.toBeNull();

    // Nothing was committed by any probe.
    expect(await settlementsOf(world, emp)).toEqual([p]);

    // After the official reversal: no reversal of a reversal, no second one.
    await reverseRun(mar);
    const rows = await settlementsOf(world, emp);
    expect(rows).toHaveLength(2);
    const reversal = rows[1]!;
    expect(reversal.method).toBe("reversal");
    expect(
      await appRoleFailure((conn) =>
        insertReversal(conn, { reversalOf: reversal.id }),
      ),
    ).not.toBeNull();
    const dup = await appRoleFailure((conn) => insertReversal(conn));
    expect(dup?.code).toBe("23505");
    expect(await settlementsOf(world, emp)).toEqual(rows);
    expect(await otherSnapshot(other)).toEqual(otherBefore);
  }, 900_000);
});
