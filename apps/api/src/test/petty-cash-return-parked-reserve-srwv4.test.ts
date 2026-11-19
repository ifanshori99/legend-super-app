// legend-srwv4 (second opinion ronde 3, finding 2): a parked petty cash RETURN is
// cash that already left the fund but not yet GL 1102. It must be reserved in the
// available 1102 cash until its journal posts, and its retry must refuse when
// 1102 cannot cover it. Written fail-first from the finding, not from the guard.
//
// Scenario (amounts scaled x100 from the finding): the entity has no petty_cash
// mapping, a top-up of 100.000 is parked (fund 100.000), a return of 50.000 is
// parked (fund 50.000). Mapping added, ONLY the top-up re-posted: GL 1102 +100.000.
// A cash payroll batch of 60.000 must be refused (available 50.000); 50.000 is
// safe before and after the return retry; a replay makes no second journal.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  approveDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { originHeader } from "./helpers.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  key,
  makeOutlet,
  owner as kitOwner,
  signedIn,
  tenantId,
  type Session,
} from "./helpers/cash-bank-world.ts";
import {
  APP,
  CASHIER,
  REQ,
  actorOf,
  cash,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";

const app = createApp();
const MOVEMENTS = "/api/accounting/petty-cash/movements";
const ENTRIES = "/api/accounting/petty-cash/entries";
const W = installPayoutWorld("srwv4parkedreturn");

let finance: Session;
let bankAccountId: string;
let pettyGlId: string;
const outlets: string[] = [];
/** Net of the cash batches approved here (never handed over in this file). */
let committed = 0;

withLimitSharedLock();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn(app, "srwv4 finance", [
    { role: "finance", outletId: null },
  ]);
  const bankRow = await kitOwner.query<{ id: string }>(
    "SELECT id FROM bank_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 LIMIT 1",
    [tenantId, W.entityId()],
  );
  bankAccountId = bankRow.rows[0]!.id;
  const gl = await kitOwner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1102'",
    [tenantId, W.entityId()],
  );
  pettyGlId = gl.rows[0]!.id;
});

afterAll(async () => {
  // Runs before the payout world's own cleanup (hooks run in reverse order).
  const client = await kitOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const outletId of outlets) {
      await client.query(
        "DELETE FROM petty_cash_entries WHERE tenant_id = $1 AND outlet_id = $2",
        [tenantId, outletId],
      );
      await client.query(
        "DELETE FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
        [tenantId, outletId],
      );
      await client.query("DELETE FROM outlets WHERE id = $1", [outletId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await closeKit();
});

// ---- helpers -------------------------------------------------------------------

const movement = (
  kind: "topup" | "return",
  amountIdr: number,
  outletId: string,
) =>
  finance.client
    .post(MOVEMENTS)
    .set(originHeader)
    .send({
      kind,
      outletId,
      bankAccountId,
      amountIdr,
      description: kind === "topup" ? "Isi kas kecil srwv4" : "Setor srwv4",
      idempotencyKey: key(),
    });

const retryPost = (entryId: string) =>
  finance.client.post(`${ENTRIES}/${entryId}/post`).set(originHeader).send({});

/** Debit minus credit of GL 1102 of the payout world's entity. */
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

async function journalsOfKey(entryId: string): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3",
    [tenantId, W.entityId(), `pc:${entryId}`],
  );
  return Number(rows[0]!.n);
}

async function entryStatus(entryId: string): Promise<string> {
  const { rows } = await kitOwner.query<{ s: string }>(
    "SELECT journal_status AS s FROM petty_cash_entries WHERE tenant_id = $1 AND id = $2",
    [tenantId, entryId],
  );
  return rows[0]!.s;
}

const digitsOf = (text: string) => text.replace(/(?<=\d)[.,](?=\d)/g, "");

type Pending = { batchId: string; hash: string; net: number };

/** A cash batch of one slip, submitted and waiting for approval. */
async function pendingBatch(net: number): Promise<Pending> {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  const batchId = await W.createBatch(runId, "cash");
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
  const hash = (await W.batchById(batchId)).content_hash as string;
  return { batchId, hash, net };
}

/** Approves through the service; null on success, the thrown error otherwise. */
async function tryApprove(batch: Pending): Promise<HttpError | null> {
  const failure = await W.httpFailure(
    W.inTx((tx) =>
      approveDisbursementBatch(tx, actorOf(APP), batch.batchId, {
        contentHash: batch.hash,
        sourceBankAccountId: null,
      } as never),
    ),
  );
  if (failure === null) committed += batch.net;
  return failure;
}

/** Approves one exact batch for all the posted cash: baseline becomes 0. */
async function drain() {
  const avail = (await glBalance()) - committed;
  expect(avail, "no negative cash between tests").toBeGreaterThanOrEqual(0);
  if (avail > 0) {
    expect(await tryApprove(await pendingBatch(avail))).toBeNull();
  }
  expect((await glBalance()) - committed).toBe(0);
}

