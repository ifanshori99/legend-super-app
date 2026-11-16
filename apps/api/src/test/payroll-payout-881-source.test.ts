// Brief 881, item P1-b (legend-zlcsd): the payout source account of a
// skipped/pending settlement is never guessed from today's configuration.
//
// Rules proven here (money: the right account is credited, exactly once, and
// nothing is credited from an account nobody froze):
// - The identity of the petty_cash account is stored at handover even when the
//   account is temporarily inactive. The resolver (consumer or the periodic
//   recovery sweep) never swaps it for the mapping of the moment: a frozen but
//   inactive account holds the settlement (reason `source_account_inactive`)
//   until it is active again, then that very account is credited once.
// - No stored source (no mapping at handover, or a legacy bank batch without a
//   frozen bank account): the settlement is held (reason
//   `source_account_unknown`), never resolved from the mapping, and the consumer
//   never throws (the outbox event is delivered).
// - Finance records the real source over HTTP:
//   POST /api/hris/payroll/disbursement-batches/:id/postings/:postingId/source
//   { glAccountId }  (payroll.disburse.approve, trusted origin). The posting is
//   then resolved once (that account is credited), a second call adds nothing.
//
// Names this test EXPECTS (from brief 881, none exist yet):
// - `runPayoutGlRecoverySweep(context, now)` in worker/payout-gl-recovery.job.ts
// - the route above, and a `reason` field on rows of
//   GET /api/hris/payroll/payout-fee-reposts (postingId, batchId, feeIdr,
//   netIdr, kind, reason).
//
// Assumptions (spec silent, stated so they can be contested):
// - Success of the source route is HTTP 200. A second call is either a safe
//   no-op (200) or 409 (PAYOUT_SOURCE_ALREADY_RECORDED); both are accepted, what
//   is asserted is that nothing is journaled twice and the source stays.
// - Every other refusal (other entity, unknown account, inactive account, bank
//   GL not owned by an active bank account, posting of another batch, frozen
//   bank batch) is asserted as "a 4xx and nothing changed"; 409 is asserted
//   only where the brief names it (bank batch with a frozen source).
// - Brief 883 (legend-6ae7e, legend-hblpg): the route has the same step-up as
//   confirm-cash. The body carries `password` (the current account password,
//   optional in the schema): a session whose second factor only comes from the
//   MFA enrollment (never passed a challenge at sign-in) must send it, else
//   401 REAUTH_REQUIRED; a wrong password is refused (401 or 403); a session
//   with a fresh real challenge (factor older than the session, as in
//   payroll-payout-evidence.test.ts) may omit it. The default `finance` client
//   is enrollment-only, so every call of it sends the password. Refusals change
//   nothing: no source, no journal, no credit, no audit row.
// - hblpg: the person who requested the batch (batch.requested_by) cannot record
//   its payout source: 403 PAYOUT_SOURCE_SELF_RECORD, nothing changes; another
//   approver records it once. The requester is modelled by setting
//   `requested_by` of the batch to the user id of an HTTP client (triggers off,
//   like the other fixtures that rewrite pre-existing rows).
// - "Cash handed over with accounting off" = tenant feature flag without
//   "accounting" (as in payroll-payout-877-gl-fee-skipped.test.ts). The
//   `payroll.locked` outbox row is queued AFTER the handover and consumed with
//   the real consumer (consumeOutbox + deliverPayrollGlEvent).
// - A "legacy bank batch" is modelled by clearing the batch's frozen
//   `source_bank_account_id` and the posting's `source_gl_account_id` with
//   triggers off (like the other payout tests do for pre-freeze rows).
// - The sweep is run with the tenant scope used by the consumer.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { provisionStandardChart } from "../services/accounting-provisioning.service.ts";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  APP2,
  BUDI,
  CASHIER,
  bank,
  cash,
  installPayoutWorld,
  runTotals,
  type Row,
  type Slip,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("881src");
const tenantId = () => W.tenantId;

const BASE = "/api/hris/payroll/disbursement-batches";
const LIST = "/api/hris/payroll/payout-fee-reposts";
const FEE = 5_000;
const NET_BANK = 2_000_000;
const NET_CASH = 1_000_000;
const NOW = new Date("2026-11-30T03:00:00Z");

// ---- Finance people over HTTP ------------------------------------------------

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

type Client = Awaited<ReturnType<typeof W.signedInClient>>["client"];
let finance: Client;
let viewer: Client;
const PASSWORD = "Test-password-123!";
/** Signed in, granted the disburse permission, TOTP enrolled and verified in this session (enrollment-only). */
async function enrolledFinance(label: string) {
  const { client, userId } = await W.signedInClient(`Src881 ${label}`);
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
  return { client, userId, factorId, secretBase32 };
}
async function financeClient(label: string) {
  return (await enrolledFinance(label)).client;
}
/**
 * Finance with a real challenge: the factor existed before the session
 * (backdated), so verifying a code stamps `mfa_challenge_verified_at` and the
 * password is not asked (same set-up as payroll-payout-evidence.test.ts).
 */
