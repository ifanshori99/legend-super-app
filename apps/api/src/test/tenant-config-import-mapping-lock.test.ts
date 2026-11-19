// legend 1140 P2-1 (second opinion kas ronde 8): the tenant config import
// (POST /api/platform/tenants/:id/config-import) and the owner's mapping
// endpoint (PUT /api/accounting/legal-entities/:id/account-mappings) both write
// account_mappings. Neither may leave one asset account serving a cash role
// (petty_cash) and another role (employee_receivable) at the same time, even
// when they run concurrently. Written from the brief
// (docs/briefs/1140-fix-so-kas-ronde8.md, decision 2) and the second opinion
// report, not from the service code.
//
// Interleave (two connections plus a gate, no hooks into the code, no fixed
// sleeps), same technique as accounting-bank-recon-writeoff-reversal-race:
//  1. a gate connection holds `SELECT ... FROM tenants ... FOR UPDATE` on the
//     tenant row, so anything that locks or references the tenant parks on it;
//  2. the IMPORT is started first and parks on the gate (it holds nothing else
//     that the owner needs, or the owner parks behind it);
//  3. the OWNER PUT is started second; it runs on to its INSERT, which needs the
//     tenant row (FK), and parks behind the import. Its DELETE of the (empty)
//     mapping set is already done by then;
//  4. the test waits (reading pg_stat_activity / pg_blocking_pids) until both
//     are parked, commits the gate, and the import runs first: with the bug it
//     reads the mapping set while the owner's rows are still uncommitted, sees
//     it empty, validates only employee_receivable -> A, and commits; the
//     owner's INSERT then commits petty_cash -> A. Different roles never hit
//     the (tenant, entity, role) unique index, so both succeed.
//
// Rules asserted (the correct system serializes the two writers on one lock
// protocol and the second one validates the merged set):
//  - the final mappings never have one account on a cash role and another role
//    (the invariant of preflight statement 1: zero rows);
//  - neither call is a server error (a deadlock between the tenant row and the
//    chart lock is a 500 and counts as a failure: the brief wants the lock
//    order aligned so the fix adds no deadlock);
//  - at least one of the two succeeds, each alone is valid.
//
// Assumptions (stated so they can be contested):
//  - Which writer wins is not specified; both orders are accepted. The PUT
//    replaces the whole mapping set of the entity, so when the PUT runs after
//    the import it may legitimately wipe the import's mapping: the final state
//    is then petty_cash -> A only, which is not shared.
//  - A refused writer answers with a 4xx (the import path reports a refusal as
//    422, as cash-1102-1118-config-import.test.ts expects).
//  - A fresh tenant with one legal entity, an asset account A (code 1102,
//    cash_and_equivalents) already in the chart, no mappings, as the report's
//    scenario says. The bundle repeats A by code, so the import creates no
//    account.
//  - The finance role may call the mapping endpoint (as in the 1118 tests).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const limits = cafeLegendPlatformFixtures.tenant.limits;
const suffix = () => randomBytes(4).toString("hex");

let admin: ReturnType<typeof agent>;
let adminUserId: string;

beforeAll(async () => {
  admin = agent(app);
  const email = await signUp(admin, "Platform Admin 1140 import lock");
  await setRole(email, "admin");
  const session = await admin.get("/api/auth/get-session");
  adminUserId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [adminUserId],
  );
  await verifySessionMfa(email);
});

afterAll(async () => {
  await owner.query("DELETE FROM platform_admins WHERE user_id = $1", [
    adminUserId,
  ]);
  await owner.end();
});

type World = {
  tenantId: string;
  entityId: string;
  /** Asset account A (1102) and a second asset account B (1204). */
  accountA: string;
  accountB: string;
  finance: ReturnType<typeof agent>;
  /** Verified hostname of the tenant: tenant routes resolve the tenant from Host. */
  host: string;
};

