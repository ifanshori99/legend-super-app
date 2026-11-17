// Petty cash top-up above the tenant limit + anti-split rule (founder decision
// 13 Nov 2026, tier K money). Written from docs/briefs/sub-cash-limit-antisplit.md
// ("Keputusan" and "Test gagal-dulu" 1-10) and the black-box API, not from the
// implementation. Real Better Auth, RLS and PostgreSQL on the disposable test
// DB; requests go through createApp().
//
// Rules under test:
// - A petty cash top-up (kind topup, bank -> petty cash) obeys the SAME limit
//   and approval as a cash out: amount > limit (strict) -> pending_approval,
//   no journal, no fund balance change, no petty_cash_entries row, until a
//   different finance user approves. `return` is not gated.
// - Anti-split (founder Q18, 13 Nov 2026): for one creator and one tenant
//   calendar day (Asia/Jakarta, 00:00, measured on the SERVER created_at,
//   never the back-datable entry_date), across ALL outlets and entity-level
//   entries (no outlet), the amount of THIS entry + earlier cash outs +
//   top-ups that are approved or pending > limit makes THIS entry pending.
//   Earlier entries are never changed. Rejected entries, other creators and
//   other days are not summed. Parallel submits cannot all slip through.
//
// Fail-first mapping (brief items):
//   AS-1 (1) direct at/below limit        AS-2 (2) pending topup, nothing moves
//   AS-3 (3) approve once, seq + parallel AS-4 (4) self approval, reject
//   AS-5 (5) 3 x 2jt, mixed kinds         AS-6 (6) other creator/day; all outlets summed,
//   AS-7 (7) parallel submits                      rejected not counted
//   AS-8 (8) other tenant refused         AS-9 (9) no double count on approval
//   (10) the old cash-out/petty suites stay green; AS-1 keeps small amounts.
//
// Isolation: the Cafe Legend tenant is shared with other test files, so this
// file only counts rows of its own outlets / own legal entity, and every test
// uses its OWN creator (and its own outlet) so the per-creator daily
// accumulation (now across all outlets) never leaks between tests. The tenant limit is shared state:
// the cash-out approval file lowers it briefly, so each test first waits for
// the default Rp5.000.000 to be back. This file never changes the limit.
//
// Assumptions where the brief is silent:
// - An approved/direct top-up answers 201 with the petty entry
//   (kind "topup", journalStatus "posted"); a pending one answers 202 with
//   `{ data }` = CashBankEntry (kind "petty_topup", status "pending_approval",
//   journalEntryId null, outletId = the outlet, amountIdr).
// - A cash out answers 201 in both cases (status approved | pending_approval).
// - Approve/reject of a petty_topup use the same endpoints as a cash out
//   (POST /entries/:id/approve|reject), answer 200, errors use
//   `{ error: { code } }` (CASH_OUT_SELF_APPROVAL 403, CASH_ENTRY_NOT_PENDING
//   409, CASH_ENTRY_NOT_FOUND 404), as in accounting-cash-out-approval.test.ts.
// - Approving a petty_topup opens/raises the outlet's fund exactly once: one
//   petty_cash_entries row (kind topup) and one journal Dr petty cash /
//   Cr the bank account's own GL. The exact idempotency key of that row is
//   not pinned.
// - Period closed before approval: the approve answers a 4xx domain error
//   (not NOT_FOUND / NOT_PENDING), the entry stays pending, no petty entry,
//   no fund, no journal, nothing parked (brief: do NOT park).
// - Day = calendar date in Asia/Jakarta (WIB, midnight cutoff), the same for
//   every outlet: the outlet's own time zone and cutoff play no part. To
//   control the SERVER time the tests move created_at of an earlier
//   cash_bank_entries row as the migration owner (replica role, so triggers
//   do not interfere). Only cash outs are moved, never top-ups. WIB has no DST.
// - Entity-level entries (outlet NULL) are summed with the outlet entries.
import { randomUUID } from "node:crypto";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { originHeader } from "./helpers.ts";
import {
  closeKit,
  daysAgo,
  journalLinesOf,
  journalsByKey,
  key,
  lineOf,
  makeOutlet,
  makeWorld,
  owner,
  short,
  signedIn,
  tenantId,
  type Session,
  type World,
} from "./helpers/cash-bank-world.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";

const app = createApp();
const ENTRIES = "/api/accounting/cash-bank/entries";
const MOVEMENTS = "/api/accounting/petty-cash/movements";
const LIMIT_IDR = 5_000_000;
const MIL = 1_000_000;

let world: World;
let nobody: Session;
const foreignFixture: { outletId?: string; brandId?: string } = {};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  world = await makeWorld();
  nobody = await signedIn(app, "AS nobody", []);
});

afterAll(async () => {
  // Owner cleanup of the other-tenant rows of AS-8 (replica mode skips FKs).
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "cash_bank_entries",
      "petty_cash_entries",
      "petty_cash_funds",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        world.foreign.tenantId,
      ]);
    if (foreignFixture.outletId)
      await client.query("DELETE FROM outlets WHERE id = $1", [
        foreignFixture.outletId,
      ]);
    if (foreignFixture.brandId)
      await client.query("DELETE FROM brands WHERE id = $1", [
        foreignFixture.brandId,
      ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await closeKit();
});

// The cash-out approval file briefly lowers the shared tenant limit (CO-8d).
// Hold the shared limit lock per test so the amounts below mean what they say.
withLimitSharedLock();

// ---- sessions and fixtures -------------------------------------------------

/** A tenant-wide finance user: records, approves, one per test. */
const finance = (label: string) =>
  signedIn(app, `AS ${label}`, [{ role: "finance", outletId: null }]);
const freshOutlet = () => makeOutlet(world.entityId);

// ---- requests --------------------------------------------------------------

type Json = Record<string, unknown>;
const postEntry = (who: Session, body: Json) =>
  who.client
    .post(ENTRIES)
    .set(originHeader)
    .send(body as object);
const postMove = (who: Session, body: Json) =>
  who.client
    .post(MOVEMENTS)
    .set(originHeader)
    .send(body as object);
const decide = (
  who: Session,
  entryId: string,
  action: "approve" | "reject",
  body: Json = action === "reject" ? { reason: "Tidak sesuai" } : {},
) =>
  who.client
    .post(`${ENTRIES}/${encodeURIComponent(entryId)}/${action}`)
    .set(originHeader)
    .send(body);
const approve = (who: Session, id: string) => decide(who, id, "approve");
const reject = (who: Session, id: string, reason = "Tidak sesuai") =>
  decide(who, id, "reject", { reason });