async function challengedFinance(label: string) {
  const person = await enrolledFinance(label);
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
  const stamp = await mfaOwner.query(
    `SELECT mfa_challenge_verified_at FROM "session" WHERE revoked_at IS NULL AND user_id = $1 AND id NOT LIKE 'payout-fixture-session-%'`,
    [person.userId],
  );
  expect(
    stamp.rows[0]?.mfa_challenge_verified_at,
    "premise: a real challenge stamped the session",
  ).not.toBeNull();
  return person;
}
beforeAll(async () => {
  finance = await financeClient("Finance");
  const v = await W.signedInClient("Src881 Viewer");
  await W.grantRole(v.userId, ["payroll.view"]);
  viewer = v.client;
});

// ---- Outbox / consumer / sweep ------------------------------------------------

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

/**
 * Queues the `payroll.locked` event in the real outbox. After a settlement the
 * run's aggregate already holds its own `payroll.paid` event (sequence 1), so
 * then the lock event goes on a separate aggregate (the GL consumer reads the
 * run from the payload).
 */
async function queueLocked(runId: string, slips: Slip[]) {
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
  return outboxId;
}

/** The real consumer path: consumeOutbox with the payroll GL consumer. */
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

/** The periodic recovery job, called the way the worker calls it. */
async function sweep() {
  const mod = await import("../worker/payout-gl-recovery.job.ts");
  return (
    mod.runPayoutGlRecoverySweep as (
      context: unknown,
      now: Date,
    ) => Promise<unknown>
  )(W.scope(), NOW);
}

// ---- Tenant flags / GL accounts / mappings ------------------------------------

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

const journalCount = async () =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [tenantId(), W.entityId()],
      )
    )[0]!.n,
  );

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
    c1101: await account("1101"),
    cash: await account("1102"),
    bank: await account("1103"),
    fee: await account("8101"),
    payable: await account("2103"),
  };
}
async function accountId(code: string, entityId = W.entityId()) {
  const [row] = await W.rowsOf(
    `SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
    [tenantId(), entityId, code],
  );
  return row!.id as string;
}

const feeKey = (posting: Row) => `payroll-payout-fee:${posting.item_set_hash}`;

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
  return once(() =>
    W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
           VALUES ($1, $2, $3, $4)`,
          [tenantId(), W.entityId(), role, mapping!.account_id],
        ),
      true,
    ),
  );
}
/** The role now points at the GL account `code`. Returns the restore. */
async function remapMapping(role: string, code: string) {
  const where = `tenant_id = $1 AND legal_entity_id = $2 AND role = '${role}'`;
  const [mapping] = await W.rowsOf(
    `SELECT account_id FROM account_mappings WHERE ${where}`,
    [tenantId(), W.entityId()],
  );
  expect(mapping, `premise: the fixture maps ${role}`).toBeDefined();
  const set = (id: string) =>
    W.asTenant(
      (c) =>
        c.query(`UPDATE account_mappings SET account_id = $3 WHERE ${where}`, [
          tenantId(),
          W.entityId(),
          id,
        ]),
      true,
    );
  await set(await accountId(code));
  return once(() => set(mapping!.account_id as string));
}
async function deactivateGlAccount(code: string) {
  const setActive = (active: boolean) =>
    W.asTenant(
      (c) =>
        c.query(
          `UPDATE chart_of_accounts SET is_active = $3
            WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $4`,
          [tenantId(), W.entityId(), active, code],
        ),
      true,
    );
  await setActive(false);
  return once(() => setActive(true));
}
function once(restore: () => Promise<unknown>) {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await restore();
  };
}
/** Triggers off: a posting row from before the source was frozen. */
const clearPostingSource = (postingId: string) =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_payout_gl_postings SET source_gl_account_id = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), postingId],
      ),
    true,
  );
