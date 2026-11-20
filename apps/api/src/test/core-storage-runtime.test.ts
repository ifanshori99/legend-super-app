import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { outletIdSchema } from "@starter/shared/core";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { NoopMalwareScanner } from "../services/core-image";
import {
  createAttendanceSelfieSigner,
  createHrisDocumentSigner,
  createObjectStorageFromEnv,
  createStorageRuntimeFromEnv,
} from "../services/core-storage-runtime";
import { S3ObjectStorage } from "../services/core-storage-provider";
import {
  ATTENDANCE_SELFIE_PURGE_CRON,
  ATTENDANCE_SELFIE_PURGE_QUEUE,
  ATTENDANCE_SELFIE_PURGE_TZ,
  registerAttendanceSelfiePurgeJob,
} from "../worker/attendance-selfie-purge.job";

// legend-dzh9q: storage wired into the app and the worker. Env parsing, the
// attendance selfie signer (real DB, fake storage) and the purge registration.

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const db = drizzle(pool, { schema });

const outletContext = (tenantId: string, ...outletIds: string[]) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

/** Owner-seeded tenant with two outlets (the storage FK needs real outlets). */
async function seedTenant() {
  const [tenantId, brandId, legalEntityId, outletA, outletB] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const tag = tenantId.slice(0, 8);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Signer', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenantId,
      `uji-signer-${tag}`,
      JSON.stringify({
        maxOutlets: 2,
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
  for (const [outletId, code] of [
    [outletA, "S-01"],
    [outletB, "S-02"],
  ] as const)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
       VALUES ($1, $2, $3, $4, $5, 'Outlet Uji', 'Jl. Uji', '{}')`,
      [outletId, tenantId, brandId, legalEntityId, code],
    );
  return { tenantId, outletA, outletB };
}

/** Owner-seeded storage row (bypasses RLS); returns the id. */
async function seedRow(tenantId: string, outletId: string, purpose: string) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO core_storage_objects
       (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, 'image/webp', 1)`,
    [tenantId, outletId, id, purpose, `${id}/original.webp`],
  );
  return id;
}

let tenant: Awaited<ReturnType<typeof seedTenant>>;
let other: Awaited<ReturnType<typeof seedTenant>>;
beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenant = await seedTenant();
  other = await seedTenant();
});
afterAll(async () => {
  await pool.end();
  await owner.end();
});

const FULL_ENV = {
  STORAGE_S3_ACCESS_KEY_ID: "sentinel-access-key-id",
  STORAGE_S3_SECRET_ACCESS_KEY: "sentinel-secret-access-key",
  STORAGE_S3_PRIVATE_BUCKET: "sentinel-private-bucket",
  STORAGE_S3_PUBLIC_BUCKET: "sentinel-public-bucket",
  STORAGE_S3_REGION: "ap-southeast-3",
  STORAGE_PUBLIC_BASE_URL: "https://sentinel.example/images",
};

