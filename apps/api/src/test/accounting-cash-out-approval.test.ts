// Cash-out approval above the tenant limit (founder Q7, 13 Nov 2026; tier K
// money). Written from docs/briefs/sub-cash-out-approval.md ("Kontrak" and
// "Test gagal-dulu"), not from the implementation. Real Better Auth, RLS and
// PostgreSQL on the disposable test DB; requests go through createApp().
//
// Rule: a `cash_out` with amount > tenant limit (default Rp5.000.000; "above"
// means strictly greater) is stored as `pending_approval` with NO journal. An
// approval posts the journal exactly once; a rejection posts nothing; the
// creator cannot decide their own entry. Transfers and cash_in are not gated.
//
// Fail-first mapping (brief items 1-9):
//   CO-1 at/below limit posts now   CO-2 above limit pends, no journal/GL
//   CO-3 double approve = 1 journal CO-4 self approval refused
//   CO-5 other tenant blind          CO-6 reject = no journal, final
//   CO-7 no permission refused       CO-8 limit endpoint rules
//   CO-9 idempotent submission       CO-10/11 gating scope + counter account
//   CO-3c approve vs reject race     CO-12 period closed before approval
//   CO-13 outlet-scoped approver
//
// Anti-split (sub-cash-limit-antisplit): cash outs and top-ups are summed per
// creator + outlet + day against the limit. The shared `creator` below files
// many entries on the same day at the entity level, so every test that expects
// an immediate posting at or below the limit (CO-1, CO-8d, CO-9, CO-10) uses a
// fresh finance user via `freshCreator()`. Amounts and assertions are unchanged.
//
// Isolation: the Cafe Legend tenant is shared with other test files, so this
// file only counts rows of its own legal entity / own GL accounts (makeWorld)
// and never deletes or counts tenant-wide. The tenant limit is the one shared
// knob: CO-8 lowers it to Rp1.000.000 briefly and restores Rp5.000.000 in a
// `finally` and in afterAll.
//
// Assumptions where the brief is silent:
// - Success on create is 201 (as the other cash-bank tests); approve/reject
//   and limit PUT answer 200; idempotent replay answers 200 or 201.
// - Errors use the `{ error: { code } }` envelope.
// - A user with no role at all gets 403 on approve/reject and on the limit
//   endpoints; no session gets 401.
// - Rejecting an entry that is no longer pending answers 409
//   CASH_ENTRY_NOT_PENDING (same code as approving a rejected entry).
// - An invalid limit/reason body answers a 4xx (400 or 422), not pinned.
// - A foreign-tenant entry id answers 404 CASH_ENTRY_NOT_FOUND (RLS hides it).
// - Period closed between submit and approve (CO-12): the period is closed as
//   the migration owner on a dedicated world (own legal entity), so the shared
//   world keeps its open periods. Approve answers a 4xx domain error (not
//   pinned to a code, but never NOT_FOUND/NOT_PENDING), the entry stays pending
//   with no journal, and it can still be decided (rejected) afterwards.
// - Outlet scope (CO-13): like recording (OUTLET_OUT_OF_SCOPE), an approver
//   scoped to one outlet is refused (403, or 404 when reads narrow it) for an
//   entry tagged to another outlet and for an entity-level entry. The outlet
//   they are scoped to is not asserted (the brief leaves it open).
// - Approve and reject racing (CO-3c): exactly one wins (200), the other
//   answers 409 CASH_ENTRY_NOT_PENDING; the final status follows the winner.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { agent, originHeader, verifySessionMfa } from "./helpers.ts";
import {
  closeKit,
  daysAgo,
  journalsByKey,
  journalLinesOf,
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
import {
  limitExclusiveLock,
  withLimitSharedLock,
} from "./helpers/cash-limit-lock.ts";

const app = createApp();
const ENTRIES = "/api/accounting/cash-bank/entries";
const LIMIT = "/api/accounting/cash-bank/approval-limit";
const DEFAULT_LIMIT = 5_000_000;

let world: World;
let creator: Session;
let approver: Session;
let approver2: Session;
let nobody: Session;
/** No session at all. */
const anon = (): Session => ({ client: agent(app), userId: "" });
/** The limit body, whether the API wraps it in `data` or not (brief shows it bare). */
const limitOf = (res: { body: { data?: unknown } }) =>
  (res.body.data ?? res.body) as { limitIdr: number; isDefault: boolean };

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  world = await makeWorld();
  creator = await signedIn(app, "CO creator", [
    { role: "finance", outletId: null },
  ]);
  approver = await signedIn(app, "CO approver", [
    { role: "finance", outletId: null },
  ]);
  approver2 = await signedIn(app, "CO approver 2", [
    { role: "finance", outletId: null },
  ]);
  nobody = await signedIn(app, "CO nobody", []);
  // legend-bf8f2: approving a chained entry decides the last step through the
  // approval service, which needs an MFA-verified session (like the inbox).
  for (const who of [approver, approver2]) await verifyMfa(who);
});

