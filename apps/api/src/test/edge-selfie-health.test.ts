// C7: a local selfie upload that answers 507 EDGE_SELFIE_STORAGE_FULL raises an
// informational alarm on GET /api/edge/health (`selfie`). The alarm never
// changes the health status or HTTP code: a full selfie disk is a staff
// problem, not an outage. The state is in memory and holds no ids or PII.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import sharp from "sharp";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import * as schema from "../db/schema";
import {
  getEdgeSelfieHealth,
  recordSelfieStorageFull,
  recordSelfieStored,
  recordUploaderRejection,
  resetEdgeSelfieHealth,
} from "../edge/selfie-health";
import { logger } from "../lib/logger";
import { edgeRouter } from "../routes/edge.routes";
import { NoopMalwareScanner } from "../services/core-image";
import { uploadEdgeSelfie } from "../services/edge-selfie.service";

vi.mock("../db/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/index.ts")>()),
  checkDatabase: async () => undefined,
}));
vi.mock("../edge/runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../edge/runtime.ts")>()),
  getEdgeRuntimeState: () => ({
    edgeMode: true,
    identity: {},
    link: { cloudLink: "connected" },
  }),
  getDeviceRegistrySyncState: () => null,
}));

// Lets one test make the next file open fail like a full disk.
const fsFault = vi.hoisted(() => ({ enospcOnce: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: ((...args: Parameters<typeof real.open>) => {
      if (fsFault.enospcOnce) {
        fsFault.enospcOnce = false;
        return Promise.reject(
          Object.assign(new Error("no space"), { code: "ENOSPC" }),
        );
      }
      return real.open(...args);
    }) as typeof real.open,
  };
});

const T0 = new Date("2026-11-10T08:00:00.000Z");
const T1 = new Date("2026-11-10T08:05:00.000Z");

beforeEach(() => resetEdgeSelfieHealth());

describe("selfie health state", () => {
  it("starts clear", () => {
    expect(getEdgeSelfieHealth()).toEqual({ storageFull: null, rejected: 0 });
  });

  it("records the first full-disk answer as a new episode", () => {
    expect(recordSelfieStorageFull(T0)).toBe(true);
    expect(getEdgeSelfieHealth().storageFull).toEqual({
      since: T0.toISOString(),
      lastAt: T0.toISOString(),
    });
  });

  it("keeps since and moves lastAt on a repeat, and says it is not new", () => {
    recordSelfieStorageFull(T0);
    expect(recordSelfieStorageFull(T1)).toBe(false);
    expect(getEdgeSelfieHealth().storageFull).toEqual({
      since: T0.toISOString(),
      lastAt: T1.toISOString(),
    });
  });

  it("clears on a stored selfie and starts a new episode after", () => {
    recordSelfieStorageFull(T0);
    recordSelfieStored();
    expect(getEdgeSelfieHealth().storageFull).toBeNull();
    expect(recordSelfieStorageFull(T1)).toBe(true);
    expect(getEdgeSelfieHealth().storageFull?.since).toBe(T1.toISOString());
  });

  it("counts uploader rejections and a stored selfie does not clear them", () => {
    recordUploaderRejection();
    recordUploaderRejection();
    recordSelfieStored();
    expect(getEdgeSelfieHealth().rejected).toBe(2);
  });

  it("holds nothing but timestamps and a count", () => {
    recordSelfieStorageFull(T0);
    recordUploaderRejection();
    expect(Object.keys(getEdgeSelfieHealth()).sort()).toEqual([
      "rejected",
      "storageFull",
    ]);
  });
});

describe("GET /api/edge/health selfie field", () => {
  const app = express().use("/api/edge", edgeRouter);

  it("shows a clear selfie field", async () => {
    const res = await request(app).get("/api/edge/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.selfie).toEqual({ storageFull: null, rejected: 0 });
  });

  it("shows the alarm and rejections without changing status or HTTP code", async () => {
    recordSelfieStorageFull(T0);
    recordUploaderRejection();
    const res = await request(app).get("/api/edge/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.selfie).toEqual({
      storageFull: { since: T0.toISOString(), lastAt: T0.toISOString() },
      rejected: 1,
    });
  });
});

// Real PG, same seeding as edge-selfie-upload.test.ts.
describe("edge selfie upload 507 raises the alarm", () => {
  const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
  const owner = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 1,
  });
  const db = drizzle(pool, { schema });
  const dirs: string[] = [];
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  let target: { tenantId: string; outletId: string };

  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    const [tenantId, brandId, legalEntityId, outletId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'Uji Sehat', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
      [
        tenantId,
        `uji-sehat-${tenantId.slice(0, 8)}`,
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
    await owner.query(
      `INSERT INTO edge_people_sync_state (tenant_id, outlet_id, selfie_seal_kid, selfie_seal_public_key)
       VALUES ($1, $2, 'test-kid-1', $3)`,
      [tenantId, outletId, publicKey],
    );
    target = { tenantId, outletId };
  });
  afterAll(async () => {
    await pool.end();
    await owner.end();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const image = () =>
    sharp({
      create: { width: 64, height: 48, channels: 3, background: "teal" },
    })
      .jpeg()
      .toBuffer();

  const upload = async (options: { dir?: string; maxBytes: number }) => {
    const dir = options.dir ?? mkdtempSync(join(tmpdir(), "edge-health-test-"));
    dirs.push(dir);
    return uploadEdgeSelfie(
      db,
      establishScopedTenantContext(
        establishTenantContext({
          tenantId: target.tenantId,
          brandId: null,
          source: "session",
        }),
        { kind: "tenant" },
      ),
      {
        purpose: "selfie",
        outletId: outletIdSchema.parse(target.outletId),
      } as never,
      await image(),
      {
        authorize: async () => true,
        actorUserId: randomUUID(),
        scanner: new NoopMalwareScanner(),
        dir,
        maxBytes: options.maxBytes,
      } as never,
    );
  };

  it("budget already spent: sets the alarm and logs once per episode", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      await expect(upload({ maxBytes: 0 })).rejects.toMatchObject({
        status: 507,
      });
      const first = getEdgeSelfieHealth().storageFull;
      expect(first).not.toBeNull();
      await expect(upload({ maxBytes: 0 })).rejects.toMatchObject({
        status: 507,
      });
      expect(getEdgeSelfieHealth().storageFull?.since).toBe(first?.since);
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls)).not.toContain(target.tenantId);
    } finally {
      error.mockRestore();
    }
  });

  it("sealed file would not fit: sets the alarm", async () => {
    await expect(upload({ maxBytes: 1 })).rejects.toMatchObject({
      status: 507,
    });
    expect(getEdgeSelfieHealth().storageFull).not.toBeNull();
  });

  it("a real ENOSPC on write sets the alarm", async () => {
    fsFault.enospcOnce = true;
    await expect(
      upload({ maxBytes: 1024 * 1024 * 1024 }),
    ).rejects.toMatchObject({
      status: 507,
      code: "EDGE_SELFIE_STORAGE_FULL",
    });
    expect(getEdgeSelfieHealth().storageFull).not.toBeNull();
  });

  it("a stored selfie clears the alarm", async () => {
    recordSelfieStorageFull(T0);
    const stored = await upload({ maxBytes: 1024 * 1024 * 1024 });
    expect(stored.purpose).toBe("selfie");
    expect(getEdgeSelfieHealth().storageFull).toBeNull();
  });
});
