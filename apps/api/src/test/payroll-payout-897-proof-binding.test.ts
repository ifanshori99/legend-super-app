// Payout 897 (cards legend-klr99 P1 and legend-v2dco P2; design scratchpad
// b897/design.md F1, F2 and F3; findings "overpaid proof reused for a return or
// another overpaid", "correction proof reused in another tenant" and "a failed
// second hash read lets a return skip the fingerprint gate" in
// docs/qa/second-opinion-payout-888-891.md). Written fail-first from the
// findings and the CTO decisions, not from the implementation.
//
// Rules proven here (founder: nobody is paid twice, a bank proof backs ONE
// operation):
// - A proof (by key, by uploaded bytes or by stored bytes) is bound to one
//   operation: overpaid, return or correction over ONE item set. Used for any
//   other operation, in either order, also in parallel, it is refused 409
//   PAYOUT_PROOF_REUSED and the second operation changes nothing. One proof
//   still covers the whole item SET of one operation, both steps.
// - The bound hashes are global across tenants: the same bytes cannot back a
//   correction in another PT. The refusal says nothing about the other tenant.
// - The app role cannot read or write the global hash table.
// - A return fails closed when the fingerprint of its proof cannot be read:
//   409 PAYOUT_PROOF_FINGERPRINT_PENDING, no claim, no change. The database
//   refuses a new return claim without hashes.
//
// Assumptions (the design names them, stated so they can be contested):
// - Refusal code for reuse (all three operations): 409 PAYOUT_PROOF_REUSED, text
//   "Bukti ini sudah dipakai untuk operasi lain." (design F2).
// - Tables `payroll_payout_proof_bindings` (tenant_id, id, batch_id, kind,
//   item_set_hash, evidence_key, content_sha256, stored_sha256,
//   legacy_duplicate, created_by) and global `payroll_payout_proof_hashes`
//   (sha256, binding_id). A "proof held by another PT" is built as the table
//   owner with triggers off (a second full tenant world does not exist in the
//   fixtures); the rest of the path runs for real.
//   LIMIT: the parallel cross-tenant race cannot be driven for the same reason;
//   the parallel race here is the in-tenant one (the lock key is the same).
// - The overpaid and correction calls carry the same body as the 888/891 tests
//   and a real password step-up. Real proof bytes are used throughout (an empty
//   object is no proof), so this file wires its own app to a FakeObjectStorage.
// - A proof carries the two hashes of upload and stored bytes; PDFs are stored
//   unchanged, JPEGs are re-encoded (EXIF removed).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  FakeObjectStorage,
  type ObjectStorage,
} from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { uploadPayoutEvidence } from "../services/payroll-payout-evidence-upload.service.ts";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import {
  exportManualBatch,
  returnManualItems,
} from "../services/payroll-payout-manual.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import { withAppRole } from "./accounting-ledger-guard-test-helpers.ts";
import {
  ANDI,
  APP,
  APP3,
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  type Person,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("897proof");
const PASSWORD = "Test-password-123!";
const BASE = "/api/hris/payroll/disbursement-batches";
const REUSED = "PAYOUT_PROOF_REUSED";
const REUSED_TEXT = "Bukti ini sudah dipakai untuk operasi lain.";
const PENDING = "PAYOUT_PROOF_FINGERPRINT_PENDING";
const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const idOf = (row: Row) => row.id as string;
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

// ---- Storage, app and people ------------------------------------------------------

const storage = new FakeObjectStorage();
const store = (s: ObjectStorage = storage) => ({
  storage: s,
  context: W.scope(),
});
const app = createApp({
  storageRuntime: {
    storage,
    scanner: new NoopMalwareScanner(),
    fileSigner: async () => "https://signed.example.test/x",
    hrisDocumentSigner: async () => null,
  },
});
const lookup = (key: string) =>
  ({
    tenantId: W.tenantId,
    outletId: null,
    reference: "payout-897-proof-test",
    key,
  }) as never;

const uploadTo = async (batchId: string, bytes: Uint8Array) =>
  (
    await uploadPayoutEvidence(W.scope(), batchId, bytes, {
      storage,
      scanner: new NoopMalwareScanner(),
    })
  ).evidenceKey;
const storedBytes = async (key: string) =>
  Buffer.from(
    (await storage.get(W.scope(), lookup(key))).content as Uint8Array,
  );
const pdf = (label: string) =>
  validPdfBytes({ marker: `${label} ${randomUUID()}` });
const noisyJpeg = () =>
  sharp(randomBytes(32 * 32 * 3), {
    raw: { width: 32, height: 32, channels: 3 },
  })
    .withExif({ IFD0: { ImageDescription: "rahasia-897" } })
    .jpeg({ quality: 90 })
    .toBuffer();

const dbOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const grantedUsers: string[] = [];
afterAll(async () => {
  if (grantedUsers.length > 0) {
    await dbOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [grantedUsers],
    );
    await dbOwner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [grantedUsers],
    );
  }
  await dbOwner.end();
});

