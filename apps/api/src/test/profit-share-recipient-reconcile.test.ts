// Profit-share recipient reconciliation (Codex 405, bead legend-9t04v, ps-405).
//
// Problem: migration 0239 used to copy `shareholders.user_id` (the login at
// migration time) onto every old distribution line. If the login had moved
// A -> B before the migration, B got permanent access to A's old statements.
//
// Decision under test: no blind backfill. Old lines keep recipient_user_id NULL.
// Old PAID lines whose shareholder currently has a login are marked
// `recipient_unverified = true`: no shareholder login can read them, and only a
// tenant Owner can list and resolve them (GET/POST
// /api/tenant/profit-share/recipient-reconciliation[...]).
//
// Written from the brief, not from the implementation. Real Express app, Better
// Auth, RBAC, PostgreSQL and RLS. The "pre-migration" state is built by running
// a run through the endpoint while the shareholder has no login (recipient NULL),
// paying it as the migration owner, then linking the login directly in SQL.
//
// Assumptions (the brief does not pin these down):
// - List response: `data` is an array of rows (or an object holding that array
//   under `lines`/`items`/`rows`); each row has `lineId`.
// - A successful resolve answers 2xx (200 expected); the body is not inspected.
// - Unknown login on resolve: any 4xx (400/404/409/422), never 5xx.
// - The audit row is found by action `profit_share.recipient_reconciled` and
//   the line id appearing anywhere in the event.
// - The pre-0239 backfill statement is exercised by extracting the UPDATE on
//   distribution_lines from the migration file (pattern of
//   profit-share-permission-backfill-migration.test.ts) and scoping it to the
//   test's own line ids with an extra `AND l.id = ANY($1)`.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  businessDateSchema,
  idr,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  accountIdSchema,
  distributionRunSchema,
  type DistributionRun,
} from "@starter/shared/accounting";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer";
import { coreAuditWriter } from "../services/core-audit-writer";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import { closeFiscalPeriod } from "../services/accounting-period-close.service";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const API = "/api/accounting";
const RECON = "/api/tenant/profit-share/recipient-reconciliation";
// Each test builds users, a closed period, a run and pays it: allow for a
// loaded machine (a timeout is never the behavior under test).
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const app = createApp();

const pg = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");
const key = (label: string) => `${label}-${randomUUID()}`;

type Person = { client: ReturnType<typeof agent>; userId: string };

async function signedIn(name: string): Promise<Person> {
  const client = agent(app);
  const email = await signUp(client, name);
  await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  return { client, userId: session.body.user.id as string };
}

async function customRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  await pg.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantA,
      `Reconcile test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(["tenant"]),
    ],
  );
  await pg.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantA, userId, roleId],
  );
}

async function assignTemplate(userId: string, templateKey: string) {
  const assigned = await pg.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
      WHERE tenant_id = $1 AND template_key = $3`,
    [tenantA, userId, templateKey],
  );
  expect(assigned.rowCount).toBe(1);
}

async function shareholderUser(name: string) {
  const person = await signedIn(name);
  await assignTemplate(person.userId, "shareholder");
  return person;
}

const post = (who: Person, path: string, body: unknown) =>
  who.client
    .post(path)
    .set(originHeader)
    .send(body as object);
const get = (who: Person, path: string) => who.client.get(path);

// ---- Fixtures (same shape as profit-share-recipient-version.test.ts) ----------

const baseContext = () =>
  establishTenantContext({ tenantId: tenantA, brandId: null, source: "session" });
const scopedContext = (): ScopedTenantContext =>
  establishScopedTenantContext(baseContext(), { kind: "tenant" });

type Accounts = { cash: string; revenue: string; expense: string };

