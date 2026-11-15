// Second-opinion final payout area (bead legend-8vcsg, two P2 proof findings;
// docs/qa/second-opinion-payout-area-final.md). Written fail-first from the
// finding text and the CTO decision of brief 888, not from the implementation.
//
// Finding 1 (P2): a stored image proof can be re-uploaded with a different
// fingerprint. A JPEG with EXIF is uploaded (original bytes O) and stored
// re-encoded (bytes S, no EXIF). It is used as the proof of return A. Someone
// downloads S and uploads it again: the new upload has original hash H(S),
// which differs from the claim's H(O), so the claim did not recognise the same
// proof and B could be returned (and paid again) although its money never came
// back. Decision: store and check the hash of the original bytes AND of the
// stored bytes; a claim is refused when EITHER matches a proof already used.
//
// Finding 2 (P2): proofs from before migration 0382 have no fingerprint. A
// byte-identical re-upload after the migration gets a new fingerprint that is
// not linked to the old claim. Decision: a backfill job fingerprints the stored
// objects; while a tenant's backfill is not finished, confirming a return with a
// NEW proof is refused (fail closed); after the backfill a re-upload of an old
// proof is refused; a legitimate proof (a legacy multi-item operation, or a
// genuinely different file) is still accepted.
//
// Assumptions (the finding is silent, stated so they can be contested):
// - Refusal of a re-uploaded copy is 409 PAYOUT_PROOF_REUSED for a return (the
//   proof binding of legend-so897 refuses first) and the existing 409
//   PAYOUT_RETURN_PROOF_REUSED for a resolution or confirmation. Which of the two steps of the
//   second operation is refused is not pinned: at least one is, every refusal is
//   that code, and the end state is unchanged.
// - The fail-closed refusal while the backfill is not finished is any 4xx/5xx
//   HttpError (the code is not pinned); nothing is recorded: the item stays
//   `succeeded`, no return journal, no claim for the new key.
// - "Backfill not finished for the tenant" is derived from data: the tenant has a
//   return claim without a stored fingerprint (what a pre-0382 claim looks like).
//   The test builds that state from a real return and then erases every
//   `*sha256*` column of that claim and its evidence_files row as the table
//   owner with triggers off (session_replication_role = replica), which is
//   exactly the shape migration 0382 left behind.
// - The backfill job is
//   `apps/api/src/worker/payout-evidence-backfill.job.ts` exporting
//   `runPayoutEvidenceBackfillSweep(context, now, { storage })` (pattern of
//   payout-gl-recovery.job.ts). It reads the stored objects through `storage`,
//   writes the fingerprints and clears the pending state. A name mismatch is a
//   mismatch to adapt, not a behavior difference.
// - Every test uploads unique bytes (random pixels / unique marker), because
//   fingerprints persist per tenant. The legacy tests always run the backfill
//   in `finally`, so a failing run does not leave the tenant "pending" for the
//   tests after it. Real uploads only (no fixture keys) in this file.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import sharp from "sharp";
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
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("888fp");

const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const idOf = (row: Row) => row.id as string;
const returnKey = (itemId: string) => `payroll-payout-return:${itemId}`;
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const real = (() => {
  const storage = new FakeObjectStorage();
  return {
    storage,
    store: () => ({ storage, context: W.scope() }),
  };
})();

const upload = async (batchId: string, bytes: Uint8Array) =>
  (
    await uploadPayoutEvidence(W.scope(), batchId, bytes, {
      storage: real.storage,
      scanner: new NoopMalwareScanner(),
    })
  ).evidenceKey;
const storedBytes = async (key: string) =>
  Buffer.from(
    (
      await real.storage.get(W.scope(), {
        tenantId: W.tenantId,
        outletId: null,
        reference: "payout-888-fingerprint-test",
        key,
      } as never)
    ).content as Uint8Array,
  );

const pdf = (label: string) =>
  validPdfBytes({ marker: `${label} ${randomUUID()}` });

