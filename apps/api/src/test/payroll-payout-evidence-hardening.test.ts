// Payout evidence hardening (beads legend-bmlwf, legend-01gg8, legend-t58lr;
// brief "Payout evidence hardening"). Written fail-first from the brief and the
// shared validators (packages/shared/src/validators/payroll-payout.ts), not
// from the implementation. Rule: when in doubt, limit the payment; no pay-out
// twice.
//
// Rules proven here (all over HTTP, so the tests do not depend on how the
// services get at storage; the app is wired to a fake object storage):
// - bmlwf: the SECOND resolve step must carry the same evidence key as the
//   first. Two different (both real, both uploaded to this batch) proofs are
//   refused and the slip is not freed (item stays `exported`, no new batch).
// - 01gg8: a key that only has the right shape (tenants/<tenant>/payroll-payout/
//   <batch>/<file>) but whose object was never uploaded is refused on resolve,
//   return and confirm with 422 PAYOUT_EVIDENCE_INVALID BEFORE any money status
//   changes. A real upload of the same batch is still accepted (control).
// - t58lr: a read path for stored proof, bound to tenant + batch, guarded by
//   payroll.disburse.approve.
// - no pay-out twice: refused calls leave items, journals and the batch
//   untouched, and the slip cannot be put in a new batch while a live item
//   exists.
//
// Assumptions (the brief is silent, stated so they can be contested):
// - Refusals use PAYOUT_EVIDENCE_INVALID 422 (same as the upload suite). The
//   second-step mismatch (bmlwf) is only pinned as 409 or 422, no exact code.
// - Read path (t58lr): GET /api/hris/payroll/disbursement-batches/:id/evidence
//   ?key=<evidenceKey>. It answers 200 with EITHER JSON { data: { url } } (a
//   short-lived signed URL) OR the proof bytes (stream); both are accepted.
//   A key of another batch, of another tenant, one that climbs out of the batch
//   folder with "..", is 422 PAYOUT_EVIDENCE_INVALID; a never-uploaded key of
//   this batch is 404 or 422. No permission: 403. Not signed in: 401. The read
//   never changes any batch or item.
// - The proposal DTO for the second approver (t58lr, part 2) is NOT tested
//   here: the brief names its fields (outcome, evidenceKey, proposer, time) but
//   not where it is exposed nor the property names.
// - Cash handover is not tested: the upload route refuses cash batches (409/422
//   in the upload suite), so no real proof can exist for it.
// - Confirm results are set up without evidence (it is optional) so that the
//   fixtures do not depend on the existence check.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import {
  BUDI,
  SITI,
  bank,
  evidenceKeyFor,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("evidence-hardening");
const BASE = "/api/hris/payroll/disbursement-batches";
const FOREIGN_TENANT_ID = "99999999-9999-4999-8999-999999999999";
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
let first: Staff; // payroll.disburse.approve, real MFA challenge
let second: Staff; // a different person with the same rights
let viewer: Staff; // payroll.view only: must not read proof

/** Staff holding exactly these permissions; `challenged` skips the password step-up. */
async function staff(permissions: string[], challenged: boolean) {
  const client = agent(app);
  await signUp(client, "Payout Hardening");
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
  if (challenged) {
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
  }
  return { client, userId } as Staff;
}