const cashOutBody = (
  outletId: string | null,
  amountIdr: number,
  extra: Json = {},
): Json => ({
  kind: "cash_out",
  legalEntityId: world.entityId,
  bankAccountId: world.bankAccountA,
  counterAccountId: world.gl.expense,
  amountIdr,
  entryDate: daysAgo(1),
  description: "Bayar supplier",
  reference: `REF-${short()}`,
  idempotencyKey: key(),
  ...(outletId ? { outletId } : {}),
  ...extra,
});
const topupBody = (outletId: string, amountIdr: number, extra: Json = {}) => ({
  kind: "topup",
  outletId,
  bankAccountId: world.bankAccountA,
  amountIdr,
  description: "Isi kas kecil",
  idempotencyKey: key(),
  ...extra,
});

const cashOut = (
  who: Session,
  outletId: string | null,
  amountIdr: number,
  extra: Json = {},
) => postEntry(who, cashOutBody(outletId, amountIdr, extra));
const topup = (
  who: Session,
  outletId: string,
  amountIdr: number,
  extra: Json = {},
) => postMove(who, topupBody(outletId, amountIdr, extra));

type Res = Pick<Response, "status" | "body">;
type Outcome = "direct" | "pending";

/** Reads a cash-out response: 201 either way; the status says which. */
function coOutcome(res: Res): Outcome {
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const status = res.body.data.status as string;
  expect(["approved", "pending_approval"], JSON.stringify(res.body)).toContain(
    status,
  );
  return status === "approved" ? "direct" : "pending";
}
/** Reads a top-up response: 201 petty entry (direct) or 202 petty_topup (pending). */
function tuOutcome(res: Res): Outcome {
  expect([201, 202], JSON.stringify(res.body)).toContain(res.status);
  if (res.status === 202) {
    expect(res.body.data).toMatchObject({
      kind: "petty_topup",
      status: "pending_approval",
      journalEntryId: null,
    });
    return "pending";
  }
  expect(res.body.data).toMatchObject({
    kind: "topup",
    journalStatus: "posted",
  });
  return "direct";
}

// ---- reads as the migration owner, scoped to this file's rows ---------------

async function fundBalance(outletId: string): Promise<number | null> {
  const { rows } = await owner.query<{ balance: string }>(
    "SELECT balance_idr::text AS balance FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
  return rows[0] ? Number(rows[0].balance) : null;
}

type PettyRow = {
  id: string;
  kind: string;
  amount: number;
  journal_entry_id: string | null;
};
async function pettyRows(outletId: string): Promise<PettyRow[]> {
  const { rows } = await owner.query<{
    id: string;
    kind: string;
    amount: string;
    journal_entry_id: string | null;
  }>(
    `SELECT id, kind, amount_idr::text AS amount, journal_entry_id
       FROM petty_cash_entries WHERE tenant_id = $1 AND outlet_id = $2
      ORDER BY created_at, id`,
    [tenantId, outletId],
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

/** Journals reached through the petty entries of one outlet. */
async function pettyJournalCount(outletId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries je
       JOIN petty_cash_entries pe ON pe.journal_entry_id = je.id
      WHERE pe.tenant_id = $1 AND pe.outlet_id = $2`,
    [tenantId, outletId],
  );
  return Number(rows[0]!.n);
}

type StoredEntry = {
  id: string;
  kind: string;
  status: string;
  outlet_id: string | null;
  bank_account_id: string | null;
  amount: number;
  journal_entry_id: string | null;
  approver_id: string | null;
  created_by: string;
};
async function stored(id: string): Promise<StoredEntry> {
  const { rows } = await owner.query<
    Omit<StoredEntry, "amount"> & { amount: string }
  >(
    `SELECT id, kind, status, outlet_id, bank_account_id, amount_idr::text AS amount,
            journal_entry_id, approver_id, created_by
       FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  expect(rows, `cash_bank_entries row ${id}`).toHaveLength(1);
  return { ...rows[0]!, amount: Number(rows[0]!.amount) };
}
async function entryRowsOfOutlet(outletId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_bank_entries WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
  return Number(rows[0]!.n);
}
const journalsOf = (entryId: string) =>
  journalsByKey(world.entityId, `cb:${entryId}`);

/** Moves the SERVER created_at of one cash_bank_entries row (owner, no triggers). */
async function backdate(entryId: string, instant: Date): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const res = await client.query(
      "UPDATE cash_bank_entries SET created_at = $3 WHERE tenant_id = $1 AND id = $2",
      [tenantId, entryId, instant.toISOString()],
    );
    expect(res.rowCount).toBe(1);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** The latest instant <= now that is local midnight in `timeZone` (no DST zones). */
function lastLocalMidnight(timeZone: string): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const num = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  const sinceMidnightMs =
    ((num("hour") * 60 + num("minute")) * 60 + num("second")) * 1000 +
    now.getMilliseconds();
  return new Date(now.getTime() - sinceMidnightMs);
}

// ============================================================================

describe("top-up limit: direct posting", () => {
  it("[cash-limit-antisplit-AS-1] a top-up at or below the limit posts at once: fund up, one balanced journal; small amounts stay direct", async () => {
    // Exactly the limit: strict `>` means it is NOT gated.
    const a = await finance("as1 a");
    const outletA = await freshOutlet();
    const exact = await topup(a, outletA, LIMIT_IDR);
    expect(tuOutcome(exact)).toBe("direct");
    expect(exact.body.data).toMatchObject({
      amountIdr: LIMIT_IDR,
      balanceAfterIdr: LIMIT_IDR,
    });
    expect(await fundBalance(outletA)).toBe(LIMIT_IDR);
    const rows = await pettyRows(outletA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.journal_entry_id).toEqual(expect.any(String));
    const lines = await journalLinesOf(rows[0]!.journal_entry_id!);
    expect(lineOf(lines, world.gl.pettyCash)).toEqual({
      debit: LIMIT_IDR,
      credit: 0,
    });
    expect(lineOf(lines, world.gl.bankA)).toEqual({
      debit: 0,
      credit: LIMIT_IDR,
    });
    expect(await pettyJournalCount(outletA)).toBe(1);

    // Own amount <= limit and the accumulation stays <= limit: both direct.
    const b = await finance("as1 b");
    const outletB = await freshOutlet();
    expect(tuOutcome(await topup(b, outletB, 2 * MIL))).toBe("direct");
    expect(tuOutcome(await topup(b, outletB, 2 * MIL))).toBe("direct");
    expect(await fundBalance(outletB)).toBe(4 * MIL);
    expect(await pettyJournalCount(outletB)).toBe(2);

    // A small amount (the old petty tests) is untouched.
    const c = await finance("as1 c");
    const outletC = await freshOutlet();
    expect(tuOutcome(await topup(c, outletC, 100_000))).toBe("direct");
    expect(await fundBalance(outletC)).toBe(100_000);
  });
});

describe("top-up limit: above the limit needs approval", () => {
  it("[cash-limit-antisplit-AS-2] a top-up above the limit answers 202 pending: no journal, fund unchanged, no petty entry, visible in the list", async () => {
    const creator = await finance("as2");
    const other = await finance("as2 funder");
    const outlet = await freshOutlet();
    // An existing fund (opened by someone else, so it is not creator's sum).
    expect(tuOutcome(await topup(other, outlet, 100_000))).toBe("direct");
    const petty = await pettyRows(outlet);
    const journals = await pettyJournalCount(outlet);

    const res = await topup(creator, outlet, LIMIT_IDR + 1);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.data).toMatchObject({
      kind: "petty_topup",
      status: "pending_approval",
      amountIdr: LIMIT_IDR + 1,
      outletId: outlet,
      journalEntryId: null,
      approverId: null,
    });
    const id = res.body.data.id as string;

    expect(await fundBalance(outlet)).toBe(100_000);
    expect(await pettyRows(outlet)).toEqual(petty);
    expect(await pettyJournalCount(outlet)).toBe(journals);
    expect(await journalsOf(id)).toHaveLength(0);
    expect(await stored(id)).toMatchObject({
      kind: "petty_topup",
      status: "pending_approval",
      outlet_id: outlet,
      bank_account_id: world.bankAccountA,
      amount: LIMIT_IDR + 1,
      journal_entry_id: null,
      created_by: creator.userId,
    });

    // The Kas & Bank list shows it with its status.
    const read = await creator.client
      .get(`${ENTRIES}/${encodeURIComponent(id)}`)
      .set(originHeader);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data).toMatchObject({
      id,
      kind: "petty_topup",
      status: "pending_approval",
    });
    const listed = await creator.client
      .get(ENTRIES)
      .set(originHeader)
      .query({
        legalEntityId: world.entityId,
        from: daysAgo(30),
        to: daysAgo(0),
        limit: 100,
      });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(
      listed.body.data.find((r: { id: string }) => r.id === id),
    ).toMatchObject({ kind: "petty_topup", status: "pending_approval" });
  });

  it("[cash-limit-antisplit-AS-2b] a return (petty cash back to bank) is not gated and is not summed into the daily total", async () => {
    const creator = await finance("as2b");
    const outlet = await freshOutlet();
    // Seed a fund of Rp9.000.000 through an approved top-up by two OTHER users, so
    // the creator's own sum is 0 and GL 1102 backs the fund (legend-a4z2f refuses a
    // return of money the books do not show; a raw INSERT left the GL at 0).
    const seeder = await finance("as2b seeder");
    const seedApprover = await finance("as2b seed approver");
    const seeded = await topup(seeder, outlet, 9 * MIL);
    expect(tuOutcome(seeded)).toBe("pending");
    const seedApproved = await approve(
      seedApprover,
      seeded.body.data.id as string,
    );
    expect(seedApproved.status, JSON.stringify(seedApproved.body)).toBe(200);
    // A return above the limit posts at once.
    const back = await postMove(creator, {
      kind: "return",
      outletId: outlet,
      bankAccountId: world.bankAccountA,
      amountIdr: LIMIT_IDR + 1,
      description: "Setor sisa kas kecil",
      idempotencyKey: key(),
    });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect(back.body.data).toMatchObject({
      kind: "return",
      journalStatus: "posted",
    });
    expect(await fundBalance(outlet)).toBe(9 * MIL - (LIMIT_IDR + 1));
    // If the return were summed (5.000.001 + 4.000.000) this would be pending.
    expect(tuOutcome(await topup(creator, outlet, 4 * MIL))).toBe("direct");
  });
});

