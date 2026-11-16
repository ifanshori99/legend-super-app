// Payout 905 card 2(b) (bead legend-kjht5; docs/briefs/905/design.md "0646 kartu
// 2(b)" and "Asumsi pemanggil", brief "Kartu 2", finding P2 "historical cash /
// non-frozen source" in docs/briefs/905/so-900.md). Written fail-first from the
// brief and the design, not from the implementation.
//
// A payout posting whose source account is unknown (NULL: cash handed over
// before the source was frozen, or a legacy bank batch) is held. Rules proven
// here (founder: the GL matches the money that moved; when in doubt, limit the
// payment):
// - The app role (`SET LOCAL ROLE legend_app`, a REAL commit) cannot fill the
//   source of such a posting directly, with the cash origin or with any other
//   account, nor fill it and settle through it: the stored source stays NULL, no
//   journal appears. (It could invent "the origin" of the cash.)
// - The one legitimate path is finance recording the source over HTTP
//   (`recordPostingSource`, POST .../postings/:postingId/source), which goes
//   through the trusted function `app.payout_posting_record_source`: the posting
//   resolves, journals Dr 2103 / Cr account once, a replay adds nothing; the
//   batch requester is refused (403 PAYOUT_SOURCE_SELF_RECORD); an account that
//   is not cash-and-equivalents (an expense or payable account) is refused.
// - The trusted function itself is not a back door: called by the app role with
//   an actor or session that does not exist, it refuses and stores nothing.
//
// Assumptions (the brief/design leave them open, stated so they can be contested):
// - "Direct fill refused" = after the attempt the stored source is still NULL
//   (the statement may raise a guard error or be ignored) and, where a journal
//   was part of the attempt, the commit fails and no journal stays. Filling the
//   cash origin itself (1102) directly is refused too, as the design says every
//   fill by `legend_app` on the non-frozen-bank branch needs the payout role.
// - The held posting is built the way payroll-payout-881-source.test.ts does
//   (cash handed over with accounting off and no petty_cash mapping, then the
//   lock journal arrives): source NULL, not settled, no journal.
// - The refusal of a non-cash account is any 4xx plus unchanged state.
// - The forged-actor call is refused with an error that is neither "function
//   does not exist" (42883, missing behaviour) nor "permission denied" (42501,
//   the app role must be able to call it): the actor check refuses it.
// - Success of the HTTP route is 200; a second call is a no-op (200) or 409.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { originHeader } from "./helpers.ts";
import {
  APP2,
  CASHIER,
  cash,
  installPayoutWorld,
  runTotals,
  type Row,
  type Slip,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("905src");
const tenantId = () => W.tenantId;
const BASE = "/api/hris/payroll/disbursement-batches";
const PASSWORD = "Test-password-123!";
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
let finance: { client: Client; userId: string };

/** Signed in, approve permission, TOTP enrolled in this very session (enrollment-only: every call sends the password). */
async function enrolledFinance(label: string) {
  const { client, userId } = await W.signedInClient(`Src905 ${label}`);
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
  return { client, userId };
}
beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await enrolledFinance("Finance");
});

