// Payout 920 (second opinion 919, finding 3, P2): a frozen payout batch must
// not break the GL consumer of its run. Written fail-first from the second
// opinion (scratchpad so919.md) and the brief, NOT from the implementation.
//
// Rule proven (founder: nobody is paid on one person's word; money that already
// left the bank is still booked; only steps that would send NEW money are held):
// a bank batch was confirmed before the `payroll.locked` event was consumed
// (posting `settle_pending`, approval-log row `bank_confirm`). The person behind
// that log says "not me" (disown) and the batch freezes. When the consumer then
// handles the locked event in ONE transaction, the lock journal posts, the
// healthy sibling batch of the run settles, the event is consumed (outbox row
// `delivered`) and nothing is posted twice. The frozen batch stays pending (no
// payout journal is written for it while frozen) and recovers exactly once after
// an outsider unfreezes it.
//
// Fixture: [2aspe-pending-resolves-bank] and pendingCashThenExportedBank of
// payroll-payout-870-gl-pending.test.ts, plus the disown/unfreeze SQL calls of
// payroll-payout-918-disown.test.ts (grants from the grantor stand-in).
//
// Assumptions (the spec leaves them open, stated so they can be contested):
// - World: one mixed run [cash CASHIER, bank BUDI]. The cash batch (healthy) is
//   handed over by APP2 and the bank batch (to be frozen) is confirmed by APP3,
//   both while the locked event waits in the outbox. Each leaves one approval-log
//   row of its own actor.
// - Disown = the 918 SQL path: password grant (kind disown, step record, ref =
//   log id, detail = sha256(reason)) then app.payout_approval_disown as
//   legend_app with a REAL COMMIT. APP3 may disown without an owner/finance role.
// - Unfreeze = outsider with the owner template role at tenant scope who took
//   no part in the batch; grant (unfreeze, approve, batch, detail = sha256(reason)),
//   password first, mfa_challenge as fallback. Reason of 10+ characters.
// - Frozen = the batch stays `settle_pending` with no payout journal while
//   frozen (the second opinion: "batch beku tetap pending"). The bank fee
//   journal may or may not be posted during the freeze (the spec does not say),
//   so only "at most the fee" is asserted for the bank credit before unfreeze.
// - How the frozen batch is resolved after unfreeze is not fixed: the test
//   replays settleBatchPayouts (twice, concurrently) and the consumer for the
//   same event, all idempotent, and demands the exact money once.
// - Bank fee: Rp5.000 per item (BCA, as in [2aspe-pending-resolves-bank]).
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import { settleBatchPayouts } from "../services/payroll-payout-gl.service.ts";
import {
  APP2,
  APP3,
  BUDI,
  CASHIER,
  actorOf,
  bank,
  cash,
  installPayoutWorld,
  netOf,
  runTotals,
  type Slip,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("920frz");
const tenantId = () => W.tenantId;

const CASH_NET = 1_000_000;
const BANK_NET = 2_000_000;
const BANK_FEE = 5_000;
const CONSUME_NOW = new Date("2026-11-30T03:00:00Z");
const DISOWN_REASON =
  "Bukan saya yang mengonfirmasi transfer ini, akun saya dipakai orang";
const UNFREEZE_REASON = "Sudah dicek ke bank, tidak ada dana keluar tambahan";
const DISPUTES = "payroll_payout_batch_disputes";
const UNFREEZES = "payroll_payout_batch_unfreezes";
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const batchIds: string[] = [];
const outsideUsers: string[] = [];
let outsideOwner = "";

// ---- Outside owner (took no part in any batch) --------------------------------

async function ownerTemplateRoleId() {
  const read = () =>
    W.owner.query<{ id: string }>(
      `SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'`,
      [tenantId()],
    );
  const found = await read();
  if (found.rows[0]) return found.rows[0].id;
  await W.owner.query(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, 'Template owner 920', true, 'owner', '[]'::jsonb, false, '["tenant","brand"]'::jsonb)
     ON CONFLICT DO NOTHING`,
    [tenantId()],
  );
  return (await read()).rows[0]!.id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  outsideOwner = randomUUID();
  outsideUsers.push(outsideOwner);
  await W.provisionActor(outsideOwner, { user: true, permit: true });
  await W.owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId(), outsideOwner, await ownerTemplateRoleId()],
  );
});

// Registered after the world's own hook: runs first (stack order).
afterAll(async () => {
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
      [tenantId(), outsideUsers],
    );
    if (batchIds.length > 0) {
      for (const table of [UNFREEZES, DISPUTES])
        await c.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND batch_id = ANY($2)`,
          [tenantId(), batchIds],
        );
      await c.query(
        `DELETE FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = ANY($2)`,
        [tenantId(), batchIds],
      );
    }
  }, true).catch(() => undefined);
});

