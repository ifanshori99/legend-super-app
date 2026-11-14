import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { outletIdSchema } from "@starter/shared/core";
import * as schema from "../db/schema";
import type { MalwareScanner } from "../services/core-image";
import { uploadStorage } from "../services/core-storage";
import { HttpError } from "../lib/http-error";

// Contract (brief M5): uploadStorage PDF path runs
// assertScannerAcceptsDocuments -> assertSafePdf -> scanUpload -> put.
// Assumption: the original bytes are stored untouched (design D-5).

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const db = drizzle(pool, { schema });
const context = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

async function seedOutlet() {
  const [tenantId, brandId, legalEntityId, outletId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const tag = tenantId.slice(0, 8);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji PDF Aman', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenantId,
      `uji-pdf-aman-${tag}`,
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)",
    [legalEntityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, 'U-01', 'Outlet Uji', 'Jl. Uji', '{}')`,
    [outletId, tenantId, brandId, legalEntityId],
  );
  return { tenantId, outletId };
}

let a: Awaited<ReturnType<typeof seedOutlet>>;
beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  a = await seedOutlet();
});
afterAll(async () => {
  await pool.end();
  await owner.end();
});

const validPdf = async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return doc.save();
};
const javascriptPdf = async () => {
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
  return doc.save();
};

function harness() {
  const storage = new FakeObjectStorage();
  const put = vi.spyOn(storage, "put");
  const scan = vi.fn<MalwareScanner["scan"]>(async () => undefined);
  const scanner: MalwareScanner = { scan, acceptsDocuments: true };
  const upload = (bytes: Uint8Array) =>
    uploadStorage(
      db,
      context(a.tenantId),
      { purpose: "document", outletId: outletIdSchema.parse(a.outletId) },
      bytes,
      {
        storage,
        scanner,
        authorize: async () => true,
        actorUserId: `user-${randomUUID()}`,
      },
    );
  return { put, scan, upload };
}

it("rejects a PDF with JavaScript with 422, without scanning or storing it", async () => {
  const { put, scan, upload } = harness();
  const error = await upload(await javascriptPdf()).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  expect(error).toMatchObject({ status: 422, code: "UPLOAD_REJECTED" });
  expect(put).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
});

it("rejects a truncated PDF with 422 and stores nothing", async () => {
  const { put, upload } = harness();
  const bytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n");
  await expect(upload(bytes)).rejects.toMatchObject({
    status: 422,
    code: "UPLOAD_REJECTED",
  });
  expect(put).not.toHaveBeenCalled();
});

it("stores a valid PDF byte for byte after the scanner passes it", async () => {
  const { put, scan, upload } = harness();
  const bytes = await validPdf();
  const stored = await upload(bytes);
  expect(stored.id).toBeTruthy();
  expect(scan).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledTimes(1);
  const request = put.mock.calls[0]?.[1];
  expect(Array.from(new Uint8Array(request?.content as Uint8Array))).toEqual(
    Array.from(bytes),
  );
});

it("a valid PDF is still refused when the scanner reports malware", async () => {
  const { put, scan, upload } = harness();
  scan.mockRejectedValueOnce(
    new HttpError(422, "UPLOAD_REJECTED", "Berkas ditolak pemindai malware."),
  );
  await expect(upload(await validPdf())).rejects.toMatchObject({
    status: 422,
    code: "UPLOAD_REJECTED",
  });
  expect(put).not.toHaveBeenCalled();
});
