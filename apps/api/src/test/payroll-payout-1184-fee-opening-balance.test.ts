// Brief 1184, card 1 (legend-3xzop): finance marks the bank fee of a payout GL
// posting as "already in the opening balance". Written from
// docs/briefs/sub-1184-payout-gl-holds.md and the shared validators, NOT from
// the implementation.
//
// Route: POST /api/hris/payroll/payout-gl-postings/:postingId/fee-opening-balance
//   body { password?, note }, permission payroll.payout.gl_resolve, MFA step-up,
//   answer 200 { data: { postingId, resolvedAt } }.
//
// Rules proven ("jangan sampai rugi": the fee is never booked twice, nothing
// is booked by the mark itself, and nobody can mark a fee they should not):
// - A posting whose live reason is accounting_was_off can be marked once. The
//   mark writes fee_opening_balance_at/by/note, writes ONE audit row
//   (payroll.payout_gl_fee.opening_balance_marked) and NO journal; the row
//   leaves the finance recovery list.
// - After the mark NO path journals the fee: repostSkippedFees, the recovery
//   (recoverPayoutGlOfBatch), the worker sweep and the resolver that settles
//   the posting once the lock arrives. The net settle journal is unchanged.
// - Concurrent marks: exactly one 200, the rest 409 PAYOUT_GL_ALREADY_RESOLVED,
//   one audit row, no journal. A second mark later is 409 too.
// - Refused without effect and without a success audit row: the batch creator
//   (403 PAYOUT_GL_SELF_APPROVAL), a role without the permission (403), no MFA
//   (401/403), stale step-up (401 REAUTH_REQUIRED), a missing or wrong password
//   on an enrollment-only session (401 / 401-403), a blank, missing or too long
//   note (400/422).
// - Another tenant's posting, or an unknown id: 404 PAYOUT_GL_POSTING_NOT_FOUND,
//   the other tenant's row untouched.
// - A posting whose reason is not accounting_was_off (settled normally, or
//   bank_charges_missing after the lock was consumed): 409
//   PAYOUT_GL_NOT_ACCOUNTING_WAS_OFF, untouched.
//
// Assumptions (spec silent, stated so they can be contested):
// - The route prefix is /api/hris/payroll like /payout-fee-reposts.
// - Error code for validation is 400 or 422 (repo convention varies); both pass.
// - Missing MFA (no factor enrolled) is 401 or 403, never 200.
// - The password is required only when the second factor comes from enrollment
//   in the same session (shared validator: password optional), as the other
//   payout steps. The test people are enrollment-only, so they must send it.
// - Stale step-up = both mfa_verified_at and mfa_challenge_verified_at older
//   than 15 minutes (pattern of payroll-payout-920-unfreeze-password.test.ts);
//   stale + the right password is still 401.
// - Audit rows are counted by action over the whole tenant (delta before/after),
//   the note is expected inside the stored event.
// - The other tenant's posting is made by copying a posting row of the fixture
//   tenant under another tenant id (superuser, triggers off); removed afterwards.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import * as glService from "../services/payroll-payout-gl.service.ts";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { exportManualBatch } from "../services/payroll-payout-manual.service.ts";
import {
  __resetRecoveryCursorsForTest,
  runPayoutGlRecoverySweep,
} from "../worker/payout-gl-recovery.job.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  APP2,
  BUDI,
  actorOf,
  bank,
  installPayoutWorld,
  runTotals,
  type Row,
  type Slip,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("1184fee");
const tenantId = () => W.tenantId;

const GL = "/api/hris/payroll/payout-gl-postings";
const LIST = "/api/hris/payroll/payout-fee-reposts";
const PASSWORD = "Test-password-123!";
const WRONG = "Salah-password-999!";
const NOTE = "Biaya transfer sudah termasuk di saldo awal pembukuan";
const AUDIT_ACTION = "payroll.payout_gl_fee.opening_balance_marked";
const FEE = 5_000;
const NET = 1_000_000;
const NOW = new Date("2026-11-30T03:00:00Z");