afterAll(async () => {
  // Safety net: never leave a lowered tenant limit for the other files.
  await creator?.client
    .put(LIMIT)
    .set(originHeader)
    .send({ limitIdr: DEFAULT_LIMIT })
    .catch(() => {});
  await closeKit();
});

/** Marks the session of a signed-in user as MFA-verified (looked up by user id). */
async function verifyMfa(who: Session) {
  const { rows } = await owner.query<{ email: string }>(
    'SELECT email FROM "user" WHERE id = $1',
    [who.userId],
  );
  expect(rows, `user ${who.userId}`).toHaveLength(1);
  await verifySessionMfa(rows[0]!.email);
}

/** A fresh tenant-wide finance user: its daily anti-split total starts at zero. */
const freshCreator = (label: string) =>
  signedIn(app, `CO ${label}`, [{ role: "finance", outletId: null }]);

// ---- request helpers -------------------------------------------------------

const post = (who: Session, body: Record<string, unknown>) =>
  who.client
    .post(ENTRIES)
    .set(originHeader)
    .send(body as object);
const decide = (
  who: Session,
  entryId: string,
  action: "approve" | "reject",
  body: Record<string, unknown> = action === "reject"
    ? { reason: "Tidak sesuai" }
    : {},
) =>
  who.client
    .post(`${ENTRIES}/${encodeURIComponent(entryId)}/${action}`)
    .set(originHeader)
    .send(body);
const approve = (who: Session, entryId: string) =>
  decide(who, entryId, "approve");
const reject = (who: Session, entryId: string, reason = "Tidak sesuai") =>
  decide(who, entryId, "reject", { reason });
const getEntry = (who: Session, entryId: string) =>
  who.client.get(`${ENTRIES}/${encodeURIComponent(entryId)}`).set(originHeader);
const getLimit = (who: Session) => who.client.get(LIMIT).set(originHeader);
const putLimit = (who: Session, body: Record<string, unknown>) =>
  who.client.put(LIMIT).set(originHeader).send(body);

const cashOutBody = (extra: Record<string, unknown> = {}) => ({
  kind: "cash_out",
  legalEntityId: world.entityId,
  bankAccountId: world.bankAccountA,
  counterAccountId: world.gl.expense,
  amountIdr: DEFAULT_LIMIT + 1,
  entryDate: daysAgo(1),
  description: "Bayar supplier besar",
  reference: `REF-${short()}`,
  idempotencyKey: key(),
  ...extra,
});
const cashInBody = (extra: Record<string, unknown> = {}) =>
  cashOutBody({
    kind: "cash_in",
    counterAccountId: world.gl.revenue,
    description: "Setoran modal",
    ...extra,
  });
const transferBody = (extra: Record<string, unknown> = {}) => ({
  kind: "transfer",
  legalEntityId: world.entityId,
  fromBankAccountId: world.bankAccountA,
  toBankAccountId: world.bankAccountB,
  amountIdr: DEFAULT_LIMIT + 1_000_000,
  entryDate: daysAgo(1),
  description: "Pindah rekening",
  reference: `REF-${short()}`,
  idempotencyKey: key(),
  ...extra,
});

// ---- reads as the migration owner, scoped to this file's rows --------------

