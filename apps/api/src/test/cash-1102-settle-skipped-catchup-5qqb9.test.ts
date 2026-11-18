// 5qqb9 P2: a cash payroll handover done while accounting was OFF ends as a
// `settle_skipped` posting. It keeps counting as a reserve against GL 1102
// (nobody may spend that cash twice), and finance gets an official catch-up:
//   POST /api/hris/payroll/disbursement-batches/:id/postings/:postingId/post-skipped
// Written fail-first from the brief (scratchpad brief-5qqb9.md, section P2),
// the founder rule "nobody is paid twice, GL 1102 never goes negative", and the
// HTTP surface only, NOT from the service code.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Path: sibling of the `source` route in payroll-payout.routes.ts
//   (`/api/hris/payroll/disbursement-batches/:id/postings/:postingId/source`),
//   so `.../post-skipped`, POST, same permission (payroll.disburse.approve),
//   trusted origin, step-up and password step-up as the sibling. Body: `{ password }`
//   (the sibling takes the account password for enrollment-only sessions).
// - Success is HTTP 200. A second call is a no-op 200 (brief: idempotent).
// - Refusals: accounting off -> 409; posting not `settle_skipped` -> 409 when it
//   is `settle_pending`; posting without a stored source account -> 409; no
//   permission -> 403; unknown batch or posting id -> 404.
// - "Other tenant -> 404" is NOT covered over HTTP: a second tenant needs a
//   domain-resolved client that this fixture world does not give. A batch/posting
//   id that does not exist is the stand-in (404). Flagged in the report.
// - "Supplier / cash-out refused meanwhile": the supplier payment route is not
//   named in the brief; the probe is a cash out of a bank account mapped to GL
//   1102 (the same guard, PETTY_CASH_GL_INSUFFICIENT, status 409 or 422, with
//   the available figure in the message), as petty-cash-1053b-reserve does.
// - Available cash = GL 1102 minus reserve. The probe is a cash out of
//   `available + 1`: it must be refused and the message must name `available`.
//   The world is funded with EXTRA free cash once; every scenario funds exactly
//   its net on top, so available stays EXTRA unless a catch-up changes it (it must
//   not: the posting turns reserve into a GL credit of the same amount).
// - The audit row is only asserted as "at least one new audit row that
//   mentions the batch"; its action name is not pinned.
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
const W = installPayoutWorld("5qqb9catchup");
const BASE = "/api/hris/payroll/disbursement-batches";
const ENTRIES = "/api/accounting/cash-bank/entries";
const PASSWORD = "Test-password-123!";
const NET = 1_000_000;
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
let viewer: Client;
let probeFinance: Session;
let pettyGlId: string;
let pettyBankId: string;
let expenseAccountId: string;
/** Net of the settle_skipped / settle_pending postings this file created and nobody caught up. */
let reserve = 0;