describe("top-up approval: money moves exactly once", () => {
  it("[cash-limit-antisplit-AS-3a] approving raises the fund once with one balanced journal; approving again (sequential) changes nothing", async () => {
    const creator = await finance("as3a creator");
    const approver = await finance("as3a approver");
    const approver2 = await finance("as3a approver2");
    const outlet = await freshOutlet();
    const amount = 6 * MIL;
    const pending = await topup(creator, outlet, amount);
    expect(tuOutcome(pending)).toBe("pending");
    const id = pending.body.data.id as string;
    expect(await fundBalance(outlet)).toBeNull();

    const first = await approve(approver, id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toMatchObject({
      id,
      kind: "petty_topup",
      status: "approved",
      approverId: approver.userId,
    });
    expect(typeof first.body.data.journalEntryId).toBe("string");

    expect(await fundBalance(outlet)).toBe(amount);
    const rows = await pettyRows(outlet);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "topup", amount });
    expect(rows[0]!.journal_entry_id).toBe(first.body.data.journalEntryId);
    expect(await pettyJournalCount(outlet)).toBe(1);
    const lines = await journalLinesOf(rows[0]!.journal_entry_id!);
    expect(lineOf(lines, world.gl.pettyCash)).toEqual({
      debit: amount,
      credit: 0,
    });
    expect(lineOf(lines, world.gl.bankA)).toEqual({
      debit: 0,
      credit: amount,
    });
    expect(lines).toHaveLength(2);
    expect(await stored(id)).toMatchObject({
      status: "approved",
      approver_id: approver.userId,
      journal_entry_id: rows[0]!.journal_entry_id,
    });

    // Approving again (same or another approver) is idempotent: money once.
    for (const who of [approver, approver, approver2]) {
      const again = await approve(who, id);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body.data.status).toBe("approved");
      expect(again.body.data.journalEntryId).toBe(
        first.body.data.journalEntryId,
      );
    }
    expect(await fundBalance(outlet)).toBe(amount);
    expect(await pettyRows(outlet)).toHaveLength(1);
    expect(await pettyJournalCount(outlet)).toBe(1);
  });

  it("[cash-limit-antisplit-AS-3b] parallel approvals (Promise.all) raise the fund once with one journal", async () => {
    const creator = await finance("as3b creator");
    const approver = await finance("as3b approver");
    const approver2 = await finance("as3b approver2");
    const outlet = await freshOutlet();
    const amount = 6_200_000;
    const pending = await topup(creator, outlet, amount);
    expect(tuOutcome(pending)).toBe("pending");
    const id = pending.body.data.id as string;

    const results = await Promise.all([
      approve(approver, id),
      approve(approver, id),
      approve(approver2, id),
      approve(approver2, id),
      approve(approver, id),
    ]);
    for (const res of results) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.status).toBe("approved");
    }
    expect(
      new Set(results.map((r) => r.body.data.journalEntryId as string)).size,
    ).toBe(1);
    expect(await fundBalance(outlet)).toBe(amount);
    expect(await pettyRows(outlet)).toHaveLength(1);
    expect(await pettyJournalCount(outlet)).toBe(1);
  });

  it("[cash-limit-antisplit-AS-3c] approve and reject racing: one wins, the other is 409; the fund follows the winner", async () => {
    for (let round = 0; round < 3; round += 1) {
      const creator = await finance(`as3c creator ${round}`);
      const approver = await finance(`as3c approver ${round}`);
      const rejecter = await finance(`as3c rejecter ${round}`);
      const outlet = await freshOutlet();
      const amount = 6_400_000 + round;
      const pending = await topup(creator, outlet, amount);
      expect(tuOutcome(pending)).toBe("pending");
      const id = pending.body.data.id as string;
      const calls =
        round % 2 === 0
          ? [approve(approver, id), reject(rejecter, id)]
          : [reject(rejecter, id), approve(approver, id)];
      const results = await Promise.all(calls);
      const [approveRes, rejectRes] =
        round % 2 === 0 ? results : [results[1]!, results[0]!];
      const winners = [approveRes, rejectRes].filter((r) => r.status === 200);
      const losers = [approveRes, rejectRes].filter((r) => r.status !== 200);
      expect(
        winners,
        JSON.stringify([approveRes.body, rejectRes.body]),
      ).toHaveLength(1);
      expect(losers[0]!.status).toBe(409);
      expect(losers[0]!.body.error.code).toBe("CASH_ENTRY_NOT_PENDING");
      if (approveRes.status === 200) {
        expect(await fundBalance(outlet)).toBe(amount);
        expect(await pettyRows(outlet)).toHaveLength(1);
        expect(await pettyJournalCount(outlet)).toBe(1);
      } else {
        expect(await fundBalance(outlet)).toBeNull();
        expect(await pettyRows(outlet)).toHaveLength(0);
        expect(await pettyJournalCount(outlet)).toBe(0);
      }
    }
  });

  it("[cash-limit-antisplit-AS-3d] approving after the period closed is refused: still pending, no fund, no petty entry, no journal, nothing parked", async () => {
    const w = await makeWorld(); // own legal entity: closing its periods is private
    const creator = await finance("as3d creator");
    const approver = await finance("as3d approver");
    const outlet = await makeOutlet(w.entityId);
    const res = await postMove(creator, {
      kind: "topup",
      outletId: outlet,
      bankAccountId: w.bankAccountA,
      amountIdr: 6_600_000,
      description: "Isi kas kecil periode ditutup",
      idempotencyKey: key(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const id = res.body.data.id as string;

    // The finance team closes every period of the entity before anyone approves.
    const closed = await owner.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [tenantId, w.entityId, randomUUID()],
    );
    expect(closed.rowCount).toBeGreaterThan(0);

    const refused = await approve(approver, id);
    expect(
      refused.status >= 400 && refused.status < 500,
      JSON.stringify(refused.body),
    ).toBe(true);
    expect(["CASH_ENTRY_NOT_FOUND", "CASH_ENTRY_NOT_PENDING"]).not.toContain(
      refused.body.error.code,
    );
    expect(await stored(id)).toMatchObject({
      status: "pending_approval",
      approver_id: null,
      journal_entry_id: null,
    });
    expect(await fundBalance(outlet)).toBeNull();
    expect(await pettyRows(outlet)).toHaveLength(0);
    expect(await pettyJournalCount(outlet)).toBe(0);
    // Still pending, so it can still be decided: a reject posts nothing.
    const rejected = await reject(approver, id, "Periode sudah ditutup");
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data.status).toBe("rejected");
    expect(await fundBalance(outlet)).toBeNull();
  });
});