/** Staff with payroll.disburse.approve on THIS file's app; the password is the step-up. */
async function approverClient(label: string) {
  const client = agent(app);
  await signUp(client, `Proof ${label}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
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
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return { client, userId };
}
type Approver = Awaited<ReturnType<typeof approverClient>>;
const trio = async (label: string) => ({
  requester: await approverClient(`${label} Requester`),
  first: await approverClient(`${label} First`),
  second: await approverClient(`${label} Second`),
});

// ---- Worlds -----------------------------------------------------------------------

const currentSourceBank = async () =>
  (
    await W.rowsOf(
      `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [W.tenantId, W.entityId()],
    )
  )[0]!.id as string;

/**
 * Batch 1 (created by a real requester, exported): the `failed` people are
 * resolved failed by two people, everybody else is paid.
 * `retriesPaid` also creates the follow-up batch and pays every retry, so the
 * failed first items are double transfers (the overpaid path).
 */
async function world(
  requester: Approver,
  options: { failed: Person[]; retriesPaid?: boolean },
) {
  const slips = [
    bank(BUDI, BUDI_NET),
    bank(SITI, SITI_NET),
    bank(ANDI, ANDI_NET),
  ];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requester.userId), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
  const [batch] = await W.rowsOf(
    `SELECT id FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [W.tenantId, runId],
  );
  const batchId = batch!.id as string;
  await W.inTx((tx) =>
    submitDisbursementBatch(tx, actorOf(requester.userId), batchId),
  );
  const hash = (await W.batchById(batchId)).content_hash as string;
  const sourceBankAccountId = await currentSourceBank();
  await W.inTx((tx) =>
    approveDisbursementBatch(tx, actorOf(APP), batchId, {
      contentHash: hash,
      sourceBankAccountId,
    }),
  );
  await W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId));
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  const isFailed = (i: Row) =>
    options.failed.some((p) => p.id === i.employee_id);
  const paid = items.filter((i) => !isFailed(i));
  if (paid.length > 0) await W.confirm(batchId, W.succeedItems(batchId, paid));
  const failedIds = items.filter(isFailed).map(idOf);
  if (failedIds.length > 0) {
    await W.resolve(batchId, failedIds, "failed", APP);
    await W.resolve(batchId, failedIds, "failed", APP3);
  }
  if (options.retriesPaid) {
    const followUp = await W.exportedBatch(runId);
    const retries = (await W.itemsOf(followUp)).filter(
      (i) => i.status === "exported",
    );
    await W.confirm(followUp, W.succeedItems(followUp, retries));
  }
  const of = async (p: Person) => idOf(await W.itemOfPerson(batchId, p));
  return {
    runId,
    batchId,
    budi: await of(BUDI),
    siti: await of(SITI),
    andi: await of(ANDI),
  };
}

/** Siti and Andi paid in batch 1 only (for the return-only checks). */
async function paidBatch() {
  const slips = [bank(BUDI, BUDI_NET), bank(SITI, SITI_NET)];
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
    budi: idOf(await W.itemOfPerson(batchId, BUDI)),
    siti: idOf(await W.itemOfPerson(batchId, SITI)),
  };
}

// ---- Operations ---------------------------------------------------------------------

const overpaidCall = (
  who: Approver,
  w: { batchId: string },
  itemIds: string[],
  evidenceKey: string,
) =>
  who.client.post(`${BASE}/${w.batchId}/overpaid`).set(originHeader).send({
    itemIds,
    evidenceKey,
    note: "Mutasi bank menunjukkan transfer pertama ternyata berhasil",
    password: PASSWORD,
  });
const correctCall = (
  who: Approver,
  w: { batchId: string },
  itemIds: string[],
  evidenceKey: string,
) =>
  who.client
    .post(`${BASE}/${w.batchId}/correct-failed`)
    .set(originHeader)
    .send({
      itemIds,
      evidenceKey,
      note: "Mutasi bank menunjukkan transfer ternyata berhasil, tidak ada transfer lain",
      password: PASSWORD,
    });
const returnCall = (
  w: { batchId: string },
  itemIds: string[],
  by: string,
  evidenceKey: string,
  proofs = store(),
) =>
  W.inTx((tx) =>
    returnManualItems(
      tx,
      actorOf(by),
      w.batchId,
      {
        itemIds,
        evidenceKey,
        note: "Bank mengembalikan dana, rekening tujuan ditutup",
      } as never,
      proofs,
    ),
  );

type Res = Awaited<ReturnType<typeof overpaidCall>>;
const expectOk = (res: Res, label = "") =>
  expect(res.status, `${label} ${JSON.stringify(res.body)}`).toBe(200);
const expectReusedHttp = (res: Res, label = "") => {
  expect(res.status, `${label} ${JSON.stringify(res.body)}`).toBe(409);
  expect(res.body.error?.code, label).toBe(REUSED);
};
async function expectReusedService(work: Promise<unknown>, label = "") {
  const error = await W.httpFailure(work);
  expect(error, `${label}: the return must be refused`).not.toBeNull();
  expect(error!.status, label).toBe(409);
  expect(error!.code, label).toBe(REUSED);
}

// ---- Observations -----------------------------------------------------------------------

const countOf = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const proposals = (itemId: string) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_payout_overpaid_proposals
      WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, itemId],
  );
const corrections = (itemId: string) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_payout_failed_corrections
      WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, itemId],
  );
const claims = (key: string) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_payout_return_claims
      WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, key],
  );
const statusOf = async (batchId: string, person: Person) =>
  (await W.itemOfPerson(batchId, person)).status as string;
const returnJournals = async (itemId: string) =>
  W.countJournals(`payroll-payout-return:${itemId}`);

// =========================================================================
// F1: one proof, one operation
// =========================================================================

describe("897 a bank proof backs ONE operation (F1)", () => {
  for (const [label, finishReturn] of [
    ["step one", false],
    ["both steps", true],
  ] as const) {
    it(`[897-return-then-overpaid-${label.replace(" ", "-")}] a proof used by a return (${label}) cannot back an overpaid record: 409 PAYOUT_PROOF_REUSED, no proposal, the failed item stays failed`, async () => {
      const { requester, first } = await trio(`RetOver ${label}`);
      const w = await world(requester, {
        failed: [BUDI, ANDI],
        retriesPaid: true,
      });
      const key = await uploadTo(w.batchId, await pdf("bukti-return"));
      await returnCall(w, [w.siti], APP, key);
      if (finishReturn) await returnCall(w, [w.siti], APP3, key);

      expectReusedHttp(await overpaidCall(first, w, [w.andi], key));

      expect(await proposals(w.andi)).toBe(0);
      expect(await statusOf(w.batchId, ANDI)).toBe("failed");
      // Control: another proof starts the overpaid record.
      expectOk(
        await overpaidCall(
          first,
          w,
          [w.andi],
          await uploadTo(w.batchId, await pdf("bukti-overpaid-lain")),
        ),
        "control",
      );
    });
  }

  it("[897-overpaid-then-return] a proof used by an overpaid record cannot back a return: 409 PAYOUT_PROOF_REUSED, no claim, the paid item stays succeeded; another proof works", async () => {
    const { requester, first, second } = await trio("OverRet");
    const w = await world(requester, {
      failed: [BUDI, ANDI],
      retriesPaid: true,
    });
    const key = await uploadTo(w.batchId, await pdf("bukti-overpaid"));
    expectOk(await overpaidCall(first, w, [w.andi], key), "step one");
    expectOk(await overpaidCall(second, w, [w.andi], key), "step two");
    expect(await statusOf(w.batchId, ANDI)).toBe("overpaid");

    await expectReusedService(returnCall(w, [w.siti], APP, key), "return");

    expect(await claims(key)).toBe(0);
    expect(await statusOf(w.batchId, SITI)).toBe("succeeded");
    expect(await returnJournals(w.siti)).toBe(0);
    await returnCall(
      w,
      [w.siti],
      APP,
      await uploadTo(w.batchId, await pdf("bukti-return-lain")),
    );
  });

  for (const variant of ["same key", "new key, same bytes", "stored copy"]) {
    it(`[897-two-overpaid-${variant.replace(/[ ,]+/g, "-")}] two different overpaid operations cannot share a proof (${variant})`, async () => {
      const { requester, first, second } = await trio(`TwoOver ${variant}`);
      const w = await world(requester, {
        failed: [BUDI, ANDI],
        retriesPaid: true,
      });
      const original =
        variant === "stored copy"
          ? await noisyJpeg()
          : await pdf("dua-overpaid");
      const key = await uploadTo(w.batchId, original);
      expectOk(await overpaidCall(first, w, [w.budi], key), "A step one");
      expectOk(await overpaidCall(second, w, [w.budi], key), "A step two");
      const again =
        variant === "same key"
          ? key
          : await uploadTo(
              w.batchId,
              variant === "stored copy" ? await storedBytes(key) : original,
            );
      if (variant !== "same key")
        expect(again, "premise: a new key").not.toBe(key);

      expectReusedHttp(await overpaidCall(first, w, [w.andi], again), "B");

      expect(await proposals(w.andi)).toBe(0);
      expect(await statusOf(w.batchId, ANDI)).toBe("failed");
      expect(await statusOf(w.batchId, BUDI)).toBe("overpaid");
    });
  }

  for (const round of [1, 2]) {
    it(`[897-parallel-overpaid-vs-return-${round}] overpaid A and return B on the same bytes at the same moment: exactly one succeeds, the other is refused 409 and leaves nothing`, async () => {
      const { requester, first } = await trio(`Race${round}`);
      const w = await world(requester, {
        failed: [BUDI, ANDI],
        retriesPaid: true,
      });
      const key = await uploadTo(w.batchId, await pdf("balapan"));

      const [overpaid, returned] = await Promise.all([
        overpaidCall(first, w, [w.andi], key),
        W.httpFailure(returnCall(w, [w.siti], APP, key)),
      ]);

      expect(overpaid.status, JSON.stringify(overpaid.body)).toBeLessThan(500);
      const overpaidWon = overpaid.status === 200;
      const returnWon = returned === null;
      expect(
        Number(overpaidWon) + Number(returnWon),
        `exactly one wins: ${JSON.stringify(overpaid.body)} ${String(returned?.message)}`,
      ).toBe(1);
      if (overpaidWon) {
        expect(returned!.status).toBe(409);
        expect(returned!.code).toBe(REUSED);
        expect(await claims(key)).toBe(0);
        expect(await statusOf(w.batchId, SITI)).toBe("succeeded");
      } else {
        expectReusedHttp(overpaid);
        expect(await proposals(w.andi)).toBe(0);
        expect(await statusOf(w.batchId, ANDI)).toBe("failed");
      }
    });
  }

  it("[897-proof-covers-item-set] ONE proof covers the item set of one overpaid operation (both steps); a second step over a different item set is refused 409", async () => {
    const { requester, first, second } = await trio("ItemSet");
    const ok = await world(requester, {
      failed: [BUDI, ANDI],
      retriesPaid: true,
    });
    const keyOk = await uploadTo(ok.batchId, await pdf("dua-item"));
    expectOk(await overpaidCall(first, ok, [ok.budi, ok.andi], keyOk), "one");
    expectOk(await overpaidCall(second, ok, [ok.budi, ok.andi], keyOk), "two");
    expect(await statusOf(ok.batchId, BUDI)).toBe("overpaid");
    expect(await statusOf(ok.batchId, ANDI)).toBe("overpaid");

    const other = await world(requester, {
      failed: [BUDI, ANDI],
      retriesPaid: true,
    });
    const key = await uploadTo(other.batchId, await pdf("dua-item-beda"));
    expectOk(await overpaidCall(first, other, [other.budi, other.andi], key));
    const mismatch = await overpaidCall(second, other, [other.andi], key);
    expect(mismatch.status, JSON.stringify(mismatch.body)).toBe(409);
    expect(await statusOf(other.batchId, BUDI)).toBe("failed");
    expect(await statusOf(other.batchId, ANDI)).toBe("failed");
  });

  it("[897-correction-then-return-new-key] the same bytes uploaded again (new key) cannot move from a correction to a return", async () => {
    const { requester, first } = await trio("CorrRet");
    const w = await world(requester, { failed: [BUDI] });
    const bytes = await pdf("koreksi-lalu-return");
    const key = await uploadTo(w.batchId, bytes);
    expectOk(await correctCall(first, w, [w.budi], key), "correction");
    const copy = await uploadTo(w.batchId, bytes);

    await expectReusedService(returnCall(w, [w.siti], APP, copy), "return");

    expect(await claims(copy)).toBe(0);
    expect(await statusOf(w.batchId, SITI)).toBe("succeeded");
  });
});

// =========================================================================
// F2: the hash is unique across tenants and says nothing about the holder
// =========================================================================

/** A binding of ANOTHER tenant that holds these hashes (owner, triggers off). */
async function holdInOtherTenant(contentSha: string, storedSha: string) {
  const tenant = randomUUID();
  const binding = randomUUID();
  const batch = randomUUID();
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO payroll_payout_proof_bindings
         (id, tenant_id, batch_id, kind, item_set_hash, evidence_key,
          content_sha256, stored_sha256, legacy_duplicate, created_by)
       VALUES ($1, $2, $3, 'correction', $4, $5, $6, $7, false, 'holder-b')`,
      [
        binding,
        tenant,
        batch,
        sha256(Buffer.from(binding)),
        `tenants/${tenant}/payroll-payout/${batch}/bukti.pdf`,
        contentSha,
        storedSha,
      ],
    );
    for (const hash of new Set([contentSha, storedSha]))
      await client.query(
        `INSERT INTO payroll_payout_proof_hashes (sha256, binding_id) VALUES ($1, $2)`,
        [hash, binding],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return {
    tenant,
    batch,
    release: async () => {
      await W.owner.query(
        `DELETE FROM payroll_payout_proof_hashes WHERE binding_id = $1`,
        [binding],
      );
      await W.owner.query(
        `DELETE FROM payroll_payout_proof_bindings WHERE id = $1`,
        [binding],
      );
    },
  };
}