/** Fresh tenant, one legal entity, accounts A and B, no mappings, a finance user. */
async function newWorld(): Promise<World> {
  const created = await admin
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `m1140-${suffix()}`,
      name: "Uji 1140 kunci impor",
      plan: "lengkap",
      deploymentMode: "shared",
      featureFlags: { modules: ["pos"], integrationProviders: [] },
      limits,
      firstAdmin: {
        name: "Admin Pertama",
        whatsapp: "6281234567890",
        email: null,
      },
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const tenantId = created.body.data.id as string;

  // Tenant-scoped routes resolve the tenant from the request Host, which must be
  // a verified domain of a brand of that tenant (as platform-tenant-api.test.ts).
  const brandId = randomUUID();
  const host = `m1140-${suffix()}.contoh.example`;
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandId, tenantId, `brand-${suffix()}`, "Brand Uji 1140"],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
    [randomUUID(), tenantId, brandId, host],
  );

  const entityId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entityId, tenantId, `PT Uji 1140 ${suffix()}`],
  );
  const accountA = randomUUID();
  const accountB = randomUUID();
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1102', 'Akun 1102', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '1204', 'Akun 1204', 'asset', 'current_asset')`,
    [accountA, accountB, tenantId, entityId],
  );

  const finance = agent(app);
  const email = await signUp(finance, "Finance 1140");
  const userId = (await finance.get("/api/auth/get-session")).body.user
    .id as string;
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenantId],
  );
  expect(role.rows, "premise: the new tenant has a finance role").toHaveLength(
    1,
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, userId, role.rows[0]!.id],
  );
  // The finance role requires a verified second factor (PERMISSION_DENIED otherwise).
  await verifySessionMfa(email);
  // Premise: the finance user can call the mapping endpoint at all (an empty set
  // is a no-op on a fresh entity), so a later parked PUT is not a 403 in disguise.
  const probe = await finance
    .put(`/api/accounting/legal-entities/${entityId}/account-mappings`)
    .set(originHeader)
    .set("Host", host)
    .send({ mappings: [] });
  expect(probe.status, JSON.stringify(probe.body)).toBe(200);
  return { tenantId, entityId, accountA, accountB, finance, host };
}

const account = (code: string, reportGroup: string) => ({
  key: `acct.${code}`,
  kind: "account",
  code,
  name: `Akun ${code}`,
  type: "asset",
  reportGroup,
  parentKey: null,
  isActive: true,
});

type Outcome = { status: number; body: unknown };

/** Import: employee_receivable -> the account with `code` (already in the chart). */
function startImport(world: World, code: string): Promise<Outcome> {
  const group = code === "1102" ? "cash_and_equivalents" : "current_asset";
  return admin
    .post(`/api/platform/tenants/${world.tenantId}/config-import`)
    .set(originHeader)
    .send({
      bundle: {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        sections: {
          chart_of_accounts: {
            version: 1,
            items: [
              account(code, group),
              {
                key: "map.employee_receivable",
                kind: "mapping",
                role: "employee_receivable",
                accountKey: `acct.${code}`,
              },
            ],
          },
        },
      },
    })
    .then((res) => ({ status: res.status, body: res.body as unknown }));
}

/** Owner endpoint: replaces the mapping set with petty_cash -> the given account. */
function startOwnerPut(world: World, accountId: string): Promise<Outcome> {
  return world.finance
    .put(`/api/accounting/legal-entities/${world.entityId}/account-mappings`)
    .set(originHeader)
    .set("Host", world.host)
    .send({ mappings: [{ role: "petty_cash", accountId }] })
    .then((res) => ({ status: res.status, body: res.body as unknown }));
}

// ---- gate on the tenant row ---------------------------------------------------

type Gate = { pid: number; release: () => Promise<void> };

async function openTenantGate(tenantId: string): Promise<Gate> {
  const client: PoolClient = await owner.connect();
  await client.query("BEGIN");
  const locked = await client.query(
    "SELECT id FROM tenants WHERE id = $1 FOR UPDATE",
    [tenantId],
  );
  if (locked.rowCount !== 1) {
    await client.query("ROLLBACK");
    client.release();
    throw new Error("Gate could not lock the tenant row");
  }
  const { rows } = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  let released = false;
  return {
    pid: rows[0]!.pid,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
  };
}

/** Backends waiting, directly or behind a waiter, on the gate connection. */
async function waitersBehind(gatePid: number): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `WITH direct AS (
       SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
     )
     SELECT count(*)::text AS n FROM pg_stat_activity a
      WHERE a.pid IN (SELECT pid FROM direct)
         OR EXISTS (
              SELECT 1 FROM unnest(pg_blocking_pids(a.pid)) AS b(pid)
               WHERE b.pid IN (SELECT pid FROM direct))`,
    [gatePid],
  );
  return Number(rows[0]!.n);
}

/** Polls a condition (not a delay) until `want` writers are parked; throws on timeout. */
async function waitForWaiters(gatePid: number, want: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await waitersBehind(gatePid)) >= want) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`Timed out waiting for ${want} writer(s) parked on the gate`);
}

/** Starts the writers in the given order behind the gate, then lets them race. */
async function raceBehindGate(
  world: World,
  starters: [() => Promise<Outcome>, () => Promise<Outcome>],
): Promise<[Outcome, Outcome]> {
  const gate = await openTenantGate(world.tenantId);
  try {
    const first = starters[0]();
    await waitForWaiters(gate.pid, 1);
    const second = starters[1]();
    await waitForWaiters(gate.pid, 2);
    await gate.release();
    return [await first, await second];
  } finally {
    await gate.release();
  }
}