type DecisionRow = {
  id: string;
  status: string;
  approver_id: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  journal_entry_id: string | null;
};
async function row(id: string): Promise<DecisionRow> {
  const { rows } = await owner.query<DecisionRow>(
    `SELECT id, status, approver_id, decided_at::text, decision_reason, journal_entry_id
       FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  expect(rows, `cash_bank_entries row ${id}`).toHaveLength(1);
  return rows[0]!;
}

async function entryCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_bank_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, world.entityId],
  );
  return Number(rows[0]!.n);
}

/** Journals of one document, found by its document key. */
const journalsOf = (entryId: string) =>
  journalsByKey(world.entityId, `cb:${entryId}`);

/** Journal lines of this file's own bank A GL account (own entity only). */
async function bankLineCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_lines WHERE tenant_id = $1 AND account_id = $2",
    [tenantId, world.gl.bankA],
  );
  return Number(rows[0]!.n);
}
/** Net debit - credit on this file's own bank A GL account. */
async function bankNet(): Promise<number> {
  const { rows } = await owner.query<{ net: string }>(
    "SELECT coalesce(sum(debit_idr - credit_idr), 0)::text AS net FROM journal_lines WHERE tenant_id = $1 AND account_id = $2",
    [tenantId, world.gl.bankA],
  );
  return Number(rows[0]!.net);
}

/** Submits a pending cash out and checks it really is pending. */
async function submitPending(extra: Record<string, unknown> = {}) {
  const res = await post(creator, cashOutBody(extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.data.status).toBe("pending_approval");
  return res.body.data as { id: string; amountIdr: number };
}

const ok = (status: number) => [200, 201].includes(status);
const is4xx = (status: number) => status >= 400 && status < 500;

// ============================================================================

describe("cash-out approval: limit gating", () => {
  withLimitSharedLock();

  it("[cash-out-approval-CO-1] a cash out at or below the limit posts at once with one balanced journal", async () => {
    const before = await bankNet();
    for (const amountIdr of [DEFAULT_LIMIT, DEFAULT_LIMIT - 1, 175_000]) {
      // One fresh creator per amount: the daily total must not add them up.
      const single = await freshCreator(`co1 ${amountIdr}`);
      const res = await post(single, cashOutBody({ amountIdr }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({
        kind: "cash_out",
        amountIdr,
        status: "approved",
      });
      expect(typeof res.body.data.journalEntryId).toBe("string");
      const journals = await journalsOf(res.body.data.id);
      expect(journals).toHaveLength(1);
      expect(journals[0]!.id).toBe(res.body.data.journalEntryId);
      const lines = await journalLinesOf(journals[0]!.id);
      expect(lineOf(lines, world.gl.expense)).toEqual({
        debit: amountIdr,
        credit: 0,
      });
      expect(lineOf(lines, world.gl.bankA)).toEqual({
        debit: 0,
        credit: amountIdr,
      });
    }
    expect(await bankNet()).toBe(
      before - (DEFAULT_LIMIT + DEFAULT_LIMIT - 1 + 175_000),
    );
  });

  it("[cash-out-approval-CO-2] a cash out above the limit is pending: no journal, no GL line, bank balance unchanged until approved", async () => {
    const netBefore = await bankNet();
    const linesBefore = await bankLineCount();
    const amountIdr = DEFAULT_LIMIT + 1;
    const res = await post(creator, cashOutBody({ amountIdr }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: "cash_out",
      amountIdr,
      status: "pending_approval",
      journalEntryId: null,
      approverId: null,
      decidedAt: null,
      decisionReason: null,
    });
    const id = res.body.data.id as string;
    const stored = await row(id);
    expect(stored.status).toBe("pending_approval");
    expect(stored.journal_entry_id).toBeNull();
    expect(await journalsOf(id)).toHaveLength(0);
    expect(await bankLineCount()).toBe(linesBefore);
    expect(await bankNet()).toBe(netBefore);

    // Readers show the status.
    const read = await getEntry(creator, id);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data).toMatchObject({
      id,
      status: "pending_approval",
      journalEntryId: null,
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
    const listedRow = listed.body.data.find((r: { id: string }) => r.id === id);
    expect(listedRow).toMatchObject({ status: "pending_approval" });

    // Control: another finance user approves, then the money moves once.
    const approved = await approve(approver, id);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({
      id,
      status: "approved",
      approverId: approver.userId,
    });
    expect(typeof approved.body.data.journalEntryId).toBe("string");
    expect(typeof approved.body.data.decidedAt).toBe("string");
    const journals = await journalsOf(id);
    expect(journals).toHaveLength(1);
    const lines = await journalLinesOf(journals[0]!.id);
    expect(lineOf(lines, world.gl.expense)).toEqual({
      debit: amountIdr,
      credit: 0,
    });
    expect(lineOf(lines, world.gl.bankA)).toEqual({
      debit: 0,
      credit: amountIdr,
    });
    expect(await bankNet()).toBe(netBefore - amountIdr);
    const after = await row(id);
    expect(after).toMatchObject({
      status: "approved",
      approver_id: approver.userId,
      journal_entry_id: journals[0]!.id,
    });
    expect(after.decided_at).not.toBeNull();
  });

  it("[cash-out-approval-CO-10] cash in and transfers above the limit are not gated", async () => {
    const solo = await freshCreator("co10");
    const cashIn = await post(solo, cashInBody({ amountIdr: 9_000_000 }));
    expect(cashIn.status, JSON.stringify(cashIn.body)).toBe(201);
    expect(cashIn.body.data.status).toBe("approved");
    expect(await journalsOf(cashIn.body.data.id)).toHaveLength(1);

    const transfer = await post(solo, transferBody({ amountIdr: 9_000_000 }));
    expect(transfer.status, JSON.stringify(transfer.body)).toBe(201);
    expect(transfer.body.data.status).toBe("approved");
    expect(await journalsOf(transfer.body.data.id)).toHaveLength(1);
  });

  it("[cash-out-approval-CO-11] a pending cash out still validates the counter account at submission", async () => {
    const entries = await entryCount();
    const res = await post(
      creator,
      cashOutBody({ counterAccountId: world.gl.cashDrawer }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe("CASH_BANK_COUNTER_ACCOUNT_INVALID");
    expect(await entryCount()).toBe(entries);
    // Control: a valid account over the limit is accepted (pending).
    await submitPending();
  });
});

describe("cash-out approval: approve posts exactly once", () => {
  withLimitSharedLock();

  it("[cash-out-approval-CO-3a] approving twice in sequence answers 200 both times and leaves one journal", async () => {
    const entry = await submitPending({ amountIdr: 6_100_000 });
    const netBefore = await bankNet();
    const first = await approve(approver, entry.id);
    const second = await approve(approver, entry.id);
    const third = await approve(approver2, entry.id);
    for (const res of [first, second, third]) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.status).toBe("approved");
      expect(res.body.data.journalEntryId).toBe(first.body.data.journalEntryId);
    }
    expect(await journalsOf(entry.id)).toHaveLength(1);
    expect(await bankNet()).toBe(netBefore - 6_100_000);
    // The first decider stays on record.
    expect((await row(entry.id)).approver_id).toBe(approver.userId);
  });

  it("[cash-out-approval-CO-3b] parallel approvals (Promise.all) make exactly one journal", async () => {
    const entry = await submitPending({ amountIdr: 7_300_000 });
    const netBefore = await bankNet();
    const results = await Promise.all([
      approve(approver, entry.id),
      approve(approver, entry.id),
      approve(approver2, entry.id),
      approve(approver2, entry.id),
      approve(approver, entry.id),
    ]);
    for (const res of results) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.status).toBe("approved");
    }
    expect(
      new Set(results.map((r) => r.body.data.journalEntryId as string)).size,
    ).toBe(1);
    const journals = await journalsOf(entry.id);
    expect(journals).toHaveLength(1);
    expect((await row(entry.id)).journal_entry_id).toBe(journals[0]!.id);
    expect(await bankNet()).toBe(netBefore - 7_300_000);
  });

  it("[cash-out-approval-CO-3c] approve and reject racing (Promise.all): one wins, the other is 409, one consistent outcome, at most one journal", async () => {
    for (let round = 0; round < 4; round += 1) {
      const entry = await submitPending({ amountIdr: 6_400_000 + round });
      const netBefore = await bankNet();
      // Alternate who is listed first so neither order is favoured.
      const calls =
        round % 2 === 0
          ? [approve(approver, entry.id), reject(approver2, entry.id)]
          : [reject(approver2, entry.id), approve(approver, entry.id)];
      const results = await Promise.all(calls);
      const [approveRes, rejectRes] =
        round % 2 === 0 ? results : [results[1]!, results[0]!];
      const winners = [approveRes, rejectRes].filter((r) => r.status === 200);
      const losers = [approveRes, rejectRes].filter((r) => r.status !== 200);
      expect(
        winners,
        `round ${round}: ${JSON.stringify([approveRes.body, rejectRes.body])}`,
      ).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.status).toBe(409);
      // The approval service answers APPROVAL_REQUEST_NOT_PENDING when it loses
      // the race; the cash-entry guard answers CASH_ENTRY_NOT_PENDING. Both 409.
      expect([
        "CASH_ENTRY_NOT_PENDING",
        "APPROVAL_REQUEST_NOT_PENDING",
      ]).toContain(losers[0]!.body.error.code);

      const approvedWon = approveRes.status === 200;
      const stored = await row(entry.id);
      const journals = await journalsOf(entry.id);
      expect(winners[0]!.body.data.status).toBe(
        approvedWon ? "approved" : "rejected",
      );
      expect(stored.status).toBe(approvedWon ? "approved" : "rejected");
      expect(stored.approver_id).toBe(
        approvedWon ? approver.userId : approver2.userId,
      );
      expect(stored.decided_at).not.toBeNull();
      if (approvedWon) {
        expect(journals).toHaveLength(1);
        expect(stored.journal_entry_id).toBe(journals[0]!.id);
        expect(stored.decision_reason).toBeNull();
        expect(await bankNet()).toBe(netBefore - (6_400_000 + round));
      } else {
        expect(journals).toHaveLength(0);
        expect(stored.journal_entry_id).toBeNull();
        expect(stored.decision_reason).toBe("Tidak sesuai");
        expect(await bankNet()).toBe(netBefore);
      }
    }
  });
});

describe("cash-out approval: period closed after submission", () => {
  withLimitSharedLock();

  it("[cash-out-approval-CO-12] approving after the period closed is refused, the entry stays pending with no journal", async () => {
    const w = await makeWorld(); // own legal entity: closing its period is private
    const entryDate = daysAgo(1);
    const amountIdr = 6_600_000;
    const body = {
      kind: "cash_out",
      legalEntityId: w.entityId,
      bankAccountId: w.bankAccountA,
      counterAccountId: w.gl.expense,
      amountIdr,
      entryDate,
      description: "Bayar supplier periode ditutup",
      reference: `REF-${short()}`,
      idempotencyKey: key(),
    };
    const submitted = await post(creator, body);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    expect(submitted.body.data.status).toBe("pending_approval");
    const id = submitted.body.data.id as string;

    // The finance team closes the entry's month before anyone approves.
    const closed = await owner.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $4`,
      [tenantId, w.entityId, randomUUID(), entryDate.slice(0, 7)],
    );
    expect(closed.rowCount).toBe(1);

    const res = await approve(approver, id);
    expect(is4xx(res.status), JSON.stringify(res.body)).toBe(true);
    expect(typeof res.body.error.code).toBe("string");
    expect(["CASH_ENTRY_NOT_FOUND", "CASH_ENTRY_NOT_PENDING"]).not.toContain(
      res.body.error.code,
    );

    expect(await row(id)).toMatchObject({
      status: "pending_approval",
      approver_id: null,
      journal_entry_id: null,
    });
    expect(await journalsByKey(w.entityId, `cb:${id}`)).toHaveLength(0);
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_lines WHERE tenant_id = $1 AND account_id = $2",
      [tenantId, w.gl.bankA],
    );
    expect(Number(rows[0]!.n)).toBe(0);

    // Still pending, so it can still be decided: a reject posts nothing.
    const rejected = await reject(approver2, id, "Periode sudah ditutup");
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data.status).toBe("rejected");
    expect(await journalsByKey(w.entityId, `cb:${id}`)).toHaveLength(0);
  });
});