// ---- Outbox / consumer (as in 881) ----------------------------------------------

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
async function queueLocked(runId: string, slips: Slip[]) {
  // 905: as in 881, a run's aggregate already holds its own `payroll.paid`
  // event (sequence 1) after a handover; then the lock event goes on a separate
  // aggregate (the GL consumer reads the run from the payload).
  const [taken] = await W.rowsOf(
    `SELECT count(*)::int AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2`,
    [tenantId(), runId],
  );
  const outboxId = createUlid();
  await W.inTx((tx) =>
    appendOutbox(tx, W.scope(), {
      id: outboxId,
      event: lockedEnvelope(
        runId,
        slips,
        Number(taken!.n) > 0 ? randomUUID() : runId,
      ),
      destination: "cloud-sync",
      direction: null,
      peerId: null,
    }),
  );
  return outboxId;
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

// ---- Tenant flags / mapping / accounts -------------------------------------------

async function withAccountingOff<T>(work: () => Promise<T>) {
  const rows = await W.owner.query(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenantId()],
  );
  const original = rows.rows[0]!.flags as { modules: string[] } & Record<
    string,
    unknown
  >;
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  const set = (flags: unknown) =>
    W.owner.query(
      "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
      [tenantId(), JSON.stringify(flags)],
    );
  await set({
    ...original,
    modules: original.modules.filter((m) => m !== "accounting"),
  });
  try {
    return await work();
  } finally {
    await set(original);
  }
}
async function removePettyCashMapping() {
  const where = `tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'`;
  const [mapping] = await W.rowsOf(
    `SELECT account_id FROM account_mappings WHERE ${where}`,
    [tenantId(), W.entityId()],
  );
  expect(mapping, "premise: the fixture maps petty_cash").toBeDefined();
  await W.asTenant(
    (c) =>
      c.query(`DELETE FROM account_mappings WHERE ${where}`, [
        tenantId(),
        W.entityId(),
      ]),
    true,
  );
  return () =>
    W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
           VALUES ($1, $2, 'petty_cash', $3)`,
          [tenantId(), W.entityId(), mapping!.account_id],
        ),
      true,
    );
}
async function accountId(code: string) {
  const [row] = await W.rowsOf(
    `SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
    [tenantId(), W.entityId(), code],
  );
  return row!.id as string;
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
  return Number(row!.credit) - Number(row!.debit);
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

/** A held cash posting: source NULL, lock journal posted, not settled (the 881 scenario). */
async function heldCashWithoutSource() {
  const restore = await removePettyCashMapping();
  const slips = [cash(CASHIER, NET_CASH)];
  const runId = await W.seedRun(slips);
  const batchId = await W.approvedBatch(runId, "cash");
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  try {
    await withAccountingOff(() => W.handover(batchId, itemIds, APP2));
  } finally {
    await restore();
  }
  const outboxId = await queueLocked(runId, slips);
  expect((await consumeLocked(outboxId))?.status).toBe("posted");
  const postings = await W.postingsOf(batchId);
  expect(postings, "premise: one posting").toHaveLength(1);
  const held = postings[0] as Row;
  expect(held.kind, "premise: held, not settled").not.toBe("settle");
  expect(held.source_gl_account_id, "premise: source unknown").toBe(null);
  expect(
    await W.journalByKey(held.journal_key as string),
    "premise: no settle journal",
  ).toBe(undefined);
  return { runId, batchId, itemIds, held, net: NET_CASH };
}

const postingOf = async (postingId: string) =>
  (
    await W.rowsOf(
      `SELECT kind, source_gl_account_id FROM payroll_payout_gl_postings WHERE id = $1`,
      [postingId],
    )
  )[0]!;

// ---- legend_app helpers (patterns of 905-gl-insert / 905-trusted-boundary) -----------

/** A legend_app transaction with a real COMMIT; the first error (statement or commit), if any. */
async function appTx(work: (client: PoolClient) => Promise<void>) {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId()],
    );
    try {
      await work(client);
      await client.query("COMMIT");
      return { code: undefined as string | undefined, message: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { code: e.code ?? "unknown", message: e.message ?? "" };
    }
  } finally {
    client.release();
  }
}

const fillSource = (postingId: string, glAccountId: string) =>
  appTx(async (client) => {
    await client.query(
      `UPDATE payroll_payout_gl_postings SET source_gl_account_id = $2 WHERE id = $1`,
      [postingId, glAccountId],
    );
  });

// =========================================================================
// legend_app cannot fill the source of a held posting
// =========================================================================