beforeEach(() => {
  __resetRecoveryCursorsForTest();
});

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
afterAll(async () => {
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

// ---- People -------------------------------------------------------------------

type Person = Awaited<ReturnType<typeof makePerson>>;

/** Signed in, a custom role with `permissions`, TOTP enrolled in this very session (enrollment only). */
async function makePerson(label: string, permissions: string[], enroll = true) {
  const { client, userId } = await W.signedInClient(`Fee1184 ${label}`);
  await W.grantRole(userId, permissions);
  let factorId = "";
  let secretBase32 = "";
  if (enroll) {
    const enrolled = await client
      .post("/api/auth/mfa/factors")
      .set(originHeader)
      .send({ type: "totp" });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    ({ factorId, secretBase32 } = enrolled.body.data as {
      factorId: string;
      secretBase32: string;
    });
    enrolledUsers.push(userId);
    const verified = await client
      .post("/api/auth/mfa/verify")
      .set(originHeader)
      .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  }
  return { client, userId, factorId, secretBase32 };
}

const RESOLVER = ["payroll.view", "payroll.payout.gl_resolve"];
const memo = <T>(make: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= make());
};
const resolverA = memo(() => makePerson("Resolver A", RESOLVER));
const resolverB = memo(() => makePerson("Resolver B", RESOLVER));
/** A role that approves payouts but does not carry the GL resolve permission (what hr looks like). */
const hr = memo(() =>
  makePerson("Hr", ["payroll.view", "payroll.disburse.approve"]),
);
const noMfa = memo(() => makePerson("No MFA", RESOLVER, false));
/** Reads the finance recovery list (as the 881 tests). */
const reader = memo(() =>
  makePerson("Reader", ["payroll.view", "payroll.disburse.approve"]),
);
/** The requester of every batch that is not a self-approval case. */
const requester = memo(() => makePerson("Requester", ["payroll.view"], false));
/** A resolver whose real challenge is older than 15 minutes. */
const stale = memo(async () => {
  const person = await makePerson("Stale", RESOLVER);
  await mfaOwner.query(
    `UPDATE mfa_factors SET created_at = now() - interval '1 day', verified_at = now() - interval '1 day' WHERE id = $1`,
    [person.factorId],
  );
  const challenged = await person.client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({
      factorId: person.factorId,
      code: totpCode(person.secretBase32, totpStep(new Date()) + 1),
    });
  expect(challenged.status, JSON.stringify(challenged.body)).toBe(200);
  const aged = await mfaOwner.query(
    `UPDATE "session"
        SET created_at = now() - interval '30 minutes',
            mfa_challenge_verified_at = now() - interval '16 minutes',
            mfa_verified_at = now() - interval '16 minutes'
      WHERE revoked_at IS NULL AND user_id = $1 AND mfa_challenge_verified_at IS NOT NULL`,
    [person.userId],
  );
  expect(aged.rowCount, "premise: the challenge stamped the session").toBe(1);
  return person;
});

// ---- HTTP ---------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);
const codeOf = (res: Res) => res.body.error?.code;

const markHttp = (
  who: Person,
  postingId: string,
  body: Record<string, unknown> = { password: PASSWORD, note: NOTE },
) =>
  who.client
    .post(`${GL}/${postingId}/fee-opening-balance`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;

/** The row of this posting in the finance recovery list, or undefined. */
async function listedRow(postingId: string) {
  const res = (await (await reader()).client.get(LIST)) as unknown as Res;
  expect(res.status, detail(res)).toBe(200);
  return (res.body.data as unknown as Row[]).find(
    (row) => row.postingId === postingId,
  );
}

// ---- Outbox lock event (real consumer path, as the 881 tests) -------------------

function lockedEnvelope(runId: string, slips: Slip[], aggregateId = runId) {
  const lockedAt = "2026-10-26T05:00:00.000Z";
  return payrollLocked.envelopeSchema.parse({
    id: createUlid(),
    tenantId: tenantId(),
    outletId: null,
    name: "payroll.locked",
    version: 1,
    aggregateType: "payroll",
    aggregateId,
    sequence: 1,
    occurredAt: lockedAt,
    actor: { type: "user", id: randomUUID() },
    deviceId: null,
    idempotencyKey: `payroll.locked-${runId}-${randomUUID()}`,
    payloadSchemaRef: "payroll.locked.v1",
    payload: {
      payrollRunId: runId,
      legalEntityId: W.entityId(),
      runType: "regular",
      periodStart: "2026-09-26",
      periodEnd: "2026-10-25",
      payDate: "2026-10-27",
      totals: runTotals(slips),
      lockedBy: randomUUID(),
      lockedAt,
    },
  });
}
async function queueLockedViaOutbox(runId: string, slips: Slip[]) {
  const [taken] = await W.rowsOf(
    `SELECT count(*)::int AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2`,
    [tenantId(), runId],
  );
  const event = lockedEnvelope(
    runId,
    slips,
    Number(taken!.n) > 0 ? randomUUID() : runId,
  );
  const outboxId = createUlid();
  await W.inTx((tx) =>
    appendOutbox(tx, W.scope(), {
      id: outboxId,
      event,
      destination: "cloud-sync",
      direction: null,
      peerId: null,
    }),
  );
  return { outboxId };
}
async function consumeLocked(outboxId: string) {
  let result: { status: string } | undefined;
  await consumeOutbox(db, W.scope(), {
    outboxId,
    authorize: async () => true,
    deliver: async (
      event: unknown,
      _key: string,
      tx: Parameters<typeof deliverPayrollGlEvent>[2],
    ) => {
      result = (await deliverPayrollGlEvent(
        W.scope(),
        event as Parameters<typeof deliverPayrollGlEvent>[1],
        tx,
        NOW,
      )) as { status: string };
    },
  });
  return result;
}

// ---- Switches and ledger -----------------------------------------------------------

async function tenantFlags() {
  const rows = await W.owner.query(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenantId()],
  );
  return rows.rows[0]!.flags as { modules: string[] } & Record<string, unknown>;
}
async function setFlags(flags: unknown) {
  await W.owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [tenantId(), JSON.stringify(flags)],
  );
}
async function withAccountingOff<T>(work: () => Promise<T>) {
  const original = await tenantFlags();
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  await setFlags({
    ...original,
    modules: original.modules.filter((m) => m !== "accounting"),
  });
  try {
    return await work();
  } finally {
    await setFlags(original);
  }
}
async function removeMapping(role: string) {
  const where = `tenant_id = $1 AND legal_entity_id = $2 AND role = '${role}'`;
  const [mapping] = await W.rowsOf(
    `SELECT account_id FROM account_mappings WHERE ${where}`,
    [tenantId(), W.entityId()],
  );
  expect(mapping, `premise: the fixture maps ${role}`).toBeDefined();
  await W.asTenant(
    (c) =>
      c.query(`DELETE FROM account_mappings WHERE ${where}`, [
        tenantId(),
        W.entityId(),
      ]),
    true,
  );
  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
           VALUES ($1, $2, $3, $4)`,
          [tenantId(), W.entityId(), role, mapping!.account_id],
        ),
      true,
    );
  };
}
async function account(code: string) {
  const [row] = await W.rowsOf(
    `SELECT COALESCE(sum(l.debit_idr), 0)::text AS debit,
            COALESCE(sum(l.credit_idr), 0)::text AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND a.code = $3`,
    [tenantId(), W.entityId(), code],
  );
  const debit = Number(row!.debit);
  const credit = Number(row!.credit);
  return { debit, credit, balance: credit - debit };
}
async function snapshot() {
  return {
    bank: await account("1103"),
    fee: await account("8101"),
    payable: await account("2103"),
  };
}
const journalCountOfEntity = async () =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [tenantId(), W.entityId()],
      )
    )[0]!.n,
  );
const feeKey = (posting: Row) => `payroll-payout-fee:${posting.item_set_hash}`;
const netJournal = {
  "2103": { debit: NET, credit: 0 },
  "1103": { debit: 0, credit: NET },
};

async function auditCount() {
  const [row] = await W.rowsOf(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2`,
    [tenantId(), AUDIT_ACTION],
  );
  return Number(row!.n);
}
async function auditWithNote(note: string) {
  const [row] = await W.rowsOf(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 AND event::text LIKE '%' || $3 || '%'`,
    [tenantId(), AUDIT_ACTION, note],
  );
  return Number(row!.n);
}

const markColumns = (postingId: string) =>
  W.rowsOf(
    `SELECT fee_opening_balance_at, fee_opening_balance_by::text AS by,
            fee_opening_balance_note AS note, kind, fee_posted
       FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), postingId],
  ).then((rows) => rows[0]!);

