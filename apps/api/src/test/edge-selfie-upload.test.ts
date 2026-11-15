// T5 (DB part) of docs/design/hris-edge-replication.md section 9: the edge
// selfie upload service seals the re-encoded webp to the cloud public key and
// keeps only the sealed file on disk (design section 5).
//
// Assumptions where the brief is silent:
// - `authorize` is called like uploadStorage; a false answer throws a CoreError
//   with code FORBIDDEN before anything is written.
// - A failed upload leaves the disk dir empty (no tmp file, no sealed file).
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import sharp from "sharp";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema } from "@starter/shared/core";
import * as schema from "../db/schema";
import {
  NoopMalwareScanner,
  type MalwareScanner,
} from "../services/core-image";
import { ClamdMalwareScanner } from "../services/clamd-scanner";
import { uploadStorage } from "../services/core-storage";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { startFakeClamd } from "./helpers/fake-clamd";
import { openSelfie } from "../lib/selfie-seal";
import { uploadEdgeSelfie } from "../services/edge-selfie.service";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const db = drizzle(pool, { schema });
const context = (
  tenantId: string,
  scope:
    | { kind: "tenant" }
    | {
        kind: "outlets";
        outletIds: ReturnType<typeof outletIdSchema.parse>[];
      } = {
    kind: "tenant",
  },
) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    scope,
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
     VALUES ($1, $2, 'Uji Selfie', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenantId,
      `uji-selfie-${tag}`,
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

const KID = "test-kid-1";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let sealed: Awaited<ReturnType<typeof seedOutlet>>; // has a public key
let keyless: Awaited<ReturnType<typeof seedOutlet>>; // no sync state row
let nullKey: Awaited<ReturnType<typeof seedOutlet>>; // row, key still null
const dirs: string[] = [];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  [sealed, keyless, nullKey] = [
    await seedOutlet(),
    await seedOutlet(),
    await seedOutlet(),
  ];
  await owner.query(
    `INSERT INTO edge_people_sync_state (tenant_id, outlet_id, selfie_seal_kid, selfie_seal_public_key)
     VALUES ($1, $2, $3, $4)`,
    [sealed.tenantId, sealed.outletId, KID, publicKey],
  );
  await owner.query(
    `INSERT INTO edge_people_sync_state (tenant_id, outlet_id) VALUES ($1, $2)`,
    [nullKey.tenantId, nullKey.outletId],
  );
});
afterAll(async () => {
  await pool.end();
  await owner.end();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function newDir() {
  const dir = mkdtempSync(join(tmpdir(), "edge-selfie-test-"));
  dirs.push(dir);
  return dir;
}

/** Every file below `dir`, recursively. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesIn(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}

const SECRET_TEXT = "secret-description-8f3a";

/** A jpeg that carries EXIF (a description and a GPS reference). */
const jpegWithExif = () =>
  sharp({
    create: { width: 64, height: 48, channels: 3, background: "teal" },
  })
    .withExif({
      IFD0: { ImageDescription: SECRET_TEXT },
      IFD3: { GPSLatitudeRef: "S", GPSLongitudeRef: "E" },
    })
    .jpeg()
    .toBuffer();

const upload = (
  target: { tenantId: string; outletId: string },
  bytes: Uint8Array,
  options: {
    purpose?: string;
    dir: string;
    maxBytes?: number;
    authorize?: () => Promise<boolean>;
    actorUserId?: string;
    scopeOutletIds?: string[];
    scanner?: MalwareScanner;
  },
) =>
  uploadEdgeSelfie(
    db,
    context(
      target.tenantId,
      options.scopeOutletIds
        ? {
            kind: "outlets",
            outletIds: options.scopeOutletIds.map((id) =>
              outletIdSchema.parse(id),
            ),
          }
        : { kind: "tenant" },
    ),
    {
      purpose: options.purpose ?? "selfie",
      outletId: outletIdSchema.parse(target.outletId),
    } as never,
    bytes,
    {
      authorize: options.authorize ?? (async () => true),
      actorUserId: options.actorUserId ?? randomUUID(),
      scanner: options.scanner ?? new NoopMalwareScanner(),
      dir: options.dir,
      maxBytes: options.maxBytes ?? 1024 * 1024 * 1024,
    } as never,
  );

async function objectRows(tenantId: string) {
  const { rows } = await owner.query(
    `SELECT id, purpose, object_key, content_type, size_bytes, width, height,
            thumbnail_key, owner_user_id, source_kind
       FROM core_storage_objects WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows as Array<{
    id: string;
    purpose: string;
    object_key: string;
    content_type: string;
    size_bytes: number;
    width: number | null;
    height: number | null;
    thumbnail_key: string | null;
    owner_user_id: string | null;
    source_kind: string | null;
  }>;
}

it("T5 edge selfie upload writes a 0600 sealed file and an edge-sealed object row", async () => {
  const dir = newDir();
  const actorUserId = randomUUID();
  const stored = await upload(sealed, await jpegWithExif(), {
    dir,
    actorUserId,
  });

  expect(stored).toMatchObject({
    purpose: "selfie",
    contentType: "image/webp",
    width: 64,
    height: 48,
    publicUrl: null,
    thumbnailUrl: null,
  });
  const file = join(dir, sealed.tenantId, `${stored.id}.lss`);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, sealed.tenantId)).mode & 0o777).toBe(0o700);

  const rows = (await objectRows(sealed.tenantId)).filter(
    (row) => row.id === stored.id,
  );
  expect(rows).toEqual([
    {
      id: stored.id,
      purpose: "selfie",
      object_key: `edge-sealed:${sealed.tenantId}/${stored.id}.lss`,
      content_type: "image/webp",
      size_bytes: statSync(file).size,
      width: 64,
      height: 48,
      thumbnail_key: null,
      owner_user_id: actorUserId,
      source_kind: "attendance",
    },
  ]);
  expect(stored.sizeBytes).toBe(statSync(file).size);
});

// core_storage_objects.uploaded_by is the immutable record of the verified
// uploader (deps.actorUserId, the PIN proof's user), set at insert.
it("T5 edge selfie upload records uploaded_by as the verified actor", async () => {
  const actorUserId = randomUUID();
  const stored = await upload(sealed, await jpegWithExif(), {
    dir: newDir(),
    actorUserId,
  });

  const { rows } = await owner.query<{
    uploaded_by: string | null;
    owner_user_id: string | null;
  }>(
    `SELECT uploaded_by, owner_user_id
       FROM core_storage_objects WHERE tenant_id = $1 AND id = $2`,
    [sealed.tenantId, stored.id],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.uploaded_by).toBe(actorUserId);
});

it("T5 edge selfie upload round trips to an EXIF-free webp with the plain hash", async () => {
  const dir = newDir();
  const input = await jpegWithExif();
  // Control: the input really carries the secret text and EXIF.
  expect(input.includes(Buffer.from(SECRET_TEXT))).toBe(true);
  expect((await sharp(input).metadata()).exif).toBeDefined();

  const actorUserId = randomUUID();
  const stored = await upload(sealed, input, { dir, actorUserId });
  const bytes = readFileSync(join(dir, sealed.tenantId, `${stored.id}.lss`));
  const opened = openSelfie(bytes, privateKey);

  expect(opened.header).toMatchObject({
    v: 1,
    kid: KID,
    tenantId: sealed.tenantId,
    objectId: stored.id,
  });
  expect(opened.meta).toMatchObject({
    outletId: sealed.outletId,
    ownerUserId: actorUserId,
    contentType: "image/webp",
    width: 64,
    height: 48,
  });
  expect(opened.meta.plainSha256).toBe(
    createHash("sha256").update(opened.webp).digest("hex"),
  );

  const metadata = await sharp(opened.webp).metadata();
  expect(metadata.format).toBe("webp");
  expect(metadata.width).toBe(64);
  expect(metadata.height).toBe(48);
  expect(metadata.exif).toBeUndefined();
  expect(opened.webp.includes(Buffer.from(SECRET_TEXT))).toBe(false);
  expect(opened.webp.includes(Buffer.from("Exif"))).toBe(false);
});

it("T5 edge selfie upload keeps no plaintext image and no tmp file on disk", async () => {
  const dir = newDir();
  const input = await jpegWithExif();
  const stored = await upload(sealed, input, { dir });
  const opened = openSelfie(
    readFileSync(join(dir, sealed.tenantId, `${stored.id}.lss`)),
    privateKey,
  );

  const files = filesIn(dir);
  expect(files).toEqual([join(dir, sealed.tenantId, `${stored.id}.lss`)]);
  for (const file of files) {
    expect(file.endsWith(".lss")).toBe(true);
    const content = readFileSync(file);
    // Four-byte markers keep a chance hit in ciphertext negligible (a three
    // byte jpeg magic would flake).
    for (const marker of ["RIFF", "WEBP", "JFIF", "Exif", SECRET_TEXT])
      expect(content.includes(Buffer.from(marker, "ascii"))).toBe(false);
    expect(content.includes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(content.includes(Buffer.from([0xff, 0xd8, 0xff, 0xe1]))).toBe(false);
    expect(content.includes(opened.webp.subarray(0, 64))).toBe(false);
    expect(content.includes(input.subarray(0, 64))).toBe(false);
  }
});

it("T5 edge selfie upload answers 503 SELFIE_SEAL_KEY_MISSING without a public key and writes nothing", async () => {
  const image = await jpegWithExif();
  for (const target of [keyless, nullKey]) {
    const dir = newDir();
    await expect(upload(target, image, { dir })).rejects.toMatchObject({
      status: 503,
      code: "SELFIE_SEAL_KEY_MISSING",
    });
    expect(filesIn(dir)).toEqual([]);
    expect(await objectRows(target.tenantId)).toEqual([]);
  }
});

it("T5 edge selfie upload answers 507 EDGE_SELFIE_STORAGE_FULL over the budget and stores no row", async () => {
  const dir = newDir();
  const before = (await objectRows(sealed.tenantId)).length;
  await expect(
    upload(sealed, await jpegWithExif(), { dir, maxBytes: 1 }),
  ).rejects.toMatchObject({ status: 507, code: "EDGE_SELFIE_STORAGE_FULL" });
  expect(filesIn(dir)).toEqual([]);
  expect((await objectRows(sealed.tenantId)).length).toBe(before);
});

it("T5 edge selfie upload answers 503 for any purpose but selfie", async () => {
  const dir = newDir();
  const before = (await objectRows(sealed.tenantId)).length;
  await expect(
    upload(sealed, await jpegWithExif(), { dir, purpose: "receipt" }),
  ).rejects.toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
  expect(filesIn(dir)).toEqual([]);
  expect((await objectRows(sealed.tenantId)).length).toBe(before);
});

it("T5 edge selfie upload answers 413 above 5 MiB", async () => {
  const dir = newDir();
  const before = (await objectRows(sealed.tenantId)).length;
  await expect(
    upload(sealed, Buffer.alloc(5 * 1024 * 1024 + 1), { dir }),
  ).rejects.toMatchObject({ status: 413 });
  expect(filesIn(dir)).toEqual([]);
  expect((await objectRows(sealed.tenantId)).length).toBe(before);
});

it("T5 edge selfie upload answers 415 for bytes that are not an image", async () => {
  const dir = newDir();
  const before = (await objectRows(sealed.tenantId)).length;
  await expect(
    upload(sealed, Buffer.from("this is plain text, not an image"), { dir }),
  ).rejects.toMatchObject({ status: 415 });
  expect(filesIn(dir)).toEqual([]);
  expect((await objectRows(sealed.tenantId)).length).toBe(before);
});

it("T5 edge selfie upload refuses an unauthorized caller before writing", async () => {
  const dir = newDir();
  mkdirSync(join(dir, "marker"));
  const before = (await objectRows(sealed.tenantId)).length;
  const authorize = vi.fn(async () => false);
  await expect(
    upload(sealed, await jpegWithExif(), { dir, authorize }),
  ).rejects.toMatchObject({ name: "CoreError", code: "FORBIDDEN" });
  expect(authorize).toHaveBeenCalled();
  expect(filesIn(dir)).toEqual([]);
  expect((await objectRows(sealed.tenantId)).length).toBe(before);
});

/** Owner-seeded outlet with a sync state row holding the given key. */
async function seedKeyed(publicKeyPem: string) {
  const target = await seedOutlet();
  await owner.query(
    `INSERT INTO edge_people_sync_state (tenant_id, outlet_id, selfie_seal_kid, selfie_seal_public_key)
     VALUES ($1, $2, $3, $4)`,
    [target.tenantId, target.outletId, KID, publicKeyPem],
  );
  return target;
}

/** Owner-seeded upload row; `createdAtSql` is a SQL expression. */
async function seedUploadRow(
  target: { tenantId: string; outletId: string },
  columns: {
    state: string;
    createdAtSql: string;
    sealedBytes: number;
    rejectedAtSql?: string;
  },
) {
  await owner.query(
    `INSERT INTO edge_selfie_uploads
       (tenant_id, outlet_id, object_id, state, sealed_bytes, sealed_sha256, file_path, seal_kid, created_at, rejected_at)
     VALUES ($1, $2, $6, $3, $4, $5, 'seeded/none.lss', 'seed-kid', ${columns.createdAtSql}, ${columns.rejectedAtSql ?? "NULL"})`,
    [
      target.tenantId,
      target.outletId,
      columns.state,
      columns.sealedBytes,
      createHash("sha256").update(randomUUID()).digest(),
      randomUUID(),
    ],
  );
}

// Assumption: "garbage" means not-a-PEM text, an EC key, and a 2048-bit RSA
// key (below the 3072-bit minimum); all give the same 503, and the key is
// checked before the budget, so maxBytes 1 does not turn it into a 507.
it("T5 edge selfie upload answers 503 SELFIE_SEAL_KEY_MISSING for an unusable key even when over budget", async () => {
  const ec = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).publicKey;
  const rsa2048 = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).publicKey;
  const image = await jpegWithExif();
  for (const badKey of ["garbage, not a pem", ec, rsa2048]) {
    const target = await seedKeyed(badKey);
    const dir = newDir();
    await expect(
      upload(target, image, { dir, maxBytes: 1 }),
    ).rejects.toMatchObject({ status: 503, code: "SELFIE_SEAL_KEY_MISSING" });
    expect(filesIn(dir)).toEqual([]);
    expect(await objectRows(target.tenantId)).toEqual([]);
  }
});

// Assumption: "huge" = 2e9 bytes, above the default 1 GiB test budget. Only
// pending rows and rejected rows from the last 7 days count toward the budget.
it("T5 edge selfie upload budget ignores rejected rows older than 7 days but counts pending and recent rejected rows", async () => {
  const image = await jpegWithExif();
  const HUGE = 2_000_000_000;

  const oldRejected = await seedKeyed(publicKey);
  await seedUploadRow(oldRejected, {
    state: "rejected",
    createdAtSql: "now() - interval '8 days'",
    sealedBytes: HUGE,
  });
  const ok = await upload(oldRejected, image, { dir: newDir() });
  expect(ok.purpose).toBe("selfie");

  for (const [state, createdAtSql] of [
    ["pending", "now() - interval '8 days'"],
    ["rejected", "now()"],
  ] as const) {
    const target = await seedKeyed(publicKey);
    await seedUploadRow(target, { state, createdAtSql, sealedBytes: HUGE });
    const dir = newDir();
    await expect(upload(target, image, { dir })).rejects.toMatchObject({
      status: 507,
      code: "EDGE_SELFIE_STORAGE_FULL",
    });
    expect(filesIn(dir)).toEqual([]);
    expect(await objectRows(target.tenantId)).toEqual([]);
  }
});

// The 7 day window of a rejected row runs from rejected_at; created_at only
// stands in for legacy rows where rejected_at is NULL.
it("T5 edge selfie upload budget counts a rejected row by rejected_at, not created_at", async () => {
  const image = await jpegWithExif();
  const HUGE = 2_000_000_000;

  const recent = await seedKeyed(publicKey);
  await seedUploadRow(recent, {
    state: "rejected",
    createdAtSql: "now() - interval '30 days'",
    rejectedAtSql: "now() - interval '1 day'",
    sealedBytes: HUGE,
  });
  const dir = newDir();
  await expect(upload(recent, image, { dir })).rejects.toMatchObject({
    status: 507,
    code: "EDGE_SELFIE_STORAGE_FULL",
  });
  expect(filesIn(dir)).toEqual([]);

  const old = await seedKeyed(publicKey);
  await seedUploadRow(old, {
    state: "rejected",
    createdAtSql: "now() - interval '1 day'",
    rejectedAtSql: "now() - interval '8 days'",
    sealedBytes: HUGE,
  });
  expect((await upload(old, image, { dir: newDir() })).purpose).toBe("selfie");
});

it("T5 edge selfie upload budget is tenant-wide, not limited to the caller's outlet scope", async () => {
  const outletA = await seedKeyed(publicKey);
  const outletB = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     SELECT $1, o.tenant_id, o.brand_id, o.legal_entity_id, 'U-02', 'Outlet Uji B', 'Jl. Uji B', '{}'
       FROM outlets o WHERE o.id = $2`,
    [outletB, outletA.outletId],
  );
  await seedUploadRow(
    { tenantId: outletA.tenantId, outletId: outletB },
    { state: "pending", createdAtSql: "now()", sealedBytes: 2_000_000_000 },
  );

  const dir = newDir();
  await expect(
    upload(outletA, await jpegWithExif(), {
      dir,
      scopeOutletIds: [outletA.outletId],
    }),
  ).rejects.toMatchObject({ status: 507, code: "EDGE_SELFIE_STORAGE_FULL" });
  expect(filesIn(dir)).toEqual([]);
});

it("isolates scanner capacity between logo uploads and edge selfies by tenant", async () => {
  const other = await seedOutlet();
  const server = await startFakeClamd({ kind: "silent" });
  const scanner = new ClamdMalwareScanner({
    host: "127.0.0.1",
    port: server.port,
    timeoutMs: 10000,
    maxConcurrent: 3,
    maxQueued: 0,
    maxPerTenant: 1,
  });
  const bytes = await jpegWithExif();
  const logo = (tenantId: string) =>
    uploadStorage(db, context(tenantId), { purpose: "brand_logo" }, bytes, {
      storage: new FakeObjectStorage(),
      scanner,
      authorize: async () => true,
      actorUserId: randomUUID(),
    });
  const first = logo(sealed.tenantId).catch(() => undefined);
  try {
    await vi.waitFor(() => expect(server.sessions).toHaveLength(1));
    server.setBehavior({ kind: "reply", reply: "stream: OK\0" });
    await expect(logo(other.tenantId)).resolves.toBeDefined();
    const dir = newDir();
    await expect(upload(sealed, bytes, { dir, scanner })).rejects.toMatchObject(
      { status: 503, code: "SCANNER_OVERLOADED" },
    );
    expect(filesIn(dir)).toEqual([]);
  } finally {
    await server.close();
    await first;
  }
});