describe("top-up approval: who may decide, reject", () => {
  it("[cash-limit-antisplit-AS-4a] the creator cannot approve or reject their own top-up; nothing moves; others can", async () => {
    const creator = await finance("as4a creator");
    const approver = await finance("as4a approver");
    const outlet = await freshOutlet();
    const pending = await topup(creator, outlet, 5_500_000);
    expect(tuOutcome(pending)).toBe("pending");
    const id = pending.body.data.id as string;
    for (const res of [await approve(creator, id), await reject(creator, id)]) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe("CASH_OUT_SELF_APPROVAL");
    }
    // A user without the approve permission cannot decide either.
    for (const res of [await approve(nobody, id), await reject(nobody, id)])
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect((await stored(id)).status).toBe("pending_approval");
    expect(await fundBalance(outlet)).toBeNull();
    expect(await pettyJournalCount(outlet)).toBe(0);
    // Control: another finance user approves, so the 403 is the rule.
    expect((await approve(approver, id)).status).toBe(200);
    expect(await fundBalance(outlet)).toBe(5_500_000);
  });

  it("[cash-limit-antisplit-AS-4b] a rejected top-up leaves no fund, no petty entry, no journal, and can never be approved", async () => {
    const creator = await finance("as4b creator");
    const approver = await finance("as4b approver");
    const outlet = await freshOutlet();
    const pending = await topup(creator, outlet, 5_700_000);
    expect(tuOutcome(pending)).toBe("pending");
    const id = pending.body.data.id as string;

    const res = await reject(approver, id, "Tidak ada kebutuhan");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      id,
      kind: "petty_topup",
      status: "rejected",
      approverId: approver.userId,
      decisionReason: "Tidak ada kebutuhan",
      journalEntryId: null,
    });
    expect(await fundBalance(outlet)).toBeNull();
    expect(await pettyRows(outlet)).toHaveLength(0);
    expect(await pettyJournalCount(outlet)).toBe(0);
    expect(await journalsOf(id)).toHaveLength(0);

    const again = await approve(approver, id);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("CASH_ENTRY_NOT_PENDING");
    expect(await fundBalance(outlet)).toBeNull();
  });
});

