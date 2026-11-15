// Withdrawing a step-1 resolve proposal (bead legend-5rh26, brief "payout
// followups", card B). A first resolve step (item `exported`, resolved_by set,
// resolved_by_2 empty) can be taken back by its proposer or by another person
// holding payroll.disburse.approve:
//   POST /api/hris/payroll/disbursement-batches/:id/withdraw-resolution
//   body { itemIds: [...] }
// Rules under test:
// - the proposal columns (resolved_by, outcome, evidence key, note) go back to
//   NULL; the item stays `exported`, same attempt_no and idempotency key. The
//   slip is NOT freed: the live-item unique index still blocks a new attempt.
// - the proof object is never deleted; a legacy key whose object was never
//   uploaded can still be withdrawn (no existence check on withdraw).
// - after a withdraw, a new proposal with a correct proof runs to step 2.
// - a person without payroll.disburse.approve is refused (403), anonymous 401,
//   unknown batch 404, another tenant refused, a step-2 item refused.
// - the withdraw is audited.
//
// ASSUMPTIONS (the contract leaves them open):
// - route name `withdraw-resolution`, answers 200 on success.
// - service `withdrawResolutionProposal(tx, actor, batchId, { itemIds })` in
//   services/payroll-payout-withdraw.service.ts, same shape as
//   resolveManualItems; it checks no permission itself (the route does).
// - "refused" for a step-2 item or an item with no proposal is 409 or 422.
// - round 2 (CTO decisions): the batch requester (payroll_disbursement_batches.
//   requested_by, the fixture's REQ) cannot withdraw someone else's proposal;
//   the exact code is not fixed (PAYOUT-18 style or PAYOUT_REQUESTER_CANNOT_
//   WITHDRAW 403), so the test only requires a 4xx refusal and unchanged state.
// - round 2, migration 0367: the database guard lets exactly one rewrite
//   through (all four proposal columns NULL at once, exported, no step 2,
//   nothing else changed). Every other rewrite stays a 23514 check_violation.
//   The refusal cases pass before 0608 too; the control that clears all four
//   columns is the one that fails first.
// - the audit action name is unknown: any action containing "withdraw" that
//   mentions the batch id and carries the actor id.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FakeObjectStorage,
  type ObjectStorage,
} from "@starter/shared/adapters";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { withdrawResolutionProposal } from "../services/payroll-payout-withdraw.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import {
  BUDI,
  REQ,
  SITI,
  actorOf,
  bank,
  evidenceKeyFor,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("withdraw");
const BASE = "/api/hris/payroll/disbursement-batches";
const idOf = (row: Row) => row.id as string;

const store = new FakeObjectStorage();
const runtime: StorageRuntime = {
  storage: store,
  scanner: new NoopMalwareScanner(),
  fileSigner: async () => "https://signed.example.test/x",
  hrisDocumentSigner: async () => null,
};
const app = createApp({ storageRuntime: runtime });

const dbOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const grantedUsers: string[] = [];
const enrolledUsers: string[] = [];

type Staff = { client: ReturnType<typeof agent>; userId: string };
let first: Staff; // payroll.disburse.approve
let second: Staff; // another person with the same rights
let viewer: Staff; // payroll.view only

async function staff(permissions: string[]) {
  const client = agent(app);
  await signUp(client, "Payout Withdraw");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
  await W.grantRole(userId, permissions);
  const enrolled = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  enrolledUsers.push(userId);
  const { factorId, secretBase32 } = enrolled.body.data as {
    factorId: string;
    secretBase32: string;
  };
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  // A challenge older than the fresh-enrolment window: no password step-up.
  await dbOwner.query(
    "UPDATE mfa_factors SET created_at = now() - interval '1 day', verified_at = now() - interval '1 day' WHERE id = $1",
    [factorId],
  );
  const again = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({
      factorId,
      code: totpCode(secretBase32, totpStep(new Date()) + 1),
    });
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  return { client, userId } as Staff;
}

beforeAll(async () => {
  first = await staff(["payroll.view", "payroll.disburse.approve"]);
  second = await staff(["payroll.view", "payroll.disburse.approve"]);
  viewer = await staff(["payroll.view"]);
});
afterAll(async () => {
  if (enrolledUsers.length > 0)
    await dbOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  if (grantedUsers.length > 0)
    await dbOwner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [grantedUsers],
    );
  await dbOwner.end();
});