describe("897 a correction proof cannot be reused in another tenant (F2)", () => {
  it("[897-cross-tenant-correction] the original bytes and the stored bytes of a proof held by another PT are refused 409 with the in-tenant text and no tenant, batch or hash in the body; a different document is accepted", async () => {
    const { requester, first } = await trio("Cross");
    const w = await world(requester, { failed: [BUDI, ANDI] });
    const original = await noisyJpeg();
    const probe = await uploadTo(w.batchId, original);
    const stored = await storedBytes(probe);
    expect(sha256(stored), "premise: re-encoding changed the bytes").not.toBe(
      sha256(original),
    );
    const holder = await holdInOtherTenant(sha256(original), sha256(stored));
    try {
      const sameBytes = await uploadTo(w.batchId, original);
      const storedCopy = await uploadTo(w.batchId, stored);

      const one = await correctCall(first, w, [w.budi], sameBytes);
      expectReusedHttp(one, "original bytes");
      const two = await correctCall(first, w, [w.andi], storedCopy);
      expectReusedHttp(two, "stored bytes");
      for (const res of [one, two]) {
        expect(res.body.error?.message).toBe(REUSED_TEXT);
        const text = JSON.stringify(res.body);
        for (const secret of [
          holder.tenant,
          holder.batch,
          sha256(original),
          sha256(stored),
        ])
          expect(text, "nothing of the other PT leaks").not.toContain(secret);
      }
      expect(await corrections(w.budi)).toBe(0);
      expect(await corrections(w.andi)).toBe(0);
      expect(await statusOf(w.batchId, BUDI)).toBe("failed");

      expectOk(
        await correctCall(
          first,
          w,
          [w.budi],
          await uploadTo(w.batchId, await pdf("dokumen-lain")),
        ),
        "a different document",
      );
    } finally {
      await holder.release();
    }
  });

  it("[897-parallel-same-bytes-two-keys] two corrections with the same bytes under two keys at the same moment: exactly one is accepted, the other is refused 409", async () => {
    const { requester, first, second } = await trio("SameBytes");
    const w = await world(requester, { failed: [BUDI, ANDI] });
    const bytes = await pdf("sama-dua-kunci");
    const keyOne = await uploadTo(w.batchId, bytes);
    const keyTwo = await uploadTo(w.batchId, bytes);

    const [a, b] = await Promise.all([
      correctCall(first, w, [w.budi], keyOne),
      correctCall(second, w, [w.andi], keyTwo),
    ]);

    expect(Math.max(a.status, b.status)).toBeLessThan(500);
    expect([a, b].filter((r) => r.status === 200)).toHaveLength(1);
    expectReusedHttp(a.status === 200 ? b : a);
    expect((await corrections(w.budi)) + (await corrections(w.andi))).toBe(1);
  });

  it("[897-app-role-hash-table] the app role can neither read nor write the global hash table", async () => {
    const codes = await withAppRole(async (client) => {
      const attempt = async (sql: string) => {
        await client.query("SAVEPOINT try_hash");
        try {
          await client.query(sql);
          return undefined;
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT try_hash");
          return (error as { code?: string }).code ?? "unknown";
        }
      };
      return {
        select: await attempt(
          "SELECT count(*) FROM payroll_payout_proof_hashes",
        ),
        insert: await attempt(
          `INSERT INTO payroll_payout_proof_hashes (sha256, binding_id)
           VALUES (repeat('a', 64), gen_random_uuid())`,
        ),
        remove: await attempt("DELETE FROM payroll_payout_proof_hashes"),
      };
    });
    expect(codes).toEqual({
      select: "42501",
      insert: "42501",
      remove: "42501",
    });
  });
});

