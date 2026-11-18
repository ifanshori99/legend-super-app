// 5qqb9 P2 (revised): a cash payroll handover done while accounting was OFF
// ends as a `settle_skipped` posting. It keeps counting as a reserve against GL
// 1102 (nobody may spend that cash twice). The catch-up journal is impossible
// without the payroll.locked journal, so finance gets an official MANUAL
// "waive" instead (kind `settle_waived`, terminal, audited, no journal):
//   POST /api/hris/payroll/disbursement-batches/:id/postings/:postingId/waive-skipped
//   body { password, reason (trimmed, 1..500) }
// Written fail-first from the brief (scratchpad brief-5qqb9.md, "P2 REVISED"),
// the founder rule "nobody is paid twice, GL 1102 never goes negative", and the
// HTTP + DB surface only, NOT from the service code.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Permission: accounting.petty_cash.manage (the finance actor below holds it
//   plus payroll.view, TOTP enrolled and verified in this session, so the
//   password step-up applies). A user with only payroll.disburse.approve, or
//   only payroll.view, is refused 403.
// - Success 200; replay on settle_waived = 200 no-op, no second audit row.
// - Refusals: reason missing/blank/over 500 chars -> 422; posting not
//   settle_skipped (here settle_pending) -> 409; unknown ids -> 404; missing or
//   wrong password -> a 4xx in {400,401,403,422} (exact code not pinned); never
//   "Route not found.".
// - Accounting state is irrelevant: waiving works with accounting OFF too.
// - Waiving removes the net from the reserve, so available cash rises by net.
//   GL 1102 and journals do not move.
// - Audit: exactly one new audit_logs row mentioning the batch, containing the
//   reason and the net; its action name is not pinned.
// - DB level: the guard trigger must allow a pure flip settle_skipped ->
//   settle_waived (only `kind` changes) and refuse the flip when any other
//   column changes in the same UPDATE (refused by the trigger, NOT by the
//   kind CHECK constraint, which is what refuses it before the migration), and
//   a waived row can never go back (to settle_skipped / settle).
// - "resolvePendingSettles ignores a waived row" is not driven here: it is a
//   service call with no HTTP surface named in the brief. Covered indirectly:
//   no journal exists for a waived posting after replay and flip-back is refused.
// - "Other tenant -> 404" is not covered over HTTP (no second tenant client in
//   this world); unknown ids are the stand-in. Flagged in the report.
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { originHeader } from "./helpers.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  daysAgo,
  key,
  makeBankAccount,
  owner as kitOwner,
  signedIn,
  tenantId,
  type Session,
} from "./helpers/cash-bank-world.ts";
import {
  APP2,
  CASHIER,
  cash,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";

const app = createApp();
const W = installPayoutWorld("5qqb9waive");
const BASE = "/api/hris/payroll/disbursement-batches";
const ENTRIES = "/api/accounting/cash-bank/entries";
const PASSWORD = "Test-password-123!";
// Small nets: every waive adds one to the free cash, and a probe cash out above
// the tenant limit (default Rp5.000.000) is parked pending_approval with the 1102
// guard deferred to approval, so it could not show the refusal. 12 scenarios
// stay far below the limit.
const NET = 100_000;
const EXTRA = 2_000_000;

withLimitSharedLock();

// ---- people -----------------------------------------------------------------

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
type Client = Awaited<ReturnType<typeof W.signedInClient>>["client"];
let approver: Client;
let waiver: Client;
let viewer: Client;
let probeFinance: Session;
let pettyGlId: string;
let pettyBankId: string;
let expenseAccountId: string;
/** Net of the settle_skipped / settle_pending postings this file created and nobody caught up. */
let reserve = 0;
/** Free cash (GL 1102 minus reserve) every scenario must find: EXTRA plus the nets finance waived. */
let free = EXTRA;

/** Disburse permission, TOTP enrolled and verified in this session (enrollment-only: needs the password). */
async function enrolledActor(label: string, permissions: string[]) {
  const { client, userId } = await W.signedInClient(`Waive5qqb9 ${label}`);
  await W.grantRole(userId, permissions);
  const enrolled = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  const { factorId, secretBase32 } = enrolled.body.data as {
    factorId: string;
    secretBase32: string;
  };
  enrolledUsers.push(userId);
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return client;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  approver = await enrolledActor("Approver", [
    "payroll.view",
    "payroll.disburse.approve",
  ]);
  waiver = await enrolledActor("Waiver", [
    "payroll.view",
    "accounting.petty_cash.manage",
  ]);
  const v = await W.signedInClient("Waive5qqb9 Viewer");
  await W.grantRole(v.userId, ["payroll.view"]);
  viewer = v.client;
  probeFinance = await signedIn(app, "5qqb9 waive finance", [
    { role: "finance", outletId: null },
  ]);
  const gl = await kitOwner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1102'",
    [tenantId, W.entityId()],
  );
  pettyGlId = gl.rows[0]!.id;
  pettyBankId = await makeBankAccount(W.entityId(), pettyGlId);
  await kitOwner.query(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '6990', 'Beban Uji 5qqb9', 'expense', 'operating_expense')
     ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING`,
    [tenantId, W.entityId()],
  );
  const expense = await kitOwner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '6990'",
    [tenantId, W.entityId()],
  );
  expenseAccountId = expense.rows[0]!.id;
  await W.fundPettyCash(EXTRA);
});

afterAll(async () => {
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
  await closeKit();
});

// ---- helpers ----------------------------------------------------------------

async function withAccountingOff<T>(work: () => Promise<T>) {
  const before = await kitOwner.query<{ flags: unknown }>(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenantId],
  );
  const original = before.rows[0]!.flags as { modules?: string[] };
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  await kitOwner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      tenantId,
      JSON.stringify({
        ...original,
        modules: (original.modules ?? []).filter((m) => m !== "accounting"),
      }),
    ],
  );
  try {
    return await work();
  } finally {
    await kitOwner.query(
      "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
      [tenantId, JSON.stringify(original)],
    );
  }
}

async function glBalance(): Promise<number> {
  const { rows } = await kitOwner.query<{ balance: string }>(
    `SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND l.account_id = $3`,
    [tenantId, W.entityId(), pettyGlId],
  );
  return Number(rows[0]!.balance);
}

const available = async () => (await glBalance()) - reserve;

async function journalCount(): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, W.entityId()],
  );
  return Number(rows[0]!.n);
}

const auditRowsOf = async (batchId: string) =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
        [W.tenantId, batchId],
      )
    )[0]!.n,
  );

const digitsOf = (text: string) => text.replace(/(?<=\d)[.,](?=\d)/g, "");

/** Cash out of 1102 of `amountIdr`, answered as is. */
const cashOut = (amountIdr: number) =>
  probeFinance.client
    .post(ENTRIES)
    .set(originHeader)
    .send({
      legalEntityId: W.entityId(),
      entryDate: daysAgo(0),
      description: "Uji kas 1102 5qqb9",
      reference: `REF-${randomBytes(3).toString("hex")}`,
      idempotencyKey: key(),
      kind: "cash_out",
      bankAccountId: pettyBankId,
      counterAccountId: expenseAccountId,
      amountIdr,
    });

/** Available cash is exactly `avail`: spending one rupiah more is refused and the message names it. */
async function expectAvailableIs(avail: number, why: string) {
  expect(await available(), `${why}: tracked available`).toBe(avail);
  const gl = await glBalance();
  const journals = await journalCount();
  const res = await cashOut(avail + 1);
  const detail = JSON.stringify(res.body);
  expect([409, 422], `${why}: status ${res.status} ${detail}`).toContain(
    res.status,
  );
  expect(res.body.error?.code, `${why}: ${detail}`).toBe(
    "PETTY_CASH_GL_INSUFFICIENT",
  );
  expect(
    digitsOf(String(res.body.error?.message ?? "")),
    `${why}: the message names the available cash`,
  ).toContain(String(avail));
  expect(await glBalance(), `${why}: refused cash out moved nothing`).toBe(gl);
  expect(await journalCount()).toBe(journals);
}

type Posting = Record<string, unknown> & {
  id: string;
  kind: string;
  journal_key: string;
};

/** Cash batch handed over while accounting is OFF: a final settle_skipped. Reserve grows by `net`. */
async function skippedHandover(net = NET) {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  await W.fundPettyCash(net); // keeps available at EXTRA, covers the approve guard
  const batchId = await W.approvedBatch(runId, "cash");
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  await withAccountingOff(() => W.handover(batchId, itemIds, APP2));
  const postings = await W.postingsOf(batchId);
  expect(postings, "premise: one posting").toHaveLength(1);
  expect(postings[0]!.kind, "premise: settle_skipped").toBe("settle_skipped");
  reserve += net;
  return { batchId, net, posting: postings[0] as Posting };
}

/** Body part with the default reason. */
const waiveBody = (
  reason: unknown = "Kas sudah diserahkan, jurnal gaji tidak bisa dibuat",
) => (reason === undefined ? {} : { reason });

const waive = (
  client: Client,
  batchId: string,
  postingId: string,
  body: Record<string, unknown> | null = {
    password: PASSWORD,
    ...waiveBody(),
  },
) =>
  client
    .post(`${BASE}/${batchId}/postings/${postingId}/waive-skipped`)
    .set(originHeader)
    .send(body ?? {});

const kindOf = async (batchId: string) =>
  (await W.postingsOf(batchId))[0]!.kind as string;

const notRouteMissing = (res: { body: { error?: { message?: string } } }) =>
  expect(res.body.error?.message, "route must exist").not.toBe(
    "Route not found.",
  );

/** Runs `work`; returns the database error it raised, or null when it succeeded. */
async function dbError(work: Promise<unknown>) {
  try {
    await work;
    return null;
  } catch (error) {
    return error as { code?: string; constraint?: string; message: string };
  }
}

const KIND_CHECK = "payroll_payout_gl_postings_kind_check";

/** UPDATE of the posting row with triggers ON (the guard trigger runs). */
const updatePosting = (postingId: string, setSql: string) =>
  W.asTenant((c) =>
    c.query(
      `UPDATE payroll_payout_gl_postings SET ${setSql}
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, postingId],
    ),
  );