// ---- observations --------------------------------------------------------------

/** Accounts of the entity that serve a cash role and another role (preflight statement 1). */
async function sharedCashAccounts(world: World) {
  const { rows } = await owner.query<{ account_id: string; roles: string[] }>(
    `SELECT account_id, array_agg(role::text ORDER BY role::text) AS roles
       FROM account_mappings
      WHERE tenant_id = $1 AND legal_entity_id = $2
      GROUP BY account_id
     HAVING count(*) > 1
        AND bool_or(role::text IN ('cash_on_hand', 'petty_cash', 'bank'))`,
    [world.tenantId, world.entityId],
  );
  return rows;
}

async function mappingsOf(world: World) {
  const { rows } = await owner.query<{ role: string; code: string }>(
    `SELECT m.role::text AS role, a.code
       FROM account_mappings m
       JOIN chart_of_accounts a ON a.tenant_id = m.tenant_id AND a.id = m.account_id
      WHERE m.tenant_id = $1 AND m.legal_entity_id = $2
      ORDER BY m.role::text`,
    [world.tenantId, world.entityId],
  );
  return rows;
}

const detail = (label: string, outcome: Outcome) =>
  `${label}: ${outcome.status} ${JSON.stringify(outcome.body)}`;
const ok = (outcome: Outcome) => outcome.status >= 200 && outcome.status < 300;

describe("1140 P2-1 config import and the mapping endpoint share one lock protocol", () => {
  it("[1140-import-vs-mapping-import-first] import (employee_receivable -> A) and owner PUT (petty_cash -> A) racing: A never ends up on petty_cash and employee_receivable", async () => {
    const world = await newWorld();
    expect(
      await mappingsOf(world),
      "premise: the entity starts without mappings",
    ).toEqual([]);

    const [imported, put] = await raceBehindGate(world, [
      () => startImport(world, "1102"),
      () => startOwnerPut(world, world.accountA),
    ]);

    const final = await mappingsOf(world);
    const context = `${detail("import", imported)} | ${detail("put", put)} | mappings ${JSON.stringify(final)}`;
    expect(
      await sharedCashAccounts(world),
      `statement 1 must stay empty. ${context}`,
    ).toEqual([]);
    expect(imported.status, `no server error. ${context}`).toBeLessThan(500);
    expect(put.status, `no server error. ${context}`).toBeLessThan(500);
    expect(
      ok(imported) || ok(put),
      `each alone is valid, so at least one succeeds. ${context}`,
    ).toBe(true);
    // A refused writer is refused by a rule (4xx), never by accident.
    for (const outcome of [imported, put])
      if (!ok(outcome)) expect(outcome.status).toBeGreaterThanOrEqual(400);
  });

  it("[1140-import-vs-mapping-owner-first] control: with the owner PUT parked first the import sees its mapping and the pair is never shared", async () => {
    const world = await newWorld();

    const [put, imported] = await raceBehindGate(world, [
      () => startOwnerPut(world, world.accountA),
      () => startImport(world, "1102"),
    ]);

    const context = `${detail("put", put)} | ${detail("import", imported)} | mappings ${JSON.stringify(await mappingsOf(world))}`;
    expect(
      await sharedCashAccounts(world),
      `statement 1 must stay empty. ${context}`,
    ).toEqual([]);
    expect(put.status, `no server error. ${context}`).toBeLessThan(500);
    expect(imported.status, `no server error. ${context}`).toBeLessThan(500);
    expect(ok(put) || ok(imported), `at least one succeeds. ${context}`).toBe(
      true,
    );
  });

  it("[1140-import-vs-mapping-distinct-accounts] control: petty_cash -> A and employee_receivable -> B racing both succeed and share nothing", async () => {
    const world = await newWorld();

    const [imported, put] = await raceBehindGate(world, [
      () => startImport(world, "1204"),
      () => startOwnerPut(world, world.accountA),
    ]);

    const context = `${detail("import", imported)} | ${detail("put", put)} | mappings ${JSON.stringify(await mappingsOf(world))}`;
    expect(imported.status, `no server error. ${context}`).toBeLessThan(500);
    expect(put.status, `no server error. ${context}`).toBeLessThan(500);
    expect(ok(imported), `import succeeds. ${context}`).toBe(true);
    expect(ok(put), `owner PUT succeeds. ${context}`).toBe(true);
    expect(await sharedCashAccounts(world)).toEqual([]);
  });
});