/** Disburse permission, TOTP enrolled and verified in this session (enrollment-only: needs the password). */
async function enrolledApprover(label: string) {
  const { client, userId } = await W.signedInClient(`Catchup5qqb9 ${label}`);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
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
  approver = await enrolledApprover("Approver");
  const v = await W.signedInClient("Catchup5qqb9 Viewer");
  await W.grantRole(v.userId, ["payroll.view"]);
  viewer = v.client;
  probeFinance = await signedIn(app, "5qqb9 catchup finance", [
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

/** `password` defaults to the account password (step-up as the sibling `source` route); null omits it. */
const postSkipped = (
  client: Client,
  batchId: string,
  postingId: string,
  password: string | null = PASSWORD,
) =>
  client
    .post(`${BASE}/${batchId}/postings/${postingId}/post-skipped`)
    .set(originHeader)
    .send(password === null ? {} : { password });

const kindOf = async (batchId: string) =>
  (await W.postingsOf(batchId))[0]!.kind as string;

// ---- scenarios ----------------------------------------------------------------

describe("5qqb9 P2: settle_skipped keeps counting as a reserve", () => {
  it("[5qqb9-skipped-stays-reserve] a handover done while accounting is off is a settle_skipped credit that still counts against GL 1102: back with accounting on, a cash out above the available cash is refused, nothing posted by itself", async () => {
    await expectAvailableIs(EXTRA, "premise: free cash before");
    const { batchId, posting } = await skippedHandover();

    await expectAvailableIs(EXTRA, "after the skipped handover");
    expect(await kindOf(batchId), "still skipped, nothing catches it up").toBe(
      "settle_skipped",
    );
    expect(
      await W.journalByKey(posting.journal_key),
      "no settle journal yet",
    ).toBeUndefined();
  }, 90_000);
});

describe("5qqb9 P2: official catch-up of a skipped posting", () => {
  it("[5qqb9-post-skipped-posts-once] accounting on, finance posts the skipped settlement: 200, kind settle, one journal crediting 1102 by the net, GL 1102 down by net, reserve down by net (available cash unchanged), audited", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const glBefore = await glBalance();
    const auditBefore = await auditRowsOf(batchId);
    await expectAvailableIs(EXTRA, "before the catch-up");

    const res = await postSkipped(approver, batchId, posting.id);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    reserve -= net;
    expect(await kindOf(batchId)).toBe("settle");
    const journal = await W.journalByKey(posting.journal_key);
    expect(journal, "the stored journal is posted").toBeDefined();
    expect(journal!["1102"], "1102 is credited by the net").toEqual({
      debit: 0,
      credit: net,
    });
    expect(await W.countJournals(posting.journal_key)).toBe(1);
    expect(await glBalance(), "GL 1102 down by the net").toBe(glBefore - net);
    await expectAvailableIs(EXTRA, "after the catch-up: reserve down too");
    expect(
      await auditRowsOf(batchId),
      "the catch-up leaves an audit row",
    ).toBeGreaterThan(auditBefore);
  }, 90_000);

  it("[5qqb9-post-skipped-replay-noop] a second call is a no-op 200: still exactly one journal, GL 1102 and the posting unchanged", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const first = await postSkipped(approver, batchId, posting.id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    reserve -= net;
    const glAfterFirst = await glBalance();
    const journals = await journalCount();

    const replay = await postSkipped(approver, batchId, posting.id);

    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(await W.countJournals(posting.journal_key)).toBe(1);
    expect(await journalCount()).toBe(journals);
    expect(await glBalance()).toBe(glAfterFirst);
    expect(await kindOf(batchId)).toBe("settle");
    await expectAvailableIs(EXTRA, "replay changed nothing");
  }, 90_000);
});

describe("5qqb9 P2: refusals change nothing", () => {
  it("[5qqb9-post-skipped-accounting-off-409] while accounting is off the catch-up is refused 409: the posting stays settle_skipped, no journal; once accounting is on it posts", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const journals = await journalCount();

    const refused = await withAccountingOff(() =>
      postSkipped(approver, batchId, posting.id),
    );

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await kindOf(batchId)).toBe("settle_skipped");
    expect(await journalCount()).toBe(journals);
    expect(await W.journalByKey(posting.journal_key)).toBeUndefined();

    const later = await postSkipped(approver, batchId, posting.id);
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    reserve -= net;
    expect(await kindOf(batchId)).toBe("settle");
  }, 90_000);

  it("[5qqb9-post-skipped-not-skipped-409] a posting that is not settle_skipped (here settle_pending, set with triggers off like other payout fixtures) is refused 409: kind and journals unchanged", async () => {
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

    const refused = await postSkipped(approver, batchId, posting.id);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await kindOf(batchId)).toBe("settle_pending");
    expect(await journalCount()).toBe(journals);
  }, 90_000);

  it("[5qqb9-post-skipped-no-source-409] a skipped posting without a stored source account is refused 409: nothing is credited from an account nobody froze", async () => {
    const { batchId, net, posting } = await skippedHandover();
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET source_gl_account_id = NULL
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, posting.id],
        ),
      true,
    );
    const journals = await journalCount();
    const gl = await glBalance();

    const refused = await postSkipped(approver, batchId, posting.id);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await kindOf(batchId)).toBe("settle_skipped");
    expect(await journalCount()).toBe(journals);
    expect(await glBalance()).toBe(gl);
    void net; // the posting stays skipped, so its reserve stays counted
  }, 90_000);

  it("[5qqb9-post-skipped-no-permission-403] a user with payroll.view only is refused 403: kind and journals unchanged", async () => {
    const { batchId, posting } = await skippedHandover();
    const journals = await journalCount();

    const refused = await postSkipped(viewer, batchId, posting.id);

    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(await kindOf(batchId)).toBe("settle_skipped");
    expect(await journalCount()).toBe(journals);
  }, 90_000);

  it("[5qqb9-post-skipped-unknown-404] an unknown posting of a real batch, and a posting under an unknown batch id, answer 404 (stand-in for another tenant's ids); nothing changes", async () => {
    const { batchId, posting } = await skippedHandover();
    const journals = await journalCount();
    const unknown = "00000000-0000-4000-8000-000000000000";

    const noPosting = await postSkipped(approver, batchId, unknown);
    const noBatch = await postSkipped(approver, unknown, posting.id);

    expect(noPosting.status, JSON.stringify(noPosting.body)).toBe(404);
    expect(noBatch.status, JSON.stringify(noBatch.body)).toBe(404);
    // The route exists: this is a business 404, not "Route not found."
    expect(noPosting.body.error?.message).not.toBe("Route not found.");
    expect(noBatch.body.error?.message).not.toBe("Route not found.");
    expect(await kindOf(batchId)).toBe("settle_skipped");
    expect(await journalCount()).toBe(journals);
  }, 90_000);
});