// ---- GL observations -----------------------------------------------------------

/** Debit and credit totals of a GL account of the PT, all journals. */
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
  return { debit: Number(row!.debit), credit: Number(row!.credit) };
}
const snapshot = async () => ({
  cash: await account("1102"),
  bank: await account("1103"),
  payable: await account("2103"),
});

// ---- The locked event, through the real outbox consumer ------------------------

function lockedEnvelope(runId: string, slips: Slip[]) {
  const lockedAt = "2026-10-26T05:00:00.000Z";
  return payrollLocked.envelopeSchema.parse({
    id: createUlid(),
    tenantId: tenantId(),
    outletId: null,
    name: "payroll.locked",
    version: 1,
    aggregateType: "payroll",
    aggregateId: runId,
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
  const event = lockedEnvelope(runId, slips);
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
  return { event, outboxId };
}

/** The real consumer path (like the worker): the GL consumer inside consumeOutbox. */
async function consumeLocked(outboxId: string) {
  let result: { status: string } | undefined;
  const consumed = await consumeOutbox(db, W.scope(), {
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
        CONSUME_NOW,
      )) as { status: string };
    },
  });
  return { consumed, result };
}
/** Same as consumeLocked, but a thrown error becomes a readable message instead of aborting. */
const tryConsume = (outboxId: string) =>
  consumeLocked(outboxId).then(
    (r) => ({ ok: true as const, ...r, error: "" }),
    (e: unknown) => ({
      ok: false as const,
      consumed: false,
      result: undefined,
      error: e instanceof Error ? e.message : String(e),
    }),
  );