// =========================================================================
// F3: a return fails closed when the fingerprint cannot be read
// =========================================================================

/** A store whose first read of a key works (the probe) and every later read fails. */
function probeThenFail() {
  const reads = new Map<string, number>();
  const flaky = {
    async get(context: unknown, input: { key: string }) {
      const n = (reads.get(input.key) ?? 0) + 1;
      reads.set(input.key, n);
      if (n > 1) throw new Error("storage unavailable");
      return storage.get(context as never, input as never);
    },
  } as unknown as ObjectStorage;
  return store(flaky);
}
/** What a proof from before the fingerprint looks like: no record for the key. */
const eraseProofRecord = (key: string) =>
  W.asTenant(
    (c) =>
      c.query(
        `DELETE FROM payroll_payout_evidence_files WHERE tenant_id = $1 AND evidence_key = $2`,
        [W.tenantId, key],
      ),
    true,
  );
const nullHashClaims = (batchId: string) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_payout_return_claims
      WHERE tenant_id = $1 AND batch_id = $2
        AND (content_sha256 IS NULL OR stored_sha256 IS NULL)`,
    [W.tenantId, batchId],
  );

describe("897 a return fails closed when the fingerprint read fails (F3)", () => {
  it("[897-return-fails-closed] a legacy key without a record whose fingerprint read fails answers 409 PAYOUT_PROOF_FINGERPRINT_PENDING: no claim, no null-hash claim, nothing changes", async () => {
    const paid = await paidBatch();
    const key = await uploadTo(paid.batchId, await pdf("kunci-lama"));
    await eraseProofRecord(key);

    const refused = await W.httpFailure(
      returnCall(paid, [paid.siti], APP, key, probeThenFail()),
    );
    expect(refused, "the return must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe(PENDING);

    expect(await claims(key)).toBe(0);
    expect(await nullHashClaims(paid.batchId)).toBe(0);
    expect(await statusOf(paid.batchId, SITI)).toBe("succeeded");
    expect(await returnJournals(paid.siti)).toBe(0);
  });

  it("[897-return-fails-closed-two-batches] the same legacy object in two batches: both returns are refused while the read fails, nothing is claimed; once storage heals the first return works and the identical object cannot return the second batch", async () => {
    const bytes = await pdf("objek-lama-sama");
    const one = await paidBatch();
    const two = await paidBatch();
    const keyOne = await uploadTo(one.batchId, bytes);
    const keyTwo = await uploadTo(two.batchId, bytes);
    await eraseProofRecord(keyOne);
    await eraseProofRecord(keyTwo);

    for (const [paid, key] of [
      [one, keyOne],
      [two, keyTwo],
    ] as const) {
      const refused = await W.httpFailure(
        returnCall(paid, [paid.siti], APP, key, probeThenFail()),
      );
      expect(refused, "refused while the read fails").not.toBeNull();
      expect(refused!.status).toBe(409);
      expect(refused!.code).toBe(PENDING);
      expect(await claims(key)).toBe(0);
      expect(await nullHashClaims(paid.batchId)).toBe(0);
      expect(await statusOf(paid.batchId, SITI)).toBe("succeeded");
    }

    await returnCall(one, [one.siti], APP, keyOne);
    await returnCall(one, [one.siti], APP3, keyOne);
    expect(await statusOf(one.batchId, SITI)).toBe("returned");
    await expectReusedService(
      returnCall(two, [two.siti], APP, keyTwo),
      "identical object in the other batch",
    );
    expect(await claims(keyTwo)).toBe(0);
    expect(await statusOf(two.batchId, SITI)).toBe("succeeded");
  });

  it("[897-claim-null-hash-refused-by-db] the app role cannot insert a new return claim without its hashes (23514); with both hashes it can", async () => {
    const paid = await paidBatch();
    // 905 (migration 0648): the app role can no longer INSERT a return claim at
    // all (42501, the payout-role function is the writer), so the NOT NULL-hash
    // CHECK is proved with the migration owner and the app role is checked to be
    // refused for the same row.
    const insert = (
      content: string | null,
      stored: string | null,
      asApp = false,
    ) =>
      (asApp ? withAppRole : W.asTenant)(async (client) => {
        await client.query("SAVEPOINT try_claim");
        try {
          await client.query(
            `INSERT INTO payroll_payout_return_claims
               (tenant_id, batch_id, evidence_key, item_set_hash, status,
                created_by, content_sha256, stored_sha256)
             VALUES ($1, $2, $3, $4, 'open', 'sql-897', $5, $6)`,
            [
              W.tenantId,
              paid.batchId,
              `tenants/${W.tenantId}/payroll-payout/${paid.batchId}/${randomUUID()}.pdf`,
              randomBytes(32).toString("hex"),
              content,
              stored,
            ],
          );
          return undefined;
        } catch (error) {
          return (error as { code?: string }).code ?? "unknown";
        } finally {
          // Nothing stays behind, whatever the outcome.
          await client.query("ROLLBACK TO SAVEPOINT try_claim");
        }
      });
    const hex = () => randomBytes(32).toString("hex");

    expect(await insert(hex(), hex()), "control: with both hashes").toBe(
      undefined,
    );
    expect(
      await insert(hex(), hex(), true),
      "905: the app role cannot insert a claim at all",
    ).toBe("42501");
    expect(await insert(null, null)).toBe("23514");
    expect(await insert(hex(), null)).toBe("23514");
    expect(await insert(null, hex())).toBe("23514");
    expect(await nullHashClaims(paid.batchId)).toBe(0);
  });
});