describe("anti-split: same creator, same day, all outlets", () => {
  it("[cash-limit-antisplit-AS-5a] 3 x Rp2.000.000 cash out: the first two post, the third is pending; earlier entries are not changed", async () => {
    const creator = await finance("as5a");
    const outlet = await freshOutlet();
    const first = await cashOut(creator, outlet, 2 * MIL);
    const second = await cashOut(creator, outlet, 2 * MIL);
    expect(coOutcome(first)).toBe("direct");
    expect(coOutcome(second)).toBe("direct");
    const third = await cashOut(creator, outlet, 2 * MIL);
    expect(coOutcome(third)).toBe("pending");
    // The entry itself is <= limit: it is the accumulation that gates it.
    expect(third.body.data).toMatchObject({
      amountIdr: 2 * MIL,
      journalEntryId: null,
    });
    expect(await journalsOf(third.body.data.id)).toHaveLength(0);
    // Entries 1 and 2 keep their status and their single journal.
    for (const res of [first, second]) {
      expect((await stored(res.body.data.id)).status).toBe("approved");
      expect(await journalsOf(res.body.data.id)).toHaveLength(1);
    }
    // A fourth one stays gated: pending entries still count.
    expect(coOutcome(await cashOut(creator, outlet, 1))).toBe("pending");
  });

  it("[cash-limit-antisplit-AS-5b] cash out + top-up + cash out (Rp2.000.000 each): the third is pending", async () => {
    const creator = await finance("as5b");
    const outlet = await freshOutlet();
    expect(coOutcome(await cashOut(creator, outlet, 2 * MIL))).toBe("direct");
    expect(tuOutcome(await topup(creator, outlet, 2 * MIL))).toBe("direct");
    const third = await cashOut(creator, outlet, 2 * MIL);
    expect(coOutcome(third)).toBe("pending");
    expect(await journalsOf(third.body.data.id)).toHaveLength(0);
    // The direct top-up did post, once.
    expect(await fundBalance(outlet)).toBe(2 * MIL);
    expect(await pettyJournalCount(outlet)).toBe(1);
  });

  it("[cash-limit-antisplit-AS-5c] cash out + cash out + top-up: the top-up is pending (202) and moves nothing", async () => {
    const creator = await finance("as5c");
    const outlet = await freshOutlet();
    expect(coOutcome(await cashOut(creator, outlet, 2 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(creator, outlet, 2 * MIL))).toBe("direct");
    const res = await topup(creator, outlet, 2 * MIL);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(tuOutcome(res)).toBe("pending");
    expect(await fundBalance(outlet)).toBeNull();
    expect(await pettyRows(outlet)).toHaveLength(0);
    expect(await pettyJournalCount(outlet)).toBe(0);
    expect(await journalsOf(res.body.data.id)).toHaveLength(0);
  });

  it("[cash-limit-antisplit-AS-5d] 3 x Rp2.000.000 top-up: the first two post, the third is pending", async () => {
    const creator = await finance("as5d");
    const outlet = await freshOutlet();
    expect(tuOutcome(await topup(creator, outlet, 2 * MIL))).toBe("direct");
    expect(tuOutcome(await topup(creator, outlet, 2 * MIL))).toBe("direct");
    expect(tuOutcome(await topup(creator, outlet, 2 * MIL))).toBe("pending");
    expect(await fundBalance(outlet)).toBe(4 * MIL);
    expect(await pettyRows(outlet)).toHaveLength(2);
    expect(await pettyJournalCount(outlet)).toBe(2);
  });

  it("[cash-limit-antisplit-AS-5e] a total exactly equal to the limit is allowed (strict above); one rupiah more is pending", async () => {
    const creator = await finance("as5e");
    const outlet = await freshOutlet();
    expect(coOutcome(await cashOut(creator, outlet, 2_500_000))).toBe("direct");
    expect(coOutcome(await cashOut(creator, outlet, 2_500_000))).toBe("direct");
    expect(coOutcome(await cashOut(creator, outlet, 1))).toBe("pending");
  });

  it("[cash-limit-antisplit-AS-5f] entry_date is not the key: back-dated entry dates cannot hide the accumulation", async () => {
    const creator = await finance("as5f");
    const outlet = await freshOutlet();
    expect(
      coOutcome(
        await cashOut(creator, outlet, 2 * MIL, { entryDate: daysAgo(1) }),
      ),
    ).toBe("direct");
    expect(
      coOutcome(
        await cashOut(creator, outlet, 2 * MIL, { entryDate: daysAgo(3) }),
      ),
    ).toBe("direct");
    expect(
      coOutcome(
        await cashOut(creator, outlet, 2 * MIL, { entryDate: daysAgo(5) }),
      ),
    ).toBe("pending");
  });

  it("[cash-limit-antisplit-AS-5g] entity-level entries (no outlet) are summed too: 3 x Rp2.000.000 -> third pending", async () => {
    const creator = await finance("as5g");
    expect(coOutcome(await cashOut(creator, null, 2 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(creator, null, 2 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(creator, null, 2 * MIL))).toBe("pending");
  });
});

describe("anti-split: what is and is not summed", () => {
  it("[cash-limit-antisplit-AS-6a] another creator at the same outlet is not summed", async () => {
    const one = await finance("as6a one");
    const two = await finance("as6a two");
    const outlet = await freshOutlet();
    expect(coOutcome(await cashOut(one, outlet, 4 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(two, outlet, 4 * MIL))).toBe("direct");
    // Control: the same creator again would be summed.
    expect(coOutcome(await cashOut(one, outlet, 2 * MIL))).toBe("pending");
  });

  it("[cash-limit-antisplit-AS-6b] other outlets, top-ups at other outlets and entity-level entries ARE summed (Q18)", async () => {
    // Cash outs at two outlets: 4jt at X posts, 4jt at Y makes 8jt -> pending.
    const one = await finance("as6b one");
    const outletX = await freshOutlet();
    const outletY = await freshOutlet();
    expect(coOutcome(await cashOut(one, outletX, 4 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(one, outletY, 4 * MIL))).toBe("pending");
    // The pending entry counts too: an entity-level entry is gated as well.
    expect(coOutcome(await cashOut(one, null, 1))).toBe("pending");

    // Exactly the limit across X, Y and entity-level posts; one rupiah more pends.
    const two = await finance("as6b two");
    expect(coOutcome(await cashOut(two, outletX, 2 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(two, outletY, 2 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(two, null, 1 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(two, outletX, 1))).toBe("pending");

    // A direct top-up at another outlet counts toward a cash out elsewhere.
    const three = await finance("as6b three");
    expect(tuOutcome(await topup(three, outletY, 3 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(three, outletX, 2 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(three, null, 1))).toBe("pending");

    // ... and a cash out at one outlet counts toward a top-up at another.
    const four = await finance("as6b four");
    expect(coOutcome(await cashOut(four, outletX, 4 * MIL))).toBe("direct");
    expect(tuOutcome(await topup(four, outletY, 2 * MIL))).toBe("pending");

    // An entity-level cash out counts toward an outlet entry.
    const five = await finance("as6b five");
    expect(coOutcome(await cashOut(five, null, 4 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(five, outletX, 2 * MIL))).toBe("pending");
  });

  it("[cash-limit-antisplit-AS-6c] an entry of another calendar day is not summed (outlet and entity-level entries)", async () => {
    const outlet = await freshOutlet();
    for (const outletId of [outlet, null]) {
      // One creator per case: all outlets are summed now, so the cases would
      // otherwise add up against each other.
      const creator = await finance(`as6c ${outletId ? "outlet" : "entity"}`);
      const earlier = await cashOut(creator, outletId, 4 * MIL);
      expect(coOutcome(earlier)).toBe("direct");
      // 25 hours ago is a different WIB calendar day (no DST).
      await backdate(
        earlier.body.data.id as string,
        new Date(Date.now() - 25 * 3600_000),
      );
      expect(coOutcome(await cashOut(creator, outletId, 4 * MIL))).toBe(
        "direct",
      );
      // Control: today's entry is counted, so this one is pending.
      expect(coOutcome(await cashOut(creator, outletId, 2 * MIL))).toBe(
        "pending",
      );
    }
  });

  it("[cash-limit-antisplit-AS-6d] the day is the tenant's WIB calendar day: two entries across WIB midnight are not summed, whatever the outlet's own zone", async () => {
    // The outlet zone (and cutoff) must not matter: with Asia/Jayapura at
    // 00:00 the two entries fall on the same outlet-local day for most of the
    // WIB day, yet they are on different WIB days and must stay apart.
    for (const timeZone of ["Asia/Jakarta", "Asia/Jayapura"]) {
      const creator = await finance(`as6d ${timeZone}`);
      const outlet = await freshOutlet();
      await owner.query(
        "UPDATE outlets SET timezone = $3, business_day_cutoff = '00:00' WHERE tenant_id = $1 AND id = $2",
        [tenantId, outlet, timeZone],
      );
      const midnight = lastLocalMidnight("Asia/Jakarta");

      // Entry A: one minute before the latest WIB midnight.
      const before = await cashOut(creator, outlet, 4 * MIL);
      expect(coOutcome(before)).toBe("direct");
      await backdate(
        before.body.data.id as string,
        new Date(midnight.getTime() - 60_000),
      );
      // Entry B: now (after that midnight): another WIB day, not summed.
      const after = await cashOut(creator, outlet, 4 * MIL);
      expect(coOutcome(after), timeZone).toBe("direct");

      // Control: B is counted in today's total. B (4jt) + 1jt = 5jt equals the
      // limit (direct); one more rupiah goes over (pending). A is not counted,
      // otherwise B itself would have been pending.
      const same = await cashOut(creator, outlet, 1 * MIL);
      expect(coOutcome(same)).toBe("direct");
      expect(coOutcome(await cashOut(creator, outlet, 1))).toBe("pending");
    }
  });

  it("[cash-limit-antisplit-AS-6e] a rejected entry is not counted; approved and pending ones are", async () => {
    // Rejected: 2 + 2 direct, third (2jt) pending then rejected; a fourth of
    // 1jt makes 2+2+1 = 5jt = limit, so it posts. Counting the rejected one
    // (7jt) would make it pending.
    const creator = await finance("as6e creator");
    const approver = await finance("as6e approver");
    const outlet = await freshOutlet();
    expect(coOutcome(await cashOut(creator, outlet, 2 * MIL))).toBe("direct");
    expect(coOutcome(await cashOut(creator, outlet, 2 * MIL))).toBe("direct");
    const third = await cashOut(creator, outlet, 2 * MIL);
    expect(coOutcome(third)).toBe("pending");
    const rejected = await reject(approver, third.body.data.id as string);
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(coOutcome(await cashOut(creator, outlet, 1 * MIL))).toBe("direct");

    // A rejected top-up is not counted either.
    const creator2 = await finance("as6e creator2");
    const outlet2 = await freshOutlet();
    const bigTopup = await topup(creator2, outlet2, 6 * MIL);
    expect(tuOutcome(bigTopup)).toBe("pending");
    expect((await reject(approver, bigTopup.body.data.id)).status).toBe(200);
    expect(tuOutcome(await topup(creator2, outlet2, 4 * MIL))).toBe("direct");

    // Pending (undecided) counts: the 1jt is gated by the pending 6jt.
    const creator3 = await finance("as6e creator3");
    const outlet3 = await freshOutlet();
    expect(coOutcome(await cashOut(creator3, outlet3, 6 * MIL))).toBe(
      "pending",
    );
    expect(coOutcome(await cashOut(creator3, outlet3, 1 * MIL))).toBe(
      "pending",
    );

    // Approved counts: a 3jt + 3jt top-up pair; approving the pending one
    // keeps counting it, so one more rupiah is pending.
    const creator4 = await finance("as6e creator4");
    const outlet4 = await freshOutlet();
    expect(tuOutcome(await topup(creator4, outlet4, 3 * MIL))).toBe("direct");
    const sixth = await topup(creator4, outlet4, 3 * MIL);
    expect(tuOutcome(sixth)).toBe("pending");
    expect((await approve(approver, sixth.body.data.id)).status).toBe(200);
    expect(coOutcome(await cashOut(creator4, outlet4, 1))).toBe("pending");
  });
});

describe("anti-split: parallel submits", () => {
  it("[cash-limit-antisplit-AS-7a] 3 parallel Rp2.000.000 cash outs (Promise.all): exactly 2 post, 1 pending, repeated for fresh creators", async () => {
    for (let round = 0; round < 3; round += 1) {
      const creator = await finance(`as7a ${round}`);
      const outlet = await freshOutlet();
      const results = await Promise.all(
        Array.from({ length: 3 }, () => cashOut(creator, outlet, 2 * MIL)),
      );
      const outcomes = results.map(coOutcome);
      expect(
        outcomes.filter((o) => o === "direct"),
        `round ${round}: ${outcomes}`,
      ).toHaveLength(2);
      expect(outcomes.filter((o) => o === "pending")).toHaveLength(1);
      for (const res of results) {
        const journals = await journalsOf(res.body.data.id);
        expect(journals).toHaveLength(
          res.body.data.status === "approved" ? 1 : 0,
        );
      }
    }
  });

  it("[cash-limit-antisplit-AS-7b] 5 parallel Rp2.000.000 cash outs: exactly 2 post, 3 pending", async () => {
    const creator = await finance("as7b");
    const outlet = await freshOutlet();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cashOut(creator, outlet, 2 * MIL)),
    );
    const outcomes = results.map(coOutcome);
    expect(outcomes.filter((o) => o === "direct")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "pending")).toHaveLength(3);
  });

  it("[cash-limit-antisplit-AS-7c] 3 parallel Rp2.000.000 top-ups: exactly 2 post (201), 1 pending (202); the fund holds exactly the 2 that posted", async () => {
    for (let round = 0; round < 2; round += 1) {
      const creator = await finance(`as7c ${round}`);
      const outlet = await freshOutlet();
      const results = await Promise.all(
        Array.from({ length: 3 }, () => topup(creator, outlet, 2 * MIL)),
      );
      const outcomes = results.map(tuOutcome);
      expect(
        outcomes.filter((o) => o === "direct"),
        `round ${round}: ${outcomes}`,
      ).toHaveLength(2);
      expect(outcomes.filter((o) => o === "pending")).toHaveLength(1);
      expect(await fundBalance(outlet)).toBe(4 * MIL);
      expect(await pettyRows(outlet)).toHaveLength(2);
      expect(await pettyJournalCount(outlet)).toBe(2);
    }
  });

  it("[cash-limit-antisplit-AS-7d] 2 cash outs + 1 top-up in parallel (Rp2.000.000 each): exactly 2 direct, 1 pending", async () => {
    const creator = await finance("as7d");
    const outlet = await freshOutlet();
    const results = await Promise.all([
      cashOut(creator, outlet, 2 * MIL),
      topup(creator, outlet, 2 * MIL),
      cashOut(creator, outlet, 2 * MIL),
    ]);
    const outcomes = [
      coOutcome(results[0]!),
      tuOutcome(results[1]!),
      coOutcome(results[2]!),
    ];
    expect(outcomes.filter((o) => o === "direct")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "pending")).toHaveLength(1);
  });
});

describe("top-up limit: tenant isolation", () => {
  it("[cash-limit-antisplit-AS-8] another tenant's bank account, outlet and pending top-up are invisible: refused, nothing written", async () => {
    const creator = await finance("as8 creator");
    const approver = await finance("as8 approver");
    const outlet = await freshOutlet();

    // A foreign bank account, small and above the limit: both refused (404),
    // and neither leaves a pending row nor moves a fund.
    for (const amountIdr of [100_000, 6 * MIL]) {
      const res = await topup(creator, outlet, amountIdr, {
        bankAccountId: world.foreign.bankAccountId,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
    }
    expect(await entryRowsOfOutlet(outlet)).toBe(0);
    expect(await fundBalance(outlet)).toBeNull();

    // A real foreign outlet with the foreign tenant's own bank account.
    const brandId = randomUUID();
    const foreignOutlet = randomUUID();
    foreignFixture.brandId = brandId;
    foreignFixture.outletId = foreignOutlet;
    await owner.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'as8', 'Brand AS8')`,
      [brandId, world.foreign.tenantId],
    );
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet asing AS8', 'Jl. Uji 3', 'Asia/Jakarta', '04:00', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        foreignOutlet,
        world.foreign.tenantId,
        brandId,
        world.foreign.entityId,
        `AS8-${randomUUID().slice(0, 6)}`.toUpperCase(),
      ],
    );
    for (const amountIdr of [100_000, 6 * MIL]) {
      const res = await topup(creator, foreignOutlet, amountIdr, {
        bankAccountId: world.foreign.bankAccountId,
      });
      expect([403, 404], JSON.stringify(res.body)).toContain(res.status);
    }
    const foreignRows = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM cash_bank_entries WHERE tenant_id = $1 AND outlet_id = $2",
      [world.foreign.tenantId, foreignOutlet],
    );
    expect(Number(foreignRows.rows[0]!.n)).toBe(0);
    const foreignFunds = await owner.query(
      "SELECT 1 FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
      [world.foreign.tenantId, foreignOutlet],
    );
    expect(foreignFunds.rows).toHaveLength(0);

    // A pending petty_topup of the foreign tenant (copy of a real pending row
    // of this tenant, ids moved over) cannot be seen or decided.
    const own = await topup(creator, outlet, 6_100_000);
    expect(tuOutcome(own)).toBe("pending");
    const source = await owner.query<{ doc: Json }>(
      "SELECT to_jsonb(e) AS doc FROM cash_bank_entries e WHERE tenant_id = $1 AND id = $2",
      [tenantId, own.body.data.id],
    );
    const foreignId = randomUUID();
    await owner.query(
      "INSERT INTO cash_bank_entries SELECT (json_populate_record(NULL::cash_bank_entries, $1::json)).*",
      [
        JSON.stringify({
          ...source.rows[0]!.doc,
          id: foreignId,
          tenant_id: world.foreign.tenantId,
          legal_entity_id: world.foreign.entityId,
          bank_account_id: world.foreign.bankAccountId,
          outlet_id: foreignOutlet,
          idempotency_key: key(),
          journal_entry_id: null,
          status: "pending_approval",
          approver_id: null,
          decided_at: null,
          decision_reason: null,
        }),
      ],
    );
    for (const res of [
      await approve(approver, foreignId),
      await reject(approver, foreignId),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error.code).toBe("CASH_ENTRY_NOT_FOUND");
    }
    const after = await owner.query<{ status: string }>(
      "SELECT status FROM cash_bank_entries WHERE id = $1",
      [foreignId],
    );
    expect(after.rows[0]!.status).toBe("pending_approval");
    const foreignPetty = await owner.query(
      "SELECT 1 FROM petty_cash_entries WHERE tenant_id = $1",
      [world.foreign.tenantId],
    );
    expect(foreignPetty.rows).toHaveLength(0);

    // Control: this tenant's own pending top-up is decidable.
    expect((await approve(approver, own.body.data.id)).status).toBe(200);
    expect(await fundBalance(outlet)).toBe(6_100_000);
  });
});

describe("anti-split: no double counting after approval", () => {
  it("[cash-limit-antisplit-AS-9] the petty entry produced by approving a top-up is not counted a second time", async () => {
    // The approver is the actor of the approval-made petty_cash_entries row.
    // Their own later cash out (4jt, below the limit) must stay direct: the
    // 6jt top-up they approved is not theirs to count.
    const creator = await finance("as9 creator");
    const approver = await finance("as9 approver");
    const outlet = await freshOutlet();
    const pending = await topup(creator, outlet, 6 * MIL);
    expect(tuOutcome(pending)).toBe("pending");
    expect((await approve(approver, pending.body.data.id)).status).toBe(200);
    // Premise: approval wrote exactly one petty entry of 6jt.
    const rows = await pettyRows(outlet);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "topup", amount: 6 * MIL });

    expect(coOutcome(await cashOut(approver, outlet, 4 * MIL))).toBe("direct");
    // 4jt + 1jt = exactly the limit: still direct (strict >). One rupiah more
    // pends. The 6jt approved top-up of the other creator is in neither sum.
    expect(tuOutcome(await topup(approver, outlet, 1 * MIL))).toBe("direct");
    expect(tuOutcome(await topup(approver, outlet, 1))).toBe("pending");
  });

  it("[cash-limit-antisplit-AS-9b] the approval-made entry is counted once for the creator's own gate (pending stays pending, direct stays direct)", async () => {
    // creator: cash out 3jt (direct), top-up 3jt -> sum 6jt -> pending, approved.
    // Everything creator submits afterwards that day is gated (sum already
    // > limit), and nothing about the earlier entries changes.
    const creator = await finance("as9b creator");
    const approver = await finance("as9b approver");
    const outlet = await freshOutlet();
    const out = await cashOut(creator, outlet, 3 * MIL);
    expect(coOutcome(out)).toBe("direct");
    const pending = await topup(creator, outlet, 3 * MIL);
    expect(tuOutcome(pending)).toBe("pending");
    expect((await approve(approver, pending.body.data.id)).status).toBe(200);
    expect(await fundBalance(outlet)).toBe(3 * MIL);
    expect(await pettyRows(outlet)).toHaveLength(1);
    expect(await pettyJournalCount(outlet)).toBe(1);
    expect((await stored(out.body.data.id)).status).toBe("approved");
    expect(await journalsOf(out.body.data.id)).toHaveLength(1);
  });
});

// ---- H1 / L1 (architect findings): reserved approval key + replay ----------
// The key of the petty entry made by approving a pending top-up is derived from
// the document id ("pt/<docId>"; the old "pt:<docId>" could be sent by a
// client). Assumptions: a client key starting with "pt:" or "pt/" is refused
// with 422 VALIDATION_ERROR before anything is written (the shared key rule
// already forbids "/", the service must also forbid the "pt:" prefix); and a
// replay of a submission whose pending entry was approved meanwhile answers
// 200 or 201 (never 202) with no new money (the exact code is not pinned).
describe("top-up idempotency key: reserved approval prefix", () => {
  it("[cash-limit-antisplit-H1a] a direct top-up with a key starting pt: or pt/ is refused 422: no balance, entry or journal change", async () => {
    const creator = await finance("h1a");
    const other = await finance("h1a funder");
    const outlet = await freshOutlet();
    expect(tuOutcome(await topup(other, outlet, 100_000))).toBe("direct");
    const fund = await fundBalance(outlet);
    const petty = await pettyRows(outlet);
    const journals = await pettyJournalCount(outlet);
    const entries = await entryRowsOfOutlet(outlet);

    // Small (would post at once) and above the limit (would pend): both refused.
    for (const prefix of ["pt:", "pt/"])
      for (const amountIdr of [100_000, LIMIT_IDR + 1]) {
        const res = await topup(creator, outlet, amountIdr, {
          idempotencyKey: `${prefix}${randomUUID()}`,
        });
        expect(
          res.status,
          `${prefix} ${amountIdr}: ${JSON.stringify(res.body)}`,
        ).toBe(422);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }

    expect(await fundBalance(outlet)).toBe(fund);
    expect(await pettyRows(outlet)).toEqual(petty);
    expect(await pettyJournalCount(outlet)).toBe(journals);
    expect(await entryRowsOfOutlet(outlet)).toBe(entries);
  });

  it("[cash-limit-antisplit-H1b] a creator cannot jam a pending top-up approval with a small top-up keyed pt:<docId>: approve still answers 200, fund rises exactly once", async () => {
    const creator = await finance("h1b creator");
    const approver = await finance("h1b approver");
    const outlet = await freshOutlet();
    const amount = 6 * MIL;
    const pending = await topup(creator, outlet, amount);
    expect(tuOutcome(pending)).toBe("pending");
    const id = pending.body.data.id as string;

    // The attack: guess the document id and send a small top-up whose key
    // collides with the approval's key (old and new prefix).
    for (const prefix of ["pt:", "pt/"]) {
      const jam = await topup(creator, outlet, 100_000, {
        idempotencyKey: `${prefix}${id}`,
      });
      expect(jam.status, JSON.stringify(jam.body)).toBe(422);
    }
    expect(await fundBalance(outlet)).toBeNull();
    expect(await pettyRows(outlet)).toHaveLength(0);

    const res = await approve(approver, id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ id, status: "approved" });
    expect(await fundBalance(outlet)).toBe(amount);
    const rows = await pettyRows(outlet);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "topup", amount });
    expect(await pettyJournalCount(outlet)).toBe(1);
    expect(await stored(id)).toMatchObject({ status: "approved" });
  });
});

describe("top-up replay after approval", () => {
  it("[cash-limit-antisplit-L1] replaying a pending submission that was approved meanwhile does not answer 202; no new money", async () => {
    const creator = await finance("l1 creator");
    const approver = await finance("l1 approver");
    const outlet = await freshOutlet();
    const amount = 6 * MIL;
    const body = topupBody(outlet, amount);
    const first = await postMove(creator, body);
    expect(tuOutcome(first)).toBe("pending");
    const id = first.body.data.id as string;
    expect((await approve(approver, id)).status).toBe(200);
    expect(await fundBalance(outlet)).toBe(amount);

    const replay = await postMove(creator, body);
    expect(replay.status, JSON.stringify(replay.body)).not.toBe(202);
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);

    expect(await fundBalance(outlet)).toBe(amount);
    expect(await pettyRows(outlet)).toHaveLength(1);
    expect(await pettyJournalCount(outlet)).toBe(1);
    expect(await entryRowsOfOutlet(outlet)).toBe(1);
    expect(await stored(id)).toMatchObject({ status: "approved" });
  });
});