const outboxStatus = async (outboxId: string) =>
  (
    await W.rowsOf(
      `SELECT status FROM domain_event_outbox WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), ulidToUuid(outboxId)],
    )
  )[0]?.status;

// ---- Disown / unfreeze (SQL path of the 918 suite) -----------------------------

async function ownerCall<T>(
  role: "legend_app" | "legend_payout_grantor",
  sql: string,
  params: unknown[],
): Promise<{ rows: T[]; code?: string; message: string }> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId()],
    );
    try {
      const { rows } = await client.query(sql, params);
      await client.query("COMMIT");
      return { rows: rows as T[], message: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { rows: [], code: e.code ?? "unknown", message: e.message ?? "" };
    }
  } finally {
    client.release();
  }
}

async function issueGrant(input: {
  kind: "disown" | "unfreeze";
  step: "record" | "approve";
  userId: string;
  batchId: string;
  refId?: string | null;
  detail: string;
  method: "password" | "mfa_challenge";
}) {
  const result = await ownerCall<{ grant: string }>(
    "legend_payout_grantor",
    `SELECT app.payout_grant_issue($1::text, $2::text, $3::uuid, $4::uuid[], $5::varchar, $6::uuid, $7::uuid, $8::varchar, $9::text, $10::text, $11::text) AS grant`,
    [
      input.kind,
      input.step,
      input.batchId,
      "{}",
      null,
      input.refId ?? null,
      null,
      input.detail,
      input.userId,
      actorOf(input.userId).sessionId,
      input.method,
    ],
  );
  return { grant: result.rows[0]?.grant, message: result.message };
}

/** "Not me": the actor of the log disowns it; the batch of the log freezes. */
async function disown(userId: string, batchId: string, logId: string) {
  const issued = await issueGrant({
    kind: "disown",
    step: "record",
    userId,
    batchId,
    refId: logId,
    detail: sha256(DISOWN_REASON),
    method: "password",
  });
  expect(issued.grant, `premise: disown grant, ${issued.message}`).toBeTruthy();
  const outcome = await ownerCall(
    "legend_app",
    `SELECT app.payout_approval_disown($1::uuid, $2::text, $3::text) AS id`,
    [logId, issued.grant, DISOWN_REASON],
  );
  expect(outcome.code, `premise: disown, ${outcome.message}`).toBe(undefined);
}

/** An outsider lifts the freeze with a fresh one-time grant. Returns how many disputes were released. */
async function unfreeze(batchId: string) {
  let issued: Awaited<ReturnType<typeof issueGrant>> | undefined;
  for (const method of ["password", "mfa_challenge"] as const) {
    issued = await issueGrant({
      kind: "unfreeze",
      step: "approve",
      userId: outsideOwner,
      batchId,
      detail: sha256(UNFREEZE_REASON),
      method,
    });
    if (issued.grant) break;
  }
  expect(
    issued!.grant,
    `premise: unfreeze grant, ${issued!.message}`,
  ).toBeTruthy();
  const outcome = await ownerCall<{ released: number }>(
    "legend_app",
    `SELECT app.payout_batch_unfreeze($1::uuid, $2::text, $3::text) AS released`,
    [batchId, issued!.grant, UNFREEZE_REASON],
  );
  expect(outcome.code, `premise: unfreeze, ${outcome.message}`).toBe(undefined);
  return Number(outcome.rows[0]!.released);
}

const openDisputes = async (batchId: string) =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM ${DISPUTES} d
          WHERE d.tenant_id = $1 AND d.batch_id = $2
            AND NOT EXISTS (SELECT 1 FROM ${UNFREEZES} u
                             WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id)`,
        [tenantId(), batchId],
      )
    )[0]!.n,
  );
const settle = (batchId: string, by = APP2) =>
  W.inTx((tx) => settleBatchPayouts(tx, actorOf(by), batchId));

// ---- The world -------------------------------------------------------------------

/**
 * Mixed run, locked event queued in the outbox, both batches paid out before the
 * lock journal exists (both `settle_pending`): cash batch A (healthy, APP2) and
 * bank batch B (confirmed by APP3). APP3 then says "not me" about its
 * confirmation: B is frozen, A is not.
 */
async function frozenBankBatchWorld() {
  const before = await snapshot();
  const slips = [cash(CASHIER, CASH_NET), bank(BUDI, BANK_NET)];
  const runId = await W.seedRun(slips);
  const { event, outboxId } = await queueLockedViaOutbox(runId, slips);

  const healthy = await W.approvedBatch(runId, "cash");
  const healthyItems = await W.itemsOf(healthy);
  await W.handover(
    healthy,
    healthyItems.map((i) => i.id as string),
    APP2,
  );
  const frozen = await W.exportedBatch(runId);
  batchIds.push(healthy, frozen);
  const frozenItems = await W.itemsOf(frozen);
  await W.confirm(frozen, W.succeedItems(frozen, frozenItems), APP3);

  expect(
    (await W.postingsOf(healthy)).map((p) => p.kind),
    "premise: the cash batch is stored pending",
  ).toEqual(["settle_pending"]);
  expect(
    (await W.postingsOf(frozen)).map((p) => p.kind),
    "premise: the bank batch is stored pending",
  ).toEqual(["settle_pending"]);

  const [log] = await W.rowsOf(
    `SELECT id::text AS id FROM payroll_payout_approval_log
      WHERE tenant_id = $1 AND batch_id = $2 AND actor = $3
      ORDER BY logged_at, id LIMIT 1`,
    [tenantId(), frozen, APP3],
  );
  expect(
    log,
    "premise: APP3 left an approval-log row for the bank confirm",
  ).toBeTruthy();
  await disown(APP3, frozen, log!.id as string);
  expect(await openDisputes(frozen), "premise: bank batch frozen").toBe(1);
  expect(await openDisputes(healthy), "premise: cash batch not frozen").toBe(0);

  return {
    before,
    slips,
    runId,
    event,
    outboxId,
    healthy,
    frozen,
    frozenItems,
  };
}
type FrozenWorld = Awaited<ReturnType<typeof frozenBankBatchWorld>>;