// ---- Helpers --------------------------------------------------------------

const pdfBytes = async () =>
  Buffer.from(await validPdfBytes({ marker: `bukti ${randomUUID()}` }));

async function uploadProof(who: Staff, batchId: string) {
  const res = await who.client
    .post(`${BASE}/${batchId}/evidence`)
    .set(originHeader)
    .attach("file", await pdfBytes(), {
      filename: "bukti.pdf",
      contentType: "application/pdf",
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.data as { evidenceKey: string }).evidenceKey;
}

async function exportedRun() {
  const slips = [bank(BUDI, 4_000_000), bank(SITI, 3_000_000)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const siti = (await W.itemOfPerson(batchId, SITI))!;
  const budi = (await W.itemOfPerson(batchId, BUDI))!;
  return { runId, batchId, siti, budi };
}

const postResolve = (
  who: Staff,
  batchId: string,
  itemId: string,
  evidenceKey: string,
  outcome = "failed",
) =>
  who.client
    .post(`${BASE}/${batchId}/resolve`)
    .set(originHeader)
    .send({
      itemIds: [itemId],
      outcome,
      evidenceKey,
      note: "Bank menolak transfer, tidak ada dana keluar",
    });
const postWithdraw = (who: Staff, batchId: string, itemIds: string[]) =>
  who.client
    .post(`${BASE}/${batchId}/withdraw-resolution`)
    .set(originHeader)
    .send({ itemIds });

const itemRow = async (batchId: string, itemId: string) =>
  (await W.itemsOf(batchId)).find((i) => i.id === itemId)!;

/** A step-1 proposal made through the API; returns the stored proof key. */
async function propose(who: Staff, batchId: string, itemId: string) {
  const key = await uploadProof(who, batchId);
  const res = await postResolve(who, batchId, itemId, key);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return key;
}

/** Only the proposal columns and nothing else of the money state. */
const moneyState = async (batchId: string) =>
  JSON.stringify({
    batch: (await W.batchById(batchId)).status,
    items: (await W.itemsOf(batchId)).map((i) => ({
      id: i.id,
      status: i.status,
      attempt_no: i.attempt_no,
      idempotency_key: i.idempotency_key,
      resolved_by_2: i.resolved_by_2,
    })),
    postings: (await W.postingsOf(batchId)).length,
  });

function expectProposalCleared(item: Row) {
  expect(item.status).toBe("exported");
  expect(item.resolved_by).toBeNull();
  expect(item.resolved_by_2).toBeNull();
  expect(item.resolution_outcome).toBeNull();
  expect(item.resolution_evidence_key).toBeNull();
  expect(item.resolution_note).toBeNull();
}

describe("legend-5rh26 withdraw a step-1 resolve proposal", () => {
  it("[5rh26-withdraw-proposer] the proposer withdraws: proposal columns go back to NULL, item stays exported with the same attempt and key, nothing else moves, the proof object stays", async () => {
    const { batchId, siti } = await exportedRun();
    const key = await propose(first, batchId, idOf(siti));
    const before = await itemRow(batchId, idOf(siti));
    expect(before.resolved_by).toBe(first.userId);
    const stateBefore = await moneyState(batchId);

    const res = await postWithdraw(first, batchId, [idOf(siti)]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await itemRow(batchId, idOf(siti));
    expectProposalCleared(after);
    expect(after.attempt_no).toBe(before.attempt_no);
    expect(after.idempotency_key).toBe(before.idempotency_key);
    expect(await moneyState(batchId)).toBe(stateBefore);
    // The proof is kept for the audit trail.
    const kept = await store.get(W.scope(), {
      tenantId: W.tenantId,
      outletId: null,
      reference: "payout-withdraw-test",
      key,
    } as never);
    expect(kept.content).toBeDefined();
  });

  it("[5rh26-withdraw-other-approver] another person holding payroll.disburse.approve can withdraw the proposal", async () => {
    const { batchId, siti } = await exportedRun();
    await propose(first, batchId, idOf(siti));
    const res = await postWithdraw(second, batchId, [idOf(siti)]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectProposalCleared(await itemRow(batchId, idOf(siti)));
  });

  it("[5rh26-withdraw-keeps-slip-blocked] after a withdraw the slip is not freed: a new batch is refused and the database still refuses a second live item for it", async () => {
    const { runId, batchId, siti } = await exportedRun();
    await propose(first, batchId, idOf(siti));
    const res = await postWithdraw(first, batchId, [idOf(siti)]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    await W.expectRefused(W.createBatch(runId), { status: 409 });
    const clone = await W.asTenant(async (c) => {
      try {
        await c.query(
          `CREATE TEMP TABLE withdraw_clone ON COMMIT DROP AS SELECT * FROM payroll_disbursement_items WHERE id = $1`,
          [idOf(siti)],
        );
        await c.query(
          `UPDATE withdraw_clone SET id = gen_random_uuid(), attempt_no = 99,
                  idempotency_key = 'payslip:' || payslip_id::text || ':attempt:99'`,
        );
        await c.query(
          `INSERT INTO payroll_disbursement_items SELECT * FROM withdraw_clone`,
        );
        return null;
      } catch (error) {
        return error as { code?: string; constraint?: string };
      }
      // Triggers off: only the unique index may refuse (the insert guard
      // would otherwise answer 23514 first, as an exported item never starts).
    }, true);
    expect(clone?.code).toBe("23505");
    expect(clone?.constraint).toBe(
      "payroll_disbursement_items_one_live_per_payslip",
    );
    // Still exactly the one live item of the slip.
    expect(
      (await W.itemsOf(batchId)).filter(
        (i) => i.payslip_id === siti.payslip_id,
      ),
    ).toHaveLength(1);
    expectProposalCleared(await itemRow(batchId, idOf(siti)));
  });

  it("[5rh26-new-proposal-after-withdraw] after a withdraw a new proposal with a correct proof reaches step 2: the item becomes failed with both people stored", async () => {
    const { batchId, siti } = await exportedRun();
    await propose(first, batchId, idOf(siti)); // wrong guess, taken back
    expect((await postWithdraw(first, batchId, [idOf(siti)])).status).toBe(200);

    const goodKey = await uploadProof(second, batchId);
    const step1 = await postResolve(second, batchId, idOf(siti), goodKey);
    expect(step1.status, JSON.stringify(step1.body)).toBe(200);
    expect((await itemRow(batchId, idOf(siti))).resolved_by).toBe(
      second.userId,
    );
    const step2 = await postResolve(first, batchId, idOf(siti), goodKey);
    expect(step2.status, JSON.stringify(step2.body)).toBe(200);

    const done = await itemRow(batchId, idOf(siti));
    expect(done.status).toBe("failed");
    expect(done.resolved_by).toBe(second.userId);
    expect(done.resolved_by_2).toBe(first.userId);
    expect(done.resolution_evidence_key).toBe(goodKey);
  });

  it("[5rh26-withdraw-legacy-unuploaded-key] a proposal whose proof key was never uploaded can still be withdrawn", async () => {
    const { batchId, siti } = await exportedRun();
    const ghostKey = evidenceKeyFor(W.tenantId, batchId, "never-uploaded.pdf");
    // Legacy row: step 1 recorded when the key was not yet checked against
    // storage. A store that knows every key stands in for that old rule.
    const lenient = {
      storage: {
        async get(_ctx: unknown, input: Record<string, unknown>) {
          return { ...input, contentType: "application/pdf", content: "" };
        },
      } as unknown as ObjectStorage,
      context: W.scope(),
    };
    await W.resolve(
      batchId,
      [idOf(siti)],
      "failed",
      first.userId,
      ghostKey,
      lenient,
    );
    expect((await itemRow(batchId, idOf(siti))).resolution_evidence_key).toBe(
      ghostKey,
    );

    const res = await postWithdraw(second, batchId, [idOf(siti)]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectProposalCleared(await itemRow(batchId, idOf(siti)));
  });

  it("[5rh26-withdraw-guard] payroll.view alone gets 403, anonymous 401, an unknown batch 404; the proposal stays", async () => {
    const { batchId, siti } = await exportedRun();
    await propose(first, batchId, idOf(siti));
    const before = await moneyState(batchId);

    const denied = await postWithdraw(viewer, batchId, [idOf(siti)]);
    expect(denied.status).toBe(403);
    const anonymous = await postWithdraw(
      { client: agent(app), userId: "" },
      batchId,
      [idOf(siti)],
    );
    expect(anonymous.status).toBe(401);
    const unknown = await postWithdraw(second, randomUUID(), [idOf(siti)]);
    expect(unknown.status).toBe(404);

    const item = await itemRow(batchId, idOf(siti));
    expect(item.resolved_by).toBe(first.userId);
    expect(item.resolution_outcome).toBe("failed");
    expect(await moneyState(batchId)).toBe(before);
  });

  it("[5rh26-withdraw-step2-refused] an item already at step 2 cannot be withdrawn: refused 409 or 422, nothing changes", async () => {
    const { batchId, siti } = await exportedRun();
    const key = await propose(first, batchId, idOf(siti));
    const step2 = await postResolve(second, batchId, idOf(siti), key);
    expect(step2.status, JSON.stringify(step2.body)).toBe(200);
    const done = await itemRow(batchId, idOf(siti));
    expect(done.status).toBe("failed");
    const before = JSON.stringify(done);

    for (const who of [first, second]) {
      const res = await postWithdraw(who, batchId, [idOf(siti)]);
      expect([409, 422], JSON.stringify(res.body)).toContain(res.status);
    }
    expect(JSON.stringify(await itemRow(batchId, idOf(siti)))).toBe(before);
  });

  it("[5rh26-withdraw-nothing-proposed] an exported item with no proposal has nothing to withdraw: refused 409 or 422, item untouched", async () => {
    const { batchId, budi } = await exportedRun();
    const before = JSON.stringify(await itemRow(batchId, idOf(budi)));
    const res = await postWithdraw(first, batchId, [idOf(budi)]);
    expect([409, 422], JSON.stringify(res.body)).toContain(res.status);
    expect(JSON.stringify(await itemRow(batchId, idOf(budi)))).toBe(before);
  });

  it("[5rh26-withdraw-other-tenant] a caller in another tenant cannot withdraw this tenant's proposal: refused 403 or 404 and the proposal stays", async () => {
    const { batchId, siti } = await exportedRun();
    await propose(first, batchId, idOf(siti));
    const before = JSON.stringify(await itemRow(batchId, idOf(siti)));

    const otherTenantId = tenantIdSchema.parse(randomUUID());
    const otherScope = establishScopedTenantContext(
      establishTenantContext({
        tenantId: otherTenantId,
        brandId: null,
        source: "domain",
      }),
      { kind: "tenant" },
    );
    const error = await W.httpFailure(
      withTenant(db, otherScope, (tx) =>
        withdrawResolutionProposal(
          tx,
          { ...actorOf(second.userId), tenantId: otherTenantId },
          batchId,
          { itemIds: [idOf(siti)] } as never,
        ),
      ),
    );
    expect(error, "the call must be refused").not.toBeNull();
    expect([403, 404]).toContain(error!.status);
    expect(JSON.stringify(await itemRow(batchId, idOf(siti)))).toBe(before);
  });

  it("[5rh26-withdraw-audit] a withdraw is audited with the actor and the batch", async () => {
    const { batchId, siti } = await exportedRun();
    await propose(first, batchId, idOf(siti));
    const res = await postWithdraw(second, batchId, [idOf(siti)]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const rows = await W.rowsOf(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1
          AND event->>'action' ILIKE '%withdraw%'
          AND event::text LIKE '%' || $2 || '%'`,
      [W.tenantId, batchId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(
      rows.some(
        (r) => (r.event as { actorId?: string }).actorId === second.userId,
      ),
    ).toBe(true);
  });

  it("[5rh26-withdraw-requester-refused] the batch requester cannot withdraw another person's proposal: refused 4xx, proposal and money state unchanged", async () => {
    const { batchId, siti } = await exportedRun();
    await propose(first, batchId, idOf(siti));
    const before = JSON.stringify(await itemRow(batchId, idOf(siti)));
    const state = await moneyState(batchId);
    expect((await W.batchById(batchId)).requested_by).toBe(REQ);

    await W.expectRefused(
      W.inTx((tx) =>
        withdrawResolutionProposal(tx, actorOf(REQ), batchId, {
          itemIds: [idOf(siti)],
        } as never),
      ),
      { status: 403 },
    );
    expect(JSON.stringify(await itemRow(batchId, idOf(siti)))).toBe(before);
    expect(await moneyState(batchId)).toBe(state);
    expect((await itemRow(batchId, idOf(siti))).resolved_by).toBe(first.userId);
  });
});

// ---- Database guard (migration 0367) ---------------------------------------
// Direct UPDATEs on the item row with the triggers on (the pool owner is a
// superuser; triggers still fire). Only the one withdraw shape may pass.

type PgError = { code?: string; constraint?: string; message?: string };
const pgFailure = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error as PgError,
  );
const CLEAR_ALL = `resolved_by = NULL, resolution_outcome = NULL, resolution_evidence_key = NULL, resolution_note = NULL`;
/** UPDATE one item; $1 is the id, extra values start at $2. */
const dbUpdate = (itemId: string, set: string, values: unknown[] = []) =>
  pgFailure(
    W.asTenant((c) =>
      c.query(`UPDATE payroll_disbursement_items SET ${set} WHERE id = $1`, [
        itemId,
        ...values,
      ]),
    ),
  );
/** Same, with the triggers off: only to build a state the API cannot reach. */
const forceItem = (itemId: string, set: string, values: unknown[] = []) =>
  W.asTenant(
    (c) =>
      c.query(`UPDATE payroll_disbursement_items SET ${set} WHERE id = $1`, [
        itemId,
        ...values,
      ]),
    true,
  );

async function proposedItem() {
  const { batchId, siti } = await exportedRun();
  await propose(first, batchId, idOf(siti));
  const item = await itemRow(batchId, idOf(siti));
  expect(item.status).toBe("exported");
  expect(item.resolved_by).toBe(first.userId);
  expect(item.resolved_by_2).toBeNull();
  return { batchId, itemId: idOf(siti), before: JSON.stringify(item) };
}

describe("migration 0367 database guard on the withdraw", () => {
  it("[0608-db-clear-all-passes] control: clearing all four proposal columns on an exported item with no step 2 passes; status and the rest stay; clearing again is a no-op", async () => {
    const { batchId, itemId, before } = await proposedItem();
    const error = await dbUpdate(itemId, CLEAR_ALL);
    expect(error, error?.message).toBeNull();

    const after = await itemRow(batchId, itemId);
    expectProposalCleared(after);
    const was = JSON.parse(before) as Row;
    expect(after.attempt_no).toBe(was.attempt_no);
    expect(after.idempotency_key).toBe(was.idempotency_key);
    expect(after.resolved_by_2).toBeNull();

    // Nothing proposed any more: the same statement changes no column.
    expect(await dbUpdate(itemId, CLEAR_ALL)).toBeNull();
    expectProposalCleared(await itemRow(batchId, itemId));
  });

  it("[0608-db-partial-clear-refused] clearing only some of the four columns is refused 23514 and the row is unchanged", async () => {
    const { itemId, batchId, before } = await proposedItem();
    const cols = [
      "resolved_by",
      "resolution_outcome",
      "resolution_evidence_key",
      "resolution_note",
    ];
    const sets = [
      ...cols.map((c) => `${c} = NULL`),
      ...cols.map((skip) =>
        cols
          .filter((c) => c !== skip)
          .map((c) => `${c} = NULL`)
          .join(", "),
      ),
      "resolved_by = NULL, resolution_outcome = NULL",
    ];
    for (const set of sets) {
      const error = await dbUpdate(itemId, set);
      expect(error?.code, set).toBe("23514");
    }
    expect(JSON.stringify(await itemRow(batchId, itemId))).toBe(before);
  });

  it("[0608-db-clear-with-status-change-refused] clearing the four columns together with a status change is refused 23514", async () => {
    const { itemId, batchId, before } = await proposedItem();
    for (const status of ["failed", "not_sent", "approved", "succeeded"]) {
      const error = await dbUpdate(
        itemId,
        `${CLEAR_ALL}, status = '${status}'`,
      );
      expect(error?.code, status).toBe("23514");
    }
    expect(JSON.stringify(await itemRow(batchId, itemId))).toBe(before);
  });

  it("[0608-db-clear-after-step2-refused] clearing once step two exists is refused 23514, whether step two stays or goes too; a finished (failed) item is refused as well", async () => {
    const { itemId, batchId } = await proposedItem();
    // An exported item that already carries a second person (triggers off).
    await forceItem(itemId, `resolved_by_2 = $2`, [second.userId]);
    const mid = JSON.stringify(await itemRow(batchId, itemId));
    expect((await dbUpdate(itemId, CLEAR_ALL))?.code, "step 2 stays").toBe(
      "23514",
    );
    expect(
      (await dbUpdate(itemId, `${CLEAR_ALL}, resolved_by_2 = NULL`))?.code,
      "step 2 cleared too",
    ).toBe("23514");
    expect(JSON.stringify(await itemRow(batchId, itemId))).toBe(mid);

    // A real step two through the API: the item is failed and final.
    const run = await exportedRun();
    const key = await propose(first, run.batchId, idOf(run.siti));
    const step2 = await postResolve(second, run.batchId, idOf(run.siti), key);
    expect(step2.status, JSON.stringify(step2.body)).toBe(200);
    const done = JSON.stringify(await itemRow(run.batchId, idOf(run.siti)));
    expect(JSON.parse(done).status).toBe("failed");
    expect((await dbUpdate(idOf(run.siti), CLEAR_ALL))?.code).toBe("23514");
    expect(
      (await dbUpdate(idOf(run.siti), `${CLEAR_ALL}, resolved_by_2 = NULL`))
        ?.code,
    ).toBe("23514");
    expect(JSON.stringify(await itemRow(run.batchId, idOf(run.siti)))).toBe(
      done,
    );
  });

  it("[0608-db-clear-unknown-refused] clearing a proposal on an item whose status is unknown is refused 23514 (the withdraw is for exported items only)", async () => {
    const { itemId, batchId } = await proposedItem();
    await forceItem(itemId, `status = 'unknown'`);
    const before = JSON.stringify(await itemRow(batchId, itemId));
    expect(JSON.parse(before).status).toBe("unknown");
    expect((await dbUpdate(itemId, CLEAR_ALL))?.code).toBe("23514");
    expect(JSON.stringify(await itemRow(batchId, itemId))).toBe(before);
  });

  it("[0608-db-clear-with-other-column-refused] clearing together with a change to any other column is refused 23514", async () => {
    const { itemId, batchId, before } = await proposedItem();
    const others = [
      `provider_ref = 'WD-OTHER-1'`,
      `settled_at = now()`,
      `confirmation_ref = 'WD-OTHER-2'`,
    ];
    for (const other of others) {
      const error = await dbUpdate(itemId, `${CLEAR_ALL}, ${other}`);
      expect(error?.code, other).toBe("23514");
    }
    expect(JSON.stringify(await itemRow(batchId, itemId))).toBe(before);
  });

  it("[0608-db-rewrite-refused] rewriting a recorded proposal (to another person, outcome, proof or note) is still refused 23514", async () => {
    const { itemId, batchId, before } = await proposedItem();
    const rewrites: [string, string, unknown[]][] = [
      ["another person", `resolved_by = $2`, [second.userId]],
      ["another outcome", `resolution_outcome = 'not_sent'`, []],
      ["another proof", `resolution_evidence_key = $2`, ["evidence/other.pdf"]],
      ["another note", `resolution_note = $2`, ["catatan lain"]],
      [
        "clear then write another person",
        `resolved_by = $2, resolution_outcome = NULL, resolution_evidence_key = NULL, resolution_note = NULL`,
        [second.userId],
      ],
    ];
    for (const [name, set, values] of rewrites) {
      const error = await dbUpdate(itemId, set, values);
      expect(error?.code, name).toBe("23514");
    }
    expect(JSON.stringify(await itemRow(batchId, itemId))).toBe(before);
  });
});