const clearBatchSource = (batchId: string) =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_disbursement_batches SET source_bank_account_id = NULL WHERE id = $1`,
        [batchId],
      ),
    true,
  );

// ---- Scenarios -----------------------------------------------------------------

/** Cash handed over with accounting off and no locked event waiting: a final settle_skipped. */
async function cashSkipped(net = NET_CASH) {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  const batchId = await W.approvedBatch(runId, "cash");
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  await withAccountingOff(() => W.handover(batchId, itemIds, APP2));
  const postings = await W.postingsOf(batchId);
  expect(postings, "premise: one posting").toHaveLength(1);
  expect(postings[0]!.kind, "premise: final settle_skipped").toBe(
    "settle_skipped",
  );
  return { runId, batchId, slips, net, posting: postings[0]! };
}

/** Bank transfers confirmed with accounting off (settle_skipped, fee > 0). */
async function bankSkipped() {
  const slips = [bank(BUDI, NET_BANK)];
  const runId = await W.seedRun(slips);
  const batchId = await W.exportedBatch(runId);
  const items = await W.itemsOf(batchId);
  await withAccountingOff(() =>
    W.confirm(batchId, W.succeedItems(batchId, items)),
  );
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.kind, "premise: final settle_skipped").toBe("settle_skipped");
  return { runId, batchId, slips, posting: posting! };
}

async function listedRow(postingId: string) {
  const list = await finance.get(LIST);
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return (list.body.data as Row[]).find((row) => row.postingId === postingId);
}

/** `password` defaults to the account password (step-up like confirm-cash); `null` omits it. */
const postSource = (
  client: Client,
  batchId: string,
  postingId: string,
  glAccountId: unknown,
  headers: Record<string, string> = originHeader,
  password: string | null = PASSWORD,
) =>
  client
    .post(`${BASE}/${batchId}/postings/${postingId}/source`)
    .set(headers)
    .send(password === null ? { glAccountId } : { glAccountId, password });

const errorCodeOf = (body: { error?: { code?: string } }) => body.error?.code;

const auditCountOf = async (batchId: string) =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1 AND event::text LIKE '%posting_source_recorded%'
            AND event::text LIKE '%' || $2 || '%'`,
        [tenantId(), batchId],
      )
    )[0]!.n,
  );

const refused = (status: number) => {
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);
};

async function expectHeld(batchId: string, journalKey: string) {
  const postings = await W.postingsOf(batchId);
  expect(postings).toHaveLength(1);
  expect(postings[0]!.kind).not.toBe("settle");
  expect(await W.journalByKey(journalKey), "no settle journal").toBe(undefined);
  return postings[0]!;
}

// =========================================================================
// Frozen cash source: never swapped for today's mapping
// =========================================================================

describe("zlcsd: the frozen cash source is kept, never replaced by the current mapping", () => {
  it("[zlcsd-cash-frozen-inactive-then-active] petty_cash maps to inactive A at handover (accounting off), then moves to active B: the lock is consumed and B is NOT credited (stays settle_skipped, reason source_account_inactive); once A is active the sweep credits A exactly once, repeats and parallel sweeps add nothing", async () => {
    const before = await snapshot();
    const activateA = await deactivateGlAccount("1102");
    let restoreMapping = async () => {};
    try {
      const { runId, batchId, slips, net, posting } = await cashSkipped();
      expect(
        posting.source_gl_account_id,
        "the identity of A is stored although A is inactive",
      ).toBe(await accountId("1102"));

      restoreMapping = await remapMapping("petty_cash", "1101"); // B
      const outboxId = await queueLocked(runId, slips);
      const outcome = await consumeLocked(outboxId);
      expect(outcome?.status, "the consumer does not throw").toBe("posted");

      const held = await expectHeld(batchId, posting.journal_key as string);
      expect(held.kind).toBe("settle_skipped");
      expect(held.source_gl_account_id, "source stays A").toBe(
        await accountId("1102"),
      );
      const mid = await snapshot();
      expect(mid.c1101.credit - before.c1101.credit, "B not credited").toBe(0);
      expect(mid.cash.credit - before.cash.credit, "A not credited").toBe(0);
      expect(
        mid.payable.credit - before.payable.credit,
        "the lock journal is posted",
      ).toBe(net);
      expect(await listedRow(held.id as string)).toMatchObject({
        batchId,
        netIdr: net,
        kind: "settle_skipped",
        reason: "source_account_inactive",
      });

      // A still inactive: the sweep must neither throw nor guess.
      await sweep();
      expect((await W.postingsOf(batchId))[0]!.kind).toBe("settle_skipped");
      expect(
        (await account("1101")).credit - before.c1101.credit,
        "B still not credited",
      ).toBe(0);

      await activateA();
      await sweep();
      const [settled] = await W.postingsOf(batchId);
      expect(settled!.kind, "resolved to settle").toBe("settle");
      expect(await W.journalByKey(settled!.journal_key as string)).toEqual({
        "2103": { debit: net, credit: 0 },
        "1102": { debit: 0, credit: net },
      });
      const after = await snapshot();
      expect(after.cash.credit - before.cash.credit, "A credited once").toBe(
        net,
      );
      expect(after.c1101.credit - before.c1101.credit, "B untouched").toBe(0);
      expect(after.payable.balance - before.payable.balance).toBe(0);
      expect(await listedRow(settled!.id as string)).toBeUndefined();

      const journals = await journalCount();
      await sweep();
      await Promise.all([sweep(), sweep()]);
      await consumeLocked(outboxId);
      expect(await journalCount(), "replays add nothing").toBe(journals);
      expect(await W.countJournals(settled!.journal_key as string)).toBe(1);
      expect(await W.postingsOf(batchId)).toHaveLength(1);
      const replayed = await snapshot();
      expect(replayed.cash.credit - before.cash.credit).toBe(net);
      expect(replayed.c1101.credit - before.c1101.credit).toBe(0);
    } finally {
      await activateA();
      await restoreMapping();
    }
  });

  it("[zlcsd-cash-control-mapping-changes-after-handover] control: A is active at handover (accounting off), the mapping then changes to B: after the lock is consumed A is credited exactly once and B is untouched", async () => {
    const before = await snapshot();
    const { runId, batchId, slips, net, posting } = await cashSkipped();
    expect(posting.source_gl_account_id).toBe(await accountId("1102"));
    const restoreMapping = await remapMapping("petty_cash", "1101");
    try {
      const outboxId = await queueLocked(runId, slips);
      expect((await consumeLocked(outboxId))?.status).toBe("posted");
      await sweep();
      const [settled] = await W.postingsOf(batchId);
      expect(settled!.kind).toBe("settle");
      expect(await W.journalByKey(settled!.journal_key as string)).toEqual({
        "2103": { debit: net, credit: 0 },
        "1102": { debit: 0, credit: net },
      });
      const after = await snapshot();
      expect(after.cash.credit - before.cash.credit).toBe(net);
      expect(after.c1101.credit - before.c1101.credit).toBe(0);
      expect(after.payable.balance - before.payable.balance).toBe(0);
      expect(await W.countJournals(settled!.journal_key as string)).toBe(1);
    } finally {
      await restoreMapping();
    }
  });
});