/** The consumer handles the locked event while B is frozen; it must go through. */
async function consumeWhileFrozen(w: FrozenWorld) {
  const outcome = await tryConsume(w.outboxId);
  expect(
    outcome.error,
    "the lock event must be consumed even though one batch of the run is frozen",
  ).toBe("");
  expect(outcome.result?.status, "the lock journal is posted").toBe("posted");
  return outcome;
}

const FEE_OR_NOTHING = (delta: number) => delta >= 0 && delta <= BANK_FEE;

// ---- Tests -----------------------------------------------------------------------

describe("920 frozen batch does not break the GL consumer of its run", () => {
  it("[920-frozen-gl-lock-and-healthy-batch] a frozen bank batch in the run: the lock event is consumed, one lock journal, the healthy cash batch settles exactly once, the frozen batch stays pending and its recorded payout is kept", async () => {
    const w = await frozenBankBatchWorld();

    const outcome = await consumeWhileFrozen(w);
    expect(outcome.consumed, "the event is consumed").toBe(true);
    expect(
      await outboxStatus(w.outboxId),
      "the outbox row is finished, not stuck",
    ).toBe("delivered");

    const after = await snapshot();
    // Exactly one lock journal: 2103 is credited the whole run's net once.
    expect(
      after.payable.credit - w.before.payable.credit,
      "one lock journal (Cr 2103 = net of the whole run)",
    ).toBe(netOf(w.slips));

    // The healthy cash batch settled once, with its exact journal.
    const healthyPostings = await W.postingsOf(w.healthy);
    expect(healthyPostings).toHaveLength(1);
    expect(healthyPostings[0]!.kind).toBe("settle");
    expect(
      await W.journalByKey(healthyPostings[0]!.journal_key as string),
    ).toEqual({
      "2103": { debit: CASH_NET, credit: 0 },
      "1102": { debit: 0, credit: CASH_NET },
    });
    expect(
      await W.countJournals(healthyPostings[0]!.journal_key as string),
    ).toBe(1);
    expect(after.cash.credit - w.before.cash.credit).toBe(CASH_NET);
    for (const item of await W.itemsOf(w.healthy))
      expect(item.gl_posting_id).toBe(healthyPostings[0]!.id);

    // The frozen batch: money already left the bank and stays on record, but no
    // payout journal is written for it while it is frozen (nothing double).
    const frozenPostings = await W.postingsOf(w.frozen);
    expect(frozenPostings, "its recorded payout is kept, once").toHaveLength(1);
    expect(frozenPostings[0]!.kind, "still pending while frozen").toBe(
      "settle_pending",
    );
    expect(
      await W.journalByKey(
        `payroll-payout:${frozenPostings[0]!.item_set_hash}`,
      ),
    ).toBe(undefined);
    expect(
      FEE_OR_NOTHING(after.bank.credit - w.before.bank.credit),
      `bank credit while frozen is at most the fee, got ${after.bank.credit - w.before.bank.credit}`,
    ).toBe(true);
    for (const item of await W.itemsOf(w.frozen))
      expect(item.status, "the confirmed items stay confirmed").toBe(
        "succeeded",
      );
    expect(await openDisputes(w.frozen), "still frozen").toBe(1);

    // Replays add nothing.
    expect((await tryConsume(w.outboxId)).consumed).toBe(false);
    await W.deliverGl(w.event);
    const replay = await snapshot();
    expect(replay.payable.credit - w.before.payable.credit).toBe(
      netOf(w.slips),
    );
    expect(replay.cash.credit - w.before.cash.credit).toBe(CASH_NET);
    expect(await W.postingsOf(w.healthy)).toHaveLength(1);
    expect(await W.postingsOf(w.frozen)).toHaveLength(1);
  });

  it("[920-frozen-gl-recovers-after-unfreeze] after an outsider unfreezes, the frozen bank batch settles exactly once: bank credited net plus fee, 2103 net zero, no second journal", async () => {
    const w = await frozenBankBatchWorld();
    await consumeWhileFrozen(w);

    expect(await unfreeze(w.frozen), "the freeze is lifted").toBe(1);
    expect(await openDisputes(w.frozen)).toBe(0);

    // Resolve the pending settle (one by one and together), then replay the event.
    await settle(w.frozen);
    await Promise.all([settle(w.frozen), settle(w.frozen, APP3)]);
    await tryConsume(w.outboxId);
    await W.deliverGl(w.event);

    const postings = await W.postingsOf(w.frozen);
    expect(postings, "one posting, not a second one").toHaveLength(1);
    expect(postings[0]!.kind, "resolved").toBe("settle");
    const key = `payroll-payout:${postings[0]!.item_set_hash}`;
    expect(await W.journalByKey(key)).toEqual({
      "2103": { debit: BANK_NET, credit: 0 },
      "1103": { debit: 0, credit: BANK_NET },
    });
    expect(await W.countJournals(key), "no duplicate journal").toBe(1);
    for (const item of await W.itemsOf(w.frozen))
      expect(item.gl_posting_id).toBe(postings[0]!.id);

    const after = await snapshot();
    expect(
      after.bank.credit - w.before.bank.credit,
      "bank credit is the net plus the PT-borne fee, once",
    ).toBe(BANK_NET + BANK_FEE);
    expect(
      after.payable.credit - w.before.payable.credit,
      "still exactly one lock journal",
    ).toBe(netOf(w.slips));
    expect(
      after.payable.credit -
        w.before.payable.credit -
        (after.payable.debit - w.before.payable.debit),
      "salaries payable ends at 0 for the run",
    ).toBe(0);
    expect(after.cash.credit - w.before.cash.credit).toBe(CASH_NET);
    expect(await W.postingsOf(w.healthy)).toHaveLength(1);
  });

  it("[920-frozen-gl-control-unfrozen] control: the same world without the freeze settles both batches in the consumer, bank credited net plus fee, cash credited the cash net", async () => {
    const before = await snapshot();
    const slips = [cash(CASHIER, CASH_NET), bank(BUDI, BANK_NET)];
    const runId = await W.seedRun(slips);
    const { outboxId } = await queueLockedViaOutbox(runId, slips);
    const healthy = await W.approvedBatch(runId, "cash");
    const healthyItems = await W.itemsOf(healthy);
    await W.handover(
      healthy,
      healthyItems.map((i) => i.id as string),
      APP2,
    );
    const confirmed = await W.exportedBatch(runId);
    batchIds.push(healthy, confirmed);
    await W.confirm(
      confirmed,
      W.succeedItems(confirmed, await W.itemsOf(confirmed)),
      APP3,
    );

    const outcome = await tryConsume(outboxId);
    expect(outcome.error).toBe("");
    expect(outcome.consumed).toBe(true);
    expect((await W.postingsOf(healthy))[0]!.kind).toBe("settle");
    expect((await W.postingsOf(confirmed))[0]!.kind).toBe("settle");
    const after = await snapshot();
    expect(after.cash.credit - before.cash.credit).toBe(CASH_NET);
    expect(after.bank.credit - before.bank.credit).toBe(BANK_NET + BANK_FEE);
    expect(
      after.payable.credit -
        before.payable.credit -
        (after.payable.debit - before.payable.debit),
    ).toBe(0);
  });
});