describe("905 a held posting's source is not filled by the app role (card 2b)", () => {
  it("[905-source-direct-fill-other-account-refused] legend_app fills account B (1101, not the cash origin) into a held cash posting: the stored source stays NULL and nothing is journaled", async () => {
    const { held } = await heldCashWithoutSource();
    // 905: counted after the setup, which posts the lock journal itself.
    const before = await journalCount();
    const b = await accountId("1101");

    await fillSource(held.id as string, b);

    expect(
      (await postingOf(held.id as string)).source_gl_account_id,
      "an unproven account is not stored as the source",
    ).toBe(null);
    expect(await W.journalByKey(held.journal_key as string)).toBe(undefined);
    expect(await journalCount(), "no journal appeared").toBe(before);
  });

  it("[905-source-direct-fill-origin-refused] legend_app fills even the petty cash account (1102) directly: the source stays NULL (only the trusted function records a source)", async () => {
    const { held } = await heldCashWithoutSource();
    const origin = await accountId("1102");

    await fillSource(held.id as string, origin);

    expect((await postingOf(held.id as string)).source_gl_account_id).toBe(
      null,
    );
  });

  it("[905-source-direct-fill-and-settle-refused] legend_app fills B, journals Dr 2103 / Cr B for the net and flips the posting to settle in one transaction: the COMMIT fails; the posting stays held with no source and no journal", async () => {
    const { held, runId } = await heldCashWithoutSource();
    // 905: counted after the setup, which posts the lock journal itself.
    const before = await journalCount();
    const id = held.id as string;
    const key = held.journal_key as string;
    const b = await accountId("1101");
    const payable = await accountId("2103");
    const [period] = await W.rowsOf(
      `SELECT id FROM fiscal_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
      [tenantId(), W.entityId()],
    );

    const result = await appTx(async (client) => {
      await client.query(
        `UPDATE payroll_payout_gl_postings SET source_gl_account_id = $2 WHERE id = $1`,
        [id, b],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
            source_id, description, reversal_of, idempotency_key, request_fingerprint)
         VALUES ($1, $2, '2026-10-15', $3, 'payroll', $4, 'Payout 905 source test',
                 NULL, $5, $6)
         RETURNING id`,
        [
          tenantId(),
          W.entityId(),
          period!.id,
          runId,
          key,
          randomUUID().replaceAll("-", "").repeat(2),
        ],
      );
      await client.query(
        `INSERT INTO journal_lines
           (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
         VALUES ($1, $2, $3, 1, $5, 0, NULL), ($1, $2, $4, 2, 0, $5, NULL)`,
        [tenantId(), rows[0]!.id, payable, b, NET_CASH],
      );
      await client.query(
        `UPDATE payroll_payout_gl_postings SET kind = 'settle' WHERE id = $1`,
        [id],
      );
    });

    expect(result.code, "the forged settlement is refused").toBeDefined();
    const posting = await postingOf(id);
    expect(posting.source_gl_account_id).toBe(null);
    expect(posting.kind).not.toBe("settle");
    expect(await W.journalByKey(key), "no journal stays").toBe(undefined);
    expect(await journalCount()).toBe(before);
  });
});

// =========================================================================
// The trusted function is not a back door
// =========================================================================

describe("905 app.payout_posting_record_source checks who calls it (card 2b)", () => {
  it("[905-source-function-forged-actor-refused] legend_app can name no actor or session any more (911): it calls the function with a made-up grant, then with a malformed one: both are refused by the grant check and nothing is stored or journaled", async () => {
    const { held, batchId } = await heldCashWithoutSource();
    // 905: counted after the setup, which posts the lock journal itself.
    const before = await journalCount();
    const b = await accountId("1101");

    for (const grant of [
      `${randomUUID()}${randomUUID()}`.replaceAll("-", ""),
      `forged-${randomUUID()}`,
    ]) {
      const result = await appTx(async (client) => {
        await client.query(
          `SELECT app.payout_posting_record_source($1::uuid, $2::uuid, $3::uuid, $4::text)`,
          [batchId, held.id, b, grant],
        );
      });
      expect(result.code, "the call is refused").toBeDefined();
      expect(result.code, "the function exists (missing behaviour)").not.toBe(
        "42883",
      );
      // 911: app.payout_grant_consume raises 42501 (PAYOUT-70), so the code
      // alone cannot tell a missing EXECUTE grant from the grant check: the
      // message does.
      expect(
        result.message,
        "the app role may call it; the grant check refuses",
      ).toMatch(/PAYOUT-70:/);
    }
    expect((await postingOf(held.id as string)).source_gl_account_id).toBe(
      null,
    );
    expect(await W.journalByKey(held.journal_key as string)).toBe(undefined);
    expect(await journalCount()).toBe(before);
  });
});

