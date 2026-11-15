// Second-opinion finding legend-w3691 (P2): a return payment proof must be
// bound to ONE return operation, not reusable for another.
//
// Scenario: A and B were paid in the same batch; only A's funds came back. Two
// authorised people (not the batch requester) finish the return of A with proof
// K, then use the same K for a two-step return of B. The only existing check
// is that the proof object exists in the batch folder and both steps use the
// same key, so B was marked `returned` and got a return journal although its
// money never came back; as `returned` it left the one-live-attempt index and
// could be paid a second time in a follow-up batch.
//
// Decision (final): a proof is bound to one return operation (the item set and
// the total funds) and consumed atomically.
// - After the return of A with K is done, a two-step return of B with K is
//   rejected: B stays `succeeded`, no return journal for B, and B is not
//   offered to a follow-up batch.
// - Control: ONE proof K for several items in the SAME operation (same request,
//   both steps) stays valid and journals every item exactly once (a bank result
//   report with several rows is legitimate, design 296).
// - Control: uploading identical bytes again yields a different key (fixtures
//   model it as another file name). That is not a bypass of the binding: B with
//   the new key K2 is its own operation and passes.
//
// Assumptions:
// - Which of B's two steps is refused is not specified; the test only requires
//   that the operation does not complete (at least one step refused with a 4xx
//   HttpError) and that the end state is unchanged.
// - Items and people: the first/second step users are APP and APP3 (any two
//   non-requesters work; they are the pair used by payroll-payout-gl.test.ts).
// - Cross-tenant/batch keys are already refused by the existing evidence tests
//   and are not repeated here.
import { describe, expect, it } from "vitest";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import {
  ANDI,
  APP,
  APP3,
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("870proof");

const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const idOf = (row: Row) => row.id as string;
const returnKey = (itemId: string) => `payroll-payout-return:${itemId}`;

const returnWith = (
  batchId: string,
  itemIds: string[],
  by: string,
  evidenceKey: string,
) =>
  W.inTx((tx) =>
    returnManualItems(
      tx,
      actorOf(by),
      batchId,
      {
        itemIds,
        evidenceKey,
        note: "Bank mengembalikan dana, rekening tujuan ditutup",
      } as never,
      W.proofs(),
    ),
  );
/** Both steps of one return operation. */
async function returnBothSteps(
  batchId: string,
  itemIds: string[],
  evidenceKey: string,
) {
  await returnWith(batchId, itemIds, APP, evidenceKey);
  await returnWith(batchId, itemIds, APP3, evidenceKey);
}

/** Three items paid in one batch (Budi = A, Siti = B, Andi = C). */
async function paidBatch() {
  const slips = [
    bank(BUDI, BUDI_NET),
    bank(SITI, SITI_NET),
    bank(ANDI, ANDI_NET),
  ];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  return {
    runId,
    batchId,
    a: await W.itemOfPerson(batchId, BUDI),
    b: await W.itemOfPerson(batchId, SITI),
    c: await W.itemOfPerson(batchId, ANDI),
  };
}

/** Return of A is done with proof K; returns the K and the batch. */
async function afterReturnOfA() {
  const paid = await paidBatch();
  const k = uploadEvidence(paid.batchId, "dana-kembali-A.pdf");
  await returnBothSteps(paid.batchId, [idOf(paid.a)], k);
  expect((await W.itemOfPerson(paid.batchId, BUDI)).status).toBe("returned");
  return { ...paid, k };
}

describe("legend-w3691: a return proof is bound to one return operation", () => {
  it("[w3691-proof-not-reusable] after the return of A with proof K, a two-step return of B with the same K is rejected: B stays succeeded, no return journal for B", async () => {
    const { batchId, b, k } = await afterReturnOfA();

    const failures = [
      await W.httpFailure(returnWith(batchId, [idOf(b)], APP, k)),
      await W.httpFailure(returnWith(batchId, [idOf(b)], APP3, k)),
    ];
    expect(
      failures.some((error) => error !== null),
      "reusing the consumed proof for another item must be refused",
    ).toBe(true);
    for (const error of failures.filter((e) => e !== null)) {
      expect(error!.status).toBeGreaterThanOrEqual(400);
      expect(error!.status).toBeLessThan(500);
    }

    const row = await W.itemOfPerson(batchId, SITI);
    expect(row.status, "B's funds never came back").toBe("succeeded");
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(0);
    // A's own return is intact and journaled once.
    expect(
      await W.countJournals(
        returnKey(idOf(await W.itemOfPerson(batchId, BUDI))),
      ),
    ).toBe(1);
  });

  it("[w3691-no-second-payment] B is not offered to a follow-up batch after the replay: only A (really returned) is paid again", async () => {
    const { runId, batchId, b, k } = await afterReturnOfA();
    await W.httpFailure(returnWith(batchId, [idOf(b)], APP, k));
    await W.httpFailure(returnWith(batchId, [idOf(b)], APP3, k));

    const followUp = await W.createBatch(runId);
    const items = await W.itemsOf(followUp);
    expect(items.map((i) => i.employee_id)).toEqual([BUDI.id]);
    expect(
      (await W.itemOfPerson(batchId, SITI)).status,
      "B keeps its single successful payment",
    ).toBe("succeeded");
  });

  it("[w3691-control-one-proof-several-items] one proof K for A and B in the SAME operation stays valid: both returned, each journaled exactly once with its own net", async () => {
    const { batchId, a, b, c } = await paidBatch();
    const k = uploadEvidence(batchId, "dana-kembali-AB.pdf");

    await returnBothSteps(batchId, [idOf(a), idOf(b)], k);

    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("returned");
    expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("succeeded");
    expect(await W.journalByKey(returnKey(idOf(a)))).toEqual({
      "1103": { debit: BUDI_NET, credit: 0 },
      "2103": { debit: 0, credit: BUDI_NET },
    });
    expect(await W.journalByKey(returnKey(idOf(b)))).toEqual({
      "1103": { debit: SITI_NET, credit: 0 },
      "2103": { debit: 0, credit: SITI_NET },
    });
    expect(await W.countJournals(returnKey(idOf(c)))).toBe(0);
    expect(await W.countJournals(returnKey(idOf(a)))).toBe(1);
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(1);
  });

  it("[w3691-control-new-key-new-operation] a re-uploaded proof has a different key (K2); B returned in its own operation with K2 passes, so the binding is per operation, not a ban on proofs", async () => {
    const { batchId, b, k } = await afterReturnOfA();
    const k2 = uploadEvidence(batchId, "dana-kembali-A-unggah-ulang.pdf");
    expect(k2).not.toBe(k);

    await returnBothSteps(batchId, [idOf(b)], k2);

    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("returned");
    expect(await W.journalByKey(returnKey(idOf(b)))).toEqual({
      "1103": { debit: SITI_NET, credit: 0 },
      "2103": { debit: 0, credit: SITI_NET },
    });
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(1);
  });
});
