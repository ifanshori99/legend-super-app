import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { processImage, type MalwareScanner } from "../services/core-image";
import { ClamdMalwareScanner } from "../services/clamd-scanner";
import { uploadStorage } from "../services/core-storage";
import { HttpError } from "../lib/http-error";
import { validPdfBytes } from "./helpers/pdf-fixtures";
import {
  startFakeClamd,
  unusedPort,
  type FakeClamd,
} from "./helpers/fake-clamd";

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

// legend-1rtm1: what an overloaded clamd (HttpError 503 SCANNER_OVERLOADED)
// means for uploads. Contract: brief section "Desain ditetapkan".
//
// Assumptions:
//  - A PDF that was not scanned is never stored and the client sees the typed
//    503 SCANNER_OVERLOADED unchanged (not rewritten to SCANNER_UNAVAILABLE).
//  - Images: clamd outages (SCANNER_UNAVAILABLE) stay fail-open as today.
//    Overload is NOT treated like an outage: the brief says "when in doubt,
//    reject", and failing open exactly when a flood makes the scanner busy
//    would let unscanned images through on demand. So overloaded images are
//    rejected with 503 SCANNER_OVERLOADED.

class CountingStorage extends FakeObjectStorage {
  puts = 0;
  override async put(
    ...args: Parameters<FakeObjectStorage["put"]>
  ): ReturnType<FakeObjectStorage["put"]> {
    this.puts += 1;
    return super.put(...args);
  }
}

const upload = (
  purpose: "document" | "selfie",
  bytes: Uint8Array,
  scanner: MalwareScanner,
  storage: FakeObjectStorage = new FakeObjectStorage(),
) =>
  uploadStorage(
    db,
    context(a.tenantId),
    { purpose, outletId: outletIdSchema.parse(a.outletId) },
    bytes,
    {
      storage,
      scanner,
      authorize: async () => true,
      actorUserId: `user-${randomUUID()}`,
    },
  );

const png = () =>
  sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
    .png()
    .toBuffer();

const overloaded = () =>
  new HttpError(
    503,
    "SCANNER_OVERLOADED",
    "File scanning is busy, please retry shortly.",
  );
const unavailable = () =>
  new HttpError(
    503,
    "SCANNER_UNAVAILABLE",
    "File scanning is temporarily unavailable.",
  );

const servers: FakeClamd[] = [];
const held: Array<Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  // Held scans reject once their socket is destroyed; swallow that.
  await Promise.allSettled(held.splice(0));
});

describe("legend-1rtm1 PDF upload while the scanner is overloaded", () => {
  it("rejects with 503 SCANNER_OVERLOADED and never stores the PDF", async () => {
    const storage = new CountingStorage();
    const scanner: MalwareScanner = {
      acceptsDocuments: true,
      failOpenForImages: true,
      scan: async () => {
        throw overloaded();
      },
    };
    const error = await upload(
      "document",
      await validPdfBytes(),
      scanner,
      storage,
    )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect((error as HttpError).code).toBe("SCANNER_OVERLOADED");
    expect(storage.puts).toBe(0);
  });

  it("stores a PDF normally when the same scanner answers (control)", async () => {
    const storage = new CountingStorage();
    const stored = await upload(
      "document",
      await validPdfBytes(),
      { acceptsDocuments: true, scan: async () => {} },
      storage,
    );
    expect(stored.id).toBeTruthy();
    expect(storage.puts).toBeGreaterThan(0);
  });

  it("a real ClamdMalwareScanner with every slot and queue place taken refuses the PDF, unscanned and unstored", async () => {
    const server = await startFakeClamd({ kind: "silent" });
    servers.push(server);
    const scanner = new ClamdMalwareScanner({
      host: "127.0.0.1",
      port: server.port,
      timeoutMs: 10_000,
      maxConcurrent: 1,
      maxPerTenant: 1,
      maxQueued: 1,
    });
    // Two scans fill the slot and the one queue place; clamd never answers.
    held.push(
      scanner.scan(new Uint8Array([1])).catch(() => {}),
      scanner.scan(new Uint8Array([2])).catch(() => {}),
    );
    for (let i = 0; i < 200 && server.sessions.length < 1; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.sessions).toHaveLength(1);

    const storage = new CountingStorage();
    const startedAt = Date.now();
    const error = await upload(
      "document",
      await validPdfBytes(),
      scanner,
      storage,
    )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(Date.now() - startedAt).toBeLessThan(5000); // not the 10 s timeout
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect((error as HttpError).code).toBe("SCANNER_OVERLOADED");
    expect(storage.puts).toBe(0);
    // The overloaded upload never reached clamd.
    expect(server.sessions).toHaveLength(1);
  });
});

describe("legend-1rtm1 image upload while the scanner is overloaded", () => {
  it("rejects an image with 503 SCANNER_OVERLOADED even for a fail-open scanner, and stores nothing", async () => {
    const storage = new CountingStorage();
    const scanner: MalwareScanner = {
      failOpenForImages: true,
      scan: async () => {
        throw overloaded();
      },
    };
    const error = await upload("selfie", await png(), scanner, storage)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect((error as HttpError).code).toBe("SCANNER_OVERLOADED");
    expect(storage.puts).toBe(0);
  });

  it("processImage rejects instead of re-encoding unscanned bytes", async () => {
    const scan = vi.fn(async () => {
      throw overloaded();
    });
    await expect(
      processImage(await png(), 10_000_000, { failOpenForImages: true, scan }),
    ).rejects.toMatchObject({ status: 503, code: "SCANNER_OVERLOADED" });
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("a real overloaded ClamdMalwareScanner refuses the image quickly", async () => {
    const server = await startFakeClamd({ kind: "silent" });
    servers.push(server);
    const scanner = new ClamdMalwareScanner({
      host: "127.0.0.1",
      port: server.port,
      timeoutMs: 10_000,
      maxConcurrent: 1,
      maxPerTenant: 1,
      maxQueued: 1,
    });
    held.push(
      scanner.scan(new Uint8Array([1])).catch(() => {}),
      scanner.scan(new Uint8Array([2])).catch(() => {}),
    );
    for (let i = 0; i < 200 && server.sessions.length < 1; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));

    const startedAt = Date.now();
    await expect(
      processImage(await png(), 10_000_000, scanner),
    ).rejects.toMatchObject({ status: 503, code: "SCANNER_OVERLOADED" });
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("regression: an unreachable clamd (SCANNER_UNAVAILABLE) still fails open for images", async () => {
    const scanner = new ClamdMalwareScanner({
      host: "127.0.0.1",
      port: await unusedPort(),
      timeoutMs: 2000,
    });
    const output = await processImage(await png(), 10_000_000, scanner);
    expect(output.full.contentType).toBe("image/webp");
  });

  it("regression: a SCANNER_UNAVAILABLE scanner failure still fails open for images, but not for PDFs", async () => {
    const scanner: MalwareScanner = {
      acceptsDocuments: true,
      failOpenForImages: true,
      scan: async () => {
        throw unavailable();
      },
    };
    const output = await processImage(await png(), 10_000_000, scanner);
    expect(output.full.contentType).toBe("image/webp");
    await expect(
      upload("document", await validPdfBytes(), scanner),
    ).rejects.toMatchObject({ status: 503, code: "SCANNER_UNAVAILABLE" });
  });
});