// ---- Worlds -------------------------------------------------------------------------

type World = {
  slips: Slip[];
  runId: string;
  batchId: string;
  posting: Row;
  outboxId: string;
};

/**
 * One bank batch created by `requestedBy`, approved/exported by APP, confirmed by APP2.
 * `accountingOff`: confirmed while accounting is off -> final settle_skipped with
 * the fee owed (reason accounting_was_off, lock event queued but not consumed).
 * Otherwise the lock journal is posted first and the confirm settles normally.
 */
async function world(
  requestedBy: string,
  options: { accountingOff: boolean },
): Promise<World> {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  if (!options.accountingOff) await W.postLockedJournal(runId, slips);
  const batch = await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requestedBy), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
  const batchId = batch.id;
  await W.inTx((tx) =>
    submitDisbursementBatch(tx, actorOf(requestedBy), batchId),
  );
  const hash = (await W.batchById(batchId)).content_hash as string;
  const [source] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [tenantId(), W.entityId()],
  );
  await W.inTx((tx) =>
    approveDisbursementBatch(tx, actorOf(APP), batchId, {
      contentHash: hash,
      sourceBankAccountId: source!.id as string,
    }),
  );
  await W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId));
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  const confirm = () =>
    W.confirm(batchId, W.succeedItems(batchId, items), APP2);
  if (options.accountingOff) await withAccountingOff(confirm);
  else await confirm();
  const postings = await W.postingsOf(batchId);
  expect(postings, "premise: one posting").toHaveLength(1);
  const posting = postings[0]!;
  expect(posting.kind, "premise: kind").toBe(
    options.accountingOff ? "settle_skipped" : "settle",
  );
  const { outboxId } = options.accountingOff
    ? await queueLockedViaOutbox(runId, slips)
    : { outboxId: "" };
  return { slips, runId, batchId, posting, outboxId };
}

