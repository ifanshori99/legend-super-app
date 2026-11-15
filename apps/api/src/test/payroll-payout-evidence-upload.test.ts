// Payout evidence upload (bead legend-zoqh1; brief docs/briefs/731-payout-api-gaps-impl.md
// A and T). Written fail-first from the brief and the shared contract
// (PayrollPayoutEvidenceUploadDto, PAYOUT_EVIDENCE_* in
// packages/shared/src/validators/payroll-payout.ts), not from the implementation.
//
// Route: POST /api/hris/payroll/disbursement-batches/:id/evidence, one
// multipart part `file`, permission payroll.disburse.approve. Answers 201
// { data: { evidenceKey, contentType, sizeBytes } }. The key is
// tenants/<tenantId>/payroll-payout/<batchId>/<uuid>.<pdf|jpg|png>, is stored
// private, is accepted by resolve of that batch only, and the upload never
// changes a batch or an item.
//
// Assumptions (the brief is silent, stated so they can be contested):
// - The resolve/return acceptance is proven through the existing service
//   `resolveManualItems` (as the other payout suites do) so the proof does not
//   depend on the step-up password flow of the HTTP resolve route. The return
//   route accepts the same key through the same `assertEvidenceKeyForBatch`
//   check; it is not driven separately here.
// - A "batch of another tenant" is built by moving an existing batch row to a
//   foreign tenant id for the duration of the test (restored in `finally`).
// - A resolve of an item that is already final is refused with a 4xx (the exact
//   code is not asserted); the proof is that nothing changes and nothing posts.
// - Step-up (round 2, A2): the HTTP route needs the same fresh MFA proof as
//   resolve/return. The brief does not say how a password travels in a multipart
//   request, so the happy paths use an approver with a real MFA challenge (the
//   factor pre-dates the session), which skips the password; the refusal test
//   uses an enrollment-only approver without a password: 401 REAUTH_REQUIRED.
// - Round 2 (A1): JPEG/PNG are decoded and re-encoded (EXIF removed); so the
//   images in these tests are real (made with sharp) and `sizeBytes` is the size
//   of the stored bytes, not of the uploaded ones. A truncated image is 415.
// - A scanner that rejects (infection, a 422 detection) is refused with a 4xx
//   and no blob; the exact 4xx is not pinned. M6 (legend-egrrp): a scanner that
//   merely fails (not a detection) is now 503 SCANNER_UNAVAILABLE, not 422. A scanner with acceptsDocuments:false refuses a PDF
//   with 503 (assertScannerAcceptsDocuments) and no blob.
// - A batch that is a draft or a cash batch is refused with 409 or 422 before
//   any blob is stored (the brief says "409 or 422 per the service's pattern").
// - The return service refuses a key of another batch with the same
//   PAYOUT_EVIDENCE_INVALID 422 as resolve (same assertEvidenceKeyForBatch).
// - Empty file: 422, size above PAYOUT_EVIDENCE_MAX_BYTES: 413, bytes that are
//   not pdf/jpeg/png (whatever the declared type says): 415, as the brief says.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { PAYOUT_EVIDENCE_MAX_BYTES } from "@starter/shared/validators/payroll-payout";
import { createApp } from "../app.ts";
import { HttpError } from "../lib/http-error.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import {
  NoopMalwareScanner,
  type MalwareScanner,
} from "../services/core-image.ts";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import {
  APP,
  APP2,
  APP3,
  BUDI,
  CASHIER,
  SITI,
  actorOf,
  bank,
  cash,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("evidence-upload");
const BASE = "/api/hris/payroll/disbursement-batches";
const FOREIGN_TENANT_ID = "99999999-9999-4999-8999-999999999999";
const idOf = (row: Row) => row.id as string;

/** An app wired to its own fake storage and the given scanner, with a blob counter. */
function makeRuntime(scanner: MalwareScanner) {
  const store = new FakeObjectStorage();
  const runtime: StorageRuntime = {
    storage: store,
    scanner,
    fileSigner: async () => "https://signed.example.test/x",
    hrisDocumentSigner: async () => null,
  };
  return {
    store,
    app: createApp({ storageRuntime: runtime }),
    blobCount: () =>
      (store as unknown as { objects: Map<string, unknown> }).objects.size,
  };
}
const main = makeRuntime(new NoopMalwareScanner());
const storage = main.store;
const appWithStorage = main.app;
const blobCount = main.blobCount;
/** The proof store matching the storage that the uploads of this suite write to. */
const store = () => ({ storage, context: W.scope() });
const appWithoutStorage = createApp({ storageRuntime: null });

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

type Staff = Awaited<ReturnType<typeof staff>>;

/**
 * A staff member holding exactly these permissions whose second factor was
 * enrolled and verified in this session. `challenged` backdates the factor and
 * verifies again, so the session carries a real MFA challenge (no password
 * needed for step-up); without it only the enrollment itself is proof.
 */
async function mfaStaff(
  app: ReturnType<typeof createApp>,
  permissions: string[],
  challenged: boolean,
) {
  const client = agent(app);
  await signUp(client, "Payout Upload");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
  enrolledUsers.push(userId);
  await W.grantRole(userId, permissions);
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
  return { client, userId };
}
const APPROVE = ["payroll.view", "payroll.disburse.approve"];
const approver = (app = appWithStorage) => mfaStaff(app, APPROVE, true);

/** A signed-in staff member (MFA stamp only) holding exactly these permissions. */
async function staff(app: ReturnType<typeof createApp>, permissions: string[]) {
  const client = agent(app);
  const email = await signUp(client, "Payout Upload");
  await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
  await W.grantRole(userId, permissions);
  return { client, userId };
}

// M6 (legend-egrrp): the payout PDF goes through assertSafePdf, so the fixture
// is a real, parseable PDF (a hand-written stub is refused with 422).
let realPdf: Buffer;
beforeAll(async () => {
  realPdf = Buffer.from(await validPdfBytes({ marker: "laporan bank" }));
});
const pdfBytes = () => realPdf;
const brokenJpegBytes = () =>
  Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
  ]);