describe("cash-out approval: who may decide", () => {
  withLimitSharedLock();

  it("[cash-out-approval-CO-4] the creator cannot approve or reject their own entry", async () => {
    const entry = await submitPending({ amountIdr: 5_500_000 });
    const netBefore = await bankNet();
    for (const res of [
      await approve(creator, entry.id),
      await reject(creator, entry.id),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe("CASH_OUT_SELF_APPROVAL");
    }
    expect((await row(entry.id)).status).toBe("pending_approval");
    expect(await journalsOf(entry.id)).toHaveLength(0);
    expect(await bankNet()).toBe(netBefore);
    // Control: another finance user can approve it, so the 403 is the rule.
    expect((await approve(approver, entry.id)).status).toBe(200);
  });

  it("[cash-out-approval-CO-7] a user without the approve permission, and an anonymous caller, are refused", async () => {
    const entry = await submitPending({ amountIdr: 5_600_000 });
    const anonymous = anon().client;
    const anonymousApprove = await anonymous
      .post(`${ENTRIES}/${entry.id}/approve`)
      .set(originHeader)
      .send({});
    expect(anonymousApprove.status).toBe(401);
    const anonymousReject = await anonymous
      .post(`${ENTRIES}/${entry.id}/reject`)
      .set(originHeader)
      .send({ reason: "Tidak sesuai" });
    expect(anonymousReject.status).toBe(401);
    for (const res of [
      await approve(nobody, entry.id),
      await reject(nobody, entry.id),
    ])
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect((await row(entry.id)).status).toBe("pending_approval");
    expect(await journalsOf(entry.id)).toHaveLength(0);
    // Control: a finance approver succeeds.
    expect((await approve(approver, entry.id)).status).toBe(200);
  });

  it("[cash-out-approval-CO-13] an approver scoped to one outlet cannot decide an entry of another outlet or an entity-level entry", async () => {
    const outletX = await makeOutlet(world.entityId);
    const outletY = await makeOutlet(world.entityId);
    const scoped = await signedIn(app, "CO approver outlet", [
      { role: "finance", outletId: outletX },
    ]);
    const otherOutlet = await submitPending({
      amountIdr: 5_650_000,
      outletId: outletY,
    });
    const entityLevel = await submitPending({ amountIdr: 5_660_000 });
    const netBefore = await bankNet();
    for (const entry of [otherOutlet, entityLevel]) {
      for (const res of [
        await approve(scoped, entry.id),
        await reject(scoped, entry.id),
      ]) {
        expect([403, 404], JSON.stringify(res.body)).toContain(res.status);
      }
      expect((await row(entry.id)).status).toBe("pending_approval");
      expect(await journalsOf(entry.id)).toHaveLength(0);
    }
    expect(await bankNet()).toBe(netBefore);
    // Control: a tenant-wide approver decides both, so the refusal is scope.
    expect((await approve(approver, otherOutlet.id)).status).toBe(200);
    expect((await reject(approver, entityLevel.id)).status).toBe(200);
  });
});

describe("cash-out approval: reject", () => {
  withLimitSharedLock();

  it("[cash-out-approval-CO-6] a rejected entry has no journal, keeps its reason and can never be approved", async () => {
    const entry = await submitPending({ amountIdr: 5_700_000 });
    const netBefore = await bankNet();
    const res = await reject(approver, entry.id, "Tagihan tidak valid");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      id: entry.id,
      status: "rejected",
      approverId: approver.userId,
      decisionReason: "Tagihan tidak valid",
      journalEntryId: null,
    });
    expect(typeof res.body.data.decidedAt).toBe("string");
    const stored = await row(entry.id);
    expect(stored).toMatchObject({
      status: "rejected",
      approver_id: approver.userId,
      decision_reason: "Tagihan tidak valid",
      journal_entry_id: null,
    });
    expect(await journalsOf(entry.id)).toHaveLength(0);

    for (const who of [approver, approver2]) {
      const again = await approve(who, entry.id);
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect(again.body.error.code).toBe("CASH_ENTRY_NOT_PENDING");
    }
    const rejectAgain = await reject(approver2, entry.id, "Lagi");
    // A repeated reject is idempotent (200) and keeps the first decision.
    expect(rejectAgain.status, JSON.stringify(rejectAgain.body)).toBe(200);
    expect(rejectAgain.body.data).toMatchObject({
      status: "rejected",
      approverId: approver.userId,
      decisionReason: "Tagihan tidak valid",
    });
    expect(await journalsOf(entry.id)).toHaveLength(0);
    expect(await row(entry.id)).toMatchObject({
      status: "rejected",
      approver_id: approver.userId,
      decision_reason: "Tagihan tidak valid",
    });
    expect(await bankNet()).toBe(netBefore);
  });

  it("[cash-out-approval-CO-6b] an approved entry cannot be rejected afterwards", async () => {
    const entry = await submitPending({ amountIdr: 5_800_000 });
    expect((await approve(approver, entry.id)).status).toBe(200);
    const res = await reject(approver2, entry.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("CASH_ENTRY_NOT_PENDING");
    expect((await row(entry.id)).status).toBe("approved");
    expect(await journalsOf(entry.id)).toHaveLength(1);
  });

  it("[cash-out-approval-CO-6c] a reject needs a reason of 1 to 500 characters", async () => {
    const entry = await submitPending({ amountIdr: 5_900_000 });
    for (const body of [
      {},
      { reason: "" },
      { reason: "x".repeat(501) },
      { reason: 42 },
      { reason: "ok", extra: true },
    ]) {
      const res = await decide(approver, entry.id, "reject", body);
      expect(
        is4xx(res.status),
        `${JSON.stringify(body)} -> ${res.status}`,
      ).toBe(true);
    }
    expect((await row(entry.id)).status).toBe("pending_approval");
    // Control: 500 characters is accepted.
    const good = await reject(approver, entry.id, "x".repeat(500));
    expect(good.status, JSON.stringify(good.body)).toBe(200);
  });
});