describe("legend-dzh9q storage env", () => {
  it("returns null when no storage env is set (also for blank values)", () => {
    expect(createObjectStorageFromEnv({})).toBeNull();
    expect(
      createObjectStorageFromEnv({ STORAGE_S3_PRIVATE_BUCKET: "  " }),
    ).toBeNull();
    expect(createStorageRuntimeFromEnv({}, db)).toBeNull();
  });

  it("throws naming only the missing keys when the env is partial", () => {
    const {
      STORAGE_S3_SECRET_ACCESS_KEY,
      STORAGE_PUBLIC_BASE_URL,
      ...partial
    } = FULL_ENV;
    void STORAGE_S3_SECRET_ACCESS_KEY;
    void STORAGE_PUBLIC_BASE_URL;
    let message = "";
    try {
      createObjectStorageFromEnv(partial);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("STORAGE_S3_SECRET_ACCESS_KEY");
    expect(message).toContain("STORAGE_PUBLIC_BASE_URL");
    expect(message).not.toContain("STORAGE_S3_ACCESS_KEY_ID");
    expect(message).not.toContain("STORAGE_S3_PRIVATE_BUCKET");
    for (const value of Object.values(partial))
      expect(message).not.toContain(value);
    expect(() => createStorageRuntimeFromEnv(partial, db)).toThrow(
      /STORAGE_S3_SECRET_ACCESS_KEY/,
    );
  });

  it("treats only an optional key as a partial configuration", () => {
    expect(() =>
      createObjectStorageFromEnv({
        STORAGE_S3_ENDPOINT: "http://localhost:9000",
      }),
    ).toThrow(/STORAGE_S3_ACCESS_KEY_ID/);
  });

  it("builds a runtime with storage, scanner and signer from a full env", () => {
    const runtime = createStorageRuntimeFromEnv(
      { ...FULL_ENV, STORAGE_S3_ENDPOINT: "http://localhost:9000" },
      db,
    );
    expect(runtime).not.toBeNull();
    expect(runtime!.storage).toBeInstanceOf(S3ObjectStorage);
    expect(runtime!.scanner).toBeInstanceOf(NoopMalwareScanner);
    expect(typeof runtime!.fileSigner).toBe("function");
    expect(typeof runtime!.hrisDocumentSigner).toBe("function");
  });
});

describe("legend-dzh9q attendance selfie signer", () => {
  const signerFor = (log = { error: vi.fn() }) => ({
    log,
    sign: createAttendanceSelfieSigner({
      database: db,
      storage: new FakeObjectStorage(),
      log,
    }),
  });

  it("signs a selfie object in scope", async () => {
    const id = await seedRow(tenant.tenantId, tenant.outletA, "selfie");
    const { sign } = signerFor();
    const url = await sign(outletContext(tenant.tenantId, tenant.outletA), id);
    expect(url).toMatch(/^https:\/\/storage\.invalid\/private\//);
    expect(url).toContain("expires=300");
  });

  it("returns null for private purposes other than selfie", async () => {
    const { sign, log } = signerFor();
    const context = outletContext(tenant.tenantId, tenant.outletA);
    for (const purpose of ["receipt", "document"])
      expect(
        await sign(
          context,
          await seedRow(tenant.tenantId, tenant.outletA, purpose),
        ),
      ).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("returns null for a public purpose", async () => {
    const { sign } = signerFor();
    const id = await seedRow(tenant.tenantId, tenant.outletA, "menu_photo");
    expect(
      await sign(outletContext(tenant.tenantId, tenant.outletA), id),
    ).toBeNull();
  });

  it("returns null for a missing object", async () => {
    const { sign, log } = signerFor();
    expect(
      await sign(outletContext(tenant.tenantId, tenant.outletA), randomUUID()),
    ).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("returns null outside the outlet scope and across tenants", async () => {
    const { sign } = signerFor();
    const id = await seedRow(tenant.tenantId, tenant.outletA, "selfie");
    expect(
      await sign(outletContext(tenant.tenantId, tenant.outletB), id),
    ).toBeNull();
    expect(
      await sign(outletContext(other.tenantId, other.outletA), id),
    ).toBeNull();
  });

  it("logs and returns null when signing fails unexpectedly", async () => {
    const id = await seedRow(tenant.tenantId, tenant.outletA, "selfie");
    const log = { error: vi.fn() };
    const storage = new FakeObjectStorage();
    storage.signedGetUrl = async () => {
      throw new Error("storage down");
    };
    const sign = createAttendanceSelfieSigner({ database: db, storage, log });
    expect(
      await sign(outletContext(tenant.tenantId, tenant.outletA), id),
    ).toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe("legend-2ect HRIS document signer", () => {
  const signerFor = (log = { error: vi.fn() }) => ({
    log,
    sign: createHrisDocumentSigner({
      database: db,
      storage: new FakeObjectStorage(),
      log,
    }),
  });

  it("signs a document object in scope with a 300 second URL", async () => {
    const id = await seedRow(tenant.tenantId, tenant.outletA, "document");
    const { sign } = signerFor();
    const url = await sign(outletContext(tenant.tenantId, tenant.outletA), id);
    expect(url).toMatch(/^https:\/\/storage\.invalid\/private\//);
    expect(url).toContain("expires=300");
  });

  it("signs inside the caller transaction when one is given", async () => {
    const id = await seedRow(tenant.tenantId, tenant.outletA, "document");
    const { sign } = signerFor();
    const context = outletContext(tenant.tenantId, tenant.outletA);
    const url = await withTenant(db, context, (tx) => sign(context, id, tx));
    expect(url).toContain("expires=300");
  });

  it("refuses every purpose except document", async () => {
    const { sign, log } = signerFor();
    const context = outletContext(tenant.tenantId, tenant.outletA);
    for (const purpose of ["selfie", "receipt", "menu_photo"])
      expect(
        await sign(
          context,
          await seedRow(tenant.tenantId, tenant.outletA, purpose),
        ),
      ).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("returns null for a missing object, outside scope and across tenants", async () => {
    const { sign } = signerFor();
    const id = await seedRow(tenant.tenantId, tenant.outletA, "document");
    expect(
      await sign(outletContext(tenant.tenantId, tenant.outletA), randomUUID()),
    ).toBeNull();
    expect(
      await sign(outletContext(tenant.tenantId, tenant.outletB), id),
    ).toBeNull();
    expect(
      await sign(outletContext(other.tenantId, other.outletA), id),
    ).toBeNull();
  });

  it("the selfie signer still refuses documents", async () => {
    const sign = createAttendanceSelfieSigner({
      database: db,
      storage: new FakeObjectStorage(),
      log: { error: vi.fn() },
    });
    const id = await seedRow(tenant.tenantId, tenant.outletA, "document");
    expect(
      await sign(outletContext(tenant.tenantId, tenant.outletA), id),
    ).toBeNull();
  });
});

describe("legend-dzh9q purge job registration", () => {
  it("creates the queue, schedules the cron and registers the worker", async () => {
    const boss = {
      createQueue: vi.fn(async () => {}),
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => "worker-id"),
    };
    await registerAttendanceSelfiePurgeJob({
      boss,
      storage: new FakeObjectStorage(),
      database: db,
      log: { error: vi.fn(), info: vi.fn() },
    });
    expect(boss.createQueue).toHaveBeenCalledWith(
      ATTENDANCE_SELFIE_PURGE_QUEUE,
      expect.objectContaining({ policy: "exclusive" }),
    );
    expect(boss.schedule).toHaveBeenCalledWith(
      ATTENDANCE_SELFIE_PURGE_QUEUE,
      ATTENDANCE_SELFIE_PURGE_CRON,
      null,
      { tz: ATTENDANCE_SELFIE_PURGE_TZ },
    );
    expect(boss.work).toHaveBeenCalledWith(
      ATTENDANCE_SELFIE_PURGE_QUEUE,
      expect.any(Function),
    );
  });
});