async function makeLegalEntity() {
  const legalEntityId = randomUUID();
  const accounts: Accounts = {
    cash: randomUUID(),
    revenue: randomUUID(),
    expense: randomUUID(),
  };
  await pg.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [legalEntityId, tenantA, `Rekonsiliasi ${unique()}`],
  );
  await pg.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $4, $5, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $4, $5, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($3, $4, $5, '6101', 'Beban operasional', 'expense', 'operating_expense')`,
    [accounts.cash, accounts.revenue, accounts.expense, tenantA, legalEntityId],
  );
  return { legalEntityId, accounts };
}

function journalLine(accountId: string, debit: number, credit: number) {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: null,
    costCenter: null,
  };
}

async function postEntry(
  legalEntityId: string,
  date: string,
  lines: ReturnType<typeof journalLine>[],
) {
  const context = scopedContext();
  await withTenant(db, context, (tx) =>
    postJournalInTransaction(tx, context, {
      legalEntityId,
      outletId: null,
      entryDate: businessDateSchema.parse(date),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Penjualan dan beban (uji rekonsiliasi penerima)",
      lines,
      postedBy: null,
      idempotencyKey: `post-${randomUUID()}`,
    }),
  );
}

const closer = randomUUID();
const NET_PROFIT = 1_000_000;

async function closedPeriod(
  world: { legalEntityId: string; accounts: Accounts },
  period: string,
) {
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantA, world.legalEntityId, period],
  );
  const date = `${period}-15`;
  await postEntry(world.legalEntityId, date, [
    journalLine(world.accounts.cash, NET_PROFIT + 1_000_000, 0),
    journalLine(world.accounts.revenue, 0, NET_PROFIT + 1_000_000),
  ]);
  await postEntry(world.legalEntityId, date, [
    journalLine(world.accounts.expense, 1_000_000, 0),
    journalLine(world.accounts.cash, 0, 1_000_000),
  ]);
  await closeFiscalPeriod(
    scopedContext(),
    rows[0]!.id,
    { expectedVersion: 1, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(closer),
  );
  return rows[0]!.id;
}

let manager: Person; // registry.manage: creates holders, entities, runs
let approver: Person;
let tenantOwner: Person; // template role "owner"
let manageOnly: Person; // registry.manage but NOT Owner

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The API bootstrap installs this; the audit rows are read back below.
  setAuditWriter(coreAuditWriter);
  manager = await signedIn("Reconcile Manager");
  await customRole(manager.userId, ["profit_share.registry.manage"]);
  approver = await signedIn("Reconcile Approver");
  tenantOwner = await signedIn("Reconcile Owner");
  await assignTemplate(tenantOwner.userId, "owner");
  manageOnly = await signedIn("Reconcile Manage Only");
  await customRole(manageOnly.userId, ["profit_share.registry.manage"]);
}, 120_000);

afterAll(async () => {
  await pg.end();
});

async function makeWorld(login: Person | null) {
  const created = await post(manager, `${API}/shareholders`, {
    name: `Pemegang ${unique()}`,
    type: "person",
    userId: login?.userId ?? null,
    npwp: null,
    payoutAccount: null,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const shareholderId = created.body.data.id as string;
  const other = await post(manager, `${API}/shareholders`, {
    name: `Pasangan ${unique()}`,
    type: "person",
    userId: null,
    npwp: null,
    payoutAccount: null,
  });
  expect(other.status, JSON.stringify(other.body)).toBe(201);
  const otherId = other.body.data.id as string;
  const { legalEntityId, accounts } = await makeLegalEntity();
  const entity = await post(manager, `${API}/profit-entities`, {
    name: `Entitas ${unique()}`,
    type: "legal_entity",
    legalEntityId,
    outletId: null,
    policy: {
      basis: "closed_period_net_profit",
      frequency: "monthly",
      reserveBp: 0,
      taxWithholdingBp: 500,
    },
  });
  expect(entity.status, JSON.stringify(entity.body)).toBe(201);
  const profitEntityId = entity.body.data.id as string;
  await pg.query(
    `INSERT INTO share_allocation_versions
       (tenant_id, profit_entity_id, version, effective_from, status, requested_by, idempotency_key)
     VALUES ($1, $2, 1, '2020-01-01', 'draft', $3, $4)`,
    [tenantA, profitEntityId, manager.userId, key("seed-ver")],
  );
  await pg.query(
    `INSERT INTO share_allocations
       (tenant_id, profit_entity_id, version, shareholder_id, share_bp, position)
     VALUES ($1, $2, 1, $3, 5000, 0), ($1, $2, 1, $4, 5000, 1)`,
    [tenantA, profitEntityId, shareholderId, otherId],
  );
  await pg.query(
    `UPDATE share_allocation_versions SET status = 'pending_approval'
     WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = 1`,
    [tenantA, profitEntityId],
  );
  await pg.query(
    `UPDATE share_allocation_versions
     SET status = 'approved', decided_by = $3, decided_at = now()
     WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = 1`,
    [tenantA, profitEntityId, approver.userId],
  );
  return { shareholderId, legalEntityId, accounts, profitEntityId, next: 0 };
}

type World = Awaited<ReturnType<typeof makeWorld>>;
type PaidRun = { run: DistributionRun; lineId: string };

/** Run created through the endpoint (snapshots the recipient) and approved; lines stay pending. */
async function approvedRun(world: World): Promise<PaidRun> {
  const period = await closedPeriod(
    world,
    `${2021 + Math.floor(world.next / 12)}-${String((world.next++ % 12) + 1).padStart(2, "0")}`,
  );
  const response = await post(
    manager,
    `${API}/profit-entities/${world.profitEntityId}/distributions`,
    { fiscalPeriodId: period, idempotencyKey: key("run") },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const run = distributionRunSchema.parse(response.body.data);
  await pg.query(
    `UPDATE distribution_runs SET status = 'pending_approval'
     WHERE tenant_id = $1 AND id = $2`,
    [tenantA, run.id],
  );
  await pg.query(
    `UPDATE distribution_runs
     SET status = 'approved', approved_by = $3, approved_at = now() - interval '1 hour'
     WHERE tenant_id = $1 AND id = $2`,
    [tenantA, run.id, approver.userId],
  );
  const lineId = run.lines.find(
    (line) => line.shareholderId === world.shareholderId,
  )!.id;
  return { run, lineId };
}

/** An approved run whose line of the world's shareholder is paid as owner. */
async function paidRun(world: World): Promise<PaidRun> {
  const { run, lineId } = await approvedRun(world);
  await pg.query(
    `UPDATE distribution_lines
     SET payment_status = 'paid', payment_ref = $3, paid_at = now(), paid_by = $4
     WHERE tenant_id = $1 AND distribution_run_id = $2 AND shareholder_id = $5`,
    [tenantA, run.id, `TRF-${unique()}`, manager.userId, world.shareholderId],
  );
  return { run, lineId };
}

const statementPath = ({ run, lineId }: PaidRun) =>
  `${API}/distributions/${run.id}/lines/${lineId}/statement`;

/** Run `fn` with the lines guard and totals trigger paused, as migration 0239 does. */
async function withGuardsPaused<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await pg.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query(
      "ALTER TABLE public.distribution_lines DISABLE TRIGGER distribution_lines_guard_trg",
    );
    await client.query(
      "ALTER TABLE public.distribution_lines DISABLE TRIGGER distribution_lines_totals_trg",
    );
    const result = await fn(client);
    await client.query(
      "ALTER TABLE public.distribution_lines ENABLE TRIGGER distribution_lines_totals_trg",
    );
    await client.query(
      "ALTER TABLE public.distribution_lines ENABLE TRIGGER distribution_lines_guard_trg",
    );
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
 * The state migration 0239 meets on an old database: a paid line created before
 * recipient_user_id existed (NULL), under a shareholder whose login is `current`
 * today. `flag` marks it the way the migration's backfill does.
 */
async function legacyLine(current: Person, flag: boolean): Promise<PaidRun> {
  const world = await makeWorld(null);
  const paid = await paidRun(world);
  const link = await pg.query(
    "UPDATE shareholders SET user_id = $3 WHERE tenant_id = $1 AND id = $2",
    [tenantA, world.shareholderId, current.userId],
  );
  expect(link.rowCount).toBe(1);
  if (flag)
    await withGuardsPaused((client) =>
      client.query(
        "UPDATE distribution_lines SET recipient_unverified = true WHERE tenant_id = $1 AND id = $2",
        [tenantA, paid.lineId],
      ),
    );
  return paid;
}

async function lineRow(lineId: string) {
  const { rows } = await pg.query<{
    recipient_user_id: string | null;
    recipient_unverified: boolean;
  }>(
    "SELECT recipient_user_id, recipient_unverified FROM distribution_lines WHERE id = $1",
    [lineId],
  );
  return rows[0]!;
}

function listed(body: { data: unknown }): { lineId: string }[] {
  const data = body.data as
    | { lineId: string }[]
    | Record<string, { lineId: string }[]>;
  if (Array.isArray(data)) return data;
  return data.lines ?? data.items ?? data.rows ?? [];
}

const resolvePath = (lineId: string) => `${RECON}/${lineId}/resolve`;
const NOTE = "Diverifikasi dari bukti transfer lama.";

// ---- Tests -------------------------------------------------------------------

describe("1 a pre-0239 line whose login moved A -> B is closed to every shareholder login", () => {
  it("B (current login) and A (no snapshot) both get 404; B's own list omits it", async () => {
    const alice = await shareholderUser("Alice Lama Pra");
    const bob = await shareholderUser("Bob Login Kini");
    const line = await legacyLine(bob, true);
    expect(await lineRow(line.lineId)).toEqual({
      recipient_user_id: null,
      recipient_unverified: true,
    });

    const asBob = await get(bob, statementPath(line));
    expect(asBob.status, JSON.stringify(asBob.body)).toBe(404);
    const asAlice = await get(alice, statementPath(line));
    expect(asAlice.status, JSON.stringify(asAlice.body)).toBe(404);

    const mine = await get(bob, `${API}/my-profit-share`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const ids = (
      mine.body.data.distributionHistory as { distributionLineId: string }[]
    ).map((entry) => entry.distributionLineId);
    expect(ids).not.toContain(line.lineId);
  });
});

describe("2 reconciliation list is Owner only", () => {
  it("the Owner sees the unverified line; a manager without Owner and B get 403", async () => {
    const bob = await shareholderUser("Bob Daftar");
    const line = await legacyLine(bob, true);

    const asOwner = await get(tenantOwner, RECON);
    expect(asOwner.status, JSON.stringify(asOwner.body)).toBe(200);
    const row = listed(asOwner.body).find(
      (entry) => entry.lineId === line.lineId,
    );
    expect(row).toMatchObject({
      lineId: line.lineId,
      runId: line.run.id,
      shareholderId: line.run.lines.find((l) => l.id === line.lineId)!
        .shareholderId,
      paymentStatus: "paid",
    });

    const asManager = await get(manageOnly, RECON);
    expect(asManager.status, JSON.stringify(asManager.body)).toBe(403);
    const asBob = await get(bob, RECON);
    expect(asBob.status, JSON.stringify(asBob.body)).toBe(403);
  });

  it("a line that is not unverified is not listed", async () => {
    const bob = await shareholderUser("Bob Tidak Ditandai");
    const line = await legacyLine(bob, false);
    const asOwner = await get(tenantOwner, RECON);
    expect(asOwner.status, JSON.stringify(asOwner.body)).toBe(200);
    expect(listed(asOwner.body).map((e) => e.lineId)).not.toContain(
      line.lineId,
    );
  });
});

describe("3 only an Owner resolves, once, to a real login", () => {
  it("Owner resolves to A: A reads, B stays 404, the line leaves the list, audited; again is 404", async () => {
    const alice = await shareholderUser("Alice Penerima Asli");
    const bob = await shareholderUser("Bob Bukan Penerima");
    const line = await legacyLine(bob, true);

    const resolved = await post(tenantOwner, resolvePath(line.lineId), {
      recipientUserId: alice.userId,
      note: NOTE,
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBeGreaterThanOrEqual(
      200,
    );
    expect(resolved.status).toBeLessThan(300);
    expect(await lineRow(line.lineId)).toEqual({
      recipient_user_id: alice.userId,
      recipient_unverified: false,
    });

    const asAlice = await get(alice, statementPath(line));
    expect(asAlice.status, JSON.stringify(asAlice.body)).toBe(200);
    expect((await get(bob, statementPath(line))).status).toBe(404);

    const after = await get(tenantOwner, RECON);
    expect(after.status).toBe(200);
    expect(listed(after.body).map((e) => e.lineId)).not.toContain(line.lineId);

    const audit = await pg.query<{ actor: string | null; raw: string }>(
      `SELECT event->>'actorId' AS actor, event::text AS raw
         FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'profit_share.recipient_reconciled'
          AND event::text LIKE '%' || $2 || '%'`,
      [tenantA, line.lineId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.actor).toBe(tenantOwner.userId);

    const again = await post(tenantOwner, resolvePath(line.lineId), {
      recipientUserId: alice.userId,
      note: NOTE,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(404);
  });

  it("Owner may resolve to no login (write off): the line leaves the list, nobody reads it", async () => {
    const bob = await shareholderUser("Bob Tanpa Penerima");
    const line = await legacyLine(bob, true);
    const resolved = await post(tenantOwner, resolvePath(line.lineId), {
      recipientUserId: null,
      note: NOTE,
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBeLessThan(300);
    expect(await lineRow(line.lineId)).toEqual({
      recipient_user_id: null,
      recipient_unverified: false,
    });
    expect((await get(bob, statementPath(line))).status).toBe(404);
  });

  it("a non-Owner (manager, or B) gets 403 and the line stays unverified", async () => {
    const alice = await shareholderUser("Alice Ditolak");
    const bob = await shareholderUser("Bob Ditolak");
    const line = await legacyLine(bob, true);
    for (const who of [manageOnly, bob]) {
      const refused = await post(who, resolvePath(line.lineId), {
        recipientUserId: alice.userId,
        note: NOTE,
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    }
    expect(await lineRow(line.lineId)).toEqual({
      recipient_user_id: null,
      recipient_unverified: true,
    });
  });

  it("an unknown login id is a 4xx and changes nothing", async () => {
    const bob = await shareholderUser("Bob Id Asing");
    const line = await legacyLine(bob, true);
    const refused = await post(tenantOwner, resolvePath(line.lineId), {
      recipientUserId: `no-such-user-${unique()}`,
      note: NOTE,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(refused.status).toBeLessThan(500);
    expect(await lineRow(line.lineId)).toEqual({
      recipient_user_id: null,
      recipient_unverified: true,
    });
  });

  it("a line that was never unverified cannot be resolved (404)", async () => {
    const alice = await shareholderUser("Alice Tidak Ditandai");
    const bob = await shareholderUser("Bob Tidak Ditandai Dua");
    const line = await legacyLine(bob, false);
    const refused = await post(tenantOwner, resolvePath(line.lineId), {
      recipientUserId: alice.userId,
      note: NOTE,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(404);
    expect(await lineRow(line.lineId)).toEqual({
      recipient_user_id: null,
      recipient_unverified: false,
    });
  });
});

describe("3b the lines guard stays closed except for the one resolve edit", () => {
  it("rejects other edits of a frozen unverified line, even together with the resolve", async () => {
    const alice = await shareholderUser("Alice Guard");
    const bob = await shareholderUser("Bob Guard");
    const line = await legacyLine(bob, true);

    await expect(
      pg.query(
        "UPDATE distribution_lines SET net_idr = net_idr + 1 WHERE id = $1",
        [line.lineId],
      ),
    ).rejects.toThrow();
    await expect(
      pg.query(
        `UPDATE distribution_lines
            SET recipient_user_id = $2, recipient_unverified = false,
                net_idr = net_idr + 1
          WHERE id = $1`,
        [line.lineId, alice.userId],
      ),
    ).rejects.toThrow();
    // Setting a recipient without clearing the flag is not the resolve edit.
    await expect(
      pg.query(
        "UPDATE distribution_lines SET recipient_user_id = $2 WHERE id = $1",
        [line.lineId, alice.userId],
      ),
    ).rejects.toThrow();
    expect(await lineRow(line.lineId)).toEqual({
      recipient_user_id: null,
      recipient_unverified: true,
    });
  });

  it("rejects setting recipient_user_id on a line with recipient_unverified = false", async () => {
    const alice = await shareholderUser("Alice Tertutup");
    const bob = await shareholderUser("Bob Tertutup");
    // Never flagged (a line created after 0239 is never flagged).
    const plain = await legacyLine(bob, false);
    await expect(
      pg.query(
        "UPDATE distribution_lines SET recipient_user_id = $2 WHERE id = $1",
        [plain.lineId, alice.userId],
      ),
    ).rejects.toThrow();

    // Resolved once: it is frozen again, no second re-assignment. (A login
    // can be linked to one shareholder row only, so this line gets its own.)
    const carol = await shareholderUser("Carol Tertutup");
    const flagged = await legacyLine(carol, true);
    const resolved = await post(tenantOwner, resolvePath(flagged.lineId), {
      recipientUserId: alice.userId,
      note: NOTE,
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBeLessThan(300);
    await expect(
      pg.query(
        "UPDATE distribution_lines SET recipient_user_id = $2 WHERE id = $1",
        [flagged.lineId, carol.userId],
      ),
    ).rejects.toThrow();
    expect((await lineRow(flagged.lineId)).recipient_user_id).toBe(
      alice.userId,
    );
  });
});

const sqlText = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../drizzle/0239_profit_share_recipient_versions.sql",
  ),
  "utf8",
);
const updates = sqlText
  .split("--> statement-breakpoint")
  .map((part) => part.trim())
  .filter((part) => /^UPDATE\s+(public\.)?distribution_lines\b/im.test(part));

/** Run the migration's backfill UPDATE, scoped to the test's own line ids. */
async function runBackfill(lineIds: string[]) {
  const statement = `${updates[0]!.replace(/;\s*$/, "")}\n  AND l.id = ANY($1::uuid[])`;
  await withGuardsPaused((client) => client.query(statement, [lineIds]));
}

describe("3c an old UNPAID line is not flagged; paying it attributes the login", () => {
  it("backfill leaves it NULL and unflagged; pay sets recipient B and B reads the statement", async () => {
    const bob = await shareholderUser("Bob Bayar Tertunda");
    const world = await makeWorld(null);
    const pending = await approvedRun(world);
    await pg.query(
      "UPDATE shareholders SET user_id = $3 WHERE tenant_id = $1 AND id = $2",
      [tenantA, world.shareholderId, bob.userId],
    );

    await runBackfill([pending.lineId]);
    expect(await lineRow(pending.lineId)).toEqual({
      recipient_user_id: null,
      recipient_unverified: false,
    });

    const paid = await post(
      manager,
      `${API}/distributions/${pending.run.id}/lines/${pending.lineId}/payment`,
      {
        paymentRef: `TRF-${unique()}`,
        paidAt: new Date(Date.now() - 60_000).toISOString(),
        idempotencyKey: key("pay"),
      },
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const row = await pg.query<{ payment_status: string }>(
      "SELECT payment_status FROM distribution_lines WHERE id = $1",
      [pending.lineId],
    );
    expect(row.rows[0]!.payment_status).toBe("paid");
    expect(await lineRow(pending.lineId)).toEqual({
      recipient_user_id: bob.userId,
      recipient_unverified: false,
    });
    const asBob = await get(bob, statementPath(pending));
    expect(asBob.status, JSON.stringify(asBob.body)).toBe(200);
  });
});

describe("4 migration 0239 backfill flags, and never assigns, a recipient", () => {
  it("the SQL text has one lines UPDATE that sets recipient_unverified and never recipient_user_id", () => {
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/SET\s+recipient_unverified\s*=\s*true/i);
    expect(sqlText).not.toMatch(/SET\s+recipient_user_id\s*=\s*s\.user_id/i);
    expect(updates[0]).not.toMatch(/recipient_user_id\s*=\s*s\.user_id/i);
  });

  it("run on constructed rows: flags only paid recipient-null lines whose shareholder has a login", async () => {
    const alice = await shareholderUser("Alice Migrasi");
    const bob = await shareholderUser("Bob Migrasi");
    const dina = await shareholderUser("Dina Migrasi");
    // L1: recipient NULL, shareholder has a login now -> flagged.
    const l1 = await legacyLine(bob, false);
    // L2: recipient NULL, shareholder has no login -> not flagged.
    const world2 = await makeWorld(null);
    const l2 = await paidRun(world2);
    // L3: recipient already set (created with a login) -> untouched.
    const world3 = await makeWorld(alice);
    const l3 = await paidRun(world3);
    expect((await lineRow(l3.lineId)).recipient_user_id).toBe(alice.userId);
    // L4: recipient NULL, shareholder has a login now, but NOT paid -> unflagged.
    const world4 = await makeWorld(null);
    const l4 = await approvedRun(world4);
    await pg.query(
      "UPDATE shareholders SET user_id = $3 WHERE tenant_id = $1 AND id = $2",
      [tenantA, world4.shareholderId, dina.userId],
    );

    await runBackfill([l1.lineId, l2.lineId, l3.lineId, l4.lineId]);

    expect(await lineRow(l1.lineId)).toEqual({
      recipient_user_id: null,
      recipient_unverified: true,
    });
    expect(await lineRow(l2.lineId)).toEqual({
      recipient_user_id: null,
      recipient_unverified: false,
    });
    expect(await lineRow(l3.lineId)).toEqual({
      recipient_user_id: alice.userId,
      recipient_unverified: false,
    });
    expect(await lineRow(l4.lineId)).toEqual({
      recipient_user_id: null,
      recipient_unverified: false,
    });
  });
});
