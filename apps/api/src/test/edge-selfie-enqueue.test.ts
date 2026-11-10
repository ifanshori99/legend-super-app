// Edge selfie enqueue (design docs/design/hris-edge-replication.md section 5, 9 T5).
// Covers selfie-paths.ts (strict key parsing) and selfie-queue.ts (enqueue of
// a sealed file into edge_selfie_uploads). Sealed files are built with the real
// sealSelfie so readLss1Header validates them.
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { sealSelfie } from "../lib/selfie-seal";
import {
  EDGE_SEALED_KEY_PREFIX,
  edgeSealedFilePath,
  edgeSealedObjectKey,
  parseEdgeSealedObjectKey,
} from "../edge/selfie-paths";
import { enqueueEdgeSelfieUpload } from "../edge/selfie-queue";

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

/** Owner-seeded tenant with one outlet; the upload FK needs a real outlet. */
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
     VALUES ($1, $2, 'Uji Selfie Edge', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenantId,
      `uji-selfie-edge-${tag}`,
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

let tenant: Awaited<ReturnType<typeof seedOutlet>>;
let dir: string;
let keys: { publicKey: string; privateKey: string };
const KID = "kid-2026-11";

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenant = await seedOutlet();
  dir = await mkdtemp(path.join(tmpdir(), "edge-selfie-enqueue-"));
  keys = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
  await owner.end();
  await rm(dir, { recursive: true, force: true });
});

/** Seals a fake webp and writes it where the edge would keep it. */
async function writeSealedFile(objectId: string) {
  const webp = Buffer.from(`not-really-webp-${objectId}`);
  const sealed = sealSelfie({
    kid: KID,
    publicKeyPem: keys.publicKey,
    tenantId: tenant.tenantId,
    objectId,
    meta: {
      outletId: tenant.outletId,
      ownerUserId: randomUUID(),
      contentType: "image/webp",
      width: 64,
      height: 48,
      plainSha256: createHash("sha256").update(webp).digest("hex"),
      createdAt: new Date().toISOString(),
    },
    webp,
  });
  const filePath = edgeSealedFilePath(dir, tenant.tenantId, objectId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, sealed, { mode: 0o600 });
  return { sealed, filePath };
}

const enqueue = (input: { objectKey: string; attendanceLogId?: string }) =>
  withTenant(db, context(tenant.tenantId), (tx) =>
    enqueueEdgeSelfieUpload(tx, {
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      attendanceLogId: input.attendanceLogId ?? randomUUID(),
      objectKey: input.objectKey,
      dir,
    }),
  );

type UploadRow = {
  object_id: string;
  outlet_id: string;
  attendance_log_id: string | null;
  file_path: string;
  sha_hex: string;
  sealed_bytes: number;
  seal_kid: string;
  state: string;
  attempts: number;
};

async function uploadRows(objectId?: string) {
  const { rows } = await owner.query(
    `SELECT object_id, outlet_id, attendance_log_id, file_path,
            encode(sealed_sha256, 'hex') AS sha_hex, sealed_bytes, seal_kid, state, attempts
     FROM edge_selfie_uploads
     WHERE tenant_id = $1 AND ($2::uuid IS NULL OR object_id = $2)`,
    [tenant.tenantId, objectId ?? null],
  );
  return rows as UploadRow[];
}

