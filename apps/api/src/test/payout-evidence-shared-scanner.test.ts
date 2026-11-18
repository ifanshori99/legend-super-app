// M6 (bead legend-egrrp, brief docs/briefs/sub-storage-m6.md "Kontrak" and
// "Test wajib"): payout payment proof goes through the shared upload scan
// pipeline (scanUploadBytes). Written fail-first from the brief, not from the
// implementation.
//
// Contract under test (POST /api/hris/payroll/disbursement-batches/:id/evidence):
// - PDF: scanner must accept documents (else 503 SERVICE_UNAVAILABLE), the PDF
//   must be safe (JavaScript etc. -> 422 PAYOUT_EVIDENCE_REJECTED), then the
//   scan runs (detection 422 -> PAYOUT_EVIDENCE_REJECTED, outage 503 forwarded
//   as SCANNER_UNAVAILABLE). All of it BEFORE anything is stored.
// - Image: re-encoded; a scanner outage is tolerated only for a scanner that
//   opted in with failOpenForImages === true.
// - Money: a refused upload leaves the batch and items untouched and yields no
//   key, so resolve/confirm with a key that was never stored are refused with
//   422 PAYOUT_EVIDENCE_INVALID; nobody is paid.
//
// Assumptions:
// - Error code is read from `body.error.code` (the API error envelope used by
//   the sibling payout suites).
// - Detection is simulated with a scanner throwing HttpError(422,
//   "UPLOAD_REJECTED"); an outage with HttpError(503, "SCANNER_UNAVAILABLE"),
//   the shapes the existing scanner tests use.
// - Old behaviour that must hold: cash channel -> 409, draft / approved but not
//   exported batch -> 409 (brief says 409; the older suite accepted 409 or 422).
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { PAYOUT_EVIDENCE_MAX_BYTES } from "@starter/shared/validators/payroll-payout";
import { createApp } from "../app.ts";
import { HttpError } from "../lib/http-error.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import {
  NoopMalwareScanner,
  type MalwareScanner,
} from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import * as glService from "../services/payroll-payout-gl.service.ts";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  APP,
  BUDI,
  CASHIER,
  APP3,
  SITI,
  actorOf,
  bank,
  cash,
  evidenceKeyFor,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

// Bank reference of a return claim: unique per claim (evidence key), identical
// on both steps of the same claim.
const bankRefOf = (evidenceKey: string) =>
  `TRX${createHash("sha256").update(evidenceKey).digest("hex").slice(0, 8)}`;

const W = installPayoutWorld("evidence-shared-scanner");
const BASE = "/api/hris/payroll/disbursement-batches";
const idOf = (row: Row) => row.id as string;

function makeRuntime(scanner: MalwareScanner) {
  const store = new FakeObjectStorage();
  const put = vi.spyOn(store, "put");
  const runtime: StorageRuntime = {
    storage: store,
    scanner,
    fileSigner: async () => "https://signed.example.test/x",
    hrisDocumentSigner: async () => null,
  };
  return {
    store,
    put,
    app: createApp({ storageRuntime: runtime }),
    blobCount: () =>
      (store as unknown as { objects: Map<string, unknown> }).objects.size,
  };
}
type Rt = ReturnType<typeof makeRuntime>;

const dbOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const grantedUsers: string[] = [];
const enrolledUsers: string[] = [];
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

/** An approver (payroll.disburse.approve) with a real, challenged MFA factor. */
async function approver(app: ReturnType<typeof createApp>) {
  const client = agent(app);
  await signUp(client, "Payout Shared Scanner");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
  enrolledUsers.push(userId);
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
  return { client };
}
type Who = Awaited<ReturnType<typeof approver>>;

const upload = (
  who: Who,
  batchId: string,
  bytes: Uint8Array,
  contentType = "application/pdf",
  filename = "bukti.pdf",
) =>
  who.client
    .post(`${BASE}/${batchId}/evidence`)
    .set(originHeader)
    .attach("file", Buffer.from(bytes), { filename, contentType });

const realPng = () =>
  sharp({
    create: { width: 24, height: 16, channels: 3, background: "#0033cc" },
  })
    .png()
    .toBuffer();

/** A real PDF whose catalog OpenAction runs JavaScript. */
async function javascriptPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.catalog.set(
    PDFName.of("OpenAction"),
    doc.context.obj({
      Type: "Action",
      S: "JavaScript",
      JS: PDFString.of("app.alert('x')"),
    }),
  );
  return doc.save({ useObjectStreams: false });
}

const detection = () =>
  new HttpError(422, "UPLOAD_REJECTED", "Berkas ditolak pemindai malware.");
const outage = () =>
  new HttpError(
    503,
    "SCANNER_UNAVAILABLE",
    "File scanning is temporarily unavailable.",
  );