beforeAll(async () => {
  first = await staff(["payroll.view", "payroll.disburse.approve"], true);
  second = await staff(["payroll.view", "payroll.disburse.approve"], true);
  viewer = await staff(["payroll.view"], true);
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
  const bytes = await pdfBytes();
  const res = await who.client
    .post(`${BASE}/${batchId}/evidence`)
    .set(originHeader)
    .attach("file", bytes, {
      filename: "bukti.pdf",
      contentType: "application/pdf",
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    key: (res.body.data as { evidenceKey: string }).evidenceKey,
    bytes,
  };
}

/** A key with the exact accepted shape for this batch whose object was never uploaded. */
const fictitiousKey = (batchId: string) =>
  evidenceKeyFor(W.tenantId, batchId, `${randomUUID()}.pdf`);

async function exportedRun() {
  const slips = [bank(BUDI, 4_000_000), bank(SITI, 3_000_000)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  return { runId, batchId, items };
}
/** Money statuses and journals of a batch, to prove a refusal changed nothing. */
const moneyState = async (batchId: string) =>
  JSON.stringify({
    batch: (await W.batchById(batchId)).status,
    items: (await W.itemsOf(batchId)).map((i) => ({
      id: i.id,
      status: i.status,
      resolved_by: i.resolved_by,
      resolved_by_2: i.resolved_by_2,
      returned_by: i.returned_by,
      returned_by_2: i.returned_by_2,
    })),
    postings: (await W.postingsOf(batchId)).length,
  });

const resolveBody = (
  itemId: string,
  evidenceKey: string,
  outcome = "failed",
) => ({
  itemIds: [itemId],
  outcome,
  evidenceKey,
  note: "Bank menolak transfer, tidak ada dana keluar",
});
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
    .send(resolveBody(itemId, evidenceKey, outcome));
const postReturn = (
  who: Staff,
  batchId: string,
  itemId: string,
  evidenceKey: string,
) =>
  who.client
    .post(`${BASE}/${batchId}/return`)
    .set(originHeader)
    .send({
      itemIds: [itemId],
      evidenceKey,
      note: "Bank mengembalikan dana, rekening tujuan ditutup",
    });
const postConfirm = (
  who: Staff,
  batchId: string,
  results: { itemId: string; bankRef: string; evidenceKey?: string }[],
) =>
  who.client
    .post(`${BASE}/${batchId}/confirm`)
    .set(originHeader)
    .send({
      results: results.map((r) => ({ ...r, result: "succeeded" })),
    });

const codeOf = (body: { error?: { code?: string } }) => body.error?.code;
function expectEvidenceInvalid(res: {
  status: number;
  body: { error?: { code?: string } };
}) {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(codeOf(res.body)).toBe("PAYOUT_EVIDENCE_INVALID");
}

// =========================================================================
// legend-bmlwf: the second resolve step needs the same proof
// =========================================================================

describe("legend-bmlwf second resolve step: same evidence as the first", () => {
  it("[bmlwf-different-evidence-refused] two different proofs (both real, same batch) are refused at step 2: 409/422, the slip stays blocked, then the same proof frees it", async () => {
    const { runId, batchId, items } = await exportedRun();
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    const proofA = await uploadProof(first, batchId);
    const proofB = await uploadProof(second, batchId);
    expect(proofB.key, "premise: two distinct uploads").not.toBe(proofA.key);

    const step1 = await postResolve(first, batchId, idOf(siti), proofA.key);
    expect(step1.status, JSON.stringify(step1.body)).toBe(200);
    const afterStep1 = await moneyState(batchId);

    const step2 = await postResolve(second, batchId, idOf(siti), proofB.key);
    expect([409, 422], JSON.stringify(step2.body)).toContain(step2.status);

    // Nothing moved: still exported, one resolver, the first proof kept.
    const row = await W.itemOfPerson(batchId, SITI);
    expect(row.status, "the slip must not be freed").toBe("exported");
    expect(row.resolved_by).toBe(first.userId);
    expect(row.resolved_by_2).toBeNull();
    expect(row.resolution_evidence_key).toBe(proofA.key);
    expect(await moneyState(batchId)).toBe(afterStep1);
    expect((await W.batchById(batchId)).status).toBe("exported");
    expect((await W.runRow(runId)).status).toBe("locked");
    // No pay-out twice: a live item still holds the slip, so no new batch.
    await W.expectRefused(W.createBatch(runId));

    // Control: the same proof as the first step completes the resolve.
    const ok = await postResolve(second, batchId, idOf(siti), proofA.key);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const done = await W.itemOfPerson(batchId, SITI);
    expect(done.status).toBe("failed");
    expect(done.resolved_by_2).toBe(second.userId);
  });

  it("[bmlwf-not-sent-different-evidence-refused] the same holds for outcome not_sent: another proof at step 2 does not free the slip", async () => {
    const { runId, batchId, items } = await exportedRun();
    const budi = items.find((i) => i.employee_id === BUDI.id)!;
    const proofA = await uploadProof(first, batchId);
    const proofB = await uploadProof(first, batchId);

    const step1 = await postResolve(
      first,
      batchId,
      idOf(budi),
      proofA.key,
      "not_sent",
    );
    expect(step1.status, JSON.stringify(step1.body)).toBe(200);
    const step2 = await postResolve(
      second,
      batchId,
      idOf(budi),
      proofB.key,
      "not_sent",
    );
    expect([409, 422], JSON.stringify(step2.body)).toContain(step2.status);

    const row = await W.itemOfPerson(batchId, BUDI);
    expect(row.status).toBe("exported");
    expect(row.resolved_by_2).toBeNull();
    await W.expectRefused(W.createBatch(runId));
  });
});

// =========================================================================
// legend-01gg8: the proof must really exist in storage
// =========================================================================

describe("legend-01gg8 a proof key must name an uploaded object of this batch", () => {
  it("[01gg8-resolve-fictitious-key] resolve with a well-shaped but never uploaded key: 422 PAYOUT_EVIDENCE_INVALID, nothing recorded; the real upload is accepted", async () => {
    const { runId, batchId, items } = await exportedRun();
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    const before = await moneyState(batchId);

    const res = await postResolve(
      first,
      batchId,
      idOf(siti),
      fictitiousKey(batchId),
    );
    expectEvidenceInvalid(res);
    const row = await W.itemOfPerson(batchId, SITI);
    expect(row.status).toBe("exported");
    expect(row.resolved_by, "no resolver recorded").toBeNull();
    expect(row.resolution_evidence_key).toBeNull();
    expect(await moneyState(batchId)).toBe(before);
    await W.expectRefused(W.createBatch(runId));

    // Control: a real upload of this batch is accepted.
    const proof = await uploadProof(first, batchId);
    const ok = await postResolve(first, batchId, idOf(siti), proof.key);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await W.itemOfPerson(batchId, SITI)).resolved_by).toBe(
      first.userId,
    );
  });

  it("[01gg8-resolve-fictitious-step2] a real first step followed by a never uploaded key at step 2 does not free the slip", async () => {
    const { batchId, items } = await exportedRun();
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    const proof = await uploadProof(first, batchId);
    const step1 = await postResolve(first, batchId, idOf(siti), proof.key);
    expect(step1.status, JSON.stringify(step1.body)).toBe(200);

    const step2 = await postResolve(
      second,
      batchId,
      idOf(siti),
      fictitiousKey(batchId),
    );
    expect([409, 422], JSON.stringify(step2.body)).toContain(step2.status);
    const row = await W.itemOfPerson(batchId, SITI);
    expect(row.status).toBe("exported");
    expect(row.resolved_by_2).toBeNull();
  });

  it("[01gg8-resolve-foreign-tenant-key] a key in another tenant's folder, or one that climbs out of the batch folder, is 422 PAYOUT_EVIDENCE_INVALID and nothing is recorded", async () => {
    const { batchId, items } = await exportedRun();
    const other = await exportedRun();
    const otherProof = await uploadProof(first, other.batchId);
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    const before = await moneyState(batchId);
    const keys = [
      `tenants/${FOREIGN_TENANT_ID}/payroll-payout/${batchId}/${randomUUID()}.pdf`,
      // A real object of another batch, reached through "..".
      otherProof.key.replace(
        `/${other.batchId}/`,
        `/${batchId}/../${other.batchId}/`,
      ),
    ];
    for (const key of keys)
      expectEvidenceInvalid(await postResolve(first, batchId, idOf(siti), key));
    expect(await moneyState(batchId)).toBe(before);
  });

  it("[01gg8-confirm-fictitious-key] confirm with a never uploaded proof: 422 PAYOUT_EVIDENCE_INVALID, items stay exported, nothing posts; with the real upload it succeeds exactly once", async () => {
    const { batchId, items } = await exportedRun();
    const before = await moneyState(batchId);
    const resultsWith = (evidenceKey: string) =>
      items.map((item, index) => ({
        itemId: idOf(item),
        bankRef: `BCA-${batchId.slice(0, 8)}-${index}`,
        evidenceKey,
      }));

    const res = await postConfirm(
      first,
      batchId,
      resultsWith(fictitiousKey(batchId)),
    );
    expectEvidenceInvalid(res);
    for (const item of await W.itemsOf(batchId))
      expect(item.status, "no money status changed").toBe("exported");
    expect(await W.postingsOf(batchId)).toHaveLength(0);
    expect(await moneyState(batchId)).toBe(before);

    // Control: the real proof is accepted, and a second confirm cannot pay twice.
    const proof = await uploadProof(first, batchId);
    const ok = await postConfirm(first, batchId, resultsWith(proof.key));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    for (const item of await W.itemsOf(batchId))
      expect(item.status).toBe("succeeded");
    expect(await W.postingsOf(batchId)).toHaveLength(1);
    const again = await postConfirm(second, batchId, resultsWith(proof.key));
    expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(again.status).toBeLessThan(500);
    expect(await W.postingsOf(batchId), "no second posting").toHaveLength(1);
  });

  it("[01gg8-return-fictitious-key] return with a never uploaded proof: 422 PAYOUT_EVIDENCE_INVALID, the item stays succeeded, no return journal; the real upload records the first step", async () => {
    const { batchId, items } = await exportedRun();
    await W.confirm(
      batchId,
      items.map((item, index) => ({
        itemId: idOf(item),
        result: "succeeded" as const,
        bankRef: `BCA-${batchId.slice(0, 8)}-${index}`,
      })),
    );
    const budi = await W.itemOfPerson(batchId, BUDI);
    const before = await moneyState(batchId);

    const res = await postReturn(
      first,
      batchId,
      idOf(budi),
      fictitiousKey(batchId),
    );
    expectEvidenceInvalid(res);
    const row = await W.itemOfPerson(batchId, BUDI);
    expect(row.status).toBe("succeeded");
    expect(row.returned_by, "no returner recorded").toBeNull();
    expect(await W.countJournals(`payroll-payout-return:${idOf(budi)}`)).toBe(
      0,
    );
    expect(await moneyState(batchId)).toBe(before);

    // Control: the real proof is accepted for the first step.
    const proof = await uploadProof(first, batchId);
    const ok = await postReturn(first, batchId, idOf(budi), proof.key);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await W.itemOfPerson(batchId, BUDI)).returned_by).toBe(
      first.userId,
    );
  });

  it("[01gg8-no-repay-after-refusals] after refused resolves the slip is still held: no new batch for the run and the exported batch is untouched", async () => {
    const { runId, batchId, items } = await exportedRun();
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    for (const key of [fictitiousKey(batchId), fictitiousKey(batchId)])
      expectEvidenceInvalid(await postResolve(first, batchId, idOf(siti), key));
    await W.expectRefused(W.createBatch(runId));
    // The only batch of the run is still the exported one; its items are untouched.
    expect((await W.batchById(batchId)).status).toBe("exported");
    expect(
      (await W.itemsOf(batchId)).every((i) => i.status === "exported"),
    ).toBe(true);
  });
});