// =========================================================================
// No stored source: held, never resolved from the mapping
// =========================================================================

describe("zlcsd: no stored source means the settlement is held for finance", () => {
  it("[zlcsd-cash-no-mapping-at-handover-held] no petty_cash mapping at handover (accounting off, source null); the mapping is back and moved to B before the lock is consumed: the consumer does not throw, nothing is credited to B or A, the posting stays settle_skipped with reason source_account_unknown, sweeps do not resolve it", async () => {
    const before = await snapshot();
    const restoreMissing = await removeMapping("petty_cash");
    let restoreMapping = async () => {};
    try {
      const { runId, batchId, slips, net, posting } = await cashSkipped();
      expect(posting.source_gl_account_id, "premise: nothing to freeze").toBe(
        null,
      );
      await restoreMissing();
      restoreMapping = await remapMapping("petty_cash", "1101"); // B

      const outboxId = await queueLocked(runId, slips);
      expect((await consumeLocked(outboxId))?.status).toBe("posted");
      await sweep();
      await Promise.all([sweep(), sweep()]);

      const held = await expectHeld(batchId, posting.journal_key as string);
      expect(held.kind).toBe("settle_skipped");
      const after = await snapshot();
      expect(after.c1101.credit - before.c1101.credit, "B untouched").toBe(0);
      expect(after.cash.credit - before.cash.credit, "A untouched").toBe(0);
      expect(
        after.payable.credit - before.payable.credit,
        "the lock journal is posted",
      ).toBe(net);
      expect(await listedRow(held.id as string)).toMatchObject({
        batchId,
        netIdr: net,
        reason: "source_account_unknown",
      });
    } finally {
      await restoreMissing();
      await restoreMapping();
    }
  });

  it("[zlcsd-cash-pending-null-source-held] a pending cash posting whose source is NULL (pre-freeze row): consuming the lock does not throw (the event is delivered), the posting stays settle_pending with reason source_account_unknown and cash is not credited; finance records the source and it resolves once", async () => {
    const before = await snapshot();
    const slips = [cash(CASHIER, NET_CASH)];
    const runId = await W.seedRun(slips);
    const outboxId = await queueLocked(runId, slips);
    const batchId = await W.approvedBatch(runId, "cash");
    const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
    await W.handover(batchId, itemIds, APP2);
    const [pending] = await W.postingsOf(batchId);
    expect(pending!.kind, "premise: stored as pending").toBe("settle_pending");
    await clearPostingSource(pending!.id as string);

    expect(
      (await consumeLocked(outboxId))?.status,
      "a held pending settlement must not stall the outbox",
    ).toBe("posted");
    await sweep();
    const [held] = await W.postingsOf(batchId);
    expect(held!.kind).toBe("settle_pending");
    expect(await W.journalByKey(held!.journal_key as string)).toBe(undefined);
    expect(
      (await account("1102")).credit - before.cash.credit,
      "no cash account is guessed",
    ).toBe(0);
    expect(await listedRow(held!.id as string)).toMatchObject({
      batchId,
      kind: "settle_pending",
      reason: "source_account_unknown",
    });

    const res = await postSource(
      finance,
      batchId,
      held!.id as string,
      await accountId("1101"),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [settled] = await W.postingsOf(batchId);
    expect(settled!.kind).toBe("settle");
    expect(await W.journalByKey(settled!.journal_key as string)).toEqual({
      "2103": { debit: NET_CASH, credit: 0 },
      "1101": { debit: 0, credit: NET_CASH },
    });
    const after = await snapshot();
    expect(after.c1101.credit - before.c1101.credit).toBe(NET_CASH);
    expect(after.cash.credit - before.cash.credit).toBe(0);
    expect(after.payable.balance - before.payable.balance).toBe(0);
    expect(await W.countJournals(settled!.journal_key as string)).toBe(1);
  });
});

// =========================================================================
// Finance records the source over HTTP
// =========================================================================

/** A held cash posting: source NULL, lock journal posted, petty_cash mapped to A (1102). */
async function heldCashWithoutSource() {
  const restoreMissing = await removeMapping("petty_cash");
  let skipped: Awaited<ReturnType<typeof cashSkipped>>;
  try {
    skipped = await cashSkipped();
  } finally {
    await restoreMissing();
  }
  const outboxId = await queueLocked(skipped.runId, skipped.slips);
  expect((await consumeLocked(outboxId))?.status).toBe("posted");
  const held = await expectHeld(
    skipped.batchId,
    skipped.posting.journal_key as string,
  );
  expect(held.source_gl_account_id).toBe(null);
  return { ...skipped, held, outboxId };
}

async function otherEntityAccount() {
  const entityId = randomUUID();
  await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
        [entityId, tenantId(), `PT Src881 Other ${entityId.slice(0, 6)}`],
      ),
    true,
  );
  await withTenant(db, W.scope(), (tx) =>
    provisionStandardChart(tx, W.scope(), entityId, null),
  );
  const id = await accountId("1101", entityId);
  const cleanup = () =>
    W.asTenant(async (c) => {
      const tables = (
        await c.query(
          `SELECT a.table_name FROM information_schema.columns a
             JOIN information_schema.columns b
               ON b.table_schema = a.table_schema AND b.table_name = a.table_name AND b.column_name = 'tenant_id'
            WHERE a.table_schema = 'public' AND a.column_name = 'legal_entity_id'
              AND a.table_name <> 'legal_entities'`,
        )
      ).rows as { table_name: string }[];
      for (const { table_name } of tables)
        await c.query(
          `DELETE FROM "${table_name}" WHERE tenant_id = $1 AND legal_entity_id = $2`,
          [tenantId(), entityId],
        );
      await c.query("DELETE FROM legal_entities WHERE id = $1", [entityId]);
    }, true);
  return { id, cleanup };
}