const scannerThrowing = (
  failure: () => Error,
  failOpenForImages?: boolean,
): MalwareScanner => ({
  ...(failOpenForImages === undefined ? {} : { failOpenForImages }),
  scan: async () => {
    throw failure();
  },
});

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
const snapshotOf = async (batchId: string) =>
  JSON.stringify({
    batch: await W.batchById(batchId),
    items: await W.itemsOf(batchId),
  });
const codeOf = (res: { body: { error?: { code?: string } } }) =>
  res.body.error?.code;

/** Nobody is paid: no key was issued, so any forged key is refused, nothing posts. */
async function expectNobodyPaid(
  rt: Rt,
  run: Awaited<ReturnType<typeof exportedRun>>,
  before: string,
) {
  expect(await snapshotOf(run.batchId), "batch and items unchanged").toBe(
    before,
  );
  expect(await W.postingsOf(run.batchId), "nothing posted").toHaveLength(0);
  expect(rt.blobCount(), "no blob stored").toBe(0);

  const forged = evidenceKeyFor(W.tenantId, run.batchId, `${randomUUID()}.pdf`);
  const siti = run.items.find((i) => i.employee_id === SITI.id)!;
  await W.expectRefused(
    W.resolve(run.batchId, [idOf(siti)], "failed", APP, forged, {
      storage: rt.store,
      context: W.scope(),
    }),
    { status: 422, code: "PAYOUT_EVIDENCE_INVALID" },
  );
  await W.expectRefused(
    W.confirm(
      run.batchId,
      [
        {
          itemId: idOf(siti),
          result: "succeeded",
          bankRef: "BCA-FORGED-1",
          evidenceKey: forged,
        },
      ],
      undefined,
      { storage: rt.store, context: W.scope() },
    ),
    { status: 422, code: "PAYOUT_EVIDENCE_INVALID" },
  );
  expect(await snapshotOf(run.batchId), "refused calls changed nothing").toBe(
    before,
  );
  expect(await W.postingsOf(run.batchId)).toHaveLength(0);
}

