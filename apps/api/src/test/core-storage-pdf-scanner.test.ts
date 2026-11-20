import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import sharp from "sharp";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { outletIdSchema } from "@starter/shared/core";
import * as schema from "../db/schema";
import {
  NoopMalwareScanner,
  type MalwareScanner,
} from "../services/core-image";
import { uploadStorage } from "../services/core-storage";
import { createStorageRuntimeFromEnv } from "../services/core-storage-runtime";
import { HttpError } from "../lib/http-error";
import { validPdfBytes } from "./helpers/pdf-fixtures";

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

const STORAGE_ENV = {
  STORAGE_S3_ACCESS_KEY_ID: "sentinel-access-key-id",
  STORAGE_S3_SECRET_ACCESS_KEY: "sentinel-secret-access-key",
  STORAGE_S3_PRIVATE_BUCKET: "sentinel-private-bucket",
  STORAGE_S3_PUBLIC_BUCKET: "sentinel-public-bucket",
  STORAGE_S3_REGION: "ap-southeast-3",
  STORAGE_PUBLIC_BASE_URL: "https://sentinel.example/images",
};

/** Owner-seeded tenant with one outlet; the storage FK needs a real outlet. */
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
     VALUES ($1, $2, 'Uji PDF', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenantId,
      `uji-pdf-${tag}`,
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

const png = () =>
  sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
    .png()
    .toBuffer();
// A real PDF: document uploads are parsed before the scan (legend-851ef).
const pdf = () => validPdfBytes();

const upload = (
  purpose: "document" | "selfie",
  bytes: Uint8Array,
  scanner: MalwareScanner,
) =>
  uploadStorage(
    db,
    context(a.tenantId),
    { purpose, outletId: outletIdSchema.parse(a.outletId) },
    bytes,
    {
      storage: new FakeObjectStorage(),
      scanner,
      authorize: async () => true,
      actorUserId: `user-${randomUUID()}`,
    },
  );

const runtimeScanner = (nodeEnv: string) => {
  const runtime = createStorageRuntimeFromEnv(
    { ...STORAGE_ENV, NODE_ENV: nodeEnv },
    db,
  );
  if (!runtime) throw new Error("storage runtime expected");
  return runtime.scanner as NoopMalwareScanner;
};

it("production runtime refuses a document PDF with 503 and a clear message", async () => {
  const error = await upload(
    "document",
    await pdf(),
    runtimeScanner("production"),
  )
    .then(() => null)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(503);
  expect((error as HttpError).code).toBe("SERVICE_UNAVAILABLE");
  expect((error as HttpError).message).toBe(
    "Unggah dokumen PDF belum tersedia: pemindai malware belum dipasang.",
  );
});

it("production runtime still accepts an image", async () => {
  const stored = await upload(
    "selfie",
    await png(),
    runtimeScanner("production"),
  );
  expect(stored.id).toBeTruthy();
});

it("test runtime accepts a document PDF", async () => {
  const stored = await upload("document", await pdf(), runtimeScanner("test"));
  expect(stored.id).toBeTruthy();
});

it("a scanner with acceptsDocuments true accepts a document PDF", async () => {
  const stored = await upload(
    "document",
    await pdf(),
    new NoopMalwareScanner({ acceptsDocuments: true }),
  );
  expect(stored.id).toBeTruthy();
});

it("a scanner with acceptsDocuments false refuses a document PDF", async () => {
  await expect(
    upload(
      "document",
      await pdf(),
      new NoopMalwareScanner({ acceptsDocuments: false }),
    ),
  ).rejects.toMatchObject({ status: 503 });
});

it("a scanner outage refuses a PDF with a typed 503", async () => {
  await expect(
    upload("document", await pdf(), {
      scan: async () => {
        throw new Error("internal scanner socket failure");
      },
    }),
  ).rejects.toMatchObject({ status: 503, code: "SCANNER_UNAVAILABLE" });
});