// ---- scenarios ----------------------------------------------------------------

describe("5qqb9 P2: settle_skipped keeps counting as a reserve", () => {
  it("[5qqb9-skipped-stays-reserve] a handover done while accounting is off is a settle_skipped credit that still counts against GL 1102: back with accounting on, a cash out above the available cash is refused, nothing posted by itself", async () => {
    await expectAvailableIs(free, "premise: free cash before");
    const { batchId, posting } = await skippedHandover();

    await expectAvailableIs(free, "after the skipped handover");
    expect(await kindOf(batchId), "still skipped, nothing waives it").toBe(
      "settle_skipped",
    );
    expect(
      await W.journalByKey(posting.journal_key),
      "no settle journal yet",
    ).toBeUndefined();
  }, 90_000);
});

describe("5qqb9 P2: finance waives a skipped posting", () => {
  it("[5qqb9-waive-skipped-releases-reserve] waive with a reason: 200, kind settle_waived, reserve released (available cash up by the net), GL 1102 and journals unchanged, exactly one audit row with the reason and the net", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const glBefore = await glBalance();
    const journals = await journalCount();
    const auditBefore = await auditRowsOf(batchId);
    await expectAvailableIs(free, "before the waive");
    const reason = `Waive uji ${randomBytes(3).toString("hex")}`;

    const res = await waive(waiver, batchId, posting.id, {
      password: PASSWORD,
      reason,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    reserve -= net;
    free += net;
    expect(await kindOf(batchId)).toBe("settle_waived");
    expect(await glBalance(), "GL 1102 unchanged").toBe(glBefore);
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await W.journalByKey(posting.journal_key)).toBeUndefined();
    await expectAvailableIs(free, "after the waive: the net is free cash");
    expect(await auditRowsOf(batchId), "one audit row").toBe(auditBefore + 1);
    const audit = await W.rowsOf(
      `SELECT event::text AS event FROM audit_logs
        WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
      [W.tenantId, reason],
    );
    expect(audit, "the audit row carries the reason").toHaveLength(1);
    expect(digitsOf(String(audit[0]!.event)), "and the net").toContain(
      String(net),
    );
  }, 90_000);

  it("[5qqb9-waive-skipped-accounting-off-ok] accounting state is irrelevant: waiving while accounting is off is 200 and releases the reserve", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const journals = await journalCount();

    const res = await withAccountingOff(() =>
      waive(waiver, batchId, posting.id),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    reserve -= net;
    free += net;
    expect(await kindOf(batchId)).toBe("settle_waived");
    expect(await journalCount()).toBe(journals);
    await expectAvailableIs(free, "reserve released");
  }, 90_000);

  it("[5qqb9-waive-skipped-replay-noop] a second call is a no-op 200: still settle_waived, no second audit row, GL, journals and available cash unchanged", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const first = await waive(waiver, batchId, posting.id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    reserve -= net;
    free += net;
    const audit = await auditRowsOf(batchId);
    const gl = await glBalance();
    const journals = await journalCount();

    const replay = await waive(waiver, batchId, posting.id, {
      password: PASSWORD,
      reason: "Alasan lain pada panggilan kedua",
    });

    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(await kindOf(batchId)).toBe("settle_waived");
    expect(await auditRowsOf(batchId), "no second audit row").toBe(audit);
    expect(await glBalance()).toBe(gl);
    expect(await journalCount()).toBe(journals);
    expect(await W.journalByKey(posting.journal_key)).toBeUndefined();
    await expectAvailableIs(free, "replay changed nothing");
  }, 90_000);
});

describe("5qqb9 P2: refusals change nothing", () => {
  it("[5qqb9-waive-skipped-reason-422] no reason, a blank reason and a reason over 500 characters are refused 422: posting stays settle_skipped, reserve kept, no audit row", async () => {
    const { batchId, posting } = await skippedHandover();
    const audit = await auditRowsOf(batchId);

    const missing = await waive(waiver, batchId, posting.id, {
      password: PASSWORD,
    });
    const blank = await waive(waiver, batchId, posting.id, {
      password: PASSWORD,
      reason: "   ",
    });
    const tooLong = await waive(waiver, batchId, posting.id, {
      password: PASSWORD,
      reason: "x".repeat(501),
    });

    for (const res of [missing, blank, tooLong]) {
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      notRouteMissing(res);
    }
    expect(await kindOf(batchId)).toBe("settle_skipped");
    expect(await auditRowsOf(batchId)).toBe(audit);
    await expectAvailableIs(free, "reserve still counted");
  }, 90_000);

  it("[5qqb9-waive-skipped-not-skipped-409] a posting that is not settle_skipped (here settle_pending, set with triggers off like other payout fixtures) is refused 409: kind and journals unchanged", async () => {
    const { batchId, posting } = await skippedHandover();
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET kind = 'settle_pending'
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, posting.id],
        ),
      true,
    );
    const journals = await journalCount();

    const refused = await waive(waiver, batchId, posting.id);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    notRouteMissing(refused);
    expect(await kindOf(batchId)).toBe("settle_pending");
    expect(await journalCount()).toBe(journals);
  }, 90_000);

  it("[5qqb9-waive-skipped-no-permission-403] a disburse-only approver and a payroll.view-only user are refused 403: kind and reserve unchanged", async () => {
    const { batchId, posting } = await skippedHandover();

    const asApprover = await waive(approver, batchId, posting.id);
    const asViewer = await waive(viewer, batchId, posting.id);

    expect(asApprover.status, JSON.stringify(asApprover.body)).toBe(403);
    expect(asViewer.status, JSON.stringify(asViewer.body)).toBe(403);
    expect(await kindOf(batchId)).toBe("settle_skipped");
    await expectAvailableIs(free, "reserve still counted");
  }, 90_000);

  it("[5qqb9-waive-skipped-password-stepup] without the account password, or with a wrong one, the waive is refused with a 4xx: posting stays settle_skipped, no audit row", async () => {
    const { batchId, posting } = await skippedHandover();
    const audit = await auditRowsOf(batchId);

    const noPassword = await waive(waiver, batchId, posting.id, {
      ...waiveBody(),
    });
    const wrong = await waive(waiver, batchId, posting.id, {
      password: "Wrong-password-999!",
      ...waiveBody(),
    });

    for (const res of [noPassword, wrong]) {
      expect([400, 401, 403, 422], JSON.stringify(res.body)).toContain(
        res.status,
      );
      notRouteMissing(res);
    }
    expect(await kindOf(batchId)).toBe("settle_skipped");
    expect(await auditRowsOf(batchId)).toBe(audit);
  }, 90_000);

  it("[5qqb9-waive-skipped-unknown-404] an unknown posting of a real batch, and a posting under an unknown batch id, answer 404 (stand-in for another tenant's ids); nothing changes", async () => {
    const { batchId, posting } = await skippedHandover();
    const unknown = "00000000-0000-4000-8000-000000000000";

    const noPosting = await waive(waiver, batchId, unknown);
    const noBatch = await waive(waiver, unknown, posting.id);

    expect(noPosting.status, JSON.stringify(noPosting.body)).toBe(404);
    expect(noBatch.status, JSON.stringify(noBatch.body)).toBe(404);
    // The route exists: this is a business 404, not "Route not found."
    notRouteMissing(noPosting);
    notRouteMissing(noBatch);
    expect(await kindOf(batchId)).toBe("settle_skipped");
  }, 90_000);
});

describe("5qqb9 P2: database guard on settle_waived", () => {
  it("[5qqb9-waive-db-pure-flip-allowed] a direct UPDATE that only flips kind settle_skipped -> settle_waived is accepted by the guard trigger and the kind check", async () => {
    const { batchId, net, posting } = await skippedHandover();

    const error = await dbError(
      updatePosting(posting.id, "kind = 'settle_waived'"),
    );

    expect(error?.message, "pure flip must be accepted").toBeUndefined();
    reserve -= net;
    free += net;
    expect(await kindOf(batchId)).toBe("settle_waived");
    await expectAvailableIs(free, "waived row no longer reserves");
  }, 90_000);

  it("[5qqb9-waive-db-flip-with-other-change-refused] the flip together with any other column change is refused by the guard trigger (not by the kind check constraint) and the row stays settle_skipped; the pure flip afterwards is accepted", async () => {
    const { batchId, net, posting } = await skippedHandover();

    const withSource = await dbError(
      updatePosting(
        posting.id,
        "kind = 'settle_waived', source_gl_account_id = NULL",
      ),
    );
    const withKey = await dbError(
      updatePosting(
        posting.id,
        "kind = 'settle_waived', journal_key = journal_key || '-x'",
      ),
    );

    for (const error of [withSource, withKey]) {
      expect(error, "the guard must refuse the combined change").not.toBeNull();
      expect(
        error!.constraint,
        `refused by the trigger, not the kind check (${error!.message})`,
      ).not.toBe(KIND_CHECK);
    }
    expect(await kindOf(batchId)).toBe("settle_skipped");

    // The refusals are about the extra column only: the pure flip still works.
    const pure = await dbError(
      updatePosting(posting.id, "kind = 'settle_waived'"),
    );
    expect(pure?.message, "pure flip must be accepted").toBeUndefined();
    reserve -= net;
    free += net;
    expect(await kindOf(batchId)).toBe("settle_waived");
  }, 90_000);

  it("[5qqb9-waive-db-terminal] a waived row can never be flipped back (to settle_skipped, settle_pending or settle) and is never journaled", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const flip = await dbError(
      updatePosting(posting.id, "kind = 'settle_waived'"),
    );
    expect(flip?.message, "premise: waived").toBeUndefined();
    reserve -= net;
    free += net;
    const journals = await journalCount();

    for (const kind of ["settle_skipped", "settle_pending", "settle"]) {
      const error = await dbError(
        updatePosting(posting.id, `kind = '${kind}'`),
      );
      expect(error, `waived -> ${kind} must be refused`).not.toBeNull();
    }

    expect(await kindOf(batchId)).toBe("settle_waived");
    expect(await journalCount()).toBe(journals);
    expect(await W.journalByKey(posting.journal_key)).toBeUndefined();
    await expectAvailableIs(free, "terminal row does not reserve again");
  }, 90_000);
});