// =========================================================================
// legend-t58lr: read path for stored proof
// =========================================================================

type ReadResult = {
  status: number;
  json: { data?: { url?: unknown }; error?: { code?: string } } | null;
  bytes: Buffer;
};
async function readProof(
  who: { client: ReturnType<typeof agent> },
  batchId: string,
  key: string,
): Promise<ReadResult> {
  const res = await who.client
    .get(`${BASE}/${batchId}/evidence`)
    .query({ key })
    .buffer(true)
    .parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => done(null, Buffer.concat(chunks)));
    });
  const bytes = Buffer.isBuffer(res.body)
    ? (res.body as Buffer)
    : Buffer.alloc(0);
  const type = String(res.headers["content-type"] ?? "");
  let json: ReadResult["json"] = null;
  if (type.includes("json")) {
    try {
      json = JSON.parse(bytes.toString("utf8"));
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, bytes };
}
/** The proof was handed out: a signed URL or the stored bytes. */
const delivered = (read: ReadResult, expected: Buffer) =>
  read.status === 200 &&
  ((typeof read.json?.data?.url === "string" &&
    read.json.data.url.length > 0) ||
    read.bytes.equals(expected));
const leaked = (read: ReadResult) =>
  typeof read.json?.data?.url === "string" || read.bytes.includes("%PDF");