const SECRET_EXIF = "rahasia-lokasi-pegawai";
/** A JPEG with EXIF text and random pixels: unique bytes AND unique re-encoded bytes. */
const noisyJpeg = (withExif = true) => {
  const width = 32;
  const height = 32;
  const image = sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  });
  return (
    withExif
      ? image.withExif({
          IFD0: { ImageDescription: SECRET_EXIF, Copyright: SECRET_EXIF },
        })
      : image
  )
    .jpeg({ quality: 90 })
    .toBuffer();
};

const returnWith = (
  batchId: string,
  itemIds: string[],
  by: string,
  evidenceKey: string,
  store: ReturnType<typeof W.proofs> = real.store(),
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
async function returnBothSteps(
  batchId: string,
  itemIds: string[],
  evidenceKey: string,
) {
  await returnWith(batchId, itemIds, APP, evidenceKey);
  await returnWith(batchId, itemIds, APP3, evidenceKey);
}

/** Budi (A), Siti (B), Andi (C) paid in one batch. */
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
  // The payment proofs of the setup are fixture keys: the fixture store knows them.
  await W.confirm(batchId, W.succeedItems(batchId, items));
  return {
    runId,
    batchId,
    a: await W.itemOfPerson(batchId, BUDI),
    b: await W.itemOfPerson(batchId, SITI),
    c: await W.itemOfPerson(batchId, ANDI),
  };
}

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

/**
 * At least one step is refused, and every refusal is 409 PAYOUT_PROOF_REUSED
 * (legend-so897: the proof binding of a return refuses first). A resolution is
 * not bound and keeps the return-proof code.
 */
