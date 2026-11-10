// Selfie upload on an edge node (design docs/design/hris-edge-replication.md
// 5, card legend-we0yc). The edge never keeps a readable selfie: the image is
// checked and re-encoded in memory, sealed to the cloud public key (LSS1,
// lib/selfie-seal.ts) and only the sealed file reaches disk. Plaintext and
// meta are never written or logged. Cloud uploads keep using `uploadStorage`.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { EDGE_SELFIE_ERROR_CODES } from "@starter/shared/edge";
import {
  storageDefaultSourceKind,
  storagePurposePolicy,
  uploadStorageMetadataSchema,
  type UploadStorageMetadata,
} from "@starter/shared/storage";
import type * as schema from "../db/schema";
import { coreStorageObjects } from "../db/schema/core-storage";
import { edgePeopleSyncState } from "../db/schema/edge-hris";
import { withTenant } from "../db/tenant";
import { edgeSealedFilePath, edgeSealedObjectKey } from "../edge/selfie-paths";
import { HttpError } from "../lib/http-error";
import { SelfieSealError, sealSelfie } from "../lib/selfie-seal";
import { processImageFull, type MalwareScanner } from "./core-image";
import type { StorageAuthorization } from "./core-storage";

type Database = NodePgDatabase<typeof schema>;

export interface EdgeSelfieDeps {
  authorize: StorageAuthorization;
  /** Verified session user id; becomes the object owner and `meta.ownerUserId`. */
  actorUserId: string;
  scanner: MalwareScanner;
  /** EDGE_SELFIE_DIR. */
  dir: string;
  /** EDGE_SELFIE_MAX_BYTES: budget for sealed files waiting on this disk. */
  maxBytes: number;
}

/**
 * Bytes of sealed files on this disk that have not left yet: pending and
 * rejected uploads, plus sealed objects whose clock is not made (no upload
 * row). `uploaded` and `expired` files are already deleted. One edge serves
 * one tenant, so the tenant-scoped sum is the disk sum.
 */
async function pendingSealedBytes(
  database: Database,
  context: ScopedTenantContext,
): Promise<number> {
  return withTenant(database, context, async (tx) => {
    const result = await tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(size), 0)::text AS total FROM (
        SELECT sealed_bytes::bigint AS size FROM edge_selfie_uploads
          WHERE state IN ('pending', 'rejected')
        UNION ALL
        SELECT o.size_bytes::bigint FROM core_storage_objects o
          WHERE o.purpose = 'selfie' AND o.object_key LIKE 'edge-sealed:%'
            AND NOT EXISTS (
              SELECT 1 FROM edge_selfie_uploads u
              WHERE u.tenant_id = o.tenant_id AND u.object_id = o.id)
      ) pending`);
    return Number(result.rows[0]?.total ?? 0);
  });
}

async function sealKeyFor(
  database: Database,
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<{ kid: string; publicKeyPem: string }> {
  const [row] = await withTenant(database, context, (tx) =>
    tx
      .select({
        kid: edgePeopleSyncState.selfieSealKid,
        publicKey: edgePeopleSyncState.selfieSealPublicKey,
      })
      .from(edgePeopleSyncState)
      .where(
        and(
          eq(edgePeopleSyncState.tenantId, context.tenant.tenantId),
          eq(edgePeopleSyncState.outletId, outletId),
        ),
      )
      .limit(1),
  );
  if (!row?.kid || !row.publicKey)
    throw new HttpError(
      503,
      EDGE_SELFIE_ERROR_CODES.SELFIE_SEAL_KEY_MISSING,
      "Kunci segel selfie belum diterima dari cloud.",
    );
  return { kid: row.kid, publicKeyPem: row.publicKey };
}

/** temp file, fsync, rename, mode 0600; the directory is 0700. */
async function writeSealedFile(filePath: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, filePath);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function uploadEdgeSelfie(
  database: Database,
  context: ScopedTenantContext,
  raw: UploadStorageMetadata,
  bytes: Uint8Array,
  deps: EdgeSelfieDeps,
) {
  assertTrustedScopedContext(context);
  const input = uploadStorageMetadataSchema.parse(raw);
  // Every other purpose is served by the cloud only.
  if (input.purpose !== "selfie")
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "Hanya selfie yang bisa diunggah di edge.",
    );
  if (!input.outletId)
    throw new CoreError("VALIDATION_ERROR", "Outlet is required.");
  assertOutletInScope(context.outletScope, input.outletId);
  const sourceKind =
    input.sourceKind ?? storageDefaultSourceKind.selfie ?? null;
  if (
    !(await deps.authorize("upload", "selfie", input.outletId, { sourceKind }))
  )
    throw new CoreError("FORBIDDEN", "Permission denied.");
  const policy = storagePurposePolicy.selfie;
  if (!bytes.byteLength || bytes.byteLength > policy.maxBytes)
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Invalid upload size.");

  // Cheap refusals first: no key means no seal, so no image work at all.
  const key = await sealKeyFor(database, context, input.outletId);
  const used = await pendingSealedBytes(database, context);
  // Full already: refuse before any image work. The exact size check follows
  // the seal, when the file length is known.
  if (used >= deps.maxBytes)
    throw new HttpError(
      507,
      EDGE_SELFIE_ERROR_CODES.EDGE_SELFIE_STORAGE_FULL,
      "Penyimpanan selfie edge penuh.",
    );

  const { full } = await processImageFull(bytes, policy.maxBytes, deps.scanner);
  const id = randomUUID();
  const tenantId = context.tenant.tenantId;
  let sealed: Buffer;
  try {
    sealed = sealSelfie({
      kid: key.kid,
      publicKeyPem: key.publicKeyPem,
      tenantId,
      objectId: id,
      meta: {
        outletId: input.outletId,
        ownerUserId: deps.actorUserId,
        contentType: "image/webp",
        width: full.width,
        height: full.height,
        plainSha256: createHash("sha256").update(full.bytes).digest("hex"),
        createdAt: new Date().toISOString(),
      },
      webp: full.bytes,
    });
  } catch (error) {
    if (error instanceof SelfieSealError)
      throw new HttpError(
        503,
        EDGE_SELFIE_ERROR_CODES.SELFIE_SEAL_KEY_MISSING,
        "Kunci segel selfie tidak valid.",
      );
    throw error;
  }
  if (used + sealed.length > deps.maxBytes)
    throw new HttpError(
      507,
      EDGE_SELFIE_ERROR_CODES.EDGE_SELFIE_STORAGE_FULL,
      "Penyimpanan selfie edge penuh.",
    );

  const filePath = edgeSealedFilePath(deps.dir, tenantId, id);
  await writeSealedFile(filePath, sealed);
  try {
    await withTenant(database, context, (tx) =>
      tx.insert(coreStorageObjects).values({
        tenantId,
        outletId: input.outletId,
        id,
        purpose: "selfie",
        objectKey: edgeSealedObjectKey(tenantId, id),
        thumbnailKey: null,
        contentType: "image/webp",
        sizeBytes: sealed.length,
        width: full.width,
        height: full.height,
        ownerUserId: deps.actorUserId,
        sourceKind,
        sourceId: null,
      }),
    );
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
  return {
    id,
    purpose: "selfie" as const,
    contentType: "image/webp",
    sizeBytes: sealed.length,
    width: full.width,
    height: full.height,
    publicUrl: null,
    thumbnailUrl: null,
  };
}