// =========================================================================
// The legitimate path: finance records the source over HTTP
// =========================================================================

const postSource = (
  who: { client: Client },
  batchId: string,
  postingId: string,
  glAccountId: string,
) =>
  who.client
    .post(`${BASE}/${batchId}/postings/${postingId}/source`)
    .set(originHeader)
    .send({ glAccountId, password: PASSWORD });

describe("905 finance records the posting source through the trusted function (card 2b)", () => {
  it("[905-source-record-journals-once] finance (not the requester) records account X for the held cash posting: it settles once, Dr 2103 / Cr X for the net, the petty cash mapping is untouched, a replay (also parallel) adds no second journal", async () => {
    const before = { x: await account("1101"), cash: await account("1102") };
    const { held, batchId, itemIds, net } = await heldCashWithoutSource();
    const postingId = held.id as string;
    const x = await accountId("1101");

    const res = await postSource(finance, batchId, postingId, x);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const posting = await postingOf(postingId);
    expect(posting).toMatchObject({ kind: "settle", source_gl_account_id: x });
    const key = held.journal_key as string;
    expect(await W.journalByKey(key)).toEqual({
      "2103": { debit: net, credit: 0 },
      "1101": { debit: 0, credit: net },
    });
    expect(await W.countJournals(key)).toBe(1);
    for (const item of await W.itemsOf(batchId)) {
      expect(itemIds).toContain(item.id);
      expect(item.gl_posting_id).toBe(postingId);
    }
    expect((await account("1101")) - before.x).toBe(net);
    expect((await account("1102")) - before.cash, "mapping untouched").toBe(0);

    const journals = await journalCount();
    const again = await postSource(finance, batchId, postingId, x);
    expect([200, 409], JSON.stringify(again.body)).toContain(again.status);
    await Promise.all([
      postSource(finance, batchId, postingId, x),
      postSource(finance, batchId, postingId, x),
    ]);
    expect(await journalCount(), "no second credit").toBe(journals);
    expect(await W.countJournals(key)).toBe(1);
    expect((await postingOf(postingId)).source_gl_account_id).toBe(x);
  });

  it("[905-source-record-requester-refused] the person who requested the batch gets 403 PAYOUT_SOURCE_SELF_RECORD with the right password: no source, no journal; another approver records it once", async () => {
    const { held, batchId } = await heldCashWithoutSource();
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
    const journals = await journalCount();

    const refused = await postSource(requester, batchId, postingId, x);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error?.code).toBe("PAYOUT_SOURCE_SELF_RECORD");
    expect((await postingOf(postingId)).source_gl_account_id).toBe(null);
    expect(await journalCount()).toBe(journals);

    const ok = await postSource(finance, batchId, postingId, x);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await W.countJournals(held.journal_key as string)).toBe(1);
  });

  it("[905-source-record-non-cash-account-refused] an expense (8101) or a payable (2103) account is not a cash account: finance gets a 4xx, no source is stored and nothing is journaled", async () => {
    const { held, batchId } = await heldCashWithoutSource();
    const postingId = held.id as string;
    const journals = await journalCount();

    for (const code of ["8101", "2103"]) {
      const res = await postSource(
        finance,
        batchId,
        postingId,
        await accountId(code),
      );
      expect(
        res.status,
        `${code} ${JSON.stringify(res.body)}`,
      ).toBeGreaterThanOrEqual(400);
      expect(res.status, `${code} ${JSON.stringify(res.body)}`).toBeLessThan(
        500,
      );
    }
    expect((await postingOf(postingId)).source_gl_account_id).toBe(null);
    expect(await W.journalByKey(held.journal_key as string)).toBe(undefined);
    expect(await journalCount()).toBe(journals);
  });
});