/** Skipped posting owing a fee, created by a requester who is nobody in this file's resolvers. */
const skippedWorld = async () =>
  world((await requester()).userId, { accountingOff: true });

async function expectUntouched(w: World, label: string) {
  const row = await markColumns(w.posting.id as string);
  expect(row.fee_opening_balance_at, `${label}: not marked`).toBeNull();
  expect(row.by, label).toBeNull();
  expect(row.note, label).toBeNull();
  expect(row.kind, label).toBe(w.posting.kind);
  expect(row.fee_posted, label).toBe(false);
}

// =========================================================================

describe("legend-3xzop: mark the fee of a posting as already in the opening balance", () => {
  it("[legend-3xzop-mark-no-journal-no-path-books-the-fee] marking a skipped posting answers 200, records who/when/why, writes one audit row and no journal, delists the row; repost-fees, recovery, the sweep and the settle after the lock never book the fee, the net settles once", async () => {
    const before = await snapshot();
    const w = await skippedWorld();
    const postingId = w.posting.id as string;
    expect(
      await listedRow(postingId),
      "premise: finance sees the obligation",
    ).toMatchObject({ postingId, reason: "accounting_was_off", feeIdr: FEE });
    const journals = await journalCountOfEntity();
    const audits = await auditCount();

    const person = await resolverA();
    const res = await markHttp(person, postingId, {
      password: PASSWORD,
      note: `  ${NOTE}  `,
    });
    expect(res.status, detail(res)).toBe(200);
    const data = (res.body.data ?? res.body) as Row;
    expect(data.postingId).toBe(postingId);
    expect(Number.isNaN(Date.parse(data.resolvedAt as string))).toBe(false);

    const marked = await markColumns(postingId);
    expect(marked.fee_opening_balance_at, "marked at").not.toBeNull();
    expect(marked.by, "marked by the caller").toBe(person.userId);
    expect(marked.note, "note stored trimmed").toBe(NOTE);
    expect(marked.kind, "still skipped").toBe("settle_skipped");
    expect(marked.fee_posted, "the mark books nothing").toBe(false);
    expect(await journalCountOfEntity(), "no journal by the mark").toBe(
      journals,
    );
    expect(await W.journalByKey(feeKey(w.posting))).toBeUndefined();
    expect(await auditCount(), "exactly one audit row").toBe(audits + 1);
    expect(await auditWithNote(NOTE), "the reason is in the audit").toBe(1);
    expect(await listedRow(postingId), "delisted").toBeUndefined();

    // Accounting is on and bank_charges is mapped: every fee path stays silent.
    await W.inTx((tx) =>
      (
        glService as unknown as {
          repostSkippedFees: (
            tx: unknown,
            actor: unknown,
            batchId: string,
          ) => Promise<unknown>;
        }
      )
        .repostSkippedFees(tx, actorOf(APP), w.batchId)
        .catch(() => undefined),
    );
    await W.inTx((tx) =>
      glService.recoverPayoutGlOfBatch(
        tx,
        W.scope().tenant.tenantId,
        w.batchId,
      ),
    );
    await runPayoutGlRecoverySweep(W.scope(), NOW);
    expect(await W.journalByKey(feeKey(w.posting))).toBeUndefined();
    expect((await markColumns(postingId)).fee_posted).toBe(false);
    expect(await listedRow(postingId), "still delisted").toBeUndefined();

    // The lock arrives: the net settles once, the fee is still never booked.
    expect((await consumeLocked(w.outboxId))?.status).toBe("posted");
    await runPayoutGlRecoverySweep(W.scope(), NOW);
    await runPayoutGlRecoverySweep(W.scope(), NOW);
    const [settled] = await W.postingsOf(w.batchId);
    expect(settled!.kind, "the net settle is unchanged").toBe("settle");
    expect(await W.journalByKey(settled!.journal_key as string)).toEqual(
      netJournal,
    );
    expect(await W.countJournals(settled!.journal_key as string)).toBe(1);
    expect(await W.journalByKey(feeKey(w.posting))).toBeUndefined();
    expect(await W.countJournals(feeKey(w.posting))).toBe(0);
    const after = await snapshot();
    expect(after.fee.debit - before.fee.debit, "8101 never charged").toBe(0);
    expect(
      after.bank.credit - before.bank.credit,
      "bank credited the net only, never the fee",
    ).toBe(NET);
    expect(after.payable.balance - before.payable.balance).toBe(0);
    expect(await listedRow(postingId)).toBeUndefined();
    expect(await auditCount(), "no further audit").toBe(audits + 1);
  });

  it("[legend-3xzop-mark-concurrent] four parallel marks from two people: exactly one 200, the others 409 PAYOUT_GL_ALREADY_RESOLVED, one audit row, no journal; a later mark is 409 and keeps the first note", async () => {
    const w = await skippedWorld();
    const postingId = w.posting.id as string;
    const a = await resolverA();
    const b = await resolverB();
    const journals = await journalCountOfEntity();
    const audits = await auditCount();

    const results = await Promise.all([
      markHttp(a, postingId, { password: PASSWORD, note: "Catatan A satu" }),
      markHttp(b, postingId, { password: PASSWORD, note: "Catatan B satu" }),
      markHttp(a, postingId, { password: PASSWORD, note: "Catatan A dua" }),
      markHttp(b, postingId, { password: PASSWORD, note: "Catatan B dua" }),
    ]);
    const ok = results.filter((r) => r.status === 200);
    const conflict = results.filter((r) => r.status === 409);
    expect(ok, results.map(detail).join(" | ")).toHaveLength(1);
    expect(conflict, results.map(detail).join(" | ")).toHaveLength(3);
    for (const r of conflict)
      expect(codeOf(r)).toBe("PAYOUT_GL_ALREADY_RESOLVED");
    expect(await auditCount(), "one success audit row").toBe(audits + 1);
    expect(await journalCountOfEntity()).toBe(journals);
    const marked = await markColumns(postingId);
    expect(marked.fee_opening_balance_at).not.toBeNull();
    expect([
      "Catatan A satu",
      "Catatan B satu",
      "Catatan A dua",
      "Catatan B dua",
    ]).toContain(marked.note);

    const again = await markHttp(a, postingId);
    expect(again.status, detail(again)).toBe(409);
    expect(codeOf(again)).toBe("PAYOUT_GL_ALREADY_RESOLVED");
    expect((await markColumns(postingId)).note, "first note kept").toBe(
      marked.note,
    );
    expect(await auditCount()).toBe(audits + 1);
  });

  it("[legend-3xzop-refused-without-effect] no permission, no MFA, stale step-up, missing or wrong password, blank / missing / too long note: each is refused, nothing is marked, no audit row, no journal; a valid call then works (the refusals were not a broken setup)", async () => {
    const w = await skippedWorld();
    const postingId = w.posting.id as string;
    const journals = await journalCountOfEntity();
    const audits = await auditCount();
    const a = await resolverA();
    const still = async (label: string) => {
      await expectUntouched(w, label);
      expect(await auditCount(), `${label}: no audit`).toBe(audits);
      expect(await journalCountOfEntity(), `${label}: no journal`).toBe(
        journals,
      );
    };

    const noPermission = await markHttp(await hr(), postingId);
    expect(noPermission.status, detail(noPermission)).toBe(403);
    await still("no permission");

    const withoutMfa = await markHttp(await noMfa(), postingId);
    expect([401, 403], detail(withoutMfa)).toContain(withoutMfa.status);
    await still("no MFA");

    const staleRes = await markHttp(await stale(), postingId);
    expect(staleRes.status, detail(staleRes)).toBe(401);
    expect(codeOf(staleRes)).toBe("REAUTH_REQUIRED");
    await still("stale step-up");

    const noPassword = await markHttp(a, postingId, { note: NOTE });
    expect(noPassword.status, detail(noPassword)).toBe(401);
    expect(codeOf(noPassword)).toBe("REAUTH_REQUIRED");
    await still("no password");

    const wrong = await markHttp(a, postingId, { password: WRONG, note: NOTE });
    expect([401, 403], detail(wrong)).toContain(wrong.status);
    await still("wrong password");

    for (const [label, body] of [
      ["empty note", { password: PASSWORD, note: "" }],
      ["whitespace note", { password: PASSWORD, note: "   \n\t  " }],
      ["missing note", { password: PASSWORD }],
      ["too long note", { password: PASSWORD, note: "x".repeat(1001) }],
      ["unknown field", { password: PASSWORD, note: NOTE, amountIdr: 1 }],
    ] as const) {
      const res = await markHttp(a, postingId, body);
      expect([400, 422], `${label}: ${detail(res)}`).toContain(res.status);
      await still(label);
    }

    const ok = await markHttp(a, postingId);
    expect(ok.status, `control: ${detail(ok)}`).toBe(200);
    expect(await auditCount()).toBe(audits + 1);
  });

  it("[legend-3xzop-historical-row-fee-posted-flag-null-fee] a historical accounting_was_off row (settle_skipped, fee_posted true, fee_idr NULL as before migration 0397, sealed fee > 0, no fee journal) can be marked: 200, and repost-fees / recovery never book its fee", async () => {
    const w = await skippedWorld();
    const postingId = w.posting.id as string;
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET fee_posted = true, fee_idr = NULL
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId(), postingId],
        ),
      true,
    );
    const [historical] = await W.postingsOf(w.batchId);
    expect(historical!.fee_posted, "premise: historical flag").toBe(true);
    expect(historical!.fee_idr, "premise: fee_idr NULL").toBeNull();
    expect(historical!.kind).toBe("settle_skipped");
    expect(await W.journalByKey(feeKey(w.posting))).toBeUndefined();
    const feeBefore = (await account("8101")).debit;
    const journals = await journalCountOfEntity();
    const audits = await auditCount();

    const res = await markHttp(await resolverA(), postingId);
    expect(res.status, detail(res)).toBe(200);
    const marked = await markColumns(postingId);
    expect(marked.fee_opening_balance_at).not.toBeNull();
    expect(marked.note).toBe(NOTE);
    expect(await auditCount()).toBe(audits + 1);
    expect(await journalCountOfEntity(), "the mark books nothing").toBe(
      journals,
    );
    expect(await listedRow(postingId), "delisted").toBeUndefined();

    await W.inTx((tx) =>
      (
        glService as unknown as {
          repostSkippedFees: (
            tx: unknown,
            actor: unknown,
            batchId: string,
          ) => Promise<unknown>;
        }
      )
        .repostSkippedFees(tx, actorOf(APP), w.batchId)
        .catch(() => undefined),
    );
    await W.inTx((tx) =>
      glService.recoverPayoutGlOfBatch(
        tx,
        W.scope().tenant.tenantId,
        w.batchId,
      ),
    );
    await runPayoutGlRecoverySweep(W.scope(), NOW);
    expect(await W.journalByKey(feeKey(w.posting))).toBeUndefined();
    expect(await W.countJournals(feeKey(w.posting))).toBe(0);
    expect((await account("8101")).debit - feeBefore, "8101 untouched").toBe(0);
    expect(await journalCountOfEntity()).toBe(journals);
    expect(await listedRow(postingId), "still delisted").toBeUndefined();
  });

  it("[legend-3xzop-self-approval] the creator of the batch cannot mark its posting: 403 PAYOUT_GL_SELF_APPROVAL, nothing changes; another resolver can", async () => {
    const creator = await resolverA();
    const w = await world(creator.userId, { accountingOff: true });
    const postingId = w.posting.id as string;
    const journals = await journalCountOfEntity();
    const audits = await auditCount();

    const res = await markHttp(creator, postingId);
    expect(res.status, detail(res)).toBe(403);
    expect(codeOf(res)).toBe("PAYOUT_GL_SELF_APPROVAL");
    await expectUntouched(w, "self approval");
    expect(await auditCount()).toBe(audits);
    expect(await journalCountOfEntity()).toBe(journals);
    expect(await listedRow(postingId), "still listed").toMatchObject({
      reason: "accounting_was_off",
    });

    const other = await markHttp(await resolverB(), postingId);
    expect(other.status, `control: ${detail(other)}`).toBe(200);
    expect(await auditCount()).toBe(audits + 1);
  });

  it("[legend-3xzop-not-accounting-was-off] a posting settled normally, or held for another reason (bank_charges_missing after the lock was consumed): 409 PAYOUT_GL_NOT_ACCOUNTING_WAS_OFF, untouched, no audit, no journal", async () => {
    const a = await resolverA();
    const req = (await requester()).userId;
    const audits = await auditCount();

    const normal = await world(req, { accountingOff: false });
    let journals = await journalCountOfEntity();
    const res = await markHttp(a, normal.posting.id as string);
    expect(res.status, detail(res)).toBe(409);
    expect(codeOf(res)).toBe("PAYOUT_GL_NOT_ACCOUNTING_WAS_OFF");
    const row = await markColumns(normal.posting.id as string);
    expect(row.fee_opening_balance_at).toBeNull();
    expect(row.kind).toBe("settle");
    expect(await journalCountOfEntity()).toBe(journals);

    const held = await skippedWorld();
    const payableBefore = (await account("2103")).credit;
    const restore = await removeMapping("bank_charges");
    try {
      expect((await consumeLocked(held.outboxId))?.status).toBe("posted");
      expect(
        (await account("2103")).credit - payableBefore,
        "premise: the run now HAS a lock journal (2103 credited the net)",
      ).toBe(NET);
      expect(
        await listedRow(held.posting.id as string),
        "premise: the reason is no longer accounting_was_off",
      ).toMatchObject({ reason: "bank_charges_missing" });
      journals = await journalCountOfEntity();
      const other = await markHttp(a, held.posting.id as string);
      expect(other.status, detail(other)).toBe(409);
      expect(codeOf(other)).toBe("PAYOUT_GL_NOT_ACCOUNTING_WAS_OFF");
      const heldRow = await markColumns(held.posting.id as string);
      expect(heldRow.fee_opening_balance_at).toBeNull();
      expect(heldRow.kind).toBe("settle_skipped");
      expect(await journalCountOfEntity()).toBe(journals);
      expect(await listedRow(held.posting.id as string)).toMatchObject({
        reason: "bank_charges_missing",
      });
    } finally {
      await restore();
    }
    expect(await auditCount(), "no audit for refusals").toBe(audits);
  });

  it("[legend-3xzop-tenant-isolation] a posting of another tenant and an unknown id are 404 PAYOUT_GL_POSTING_NOT_FOUND; the other tenant's row stays untouched", async () => {
    const w = await skippedWorld();
    const otherTenant = randomUUID();
    const otherPosting = randomUUID();
    const cols = (
      await W.owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'payroll_payout_gl_postings' AND table_schema = 'public'
          ORDER BY ordinal_position`,
      )
    ).rows.map((r) => r.column_name);
    const copy = await W.owner.connect();
    try {
      await copy.query("BEGIN");
      await copy.query("SET LOCAL session_replication_role = replica");
      await copy.query(
        `INSERT INTO payroll_payout_gl_postings (${cols.map((c) => `"${c}"`).join(", ")})
         SELECT ${cols
           .map((c) =>
             c === "id"
               ? "$3::uuid"
               : c === "tenant_id"
                 ? "$2::uuid"
                 : `"${c}"`,
           )
           .join(", ")}
           FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND id = $4`,
        [tenantId(), otherTenant, otherPosting, w.posting.id],
      );
      await copy.query("COMMIT");
    } catch (error) {
      await copy.query("ROLLBACK");
      throw error;
    } finally {
      copy.release();
    }
    try {
      const readOther = async () =>
        (
          await W.owner.query(
            `SELECT * FROM payroll_payout_gl_postings WHERE id = $1`,
            [otherPosting],
          )
        ).rows[0];
      const beforeRow = await readOther();
      expect(beforeRow, "premise: the copy exists").toBeDefined();
      const audits = await auditCount();

      const foreign = await markHttp(await resolverA(), otherPosting);
      expect(foreign.status, detail(foreign)).toBe(404);
      expect(codeOf(foreign)).toBe("PAYOUT_GL_POSTING_NOT_FOUND");
      expect(await readOther(), "other tenant row untouched").toEqual(
        beforeRow,
      );

      const unknown = await markHttp(await resolverA(), randomUUID());
      expect(unknown.status, detail(unknown)).toBe(404);
      expect(codeOf(unknown)).toBe("PAYOUT_GL_POSTING_NOT_FOUND");
      expect(await auditCount()).toBe(audits);
      await expectUntouched(w, "own posting");
    } finally {
      const cleanup = await W.owner.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query("SET LOCAL session_replication_role = replica");
        await cleanup.query(
          `DELETE FROM payroll_payout_gl_postings WHERE id = $1`,
          [otherPosting],
        );
        await cleanup.query("COMMIT");
      } finally {
        cleanup.release();
      }
    }
  });
});