async function expectReuseRefused(
  steps: (() => Promise<unknown>)[],
  code = "PAYOUT_PROOF_REUSED",
) {
  const failures: Awaited<ReturnType<typeof W.httpFailure>>[] = [];
  for (const step of steps) failures.push(await W.httpFailure(step()));
  expect(
    failures.some((error) => error !== null),
    "a re-uploaded copy of a used proof must not be usable again",
  ).toBe(true);
  for (const error of failures.filter((e) => e !== null)) {
    expect(error!.status).toBe(409);
    expect(error!.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Finding 1: the proof is the same file even after the upload re-encoded it.
// ---------------------------------------------------------------------------

/** A returned (both steps) with a real EXIF JPEG; K is its key, `stored` the re-encoded bytes. */
async function afterJpegReturnOfA() {
  const paid = await paidBatch();
  const original = await noisyJpeg();
  const k = await upload(paid.batchId, original);
  const stored = await storedBytes(k);
  // Premises: the stored object is a different file than the uploaded one.
  expect(original.includes(Buffer.from(SECRET_EXIF)), "premise: EXIF in").toBe(
    true,
  );
  expect(stored.includes(Buffer.from(SECRET_EXIF)), "premise: EXIF out").toBe(
    false,
  );
  expect(sha256(stored), "premise: re-encoding changed the bytes").not.toBe(
    sha256(original),
  );
  await returnBothSteps(paid.batchId, [idOf(paid.a)], k);
  expect((await W.itemOfPerson(paid.batchId, BUDI)).status, "premise").toBe(
    "returned",
  );
  return { ...paid, k, original, stored };
}

describe("legend-8vcsg finding 1: the stored (re-encoded) copy of a used proof is the same proof", () => {
  it("[888-fp-reencode-same-batch] A returned with an EXIF JPEG; the stored copy downloaded and uploaded again (K2) cannot return B: 409 PAYOUT_RETURN_PROOF_REUSED, B stays succeeded, no return journal, not offered to a follow-up batch", async () => {
    const { runId, batchId, b, k, stored } = await afterJpegReturnOfA();
    const k2 = await upload(batchId, stored);
    expect(k2, "premise: a new key for the downloaded copy").not.toBe(k);

    await expectReuseRefused([
      () => returnWith(batchId, [idOf(b)], APP, k2),
      () => returnWith(batchId, [idOf(b)], APP3, k2),
    ]);

    expect(
      (await W.itemOfPerson(batchId, SITI)).status,
      "B's money never came back",
    ).toBe("succeeded");
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(0);
    expect(
      await W.countJournals(
        returnKey(idOf(await W.itemOfPerson(batchId, BUDI))),
      ),
    ).toBe(1);
    const followUp = await W.createBatch(runId);
    expect((await W.itemsOf(followUp)).map((i) => i.employee_id)).toEqual([
      BUDI.id,
    ]);
  });

  it("[888-fp-reencode-other-batch] across batches: the stored copy uploaded to ANOTHER batch of the same tenant cannot return that batch's item: 409 PAYOUT_RETURN_PROOF_REUSED, the item stays succeeded", async () => {
    const first = await afterJpegReturnOfA();
    const other = await paidBatch();
    const k2 = await upload(other.batchId, first.stored);

    await expectReuseRefused([
      () => returnWith(other.batchId, [idOf(other.b)], APP, k2),
      () => returnWith(other.batchId, [idOf(other.b)], APP3, k2),
    ]);

    expect((await W.itemOfPerson(other.batchId, SITI)).status).toBe(
      "succeeded",
    );
    expect(await W.countJournals(returnKey(idOf(other.b)))).toBe(0);
  });

  it("[888-fp-reencode-original-again] the ORIGINAL EXIF file uploaded again (K2) is refused too (the original hash matches)", async () => {
    const { batchId, b, original } = await afterJpegReturnOfA();
    const k2 = await upload(batchId, original);

    await expectReuseRefused([
      () => returnWith(batchId, [idOf(b)], APP, k2),
      () => returnWith(batchId, [idOf(b)], APP3, k2),
    ]);
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
  });

  it("[888-fp-reencode-as-resolution] the stored copy of a used return proof cannot resolve another exported item as failed (no second payment): 409 PAYOUT_RETURN_PROOF_REUSED, the item stays exported", async () => {
    const { batchId, b, c } = await paidAbPendingC();
    const k = await upload(batchId, await noisyJpeg());
    await returnBothSteps(batchId, [idOf(b)], k);
    expect((await W.itemOfPerson(batchId, SITI)).status, "premise").toBe(
      "returned",
    );
    const k2 = await upload(batchId, await storedBytes(k));

    await expectReuseRefused(
      [
        () => W.resolve(batchId, [idOf(c)], "failed", APP, k2, real.store()),
        () => W.resolve(batchId, [idOf(c)], "failed", APP3, k2, real.store()),
      ],
      "PAYOUT_RETURN_PROOF_REUSED",
    );
    expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("exported");
  });

  it("[888-fp-reencode-as-payment-confirmation] the stored copy of a used return proof cannot confirm another exported item as paid: 409 PAYOUT_RETURN_PROOF_REUSED, the item stays exported", async () => {
    const { batchId, b, c } = await paidAbPendingC();
    const k = await upload(batchId, await noisyJpeg());
    await returnBothSteps(batchId, [idOf(b)], k);
    const k2 = await upload(batchId, await storedBytes(k));

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

  it("[888-fp-control-multi-item-jpeg] control: ONE EXIF JPEG proof for A and B in ONE operation (both steps) stays valid: both returned, each journaled exactly once", async () => {
    const { batchId, a, b, c } = await paidBatch();
    const k = await upload(batchId, await noisyJpeg());

    await returnBothSteps(batchId, [idOf(a), idOf(b)], k);

    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("returned");
    expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("succeeded");
    expect(await W.countJournals(returnKey(idOf(a)))).toBe(1);
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(1);
    expect(await W.countJournals(returnKey(idOf(c)))).toBe(0);
  });

  it("[888-fp-control-different-image] control: a genuinely different image (own pixels, own upload) for B's own return is accepted", async () => {
    const { batchId, b } = await afterJpegReturnOfA();
    const kB = await upload(batchId, await noisyJpeg());

    await returnBothSteps(batchId, [idOf(b)], kB);

    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("returned");
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Finding 2: proofs from before migration 0382 carry no fingerprint.
// ---------------------------------------------------------------------------

type BackfillJob = {
  runPayoutEvidenceBackfillSweep: (
    context: ReturnType<typeof W.scope>,
    now: Date,
    options: { storage: FakeObjectStorage },
  ) => Promise<unknown>;
};
/** Runs the fingerprint backfill (imported lazily: only the legacy tests need it). */
async function runBackfill() {
  const job =
    (await import("../worker/payout-evidence-backfill.job.ts")) as BackfillJob;
  await job.runPayoutEvidenceBackfillSweep(W.scope(), new Date(), {
    storage: real.storage,
  });
}

/**
 * Turns the claim of `key` into what a pre-0382 claim looks like: no
 * fingerprint on the claim, no row in evidence_files. Done as the table owner
 * with triggers off, because the app role is not allowed to rewrite either.
 */
async function makeLegacy(key: string) {
  await W.asTenant(async (c) => {
    const columns = (
      await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'payroll_payout_return_claims'
            AND column_name LIKE '%sha256%'
            AND is_nullable = 'YES'`,
      )
    ).rows as { column_name: string }[];
    expect(
      columns.length,
      "premise: the claim has a fingerprint column",
    ).toBeGreaterThan(0);
    for (const { column_name } of columns)
      await c.query(
        `UPDATE payroll_payout_return_claims SET "${column_name}" = NULL
          WHERE tenant_id = $1 AND evidence_key = $2`,
        [W.tenantId, key],
      );
    await c.query(
      `DELETE FROM payroll_payout_evidence_files WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, key],
    );
  }, true);
  const [claim] = await W.rowsOf(
    `SELECT * FROM payroll_payout_return_claims WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, key],
  );
  expect(claim, "premise: the old proof has a return claim").toBeDefined();
  for (const [column, value] of Object.entries(claim!))
    if (column.includes("sha256"))
      expect(value, `premise: ${column} is empty like before 0382`).toBeNull();
}

const claimCount = async (key: string) =>
  (
    await W.rowsOf(
      `SELECT count(*)::int AS n FROM payroll_payout_return_claims WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, key],
    )
  )[0]!.n as number;

describe("legend-8vcsg finding 2: proofs from before 0382 (no fingerprint)", () => {
  it("[888-legacy-fail-closed-then-backfill] A was returned with an old proof K (no fingerprint); the identical file uploaded again (K2) cannot return B: refused while the backfill is not finished (nothing recorded), and 409 PAYOUT_RETURN_PROOF_REUSED after it", async () => {
    const { runId, batchId, a, b } = await paidBatch();
    const content = await pdf("dana-kembali-lama-A");
    const k = await upload(batchId, content);
    await returnBothSteps(batchId, [idOf(a)], k);
    expect((await W.itemOfPerson(batchId, BUDI)).status, "premise").toBe(
      "returned",
    );
    await makeLegacy(k);
    try {
      const k2 = await upload(batchId, content);
      expect(k2, "premise: a new key for the same bytes").not.toBe(k);

      // Backfill not finished: a NEW proof cannot confirm a return (fail closed).
      const early = await W.httpFailure(
        returnWith(batchId, [idOf(b)], APP, k2),
      );
      expect(
        early,
        "while the tenant's old proofs have no fingerprint, a new proof must not start a return",
      ).not.toBeNull();
      expect(early!.status).toBeGreaterThanOrEqual(400);
      expect(
        await claimCount(k2),
        "the refused call leaves no claim behind",
      ).toBe(0);
      expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
      expect(await W.countJournals(returnKey(idOf(b)))).toBe(0);

      // The backfill fingerprints the stored object of the old proof.
      await runBackfill();
      const [claim] = await W.rowsOf(
        `SELECT * FROM payroll_payout_return_claims WHERE tenant_id = $1 AND evidence_key = $2`,
        [W.tenantId, k],
      );
      expect(
        Object.values(claim!),
        "the old claim now carries the fingerprint of its stored file",
      ).toContain(sha256(await storedBytes(k)));

      await expectReuseRefused([
        () => returnWith(batchId, [idOf(b)], APP, k2),
        () => returnWith(batchId, [idOf(b)], APP3, k2),
      ]);
      expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
      expect(await W.countJournals(returnKey(idOf(b)))).toBe(0);
      const followUp = await W.createBatch(runId);
      expect((await W.itemsOf(followUp)).map((i) => i.employee_id)).toEqual([
        BUDI.id,
      ]);
    } finally {
      await runBackfill();
    }
  });

  it("[888-legacy-open-proposal] an old proof K is at step 1 of the return of A (open claim, no fingerprint); the identical file re-uploaded (K2) cannot return B before or after the backfill, and the second person can still finish A's own operation with K", async () => {
    const { batchId, a, b } = await paidBatch();
    const content = await pdf("dana-kembali-lama-proposal");
    const k = await upload(batchId, content);
    await returnWith(batchId, [idOf(a)], APP, k);
    expect((await W.itemOfPerson(batchId, BUDI)).returned_by, "premise").toBe(
      APP,
    );
    await makeLegacy(k);
    try {
      const k2 = await upload(batchId, content);

      const early = await W.httpFailure(
        returnWith(batchId, [idOf(b)], APP, k2),
      );
      expect(
        early,
        "fail closed while the backfill is not finished",
      ).not.toBeNull();
      expect(early!.status).toBeGreaterThanOrEqual(400);
      expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");

      await runBackfill();
      await expectReuseRefused([
        () => returnWith(batchId, [idOf(b)], APP, k2),
        () => returnWith(batchId, [idOf(b)], APP3, k2),
      ]);
      expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
      expect(await W.countJournals(returnKey(idOf(b)))).toBe(0);

      // Control: the legitimate operation of A still finishes with its own key.
      await returnWith(batchId, [idOf(a)], APP3, k);
      expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
      expect(await W.countJournals(returnKey(idOf(a)))).toBe(1);
    } finally {
      await runBackfill();
    }
  });

  it("[888-legacy-control-legit-proofs] after the backfill, a legitimate old multi-item operation (A and B, one proof K) still finishes with one journal each, and a genuinely different new proof is accepted for C", async () => {
    const { batchId, a, b, c } = await paidBatch();
    const k = await upload(batchId, await pdf("dana-kembali-lama-AB"));
    await returnWith(batchId, [idOf(a), idOf(b)], APP, k);
    await makeLegacy(k);
    try {
      await runBackfill();

      await returnWith(batchId, [idOf(a), idOf(b)], APP3, k);
      expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
      expect((await W.itemOfPerson(batchId, SITI)).status).toBe("returned");
      expect(await W.countJournals(returnKey(idOf(a)))).toBe(1);
      expect(await W.countJournals(returnKey(idOf(b)))).toBe(1);

      const kC = await upload(batchId, await pdf("dana-kembali-baru-C"));
      await returnBothSteps(batchId, [idOf(c)], kC);
      expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("returned");
      expect(await W.countJournals(returnKey(idOf(c)))).toBe(1);
    } finally {
      await runBackfill();
    }
  });

  it("[888-legacy-backfill-idempotent] running the backfill twice changes nothing the second time", async () => {
    const { batchId, a } = await paidBatch();
    const k = await upload(batchId, await pdf("dana-kembali-lama-idem"));
    await returnBothSteps(batchId, [idOf(a)], k);
    await makeLegacy(k);
    try {
      await runBackfill();
      const read = async () =>
        JSON.stringify(
          await W.rowsOf(
            `SELECT * FROM payroll_payout_return_claims WHERE tenant_id = $1 AND evidence_key = $2`,
            [W.tenantId, k],
          ),
        );
      const once = await read();
      await runBackfill();
      expect(await read()).toBe(once);
    } finally {
      await runBackfill();
    }
  });
});

// ---------------------------------------------------------------------------
// Architect review of 888: the gate covers every unfingerprinted proof (not only
// claims) and holds RETURNS only; paying and failing are never held.
// ---------------------------------------------------------------------------

const PENDING = "PAYOUT_PROOF_FINGERPRINT_PENDING";

/** Erases the stored hash of a proof record: what a 0382-0630 upload looks like. */
async function makeStoredHashLegacy(key: string) {
  await W.asTenant(async (c) => {
    await c.query(
      `UPDATE payroll_payout_evidence_files SET stored_sha256 = NULL
        WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, key],
    );
  }, true);
}
/** Erases the proof record of a key: what a proof from before 0382 looks like. */
async function deleteProofRecord(key: string) {
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM payroll_payout_evidence_files WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, key],
    );
  }, true);
}

describe("legend-8vcsg architect review: what closes the gate, and what it holds", () => {
  it("[888-gate-item-key-without-record] an old payment-confirmation key without a proof record holds returns with a new proof (nothing recorded); after the backfill the new proof is accepted", async () => {
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
    const kc = await upload(batchId, await pdf("laporan-bank-lama"));
    await W.confirm(
      batchId,
      items.map((item, index) => ({
        itemId: idOf(item),
        result: "succeeded" as const,
        bankRef: `BCA-${batchId.slice(0, 8)}-${index}`,
        evidenceKey: kc,
      })),
      undefined,
      real.store(),
    );
    await deleteProofRecord(kc);
    try {
      const a = await W.itemOfPerson(batchId, BUDI);
      const kNew = await upload(batchId, await pdf("dana-kembali-baru-gate"));
      const early = await W.httpFailure(
        returnWith(batchId, [idOf(a)], APP, kNew),
      );
      expect(early, "held while an item proof has no record").not.toBeNull();
      expect(early!.status).toBe(409);
      expect(early!.code).toBe(PENDING);
      expect(await claimCount(kNew)).toBe(0);

      await runBackfill();
      const [record] = await W.rowsOf(
        `SELECT * FROM payroll_payout_evidence_files WHERE tenant_id = $1 AND evidence_key = $2`,
        [W.tenantId, kc],
      );
      expect(record, "the backfill wrote the missing record").toBeDefined();

      await returnBothSteps(batchId, [idOf(a)], kNew);
      expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
      expect(await W.countJournals(returnKey(idOf(a)))).toBe(1);
    } finally {
      await runBackfill();
    }
  });

  it("[888-gate-file-without-stored-hash] a proof record from before the stored hash holds returns with a new proof; the backfill fills the hash in and reopens them", async () => {
    const { batchId, a } = await paidBatch();
    const kOld = await upload(batchId, await pdf("bukti-0382"));
    await makeStoredHashLegacy(kOld);
    try {
      const kNew = await upload(batchId, await pdf("dana-kembali-baru-file"));
      const early = await W.httpFailure(
        returnWith(batchId, [idOf(a)], APP, kNew),
      );
      expect(early!.status).toBe(409);
      expect(early!.code).toBe(PENDING);

      await runBackfill();
      const [record] = await W.rowsOf(
        `SELECT stored_sha256 FROM payroll_payout_evidence_files WHERE tenant_id = $1 AND evidence_key = $2`,
        [W.tenantId, kOld],
      );
      expect(record!.stored_sha256).toBe(sha256(await storedBytes(kOld)));

      await returnBothSteps(batchId, [idOf(a)], kNew);
      expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
    } finally {
      await runBackfill();
    }
  });

  it("[888-gate-confirm-not-held] while returns are held, a payment confirmation (money already left) is still recorded", async () => {
    const { batchId, c } = await paidAbPendingC();
    const kOld = await upload(batchId, await pdf("bukti-0382-confirm"));
    await makeStoredHashLegacy(kOld);
    try {
      await W.confirm(
        batchId,
        W.succeedItems(batchId, [await W.itemOfPerson(batchId, ANDI)]),
      );
      expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("succeeded");
      expect(idOf(c)).toBe(idOf(await W.itemOfPerson(batchId, ANDI)));
    } finally {
      await runBackfill();
    }
  });

  it("[888-gate-resolve-not-held] while returns are held, a failed resolution (two people) is still recorded", async () => {
    const { batchId, c } = await paidAbPendingC();
    const kOld = await upload(batchId, await pdf("bukti-0382-resolve"));
    await makeStoredHashLegacy(kOld);
    try {
      await W.resolve(batchId, [idOf(c)], "failed", APP);
      await W.resolve(batchId, [idOf(c)], "failed", APP3);
      expect((await W.itemOfPerson(batchId, ANDI)).status).not.toBe("exported");
    } finally {
      await runBackfill();
    }
  });
});