async function withoutPettyCashMapping<T>(work: () => Promise<T>): Promise<T> {
  const mapping = await kitOwner.query<{ account_id: string }>(
    "SELECT account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
    [tenantId, W.entityId()],
  );
  expect(mapping.rows).toHaveLength(1);
  await kitOwner.query(
    "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
    [tenantId, W.entityId()],
  );
  try {
    return await work();
  } finally {
    await kitOwner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'petty_cash', $3)`,
      [tenantId, W.entityId(), mapping.rows[0]!.account_id],
    );
  }
}

/** Fresh outlet: top-up 100.000 and return 50.000, both parked (no mapping). */
async function parkedTopupAndReturn() {
  await drain();
  const outletId = await makeOutlet(W.entityId());
  outlets.push(outletId);
  return withoutPettyCashMapping(async () => {
    const top = await movement("topup", 100_000, outletId);
    expect(top.status, JSON.stringify(top.body)).toBe(201);
    expect(top.body.data.journalStatus).toBe("parked");
    const ret = await movement("return", 50_000, outletId);
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    expect(ret.body.data.journalStatus).toBe("parked");
    return {
      outletId,
      topId: top.body.data.id as string,
      returnId: ret.body.data.id as string,
    };
  });
}

function expectGlRefusal(res: {
  status: number;
  body: { error?: { code?: string } };
}) {
  const detail = JSON.stringify(res.body);
  expect([409, 422], `status ${res.status}: ${detail}`).toContain(res.status);
  expect(res.body.error?.code, detail).toBe("PETTY_CASH_GL_INSUFFICIENT");
}

// ---- tests ---------------------------------------------------------------------

describe("srwv4 a parked petty cash return is reserved in the available 1102 cash", () => {
  it("[srwv4-return-parked-reserved] after only the top-up is re-posted, a cash batch of 60.000 is refused with available 50.000; 50.000 is approved; the same holds after the return retry and a replay adds no journal", async () => {
    const { topId, returnId } = await parkedTopupAndReturn();
    const base = await glBalance();
    const top = await retryPost(topId);
    expect(top.status, JSON.stringify(top.body)).toBeLessThan(300);
    expect(await glBalance(), "premise: only the top-up reached 1102").toBe(
      base + 100_000,
    );
    expect(await entryStatus(returnId), "premise: return still parked").toBe(
      "parked",
    );

    const tooBig = await pendingBatch(60_000);
    const refused = await tryApprove(tooBig);
    expect(
      refused,
      "60.000 must not be approved over the parked return",
    ).toBeInstanceOf(HttpError);
    expect((refused as HttpError).code).toBe("PAYOUT_CASH_INSUFFICIENT");
    expect(digitsOf((refused as HttpError).message)).toContain("50000");
    expect((await W.batchById(tooBig.batchId)).status).toBe("pending_approval");

    // Rp50.000 is safe now: it is exactly what the top-up leaves after the return.
    expect(await tryApprove(await pendingBatch(50_000))).toBeNull();
    expect(
      (await glBalance()) - committed,
      "cash left, return still parked",
    ).toBe(50_000);
    const oneMore = await tryApprove(await pendingBatch(1));
    expect(
      oneMore,
      "nothing is left after the 50.000 and the return",
    ).toBeInstanceOf(HttpError);

    // Retry of the return: 1102 covers it exactly, so it posts.
    const journalsBefore = await journalsOfKey(returnId);
    expect(journalsBefore).toBe(0);
    const retried = await retryPost(returnId);
    expect(retried.status, JSON.stringify(retried.body)).toBeLessThan(300);
    expect(retried.body.data.journalStatus).toBe("posted");
    expect(await journalsOfKey(returnId)).toBe(1);
    expect(await glBalance(), "return credited 1102 once").toBe(base + 50_000);
    // The reserve stops counting once the journal posted: no double count.
    expect((await glBalance()) - committed, "no cash left, not negative").toBe(
      0,
    );
    expect(await tryApprove(await pendingBatch(1))).toBeInstanceOf(HttpError);

    // Replay: no second journal, GL unchanged.
    const replay = await retryPost(returnId);
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(await journalsOfKey(returnId)).toBe(1);
    expect(await glBalance()).toBe(base + 50_000);
  }, 180_000);

  it("[srwv4-return-retry-refused-when-1102-cannot-cover] retrying the return before the top-up reached 1102 is refused PETTY_CASH_GL_INSUFFICIENT: entry stays parked, no journal; after the top-up posts the retry succeeds", async () => {
    const { topId, returnId } = await parkedTopupAndReturn();
    const base = await glBalance();

    const early = await retryPost(returnId);
    expectGlRefusal(early);
    expect(await entryStatus(returnId)).toBe("parked");
    expect(await journalsOfKey(returnId)).toBe(0);
    expect(await glBalance()).toBe(base);

    expect((await retryPost(topId)).status).toBeLessThan(300);
    const late = await retryPost(returnId);
    expect(late.status, JSON.stringify(late.body)).toBeLessThan(300);
    expect(late.body.data.journalStatus).toBe("posted");
    expect(await journalsOfKey(returnId)).toBe(1);
    expect(await glBalance()).toBe(base + 50_000);
  }, 120_000);
});
