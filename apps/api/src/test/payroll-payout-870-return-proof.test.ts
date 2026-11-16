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
// - Re-uploading identical bytes yields a different key, but the proof is the
//   same: it is refused (see the "second-opinion F2" tests at the end, which use
//   the real upload service). Different bytes are a different proof and pass.
//
// Assumptions:
// - Which of B's two steps is refused is not specified; the test only requires
//   that the operation does not complete (at least one step refused with a 4xx
//   HttpError) and that the end state is unchanged.
// - Items and people: the first/second step users are APP and APP3 (any two
//   non-requesters work; they are the pair used by payroll-payout-gl.test.ts).
// - Cross-tenant/batch keys are already refused by the existing evidence tests
//   and are not repeated here.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { uploadPayoutEvidence } from "../services/payroll-payout-evidence-upload.service.ts";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
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
  store: ReturnType<typeof W.proofs> = W.proofs(),
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
      store,
    ),
  );
/** Both steps of one return operation. */
async function returnBothSteps(
  batchId: string,
  itemIds: string[],
  evidenceKey: string,
  store: ReturnType<typeof W.proofs> = W.proofs(),
) {
  await returnWith(batchId, itemIds, APP, evidenceKey, store);
  await returnWith(batchId, itemIds, APP3, evidenceKey, store);
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

// Real uploads (second-opinion 870 follow-up, F2). The fixture storage above
// fakes keys; here the REAL upload service writes to a storage that keeps the
// bytes, so identical bytes uploaded twice give two different UUID keys.
const real = (() => {
  const storage = new FakeObjectStorage();
  return {
    storage,
    store: () => ({ storage, context: W.scope() }),
  };
})();
/** A valid PDF; `label` plus a random marker make the bytes unique per call (fingerprints persist per tenant). */
const pdf = (label: string) =>
  validPdfBytes({ marker: `${label} ${randomUUID()}` });
const upload = async (batchId: string, bytes: Uint8Array) =>
  (
    await uploadPayoutEvidence(W.scope(), batchId, bytes, {
      storage: real.storage,
      scanner: new NoopMalwareScanner(),
    })
  ).evidenceKey;
/** A and B paid in one batch; A returned (both steps) with a REAL upload of `bytes`. Returns K. */
async function afterRealReturnOfA(bytes?: Uint8Array) {
  const paid = await paidBatch();
  const content = bytes ?? (await pdf("dana-kembali-A"));
  const k = await upload(paid.batchId, content);
  await returnBothSteps(paid.batchId, [idOf(paid.a)], k, real.store());
  expect((await W.itemOfPerson(paid.batchId, BUDI)).status, "premise").toBe(
    "returned",
  );
  return { ...paid, k, content };
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

  it("[w3691-control-different-bytes-accepted] a genuinely different proof (different PDF bytes, own upload) for B's own return operation is accepted: the binding is per proof content, not a ban on proofs", async () => {
    const { batchId, b } = await afterRealReturnOfA();
    const kB = await upload(batchId, await pdf("dana-kembali-B"));

    await returnBothSteps(batchId, [idOf(b)], kB, real.store());

    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("returned");
    expect(await W.journalByKey(returnKey(idOf(b)))).toEqual({
      "1103": { debit: SITI_NET, credit: 0 },
      "2103": { debit: 0, credit: SITI_NET },
    });
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Review round 1, F3 (P2): one proof must not free two payslips across flows.
//
// A proof K that resolved item C as failed (two-step resolve, K is C's
// resolution evidence) must not then return item B, and the reverse order
// (K returned B, then K resolves C) is refused as well. A proof used for
// several items inside ONE operation stays valid (control above).
//
// Assumptions: which step is refused is not specified; the operation must not
// complete (at least one step refused with a 4xx) and the end state is
// unchanged. Item C is left `exported` (no bank result) so it can be resolved;
// A and B are confirmed paid.
// ---------------------------------------------------------------------------

/** A, B paid (succeeded); C still exported, waiting for the bank result. */
async function paidAbPendingC() {
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
  await W.confirm(
    batchId,
    W.succeedItems(
      batchId,
      items.filter((i) => i.employee_id !== ANDI.id),
    ),
  );
  return {
    runId,
    batchId,
    a: await W.itemOfPerson(batchId, BUDI),
    b: await W.itemOfPerson(batchId, SITI),
    c: await W.itemOfPerson(batchId, ANDI),
  };
}

const resolveWith = (
  batchId: string,
  itemIds: string[],
  by: string,
  k: string,
) => W.resolve(batchId, itemIds, "failed", by, k);

describe("review F3: a proof is not reusable across resolve and return flows", () => {
  it("[f3-resolve-then-return] K resolved C as failed; a two-step return of B with the same K is refused: B stays succeeded, no return journal", async () => {
    const { batchId, b, c } = await paidAbPendingC();
    const k = uploadEvidence(batchId, "bukti-gagal-C.pdf");
    await resolveWith(batchId, [idOf(c)], APP, k);
    await resolveWith(batchId, [idOf(c)], APP3, k);
    expect((await W.itemOfPerson(batchId, ANDI)).status, "premise").toBe(
      "failed",
    );

    const failures = [
      await W.httpFailure(returnWith(batchId, [idOf(b)], APP, k)),
      await W.httpFailure(returnWith(batchId, [idOf(b)], APP3, k)),
    ];
    expect(
      failures.some((error) => error !== null),
      "a proof that already freed C must not return B",
    ).toBe(true);
    for (const error of failures.filter((e) => e !== null)) {
      expect(error!.status).toBeGreaterThanOrEqual(400);
      expect(error!.status).toBeLessThan(500);
    }
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(0);
  });

  it("[f3-return-then-resolve] K returned B; a two-step resolve of C as failed with the same K is refused: C stays exported (not freed for a second payment)", async () => {
    const { batchId, b, c } = await paidAbPendingC();
    const k = uploadEvidence(batchId, "dana-kembali-B.pdf");
    await returnBothSteps(batchId, [idOf(b)], k);
    expect((await W.itemOfPerson(batchId, SITI)).status, "premise").toBe(
      "returned",
    );

    const failures = [
      await W.httpFailure(resolveWith(batchId, [idOf(c)], APP, k)),
      await W.httpFailure(resolveWith(batchId, [idOf(c)], APP3, k)),
    ];
    expect(
      failures.some((error) => error !== null),
      "a proof that already returned B must not free C",
    ).toBe(true);
    for (const error of failures.filter((e) => e !== null)) {
      expect(error!.status).toBeGreaterThanOrEqual(400);
      expect(error!.status).toBeLessThan(500);
    }
    expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("exported");
  });
});

// Review round 2, F6: the same binding applies to payment confirmation. A key
// used by step 1 of a return of B must not be accepted as the payment proof of
// another exported item C. Assumptions: the confirmer is the second approver
// (APP3); the refusal is 409 PAYOUT_RETURN_PROOF_REUSED; the refused confirm
// leaves C exported, and the return of B can then be finished with the same K.
describe("review F6: a return proof is not reusable as a payment confirmation proof", () => {
  it("[f6-confirm-with-return-proof] K started the return of B; confirming exported C with K is refused (409 PAYOUT_RETURN_PROOF_REUSED), C stays exported; step 2 of B with K still succeeds with one return journal", async () => {
    const { batchId, b, c } = await paidAbPendingC();
    const k = uploadEvidence(batchId, "dana-kembali-B.pdf");
    await returnWith(batchId, [idOf(b)], APP, k);

    await W.expectRefused(
      W.confirm(
        batchId,
        [
          {
            itemId: idOf(c),
            result: "succeeded",
            bankRef: `BCA-${batchId.slice(0, 8)}-C`,
            evidenceKey: k,
          },
        ],
        APP3,
      ),
      { status: 409, code: "PAYOUT_RETURN_PROOF_REUSED" },
    );
    expect(
      (await W.itemOfPerson(batchId, ANDI)).status,
      "C is not marked paid with a return proof",
    ).toBe("exported");

    await returnWith(batchId, [idOf(b)], APP3, k);
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("returned");
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Review round 1, F4 (P3): the claims table has a write guard (like the GL
// postings guard). Only `open -> consumed` with consumed_at set and every
// other column unchanged is allowed; anything else raises 23514 with a
// message that starts with PAYOUT-31. The service flow itself (open ->
// consumed) is covered by the return tests above. Rewritten rows are
// attempted without disabling triggers (no session_replication_role).
// ---------------------------------------------------------------------------

describe("review F4: return claims cannot be rewritten", () => {
  async function consumedClaim() {
    const { batchId, k } = await afterReturnOfA();
    const [claim] = await W.rowsOf(
      `SELECT * FROM payroll_payout_return_claims WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, k],
    );
    expect(claim, "premise: the return left a claim").toBeDefined();
    expect(claim!.status, "premise: the claim is consumed").toBe("consumed");
    return { batchId, claim: claim! };
  }
  const update = (sql: string, params: unknown[]) =>
    W.asTenant((c) => c.query(sql, params)).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );

  it("[f4-reopen-consumed] reopening a consumed claim (status open, consumed_at null) raises PAYOUT-31 / 23514", async () => {
    const { claim } = await consumedClaim();
    const error = await update(
      `UPDATE payroll_payout_return_claims SET status = 'open', consumed_at = NULL WHERE id = $1`,
      [claim.id],
    );
    expect(error, "the write must be rejected").not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toContain("PAYOUT-31");
    const [after] = await W.rowsOf(
      `SELECT status FROM payroll_payout_return_claims WHERE id = $1`,
      [claim.id],
    );
    expect(after!.status).toBe("consumed");
  });

  it("[f4-rebind-claim] rewriting the proof key, item-set hash or owner of a claim raises PAYOUT-31 / 23514", async () => {
    const { claim } = await consumedClaim();
    for (const [column, value] of [
      ["evidence_key", `${claim.evidence_key as string}-other`],
      ["item_set_hash", "a".repeat(64)],
      ["created_by", "someone-else"],
    ] as const) {
      const error = await update(
        `UPDATE payroll_payout_return_claims SET ${column} = $2 WHERE id = $1`,
        [claim.id, value],
      );
      expect(error, `${column} must not change`).not.toBeNull();
      expect(error!.code).toBe("23514");
      expect(error!.message).toContain("PAYOUT-31");
    }
  });
});

// ---------------------------------------------------------------------------
// Second-opinion 870 follow-up, F2 (P2, legend-w3691): uploading the SAME proof
// bytes again must not bypass the return claim.
//
// Rule (decision of the brief): the proof is identified by the SHA-256 of the
// uploaded bytes, stored at upload time; a claim is refused when its proof
// fingerprint was already consumed by a return in the same tenant. Expected
// refusal: 409 PAYOUT_RETURN_PROOF_REUSED, nothing changes.
//
// Assumptions:
// - Which step of the second operation is refused is not specified: at least
//   one step must be refused, and every refusal must be that 409 code.
// - One bank report covering A and B returned in ONE operation (same item set)
//   stays valid (control b).
// - Legacy fixture keys (no stored fingerprint) are not touched by these tests.
// - Fingerprints persist per tenant, so every test uploads unique bytes.
// ---------------------------------------------------------------------------

// legend-so897: a return over the bytes of another return is refused by the
// proof binding (one proof = one operation), with its shared code
// PAYOUT_PROOF_REUSED; resolve and confirm keep PAYOUT_RETURN_PROOF_REUSED.
async function expectReuseRefused(
  steps: (() => Promise<unknown>)[],
  code = "PAYOUT_RETURN_PROOF_REUSED",
) {
  const failures: Awaited<ReturnType<typeof W.httpFailure>>[] = [];
  for (const step of steps) failures.push(await W.httpFailure(step()));
  expect(
    failures.some((error) => error !== null),
    "re-uploading the same bytes must not make a consumed proof usable again",
  ).toBe(true);
  for (const error of failures.filter((e) => e !== null)) {
    expect(error!.status).toBe(409);
    expect(error!.code).toBe(code);
  }
}

describe("second-opinion F2 (legend-w3691): a re-uploaded copy of a consumed return proof", () => {
  it("[so-f2-reupload-same-batch] A returned with K; the identical PDF uploaded again (K2) cannot return B: 409 PAYOUT_PROOF_REUSED, B stays succeeded, no return journal, not offered to a follow-up batch", async () => {
    const { runId, batchId, b, k, content } = await afterRealReturnOfA();
    const k2 = await upload(batchId, content);
    expect(k2, "premise: a new key for the same bytes").not.toBe(k);

    await expectReuseRefused(
      [
        () => returnWith(batchId, [idOf(b)], APP, k2, real.store()),
        () => returnWith(batchId, [idOf(b)], APP3, k2, real.store()),
      ],
      "PAYOUT_PROOF_REUSED",
    );

    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(0);
    const followUp = await W.createBatch(runId);
    expect((await W.itemsOf(followUp)).map((i) => i.employee_id)).toEqual([
      BUDI.id,
    ]);
  });

  it("[so-f2-reupload-other-batch] cross batch: the identical PDF uploaded to ANOTHER batch of the same tenant cannot return that batch's item: 409 PAYOUT_PROOF_REUSED, the item stays succeeded", async () => {
    const first = await afterRealReturnOfA();
    const other = await paidBatch();
    const k2 = await upload(other.batchId, first.content);

    await expectReuseRefused(
      [
        () => returnWith(other.batchId, [idOf(other.b)], APP, k2, real.store()),
        () =>
          returnWith(other.batchId, [idOf(other.b)], APP3, k2, real.store()),
      ],
      "PAYOUT_PROOF_REUSED",
    );

    expect((await W.itemOfPerson(other.batchId, SITI)).status).toBe(
      "succeeded",
    );
    expect(await W.countJournals(returnKey(idOf(other.b)))).toBe(0);
  });

  it("[so-f2-control-one-report-two-items] control: one real bank report K covering A and B returned in ONE operation is valid, each item journaled once", async () => {
    const { batchId, a, b, c } = await paidBatch();
    const k = await upload(batchId, await pdf("dana-kembali-AB"));

    await returnBothSteps(batchId, [idOf(a), idOf(b)], k, real.store());

    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("returned");
    expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("succeeded");
    expect(await W.countJournals(returnKey(idOf(a)))).toBe(1);
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(1);
    expect(await W.countJournals(returnKey(idOf(c)))).toBe(0);
  });

  it("[so-f2-reupload-as-payment-confirmation] the identical PDF of a consumed return proof, uploaded again (K2), is refused as the payment proof of another exported item: 409 PAYOUT_RETURN_PROOF_REUSED, the item stays exported", async () => {
    const { batchId, b, c } = await paidAbPendingC();
    const content = await pdf("dana-kembali-B");
    const k = await upload(batchId, content);
    await returnBothSteps(batchId, [idOf(b)], k, real.store());
    expect((await W.itemOfPerson(batchId, SITI)).status, "premise").toBe(
      "returned",
    );
    const k2 = await upload(batchId, content);

    await W.expectRefused(
      W.confirm(
        batchId,
        [
          {
            itemId: idOf(c),
            result: "succeeded",
            bankRef: `BCA-${batchId.slice(0, 8)}-C`,
            evidenceKey: k2,
          },
        ],
        APP3,
        real.store(),
      ),
      { status: 409, code: "PAYOUT_RETURN_PROOF_REUSED" },
    );
    expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("exported");
  });

  it("[so-f2-reupload-as-resolution] the identical PDF of a consumed return proof, uploaded again (K2), cannot resolve another exported item as failed: 409 PAYOUT_RETURN_PROOF_REUSED, the item stays exported", async () => {
    const { batchId, b, c } = await paidAbPendingC();
    const content = await pdf("dana-kembali-B");
    const k = await upload(batchId, content);
    await returnBothSteps(batchId, [idOf(b)], k, real.store());
    const k2 = await upload(batchId, content);

    await expectReuseRefused([
      () => W.resolve(batchId, [idOf(c)], "failed", APP, k2, real.store()),
      () => W.resolve(batchId, [idOf(c)], "failed", APP3, k2, real.store()),
    ]);

    expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("exported");
  });
});