describe("legend-t58lr reading stored proof is bound to tenant + batch", () => {
  it("[t58lr-read-own-proof] an approver can read the proof uploaded for the batch (signed URL or stream)", async () => {
    const { batchId } = await exportedRun();
    const proof = await uploadProof(first, batchId);
    const before = await moneyState(batchId);
    const read = await readProof(second, batchId, proof.key);
    expect(
      delivered(read, proof.bytes),
      `status ${read.status}: ${read.bytes.toString("utf8").slice(0, 200)}`,
    ).toBe(true);
    expect(await moneyState(batchId), "reading changes nothing").toBe(before);
  });

  it("[t58lr-read-other-batch-refused] a proof of batch B cannot be read through batch A, nor a foreign tenant key, nor a key that climbs out with '..'", async () => {
    const a = await exportedRun();
    const b = await exportedRun();
    const proofA = await uploadProof(first, a.batchId);
    const proofB = await uploadProof(first, b.batchId);
    // Control: batch A's own proof is delivered.
    expect(
      delivered(await readProof(first, a.batchId, proofA.key), proofA.bytes),
    ).toBe(true);

    const cases: [string, string][] = [
      ["key of batch B", proofB.key],
      [
        "foreign tenant",
        `tenants/${FOREIGN_TENANT_ID}/payroll-payout/${a.batchId}/${randomUUID()}.pdf`,
      ],
      [
        "dot-dot into batch B",
        proofB.key.replace(`/${b.batchId}/`, `/${a.batchId}/../${b.batchId}/`),
      ],
    ];
    for (const [label, key] of cases) {
      const read = await readProof(first, a.batchId, key);
      expect(read.status, label).toBe(422);
      expect(read.json?.error?.code, label).toBe("PAYOUT_EVIDENCE_INVALID");
      expect(leaked(read), `${label}: nothing handed out`).toBe(false);
    }
  });

  it("[t58lr-read-never-uploaded] a well-shaped key whose object does not exist is 404 or 422, nothing handed out", async () => {
    const { batchId } = await exportedRun();
    const proof = await uploadProof(first, batchId);
    expect(
      delivered(await readProof(first, batchId, proof.key), proof.bytes),
    ).toBe(true);
    const read = await readProof(first, batchId, fictitiousKey(batchId));
    expect([404, 422]).toContain(read.status);
    expect(leaked(read)).toBe(false);
  });

  it("[t58lr-read-guard] reading needs payroll.disburse.approve: a payroll.view holder gets 403 and not signed in gets 401, with nothing handed out", async () => {
    const { batchId } = await exportedRun();
    const proof = await uploadProof(first, batchId);
    // Control: the approver reads it.
    expect(
      delivered(await readProof(first, batchId, proof.key), proof.bytes),
    ).toBe(true);

    const denied = await readProof(viewer, batchId, proof.key);
    expect(denied.status).toBe(403);
    expect(leaked(denied)).toBe(false);

    const anonymous = await readProof(
      { client: agent(app) },
      batchId,
      proof.key,
    );
    expect(anonymous.status).toBe(401);
    expect(leaked(anonymous)).toBe(false);
  });
});