describe("cash-out approval: tenant isolation", () => {
  withLimitSharedLock();

  it("[cash-out-approval-CO-5] another tenant's entry is invisible: 404, nothing changes; unknown ids are 404", async () => {
    // Seed a pending entry of the foreign tenant by copying a real pending row
    // of this tenant (columns copied as they are, only the ids move over).
    const own = await submitPending({ amountIdr: 6_200_000 });
    const foreignCounter = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, '6101', 'Beban asing', 'expense', 'operating_expense') RETURNING id`,
      [world.foreign.tenantId, world.foreign.entityId],
    );
    const foreignId = randomUUID();
    const source = await owner.query<{ doc: Record<string, unknown> }>(
      "SELECT to_jsonb(e) AS doc FROM cash_bank_entries e WHERE tenant_id = $1 AND id = $2",
      [tenantId, own.id],
    );
    const doc = {
      ...source.rows[0]!.doc,
      id: foreignId,
      tenant_id: world.foreign.tenantId,
      legal_entity_id: world.foreign.entityId,
      bank_account_id: world.foreign.bankAccountId,
      counter_account_id: foreignCounter.rows[0]!.id,
      outlet_id: null,
      idempotency_key: key(),
      journal_entry_id: null,
      status: "pending_approval",
      approver_id: null,
      decided_at: null,
      decision_reason: null,
    };
    await owner.query(
      "INSERT INTO cash_bank_entries SELECT (json_populate_record(NULL::cash_bank_entries, $1::json)).*",
      [JSON.stringify(doc)],
    );

    for (const res of [
      await getEntry(approver, foreignId),
      await approve(approver, foreignId),
      await reject(approver, foreignId),
      await approve(approver, randomUUID()),
      await reject(approver, randomUUID()),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBe(404);
    }
    const approveForeign = await approve(approver, foreignId);
    expect(approveForeign.body.error.code).toBe("CASH_ENTRY_NOT_FOUND");
    const rejectUnknown = await reject(approver, randomUUID());
    expect(rejectUnknown.body.error.code).toBe("CASH_ENTRY_NOT_FOUND");

    const { rows } = await owner.query<DecisionRow & { tenant_id: string }>(
      `SELECT id, tenant_id, status, approver_id, journal_entry_id
         FROM cash_bank_entries WHERE id = $1`,
      [foreignId],
    );
    expect(rows[0]).toMatchObject({
      tenant_id: world.foreign.tenantId,
      status: "pending_approval",
      approver_id: null,
      journal_entry_id: null,
    });
    const foreignJournals = await owner.query(
      "SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
      [world.foreign.tenantId, `cb:${foreignId}`],
    );
    expect(foreignJournals.rows).toHaveLength(0);

    // The foreign entity's list is unknown to this tenant: empty, or refused
    // (404 not found / 422 unknown legal entity), never the foreign rows.
    const listed = await creator.client
      .get(ENTRIES)
      .set(originHeader)
      .query({ legalEntityId: world.foreign.entityId, limit: 100 });
    if (listed.status === 200) expect(listed.body.data).toHaveLength(0);
    else expect([404, 422]).toContain(listed.status);

    // Control: this tenant's own pending entry is decidable.
    expect((await approve(approver, own.id)).status).toBe(200);
  });
});

describe("cash-out approval: tenant limit", () => {
  withLimitSharedLock();

  it("[cash-out-approval-CO-8a] the limit defaults to Rp5.000.000 and is readable by finance, not by outsiders", async () => {
    const res = await getLimit(creator);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(limitOf(res).limitIdr).toBe(DEFAULT_LIMIT);
    expect(typeof limitOf(res).isDefault).toBe("boolean");
    expect((await getLimit(nobody)).status).toBe(403);
    expect((await getLimit(anon())).status).toBe(401);
  });

  it("[cash-out-approval-CO-8b] changing the limit without permission is refused and the limit stays", async () => {
    const before = await getLimit(creator);
    for (const who of [nobody, anon()]) {
      const res = await putLimit(who, { limitIdr: 1_000_000 });
      expect([401, 403], JSON.stringify(res.body)).toContain(res.status);
    }
    const after = await getLimit(creator);
    expect(after.body).toEqual(before.body);
  });

  it("[cash-out-approval-CO-8c] a zero, negative, fractional, huge or malformed limit is refused and the limit stays", async () => {
    const before = await getLimit(creator);
    for (const body of [
      { limitIdr: 0 },
      { limitIdr: -5_000_000 },
      { limitIdr: 1.5 },
      { limitIdr: 100_000_000_001 },
      { limitIdr: "5000000" },
      { limitIdr: null },
      { limitIdr: "abc" },
      {},
      { limitIdr: 1_000_000, extra: 1 },
    ]) {
      const res = await putLimit(creator, body);
      expect(
        is4xx(res.status),
        `${JSON.stringify(body)} -> ${res.status}`,
      ).toBe(true);
    }
    const after = await getLimit(creator);
    expect(after.body).toEqual(before.body);
  });
});

// CO-8d changes the shared tenant limit: it takes the exclusive lock, so it waits
// for every running test and no test sees the lowered limit.
describe("cash-out approval: tenant limit change", () => {
  limitExclusiveLock();

  it("[cash-out-approval-CO-8d] a new limit takes effect: above it pends, equal to it posts; then it is restored", async () => {
    const solo = await freshCreator("co8d");
    try {
      const set = await putLimit(creator, { limitIdr: 1_000_000 });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      const read = await getLimit(creator);
      expect(limitOf(read)).toMatchObject({
        limitIdr: 1_000_000,
        isDefault: false,
      });

      const above = await post(solo, cashOutBody({ amountIdr: 1_000_001 }));
      expect(above.status, JSON.stringify(above.body)).toBe(201);
      expect(above.body.data.status).toBe("pending_approval");
      expect(await journalsOf(above.body.data.id)).toHaveLength(0);

      // Equal to the limit posts at once. Filed by a second fresh creator so the
      // pending entry above does not add to this creator's daily total.
      const soloEqual = await freshCreator("co8d equal");
      const equal = await post(
        soloEqual,
        cashOutBody({ amountIdr: 1_000_000 }),
      );
      expect(equal.status, JSON.stringify(equal.body)).toBe(201);
      expect(equal.body.data.status).toBe("approved");
      expect(await journalsOf(equal.body.data.id)).toHaveLength(1);

      // Approving is not affected by a later limit change.
      expect((await approve(approver, above.body.data.id)).status).toBe(200);
    } finally {
      const restore = await putLimit(creator, { limitIdr: DEFAULT_LIMIT });
      expect(restore.status, JSON.stringify(restore.body)).toBe(200);
    }
    const soloBack = await freshCreator("co8d back");
    const back = await post(
      soloBack,
      cashOutBody({ amountIdr: DEFAULT_LIMIT }),
    );
    expect(back.body.data.status).toBe("approved");
  });
});

describe("cash-out approval: idempotent submission", () => {
  withLimitSharedLock();

  it("[cash-out-approval-CO-9] the same key above the limit makes one entry, sequentially and in parallel", async () => {
    const solo = await freshCreator("co9");
    const entries = await entryCount();
    const body = cashOutBody({ amountIdr: 8_800_000 });
    const first = await post(solo, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.status).toBe("pending_approval");
    const replay = await post(solo, body);
    expect(ok(replay.status), JSON.stringify(replay.body)).toBe(true);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.body.data.status).toBe("pending_approval");
    expect(await entryCount()).toBe(entries + 1);

    const parallel = cashOutBody({ amountIdr: 8_900_000 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(solo, parallel)),
    );
    for (const res of results)
      expect(ok(res.status), JSON.stringify(res.body)).toBe(true);
    const ids = new Set(results.map((r) => r.body.data.id as string));
    expect(ids.size).toBe(1);
    expect(await entryCount()).toBe(entries + 2);
    for (const id of [first.body.data.id, [...ids][0]!])
      expect(await journalsOf(id)).toHaveLength(0);

    // The same key with another body is a conflict, not a second entry.
    const reused = await post(solo, { ...body, amountIdr: 8_800_001 });
    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await entryCount()).toBe(entries + 2);
  });
});