describe("zlcsd: finance records the real source (POST .../postings/:postingId/source)", () => {
  it("[zlcsd-source-endpoint-refusals] without payroll.disburse.approve 403, not signed in 401, untrusted origin 403, a bad body, an account of another entity or tenant, an inactive account and a posting of another batch are all refused: nothing is recorded, journaled or credited", async () => {
    const before = await snapshot();
    const { batchId, held } = await heldCashWithoutSource();
    const postingId = held.id as string;
    const valid = await accountId("1101");
    const other = await otherEntityAccount();
    const journals = await journalCount();
    const reactivate = await deactivateGlAccount("1101");
    try {
      // Inactive account of the right entity.
      refused((await postSource(finance, batchId, postingId, valid)).status);
    } finally {
      await reactivate();
    }
    try {
      expect(
        (await postSource(viewer, batchId, postingId, valid)).status,
        "no payroll.disburse.approve",
      ).toBe(403);
      expect(
        (await postSource(agent(W.app), batchId, postingId, valid)).status,
        "not signed in",
      ).toBe(401);
      expect(
        (
          await postSource(finance, batchId, postingId, valid, {
            Origin: "https://evil.example",
          })
        ).status,
        "untrusted origin",
      ).toBe(403);
      refused((await postSource(finance, batchId, postingId, "nope")).status);
      refused(
        (await postSource(finance, batchId, postingId, undefined)).status,
      );
      refused((await postSource(finance, batchId, postingId, other.id)).status);
      // A postable asset account that is not cash or bank (Piutang Usaha).
      refused(
        (await postSource(finance, batchId, postingId, await accountId("1201")))
          .status,
      );
      // The disburse permission without any second factor, even with the
      // password (as confirm-cash).
      const noMfa = await W.signedInClient("Src881 NoMfa");
      await W.grantRole(noMfa.userId, [
        "payroll.view",
        "payroll.disburse.approve",
      ]);
      const stepUpRefused = await postSource(
        noMfa.client,
        batchId,
        postingId,
        valid,
      );
      refused(stepUpRefused.status);
      expect(await auditCountOf(batchId), "no audit on refusals").toBe(0);
      refused(
        (await postSource(finance, batchId, postingId, randomUUID())).status,
      );
      refused((await postSource(finance, batchId, randomUUID(), valid)).status);
      refused(
        (await postSource(finance, randomUUID(), postingId, valid)).status,
      );

      const [unchanged] = await W.postingsOf(batchId);
      expect(unchanged!.kind).toBe("settle_skipped");
      expect(unchanged!.source_gl_account_id).toBe(null);
      expect(await journalCount(), "nothing journaled").toBe(journals);
      const after = await snapshot();
      expect(after.c1101.credit - before.c1101.credit).toBe(0);
      expect(after.cash.credit - before.cash.credit).toBe(0);
    } finally {
      await other.cleanup();
    }
  });

  it("[zlcsd-source-endpoint-cash-records-and-resolves-once] finance records account X (not the petty_cash mapping) for a held cash posting: the settlement resolves right away and credits X exactly net once, the second call adds nothing and keeps the source", async () => {
    const before = await snapshot();
    const { batchId, net, held } = await heldCashWithoutSource();
    const postingId = held.id as string;
    const x = await accountId("1101");

    const res = await postSource(finance, batchId, postingId, x);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await auditCountOf(batchId), "one audit row, no amount").toBe(1);

    const [settled] = await W.postingsOf(batchId);
    expect(settled!.kind).toBe("settle");
    expect(settled!.source_gl_account_id).toBe(x);
    expect(await W.journalByKey(settled!.journal_key as string)).toEqual({
      "2103": { debit: net, credit: 0 },
      "1101": { debit: 0, credit: net },
    });
    for (const item of await W.itemsOf(batchId))
      expect(item.gl_posting_id).toBe(settled!.id);
    const after = await snapshot();
    expect(after.c1101.credit - before.c1101.credit).toBe(net);
    expect(after.cash.credit - before.cash.credit, "mapping untouched").toBe(0);
    expect(after.payable.balance - before.payable.balance).toBe(0);
    expect(await listedRow(postingId)).toBeUndefined();

    const journals = await journalCount();
    const again = await postSource(finance, batchId, postingId, x);
    expect([200, 409], JSON.stringify(again.body)).toContain(again.status);
    if (again.status === 409)
      // The posting is already a `settle` (resolved by the first call), so it is
      // no longer recoverable; both codes mean "nothing more to record".
      expect([
        "PAYOUT_SOURCE_ALREADY_RECORDED",
        "PAYOUT_POSTING_NOT_RECOVERABLE",
      ]).toContain(again.body.error?.code ?? again.body.code);
    const other = await postSource(
      finance,
      batchId,
      postingId,
      await accountId("1102"),
    );
    refused(other.status);
    await sweep();
    await Promise.all([
      postSource(finance, batchId, postingId, x),
      postSource(finance, batchId, postingId, x),
    ]);
    expect(await journalCount(), "no second credit").toBe(journals);
    const replayed = await snapshot();
    expect(replayed.c1101.credit - before.c1101.credit).toBe(net);
    expect(replayed.cash.credit - before.cash.credit).toBe(0);
    expect((await W.postingsOf(batchId))[0]!.source_gl_account_id).toBe(x);
  });

  it("[zlcsd-bank-legacy-null-source-held-then-recorded] legacy bank batch (no frozen sourceBankAccountId, posting source NULL) confirmed with accounting off: the lock is consumed without throwing, the bank is not credited, the posting stays settle_skipped (reason source_account_unknown); finance records the bank's GL account: bank credited net + fee once, fee journal once, 2103 net zero, a second call adds nothing", async () => {
    const before = await snapshot();
    const { runId, batchId, slips, posting } = await bankSkipped();
    await clearBatchSource(batchId);
    await clearPostingSource(posting.id as string);

    const outboxId = await queueLocked(runId, slips);
    expect((await consumeLocked(outboxId))?.status).toBe("posted");
    await sweep();
    const held = await expectHeld(batchId, posting.journal_key as string);
    expect(held.kind).toBe("settle_skipped");
    const mid = await snapshot();
    expect(mid.bank.credit - before.bank.credit, "bank not credited").toBe(0);
    expect(mid.fee.debit - before.fee.debit).toBe(0);
    expect(await listedRow(held.id as string)).toMatchObject({
      batchId,
      netIdr: NET_BANK,
      feeIdr: FEE,
      reason: "source_account_unknown",
    });

    // A GL account that belongs to no active bank account is refused.
    refused(
      (
        await postSource(
          finance,
          batchId,
          held.id as string,
          await accountId("1101"),
        )
      ).status,
    );
    expect((await W.postingsOf(batchId))[0]!.kind).toBe("settle_skipped");

    const bankGl = await accountId("1103");
    const res = await postSource(finance, batchId, held.id as string, bankGl);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [settled] = await W.postingsOf(batchId);
    expect(settled!.kind).toBe("settle");
    expect(settled!.source_gl_account_id).toBe(bankGl);
    expect(settled!.fee_posted).toBe(true);
    expect(await W.journalByKey(settled!.journal_key as string)).toEqual({
      "2103": { debit: NET_BANK, credit: 0 },
      "1103": { debit: 0, credit: NET_BANK },
    });
    expect(await W.journalByKey(feeKey(settled!))).toEqual({
      "8101": { debit: FEE, credit: 0 },
      "1103": { debit: 0, credit: FEE },
    });
    const after = await snapshot();
    expect(after.bank.credit - before.bank.credit).toBe(NET_BANK + FEE);
    expect(after.fee.debit - before.fee.debit).toBe(FEE);
    expect(after.payable.balance - before.payable.balance).toBe(0);

    const journals = await journalCount();
    const again = await postSource(finance, batchId, held.id as string, bankGl);
    expect([200, 409]).toContain(again.status);
    await sweep();
    await Promise.all([sweep(), sweep()]);
    expect(await journalCount(), "no second credit").toBe(journals);
    expect(await W.countJournals(settled!.journal_key as string)).toBe(1);
    expect(await W.countJournals(feeKey(settled!))).toBe(1);
    const replayed = await snapshot();
    expect(replayed.bank.credit - before.bank.credit).toBe(NET_BANK + FEE);
  });

  it("[zlcsd-bank-frozen-source-refuses-record] a bank batch whose source bank account is already frozen refuses a recorded source with 409: its source is not guessable by finance, nothing changes", async () => {
    const { batchId, posting } = await bankSkipped();
    expect(
      (await W.batchById(batchId)).source_bank_account_id,
      "premise: the batch has a frozen source",
    ).not.toBe(null);
    await clearPostingSource(posting.id as string);
    const journals = await journalCount();

    const res = await postSource(
      finance,
      batchId,
      posting.id as string,
      await accountId("1103"),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const [unchanged] = await W.postingsOf(batchId);
    expect(unchanged!.kind).toBe("settle_skipped");
    expect(unchanged!.source_gl_account_id).toBe(null);
    expect(await journalCount()).toBe(journals);
  });
});