describe("legend-egrrp payout proof uses the shared scan pipeline", () => {
  it("[egrrp-pdf-ok] a valid PDF with a scanner that accepts documents is stored (201)", async () => {
    const rt = makeRuntime(new NoopMalwareScanner({ acceptsDocuments: true }));
    const { batchId } = await exportedRun();
    const who = await approver(rt.app);
    const bytes = await validPdfBytes({ marker: "bukti" });
    const res = await upload(who, batchId, bytes);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const key = res.body.data.evidenceKey as string;
    expect(key).toMatch(
      new RegExp(
        `^tenants/${W.tenantId}/payroll-payout/${batchId}/[0-9a-f-]{36}\\.pdf$`,
      ),
    );
    expect(rt.blobCount(), "the object is stored").toBe(1);
    const stored = await rt.store.get(W.scope(), {
      tenantId: W.tenantId,
      outletId: null,
      reference: "payout-evidence-shared-scanner-test",
      key,
    } as never);
    expect(Buffer.from(stored.content as Uint8Array)).toEqual(
      Buffer.from(bytes),
    );
  });

  it("[egrrp-pdf-no-documents] a scanner that does not accept documents refuses a PDF with 503 SERVICE_UNAVAILABLE and never stores", async () => {
    const scan = vi.fn(async () => {});
    const rt = makeRuntime({ scan, acceptsDocuments: false });
    const { batchId } = await exportedRun();
    const who = await approver(rt.app);
    const res = await upload(who, batchId, await validPdfBytes());
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(codeOf(res)).toBe("SERVICE_UNAVAILABLE");
    expect(scan, "the scanner is not even asked").not.toHaveBeenCalled();
    expect(rt.put, "put is not called").not.toHaveBeenCalled();
    expect(rt.blobCount()).toBe(0);
  });

  it("[egrrp-pdf-javascript] a PDF with JavaScript is refused 422 PAYOUT_EVIDENCE_REJECTED, not stored, and nobody is paid", async () => {
    const scan = vi.fn(async () => {});
    const rt = makeRuntime({ scan, acceptsDocuments: true });
    const run = await exportedRun();
    const who = await approver(rt.app);
    const before = await snapshotOf(run.batchId);
    const res = await upload(who, run.batchId, await javascriptPdf());
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(codeOf(res)).toBe("PAYOUT_EVIDENCE_REJECTED");
    expect(
      scan,
      "the PDF safety check runs before the scan",
    ).not.toHaveBeenCalled();
    expect(rt.put).not.toHaveBeenCalled();
    await expectNobodyPaid(rt, run, before);
  });

  it("[egrrp-scanner-detection] a scanner detection (422) is PAYOUT_EVIDENCE_REJECTED for a PDF and for an image, not stored, nobody paid", async () => {
    const rt = makeRuntime(scannerThrowing(detection, true));
    const run = await exportedRun();
    const who = await approver(rt.app);
    const before = await snapshotOf(run.batchId);
    for (const [bytes, type, name] of [
      [await validPdfBytes(), "application/pdf", "bukti.pdf"],
      [await realPng(), "image/png", "bukti.png"],
    ] as const) {
      const res = await upload(who, run.batchId, bytes, type, name);
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(422);
      expect(codeOf(res), name).toBe("PAYOUT_EVIDENCE_REJECTED");
    }
    expect(rt.put).not.toHaveBeenCalled();
    await expectNobodyPaid(rt, run, before);
  });

  it("[egrrp-scanner-outage] a dead scanner (503) refuses a PDF with 503 SCANNER_UNAVAILABLE and stores nothing, nobody paid", async () => {
    const rt = makeRuntime(scannerThrowing(outage, true));
    const run = await exportedRun();
    const who = await approver(rt.app);
    const before = await snapshotOf(run.batchId);
    const res = await upload(who, run.batchId, await validPdfBytes());
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(codeOf(res)).toBe("SCANNER_UNAVAILABLE");
    expect(rt.put).not.toHaveBeenCalled();
    await expectNobodyPaid(rt, run, before);
  });

  it("[egrrp-image-fail-open] a dead scanner that opted in (failOpenForImages) still accepts a re-encoded image; one that did not opt in answers 503", async () => {
    const run = await exportedRun();

    const open = makeRuntime(scannerThrowing(outage, true));
    const whoOpen = await approver(open.app);
    const accepted = await upload(
      whoOpen,
      run.batchId,
      await realPng(),
      "image/png",
      "bukti.png",
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.data.contentType).toBe("image/png");
    expect(open.blobCount()).toBe(1);

    const closed = makeRuntime(scannerThrowing(outage));
    const whoClosed = await approver(closed.app);
    const refused = await upload(
      whoClosed,
      run.batchId,
      await realPng(),
      "image/png",
      "bukti.png",
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(503);
    expect(closed.put).not.toHaveBeenCalled();
    expect(closed.blobCount()).toBe(0);
  });

  it("[egrrp-old-behaviour] wrong channel 409, batch not yet exported 409, above 5 MB 413 still hold", async () => {
    const rt = makeRuntime(new NoopMalwareScanner({ acceptsDocuments: true }));
    const who = await approver(rt.app);
    const pdf = await validPdfBytes();

    const cashSlips = [cash(CASHIER, 900_000)];
    const cashRun = await W.seedRun(cashSlips);
    await W.postLockedJournal(cashRun, cashSlips);
    // 1053: approving a cash batch needs the 1102 cash to cover it.
    await W.fundPettyCash(900_000);
    const cashId = await W.approvedBatch(cashRun, "cash");
    const wrongChannel = await upload(who, cashId, pdf);
    expect(wrongChannel.status, JSON.stringify(wrongChannel.body)).toBe(409);

    const draftSlips = [bank(BUDI, 4_000_000)];
    const draftRun = await W.seedRun(draftSlips);
    await W.postLockedJournal(draftRun, draftSlips);
    const draftId = await W.createBatch(draftRun);
    const draft = await upload(who, draftId, pdf);
    expect(draft.status, JSON.stringify(draft.body)).toBe(409);

    const notExportedSlips = [bank(SITI, 3_000_000)];
    const notExportedRun = await W.seedRun(notExportedSlips);
    await W.postLockedJournal(notExportedRun, notExportedSlips);
    const approvedId = await W.approvedBatch(notExportedRun);
    const notExported = await upload(who, approvedId, pdf);
    expect(notExported.status, JSON.stringify(notExported.body)).toBe(409);

    const { batchId } = await exportedRun();
    const big = Buffer.concat([
      Buffer.from(pdf),
      Buffer.alloc(PAYOUT_EVIDENCE_MAX_BYTES + 1 - pdf.length, 0x20),
    ]);
    expect(big.length).toBe(PAYOUT_EVIDENCE_MAX_BYTES + 1);
    const tooLarge = await upload(who, batchId, big);
    expect(tooLarge.status, JSON.stringify(tooLarge.body)).toBe(413);

    expect(rt.put, "nothing stored by any refused call").not.toHaveBeenCalled();
    expect(rt.blobCount()).toBe(0);
  });

  it("[egrrp-scanner-plain-error] a scanner that throws a plain Error is an outage: PDF 503 SCANNER_UNAVAILABLE, PNG without fail-open 503, nothing stored", async () => {
    const rt = makeRuntime(scannerThrowing(() => new Error("socket exploded")));
    const run = await exportedRun();
    const who = await approver(rt.app);
    const before = await snapshotOf(run.batchId);
    const pdf = await upload(who, run.batchId, await validPdfBytes());
    expect(pdf.status, JSON.stringify(pdf.body)).toBe(503);
    expect(codeOf(pdf)).toBe("SCANNER_UNAVAILABLE");
    const png = await upload(
      who,
      run.batchId,
      await realPng(),
      "image/png",
      "bukti.png",
    );
    expect(png.status, JSON.stringify(png.body)).toBe(503);
    expect(rt.put).not.toHaveBeenCalled();
    await expectNobodyPaid(rt, run, before);
  });

  it("[egrrp-check-order] the batch checks come before the safety check and the scan: a JavaScript PDF sent to a cash or draft batch is 409, the scanner is not asked", async () => {
    const scan = vi.fn(async () => {});
    const rt = makeRuntime({ scan, acceptsDocuments: true });
    const who = await approver(rt.app);
    const bad = await javascriptPdf();

    const cashSlips = [cash(CASHIER, 900_000)];
    const cashRun = await W.seedRun(cashSlips);
    await W.postLockedJournal(cashRun, cashSlips);
    // 1053: approving a cash batch needs the 1102 cash to cover it.
    await W.fundPettyCash(900_000);
    const cashId = await W.approvedBatch(cashRun, "cash");
    const wrongChannel = await upload(who, cashId, bad);
    expect(wrongChannel.status, JSON.stringify(wrongChannel.body)).toBe(409);

    const draftSlips = [bank(BUDI, 4_000_000)];
    const draftRun = await W.seedRun(draftSlips);
    await W.postLockedJournal(draftRun, draftSlips);
    const draftId = await W.createBatch(draftRun);
    const draft = await upload(who, draftId, bad);
    expect(draft.status, JSON.stringify(draft.body)).toBe(409);

    expect(scan).not.toHaveBeenCalled();
    expect(rt.put).not.toHaveBeenCalled();
  });

  it("[egrrp-forged-key-later-steps] after a refused upload there is no key: return and overpaid with a never-stored key are 422 PAYOUT_EVIDENCE_INVALID and move no money", async () => {
    const rt = makeRuntime(scannerThrowing(detection, true));
    const who = await approver(rt.app);
    const store = { storage: rt.store, context: W.scope() };

    // A late double payment: Budi resolved as failed, a follow-up batch paid
    // him, so his first-batch item may be recorded as overpaid; Siti's item is
    // succeeded, so it may be returned. Only the proof key is wrong.
    const { runId, batchId, items } = await exportedRun();
    const budi = items.find((i) => i.employee_id === BUDI.id)!;
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    await W.confirm(batchId, W.succeedItems(batchId, [siti]));
    await W.resolve(batchId, [idOf(budi)], "failed", APP);
    await W.resolve(batchId, [idOf(budi)], "failed", APP3);
    const followUp = await W.exportedBatch(runId);
    const followItems = (await W.itemsOf(followUp)).filter(
      (i) => i.status === "exported",
    );
    await W.confirm(followUp, W.succeedItems(followUp, followItems));

    const refused = await upload(who, batchId, await validPdfBytes());
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(rt.blobCount()).toBe(0);

    const forged = evidenceKeyFor(W.tenantId, batchId, `${randomUUID()}.pdf`);
    const before = await snapshotOf(batchId);
    const postingsBefore = (await W.postingsOf(batchId)).length;

    await W.expectRefused(
      W.inTx((tx) =>
        returnManualItems(
          tx,
          actorOf(APP),
          batchId,
          {
            itemIds: [idOf(siti)],
            evidenceKey: forged,
            bankRef: bankRefOf(forged),
            note: "Bank mengembalikan dana, rekening tujuan ditutup",
          } as never,
          store,
        ),
      ),
      { status: 422, code: "PAYOUT_EVIDENCE_INVALID" },
    );

    const recordOverpaid = (glService as Record<string, unknown>)[
      "recordOverpaidItem"
    ] as (
      tx: unknown,
      actor: unknown,
      itemId: string,
      input: { evidenceKey: string; note: string },
      proofs: unknown,
    ) => Promise<unknown>;
    expect(typeof recordOverpaid).toBe("function");
    await W.expectRefused(
      W.inTx((tx) =>
        recordOverpaid(
          tx,
          actorOf(APP),
          idOf(budi),
          {
            evidenceKey: forged,
            note: "Mutasi bank menunjukkan transfer kedua untuk slip yang sama",
          },
          store,
        ),
      ),
      { status: 422, code: "PAYOUT_EVIDENCE_INVALID" },
    );

    expect(await snapshotOf(batchId), "no item or batch moved").toBe(before);
    expect(await W.postingsOf(batchId)).toHaveLength(postingsBefore);
  });
});
