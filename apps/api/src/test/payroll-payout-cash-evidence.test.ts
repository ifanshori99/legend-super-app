// Cash handover takes no payment proof (bead legend-styqg; payout followups,
// card A). Rule: cash changes hands in person, so a handover that carries an
// `evidenceKey` (any non-null string) is refused 422 and nothing moves; a
// handover with no key (undefined or null) still succeeds and the item's
// `confirmation_evidence_key` stays NULL.
//
// Assumptions (card silent, stated so the engineer can contest them):
// - Only the status 422 is asserted for the refusal, not the error code (the
//   card allows PAYOUT_ITEMS_INVALID or any existing fitting code).
// - An empty-string key counts as non-null and is refused too.
// - The rule is exercised at the service call `confirmCashHandover` through
//   the shared fixture helper `handover`, with the same actors the other
//   cash tests use (REQ requests, APP approves, APP2 hands over).
import { describe, expect, it } from "vitest";
import {
  APP,
  CASHIER,
  SITI,
  cash,
  evidenceKeyFor,
  installPayoutWorld,
  uploadEvidence,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("cashev");

/** Everything a handover could change: batch, run, items, paid events. */
async function moneyState(runId: string, batchId: string) {
  return JSON.stringify({
    batch: (await W.batchById(batchId)).status,
    run: (await W.runRow(runId)).status,
    items: (await W.itemsOf(batchId)).map((i) => ({
      id: i.id,
      status: i.status,
      confirmed_by: i.confirmed_by,
      settled_at: i.settled_at,
      confirmation_evidence_key: i.confirmation_evidence_key,
    })),
    paid: (await W.paidEventsOf(runId)).length,
  });
}

async function approvedCashBatch() {
  const runId = await W.seedRun([cash(CASHIER, 2_000_000)]);
  const batchId = await W.approvedBatch(runId, "cash");
  const [item] = await W.itemsOf(batchId);
  return { runId, batchId, itemId: item!.id as string };
}

describe("legend-styqg cash handover refuses a payment proof key", () => {
  it("[legend-styqg-uploaded-key-refused] a handover with an uploaded proof key is refused 422 and nothing changes", async () => {
    const { runId, batchId, itemId } = await approvedCashBatch();
    const key = uploadEvidence(batchId);
    const before = await moneyState(runId, batchId);

    await W.expectRefused(W.handover(batchId, [itemId], undefined, key), {
      status: 422,
    });

    expect(await moneyState(runId, batchId)).toBe(before);
    const [item] = await W.itemsOf(batchId);
    expect(item!.status).toBe("approved");
    expect(item!.confirmation_evidence_key).toBeNull();
    expect((await W.batchById(batchId)).status).toBe("approved");
  });

  it("[legend-styqg-any-key-refused] a well-formed key with no stored object, and an empty string, are refused 422 too", async () => {
    const { runId, batchId, itemId } = await approvedCashBatch();
    const before = await moneyState(runId, batchId);
    const unstored = evidenceKeyFor(
      // same folder the proof storage would accept, but never uploaded
      (await W.batchById(batchId)).tenant_id as string,
      batchId,
      "tidak-pernah-diunggah.pdf",
    );

    for (const key of [unstored, ""]) {
      await W.expectRefused(W.handover(batchId, [itemId], undefined, key), {
        status: 422,
      });
      expect(await moneyState(runId, batchId)).toBe(before);
    }
  });

  it("[legend-styqg-retry-without-key] after the refusal the same handover without a key succeeds and the proof column stays NULL", async () => {
    const { runId, batchId, itemId } = await approvedCashBatch();
    await W.expectRefused(
      W.handover(batchId, [itemId], undefined, uploadEvidence(batchId)),
      { status: 422 },
    );

    await W.handover(batchId, [itemId], APP);

    const [item] = await W.itemsOf(batchId);
    expect(item!.status).toBe("succeeded");
    expect(item!.confirmed_by).toBe(APP);
    expect(item!.settled_at).not.toBeNull();
    expect(item!.confirmation_evidence_key).toBeNull();
    expect((await W.batchById(batchId)).status).toBe("completed");
    expect((await W.runRow(runId)).status).toBe("paid");
  });

  it("[legend-styqg-no-key-succeeds] a handover without a key (omitted) succeeds and confirmation_evidence_key is NULL", async () => {
    const { batchId, itemId } = await approvedCashBatch();

    await W.handover(batchId, [itemId], APP);

    const [item] = await W.itemsOf(batchId);
    expect(item!.status).toBe("succeeded");
    expect(item!.confirmation_evidence_key).toBeNull();
    expect((await W.batchById(batchId)).status).toBe("completed");
  });

  it("[legend-styqg-null-key-succeeds] a handover with evidenceKey null succeeds and confirmation_evidence_key is NULL", async () => {
    const { batchId, itemId } = await approvedCashBatch();

    await W.handover(batchId, [itemId], APP, null as never);

    const [item] = await W.itemsOf(batchId);
    expect(item!.status).toBe("succeeded");
    expect(item!.confirmation_evidence_key).toBeNull();
    expect((await W.batchById(batchId)).status).toBe("completed");
  });

  it("[legend-styqg-partial-batch] a refused handover of one of two items moves neither item; the keyless retry settles only the chosen one with NULL proof", async () => {
    const runId = await W.seedRun([
      cash(CASHIER, 2_000_000),
      cash(SITI, 1_000_000),
    ]);
    const batchId = await W.approvedBatch(runId, "cash");
    const items = await W.itemsOf(batchId);
    const [first, second] = items.map((i) => i.id as string);
    const before = await moneyState(runId, batchId);

    await W.expectRefused(
      W.handover(
        batchId,
        [first!, second!],
        undefined,
        uploadEvidence(batchId),
      ),
      { status: 422 },
    );
    expect(await moneyState(runId, batchId)).toBe(before);

    await W.handover(batchId, [first!], APP);
    const after = await W.itemsOf(batchId);
    const byId = new Map(after.map((i) => [i.id as string, i]));
    expect(byId.get(first!)!.status).toBe("succeeded");
    expect(byId.get(first!)!.confirmation_evidence_key).toBeNull();
    expect(byId.get(second!)!.status).toBe("approved");
    expect(byId.get(second!)!.confirmation_evidence_key).toBeNull();
  });
});