describe("selfie-paths", () => {
  const tenantId = randomUUID();
  const objectId = randomUUID();

  it("builds the object key and file path from tenant and object ids", () => {
    expect(EDGE_SEALED_KEY_PREFIX).toBe("edge-sealed:");
    expect(edgeSealedObjectKey(tenantId, objectId)).toBe(
      `edge-sealed:${tenantId}/${objectId}.lss`,
    );
    expect(edgeSealedFilePath("/var/x", tenantId, objectId)).toBe(
      path.join("/var/x", tenantId, `${objectId}.lss`),
    );
  });

  it("parses a key it built back to tenant and object ids", () => {
    expect(
      parseEdgeSealedObjectKey(edgeSealedObjectKey(tenantId, objectId)),
    ).toEqual({ tenantId, objectId });
  });

  it("rejects keys that are not strictly edge-sealed:<uuid>/<uuid>.lss", () => {
    const bad = [
      "",
      `${tenantId}/${objectId}.lss`, // missing prefix
      `${objectId}/original.webp`, // regular storage key
      `edge-sealed:${tenantId}/${objectId}`, // no extension
      `edge-sealed:${tenantId}/${objectId}.webp`, // wrong extension
      `edge-sealed:${tenantId}/${objectId}.lss/extra`, // extra segment
      `edge-sealed:${tenantId}/${objectId}.lss\n`, // trailing newline
      `edge-sealed:${tenantId}/${objectId}.lss `, // trailing space
      `edge-sealed:../${objectId}.lss`, // traversal as tenant
      `edge-sealed:${tenantId}/../${objectId}.lss`, // traversal segment
      `edge-sealed:${tenantId}/..%2F${objectId}.lss`,
      `edge-sealed:../../etc/passwd`,
      `edge-sealed:/${tenantId}/${objectId}.lss`, // absolute
      `edge-sealed:${tenantId}\\${objectId}.lss`, // backslash separator
      `edge-sealed:not-a-uuid/${objectId}.lss`,
      `edge-sealed:${tenantId}/not-a-uuid.lss`,
      `edge-sealed:${tenantId.slice(0, 35)}/${objectId}.lss`, // short uuid
      `edge-sealed:${tenantId}x/${objectId}.lss`, // long uuid
      `edge-sealed:${tenantId}/${objectId}\0.lss`, // NUL byte
      `Edge-Sealed:${tenantId}/${objectId}.lss`, // prefix case
    ];
    for (const key of bad) {
      expect(parseEdgeSealedObjectKey(key), JSON.stringify(key)).toBeNull();
    }
  });
});

describe("enqueueEdgeSelfieUpload", () => {
  it("inserts a pending upload row describing the sealed file", async () => {
    const objectId = randomUUID();
    const attendanceLogId = randomUUID();
    const { sealed, filePath } = await writeSealedFile(objectId);

    const result = await enqueue({
      objectKey: edgeSealedObjectKey(tenant.tenantId, objectId),
      attendanceLogId,
    });

    expect(result).toBe(true);
    const rows = await uploadRows(objectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      object_id: objectId,
      outlet_id: tenant.outletId,
      attendance_log_id: attendanceLogId,
      file_path: filePath,
      sha_hex: createHash("sha256").update(sealed).digest("hex"),
      sealed_bytes: sealed.length,
      seal_kid: KID,
      state: "pending",
      attempts: 0,
    });
  });

  it("is a no-op when the same object is enqueued again", async () => {
    const objectId = randomUUID();
    await writeSealedFile(objectId);
    const objectKey = edgeSealedObjectKey(tenant.tenantId, objectId);

    await enqueue({ objectKey });
    const [first] = await uploadRows(objectId);
    // Second call may report true or false, but must not add or change a row.
    await enqueue({ objectKey });

    const rows = await uploadRows(objectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(first);
  });

  it("writes nothing and returns false for a key that is not edge-sealed", async () => {
    const before = await uploadRows();
    const filesBefore = await readdir(dir, { recursive: true });

    const regular = await enqueue({
      objectKey: `${randomUUID()}/original.webp`,
    });
    const traversal = await enqueue({
      objectKey: `${EDGE_SEALED_KEY_PREFIX}../../etc/passwd`,
    });

    expect(regular).toBe(false);
    expect(traversal).toBe(false);
    expect(await uploadRows()).toEqual(before);
    expect(await readdir(dir, { recursive: true })).toEqual(filesBefore);
  });
});