// =========================================================================
// Step-up and requester separation (brief 883: legend-6ae7e, legend-hblpg)
// =========================================================================

async function expectNothingRecorded(
  batchId: string,
  before: Awaited<ReturnType<typeof snapshot>>,
  journals: number,
) {
  const [unchanged] = await W.postingsOf(batchId);
  expect(unchanged!.kind, "still held").toBe("settle_skipped");
  expect(unchanged!.source_gl_account_id, "no source recorded").toBe(null);
  expect(await journalCount(), "nothing journaled").toBe(journals);
  expect(await auditCountOf(batchId), "no audit row").toBe(0);
  const after = await snapshot();
  expect(after.c1101.credit - before.c1101.credit, "1101 not credited").toBe(0);
  expect(after.cash.credit - before.cash.credit, "1102 not credited").toBe(0);
}

describe("6ae7e: recording a payout source needs the same step-up as confirm-cash", () => {
  it("[6ae7e-source-enrollment-only-needs-password] a session whose second factor only comes from the MFA enrollment is refused without the password (401 REAUTH_REQUIRED) and with a wrong one: no source, no journal, no credit, no audit; with the right password the source is recorded and credited exactly once", async () => {
    const before = await snapshot();
    const { batchId, net, held } = await heldCashWithoutSource();
    const postingId = held.id as string;
    const x = await accountId("1101");
    const journals = await journalCount();
    const { client, userId } = await enrolledFinance("EnrollmentOnly");
    const stamp = await mfaOwner.query(
      `SELECT mfa_verified_at, mfa_challenge_verified_at FROM "session" WHERE revoked_at IS NULL AND user_id = $1 AND id NOT LIKE 'payout-fixture-session-%'`,
      [userId],
    );
    expect(
      stamp.rows[0]?.mfa_verified_at,
      "premise: the enrollment stamped a fresh second factor",
    ).not.toBeNull();
    expect(
      stamp.rows[0]?.mfa_challenge_verified_at,
      "premise: no challenge was ever passed",
    ).toBeNull();

    const without = await postSource(
      client,
      batchId,
      postingId,
      x,
      originHeader,
      null,
    );
    expect(without.status, JSON.stringify(without.body)).toBe(401);
    expect(errorCodeOf(without.body)).toBe("REAUTH_REQUIRED");
    await expectNothingRecorded(batchId, before, journals);

    const wrong = await postSource(
      client,
      batchId,
      postingId,
      x,
      originHeader,
      "Salah-password-999!",
    );
    expect([401, 403], JSON.stringify(wrong.body)).toContain(wrong.status);
    await expectNothingRecorded(batchId, before, journals);

    const ok = await postSource(client, batchId, postingId, x);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await auditCountOf(batchId), "one audit row").toBe(1);
    const [settled] = await W.postingsOf(batchId);
    expect(settled!.kind).toBe("settle");
    expect(settled!.source_gl_account_id).toBe(x);
    expect(await W.journalByKey(settled!.journal_key as string)).toEqual({
      "2103": { debit: net, credit: 0 },
      "1101": { debit: 0, credit: net },
    });
    expect(await W.countJournals(settled!.journal_key as string)).toBe(1);
    const after = await snapshot();
    expect(after.c1101.credit - before.c1101.credit).toBe(net);
    expect(after.cash.credit - before.cash.credit).toBe(0);
  });

  it("[6ae7e-source-challenged-session-skips-password] a session that passed a real second-factor challenge (factor older than the session) records the source without the password, exactly once", async () => {
    const before = await snapshot();
    const { batchId, net, held } = await heldCashWithoutSource();
    const postingId = held.id as string;
    const x = await accountId("1101");
    const { client } = await challengedFinance("Challenged");

    const res = await postSource(
      client,
      batchId,
      postingId,
      x,
      originHeader,
      null,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await auditCountOf(batchId)).toBe(1);
    const [settled] = await W.postingsOf(batchId);
    expect(settled!.kind).toBe("settle");
    expect(settled!.source_gl_account_id).toBe(x);
    expect(await W.countJournals(settled!.journal_key as string)).toBe(1);

    const journals = await journalCount();
    const again = await postSource(
      client,
      batchId,
      postingId,
      x,
      originHeader,
      null,
    );
    expect([200, 409]).toContain(again.status);
    expect(await journalCount(), "no second credit").toBe(journals);
    const after = await snapshot();
    expect(after.c1101.credit - before.c1101.credit).toBe(net);
    expect(await auditCountOf(batchId), "still one audit row").toBe(1);
  });

  it("[6ae7e-source-stale-challenge-needs-password] a challenge stamp older than 15 minutes no longer skips the password: refused 401 REAUTH_REQUIRED and nothing changes; with the password it goes through", async () => {
    const before = await snapshot();
    const { batchId, held } = await heldCashWithoutSource();
    const postingId = held.id as string;
    const x = await accountId("1101");
    const journals = await journalCount();
    const { client, userId } = await challengedFinance("StaleChallenge");
    const moved = await mfaOwner.query(
      `UPDATE "session" SET mfa_challenge_verified_at = now() - interval '16 minutes'
        WHERE revoked_at IS NULL AND user_id = $1 AND mfa_challenge_verified_at IS NOT NULL`,
      [userId],
    );
    expect(moved.rowCount, "premise: the challenge stamped the session").toBe(
      1,
    );

    const stale = await postSource(
      client,
      batchId,
      postingId,
      x,
      originHeader,
      null,
    );
    expect(stale.status, JSON.stringify(stale.body)).toBe(401);
    expect(errorCodeOf(stale.body)).toBe("REAUTH_REQUIRED");
    await expectNothingRecorded(batchId, before, journals);

    const ok = await postSource(client, batchId, postingId, x);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await W.postingsOf(batchId))[0]!.kind).toBe("settle");
  });
});