const brokenPngBytes = () =>
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);

const SECRET_EXIF = "rahasia-lokasi-pegawai";
/** A real JPEG carrying EXIF text (the kind a phone camera adds). */
const realJpeg = () =>
  sharp({
    create: { width: 24, height: 16, channels: 3, background: "#cc3300" },
  })
    .withExif({
      IFD0: { ImageDescription: SECRET_EXIF, Copyright: SECRET_EXIF },
    })
    .jpeg()
    .toBuffer();
const realPng = () =>
  sharp({
    create: { width: 24, height: 16, channels: 3, background: "#0033cc" },
  })
    .png()
    .toBuffer();
const storedBytes = async (key: string, store = storage) =>
  Buffer.from(
    (
      await store.get(W.scope(), {
        tenantId: W.tenantId,
        outletId: null,
        reference: "payout-evidence-upload-test",
        key,
      } as never)
    ).content as Uint8Array,
  );

const upload = (
  who: Staff,
  batchId: string,
  bytes: Buffer,
  contentType = "application/pdf",
  filename = "bukti.pdf",
) =>
  who.client
    .post(`${BASE}/${batchId}/evidence`)
    .set(originHeader)
    .attach("file", bytes, { filename, contentType });

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

describe("legend-zoqh1 upload payment proof for resolve and return", () => {
  it("[zoqh1-key-shape] a pdf, a jpeg and a png are stored private under the batch folder and answered as 201 with the key", async () => {
    const { batchId } = await exportedRun();
    const who = await approver();
    const cases = [
      { bytes: pdfBytes(), type: "application/pdf", ext: "pdf" },
      { bytes: await realJpeg(), type: "image/jpeg", ext: "jpg" },
      { bytes: await realPng(), type: "image/png", ext: "png" },
    ] as const;
    const keys = new Set<string>();
    for (const { bytes, type, ext } of cases) {
      const res = await upload(who, batchId, bytes, type, `bukti.${ext}`);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const data = res.body.data as {
        evidenceKey: string;
        contentType: string;
        sizeBytes: number;
      };
      expect(data.evidenceKey).toMatch(
        new RegExp(
          `^tenants/${W.tenantId}/payroll-payout/${batchId}/[0-9a-f-]{36}\\.${ext}$`,
        ),
      );
      expect(data.evidenceKey.length).toBeLessThanOrEqual(200);
      expect(data.contentType).toBe(type);
      keys.add(data.evidenceKey);

      // The object is stored, and only as a private object. A pdf is kept byte
      // for byte; an image is re-encoded, so only its size is reported as stored.
      const lookup = {
        tenantId: W.tenantId,
        outletId: null,
        reference: "payout-evidence-upload-test",
        key: data.evidenceKey,
      } as never;
      const stored = await storedBytes(data.evidenceKey);
      expect(data.sizeBytes, "sizeBytes is the size of what is stored").toBe(
        stored.length,
      );
      if (ext === "pdf") expect(stored).toEqual(bytes);
      await expect(
        storage.get(W.scope(), {
          ...(lookup as object),
          visibility: "public",
        } as never),
      ).rejects.toThrow();
    }
    expect(keys.size, "every upload gets its own key").toBe(3);
  });

  it("[zoqh1-resolve-accepts] the returned key is accepted by resolve of that batch at both steps", async () => {
    const { batchId, items } = await exportedRun();
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    const who = await approver();
    const res = await upload(who, batchId, pdfBytes());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const key = res.body.data.evidenceKey as string;

    await W.resolve(batchId, [idOf(siti)], "failed", APP, key, store());
    let row = await W.itemOfPerson(batchId, SITI);
    expect(row.resolved_by, "first step recorded with the uploaded proof").toBe(
      APP,
    );
    await W.resolve(batchId, [idOf(siti)], "failed", APP3, key, store());
    row = await W.itemOfPerson(batchId, SITI);
    expect(row.status, "second step finishes the resolve").not.toBe("exported");
  });

  it("[zoqh1-batch-binding] a key uploaded for batch A is refused when resolving batch B: 422 PAYOUT_EVIDENCE_INVALID, nothing recorded", async () => {
    const a = await exportedRun();
    const b = await exportedRun();
    const who = await approver();
    const res = await upload(who, a.batchId, pdfBytes());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const keyOfA = res.body.data.evidenceKey as string;

    const bSiti = b.items.find((i) => i.employee_id === SITI.id)!;
    await W.expectRefused(
      W.resolve(b.batchId, [idOf(bSiti)], "failed", APP, keyOfA, store()),
      { status: 422, code: "PAYOUT_EVIDENCE_INVALID" },
    );
    const row = await W.itemOfPerson(b.batchId, SITI);
    expect(row.status).toBe("exported");
    expect(row.resolved_by, "no first step recorded").toBeNull();
  });

  it("[zoqh1-tenant-isolation] a batch of another tenant is a 404 identical to an unknown batch, and no blob is stored", async () => {
    const { batchId } = await exportedRun();
    const who = await approver();
    // Control: the same caller can upload for the batch while it is theirs.
    const own = await upload(who, batchId, pdfBytes());
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const unknown = await upload(
      who,
      "00000000-0000-4000-8000-00000000dead",
      pdfBytes(),
    );
    expect(unknown.status).toBe(404);

    const move = (to: string) =>
      W.asTenant(
        (c) =>
          c.query(
            "UPDATE payroll_disbursement_batches SET tenant_id = $2 WHERE id = $1",
            [batchId, to],
          ),
        true,
      );
    await move(FOREIGN_TENANT_ID);
    try {
      const before = blobCount();
      const res = await upload(who, batchId, pdfBytes());
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error?.code).toBe(unknown.body.error?.code);
      expect(blobCount(), "nothing was stored for a foreign batch").toBe(
        before,
      );
    } finally {
      await move(W.tenantId);
    }
  });

  it("[zoqh1-file-validation] wrong type 415 (declared type is not trusted), too large 413, empty 422; nothing is stored", async () => {
    const { batchId } = await exportedRun();
    const who = await approver();
    const before = blobCount();

    const text = await upload(who, batchId, Buffer.from("hello, not a pdf"));
    expect(text.status, JSON.stringify(text.body)).toBe(415);
    const gif = await upload(
      who,
      batchId,
      Buffer.from("GIF89a\x01\x00\x01\x00", "binary"),
      "image/png",
      "bukti.png",
    );
    expect(gif.status, JSON.stringify(gif.body)).toBe(415);
    const html = await upload(
      who,
      batchId,
      Buffer.from("<html><script>alert(1)</script></html>"),
      "application/pdf",
    );
    expect(html.status, JSON.stringify(html.body)).toBe(415);

    const head = pdfBytes();
    const big = Buffer.concat([
      head,
      Buffer.alloc(PAYOUT_EVIDENCE_MAX_BYTES + 1 - head.length, 0x20),
    ]);
    expect(big.length).toBe(PAYOUT_EVIDENCE_MAX_BYTES + 1);
    const tooLarge = await upload(who, batchId, big);
    expect(tooLarge.status, JSON.stringify(tooLarge.body)).toBe(413);

    const empty = await upload(who, batchId, Buffer.alloc(0));
    expect(empty.status, JSON.stringify(empty.body)).toBe(422);

    expect(blobCount(), "no refused upload leaves a blob").toBe(before);
  });

  it("[zoqh1-permission] without payroll.disburse.approve 403 (payroll.view alone is not enough), without a session 401; nothing is stored", async () => {
    const { batchId } = await exportedRun();
    const viewer = await staff(appWithStorage, ["payroll.view"]);
    const before = blobCount();
    const denied = await upload(viewer, batchId, pdfBytes());
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);

    const anonymous = await agent(appWithStorage)
      .post(`${BASE}/${batchId}/evidence`)
      .set(originHeader)
      .attach("file", pdfBytes(), {
        filename: "bukti.pdf",
        contentType: "application/pdf",
      });
    expect(anonymous.status).toBe(401);
    expect(blobCount()).toBe(before);
  });

  it("[zoqh1-no-storage] an app without a storage runtime answers 503, not a crash and not a silent success", async () => {
    const { batchId } = await exportedRun();
    const who = await approver(appWithoutStorage);
    const res = await upload(who, batchId, pdfBytes());
    expect(res.status, JSON.stringify(res.body)).toBe(503);
  });

  it("[zoqh1-no-state-change] an upload changes no batch or item row", async () => {
    const { batchId } = await exportedRun();
    const who = await approver();
    const before = await snapshotOf(batchId);
    const res = await upload(who, batchId, pdfBytes());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await snapshotOf(batchId)).toBe(before);
    expect(await W.postingsOf(batchId)).toHaveLength(0);
  });

  it("[zoqh1-no-double-pay] an item that is already final cannot be resolved again, whatever proof is uploaded: no status change, no posting", async () => {
    // A succeeded item (money left): a resolve with a fresh proof is refused.
    const paid = await exportedRun();
    await W.confirm(paid.batchId, W.succeedItems(paid.batchId, paid.items));
    const who = await approver();
    const proof = await upload(who, paid.batchId, pdfBytes());
    expect(proof.status, JSON.stringify(proof.body)).toBe(201);
    const key = proof.body.data.evidenceKey as string;
    const postingsBefore = (await W.postingsOf(paid.batchId)).length;
    const itemsBefore = await snapshotOf(paid.batchId);
    const budi = paid.items.find((i) => i.employee_id === BUDI.id)!;
    await W.expectRefused(
      W.resolve(paid.batchId, [idOf(budi)], "failed", APP, key, store()),
    );
    expect(await snapshotOf(paid.batchId)).toBe(itemsBefore);
    expect(await W.postingsOf(paid.batchId)).toHaveLength(postingsBefore);

    // A resolved item (two steps done): a third resolve is refused too.
    const gone = await exportedRun();
    const siti = gone.items.find((i) => i.employee_id === SITI.id)!;
    const second = await upload(who, gone.batchId, pdfBytes());
    const key2 = second.body.data.evidenceKey as string;
    await W.resolve(gone.batchId, [idOf(siti)], "failed", APP, key2, store());
    await W.resolve(gone.batchId, [idOf(siti)], "failed", APP3, key2, store());
    const final = await snapshotOf(gone.batchId);
    await W.expectRefused(
      W.resolve(gone.batchId, [idOf(siti)], "failed", APP2, key2, store()),
    );
    expect(await snapshotOf(gone.batchId)).toBe(final);
  });

  it("[zoqh1-origin] an upload without a trusted Origin header is refused 403 and stores nothing", async () => {
    const { batchId } = await exportedRun();
    const who = await approver();
    const before = blobCount();
    const res = await who.client
      .post(`${BASE}/${batchId}/evidence`)
      .attach("file", pdfBytes(), {
        filename: "bukti.pdf",
        contentType: "application/pdf",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(blobCount()).toBe(before);
    // Control: the same caller with the Origin header is accepted.
    const ok = await upload(who, batchId, pdfBytes());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("[zoqh1-stepup] an approver without a second-factor proof is 403 MFA_REQUIRED; nothing is stored; with a real challenge the same upload passes", async () => {
    // Upload only stores a blob; the password step-up stays on resolve and
    // return, which are the calls that move an item (and read the password
    // from a JSON body, which this multipart route has no field for).
    const { batchId } = await exportedRun();
    const client = agent(appWithStorage);
    await signUp(client, "Payout Upload No MFA");
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    grantedUsers.push(userId);
    await W.grantRole(userId, APPROVE);
    const before = blobCount();
    const res = await upload({ client, userId }, batchId, pdfBytes());
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error?.code).toBe("MFA_REQUIRED");
    expect(blobCount(), "no blob without step-up").toBe(before);

    const challenged = await approver();
    const ok = await upload(challenged, batchId, pdfBytes());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("[zoqh1-scanner-infected] a scanner that rejects the file refuses the upload with a 4xx and no blob", async () => {
    const { batchId } = await exportedRun();
    const rt = makeRuntime({
      scan: async () => {
        throw new HttpError(422, "UPLOAD_REJECTED", "EICAR-Test-Signature");
      },
    });
    const who = await approver(rt.app);
    for (const [bytes, type, name] of [
      [pdfBytes(), "application/pdf", "bukti.pdf"],
      [await realPng(), "image/png", "bukti.png"],
    ] as const) {
      const res = await upload(who, batchId, bytes, type, name);
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
      expect(rt.blobCount(), `${name}: infected file leaves no blob`).toBe(0);
    }
  });

  it("[zoqh1-scanner-no-documents] a scanner that cannot vet documents refuses a PDF closed (503), with no blob", async () => {
    const { batchId } = await exportedRun();
    const rt = makeRuntime(new NoopMalwareScanner({ acceptsDocuments: false }));
    const who = await approver(rt.app);
    const res = await upload(who, batchId, pdfBytes());
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(rt.blobCount()).toBe(0);
  });

  it("[zoqh1-image-reencode] a real jpeg is stored without its EXIF and a real png stays a png, with the right contentType", async () => {
    const { batchId } = await exportedRun();
    const who = await approver();
    const jpeg = await realJpeg();
    expect(
      jpeg.includes(Buffer.from(SECRET_EXIF)),
      "premise: the uploaded jpeg carries EXIF text",
    ).toBe(true);
    expect((await sharp(jpeg).metadata()).exif, "premise").toBeDefined();

    const jpegRes = await upload(who, batchId, jpeg, "image/jpeg", "foto.jpg");
    expect(jpegRes.status, JSON.stringify(jpegRes.body)).toBe(201);
    expect(jpegRes.body.data.contentType).toBe("image/jpeg");
    const storedJpeg = await storedBytes(jpegRes.body.data.evidenceKey);
    expect(storedJpeg.includes(Buffer.from(SECRET_EXIF))).toBe(false);
    const jpegMeta = await sharp(storedJpeg).metadata();
    expect(jpegMeta.format).toBe("jpeg");
    expect(jpegMeta.exif, "no EXIF block is kept").toBeUndefined();
    expect([jpegMeta.width, jpegMeta.height]).toEqual([24, 16]);
    expect(jpegRes.body.data.sizeBytes).toBe(storedJpeg.length);

    const png = await realPng();
    const pngRes = await upload(who, batchId, png, "image/png", "foto.png");
    expect(pngRes.status, JSON.stringify(pngRes.body)).toBe(201);
    expect(pngRes.body.data.contentType).toBe("image/png");
    expect(pngRes.body.data.evidenceKey).toMatch(/\.png$/);
    const storedPng = await storedBytes(pngRes.body.data.evidenceKey);
    expect((await sharp(storedPng).metadata()).format).toBe("png");
    expect(pngRes.body.data.sizeBytes).toBe(storedPng.length);
  });

  it("[zoqh1-broken-image] a jpeg or png that only has the right first bytes cannot be decoded: 415, no blob", async () => {
    const { batchId } = await exportedRun();
    const who = await approver();
    const before = blobCount();
    const truncated = (await realJpeg()).subarray(0, 40);
    for (const [bytes, type, name] of [
      [brokenJpegBytes(), "image/jpeg", "rusak.jpg"],
      [brokenPngBytes(), "image/png", "rusak.png"],
      [truncated, "image/jpeg", "terpotong.jpg"],
    ] as const) {
      const res = await upload(who, batchId, bytes, type, name);
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(415);
    }
    expect(blobCount()).toBe(before);
  });

  it("[zoqh1-batch-state] a draft batch and a cash batch are refused (409 or 422) before any blob is stored", async () => {
    const who = await approver();
    const before = blobCount();

    const draftSlips = [bank(BUDI, 4_000_000)];
    const draftRun = await W.seedRun(draftSlips);
    await W.postLockedJournal(draftRun, draftSlips);
    const draftId = await W.createBatch(draftRun);
    expect((await W.batchById(draftId)).status, "premise: draft").toBe("draft");

    const cashSlips = [cash(CASHIER, 900_000)];
    const cashRun = await W.seedRun(cashSlips);
    await W.postLockedJournal(cashRun, cashSlips);
    const cashId = await W.approvedBatch(cashRun, "cash");

    for (const [label, id] of [
      ["draft", draftId],
      ["cash", cashId],
    ] as const) {
      const res = await upload(who, id, pdfBytes());
      expect([409, 422], `${label}: ${JSON.stringify(res.body)}`).toContain(
        res.status,
      );
    }
    expect(blobCount(), "no blob for a batch that cannot be resolved").toBe(
      before,
    );
  });

  it("[zoqh1-return-accepts] the return service takes a key uploaded for its own batch (both steps) and refuses the key of another batch", async () => {
    const a = await exportedRun();
    const b = await exportedRun();
    await W.confirm(a.batchId, W.succeedItems(a.batchId, a.items));
    await W.confirm(b.batchId, W.succeedItems(b.batchId, b.items));
    const who = await approver();
    // Unique content: a return claim keeps its file fingerprint for good, so a
    // fixed PDF would collide with the claim of an earlier run (legend-w3691).
    const ownRes = await upload(
      who,
      a.batchId,
      Buffer.from(await validPdfBytes({ marker: `kembali-a ${randomUUID()}` })),
    );
    expect(ownRes.status, JSON.stringify(ownRes.body)).toBe(201);
    const keyOfA = ownRes.body.data.evidenceKey as string;
    const returnWith = (batchId: string, itemId: string, by: string) =>
      W.inTx((tx) =>
        returnManualItems(
          tx,
          actorOf(by),
          batchId,
          {
            itemIds: [itemId],
            evidenceKey: keyOfA,
            note: "Bank mengembalikan dana, rekening tujuan ditutup",
          } as never,
          { storage, context: W.scope() },
        ),
      );

    // Batch B refuses the key of A; nothing is recorded.
    const bBudi = await W.itemOfPerson(b.batchId, BUDI);
    await W.expectRefused(returnWith(b.batchId, idOf(bBudi), APP), {
      status: 422,
      code: "PAYOUT_EVIDENCE_INVALID",
    });
    const bAfter = await W.itemOfPerson(b.batchId, BUDI);
    expect(bAfter.status).toBe("succeeded");
    expect(bAfter.returned_by).toBeNull();
    expect(await W.countJournals(`payroll-payout-return:${idOf(bBudi)}`)).toBe(
      0,
    );

    // Batch A accepts it at both steps (two different non-requesters).
    const aBudi = await W.itemOfPerson(a.batchId, BUDI);
    await returnWith(a.batchId, idOf(aBudi), APP);
    expect((await W.itemOfPerson(a.batchId, BUDI)).returned_by).toBe(APP);
    await returnWith(a.batchId, idOf(aBudi), APP3);
    expect((await W.itemOfPerson(a.batchId, BUDI)).status).toBe("returned");
  });
});