describe("hblpg: the batch requester cannot record the payout source", () => {
  it("[hblpg-source-requester-refused-other-approver-ok] the person who requested the batch gets 403 PAYOUT_SOURCE_SELF_RECORD even with the right password and a valid account: no source, no journal, no credit, no audit; a different approver then records it and it is credited exactly once", async () => {
    const before = await snapshot();
    const { batchId, net, held } = await heldCashWithoutSource();
    const postingId = held.id as string;
    const x = await accountId("1101");
    const requester = await enrolledFinance("Requester");
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_disbursement_batches SET requested_by = $2 WHERE id = $1`,
          [batchId, requester.userId],
        ),
      true,
    );
    expect(
      (await W.batchById(batchId)).requested_by,
      "premise: the HTTP user requested the batch",
    ).toBe(requester.userId);
    expect(
      (await W.batchById(batchId)).approved_by,
      "premise: someone else approved it",
    ).not.toBe(requester.userId);
    const journals = await journalCount();

    const refusedRes = await postSource(
      requester.client,
      batchId,
      postingId,
      x,
    );
    expect(refusedRes.status, JSON.stringify(refusedRes.body)).toBe(403);
    expect(errorCodeOf(refusedRes.body)).toBe("PAYOUT_SOURCE_SELF_RECORD");
    // A second try and a parallel pair change nothing either.
    await Promise.all([
      postSource(requester.client, batchId, postingId, x),
      postSource(requester.client, batchId, postingId, await accountId("1102")),
    ]);
    await sweep();
    await expectNothingRecorded(batchId, before, journals);
    expect(
      await listedRow(postingId),
      "still waiting for finance",
    ).toMatchObject({
      batchId,
      netIdr: net,
      reason: "source_account_unknown",
    });

    // Another approver (not the requester) records it.
    const ok = await postSource(finance, batchId, postingId, x);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await auditCountOf(batchId), "one audit row").toBe(1);
    const [settled] = await W.postingsOf(batchId);
    expect(settled!.kind).toBe("settle");
    expect(settled!.source_gl_account_id).toBe(x);
    expect(await W.journalByKey(settled!.journal_key as string)).toEqual({
      "2103": { debit: net, credit: 0 },
      "1101": { debit: 0, credit: net },
    });
    expect(await W.countJournals(settled!.journal_key as string)).toBe(1);

    const settledJournals = await journalCount();
    const again = await postSource(finance, batchId, postingId, x);
    expect([200, 409]).toContain(again.status);
    const retry = await postSource(requester.client, batchId, postingId, x);
    refused(retry.status);
    expect(await journalCount(), "no second credit").toBe(settledJournals);
    const after = await snapshot();
    expect(after.c1101.credit - before.c1101.credit).toBe(net);
    expect(after.cash.credit - before.cash.credit).toBe(0);
    expect(await auditCountOf(batchId), "still one audit row").toBe(1);
  });
});
