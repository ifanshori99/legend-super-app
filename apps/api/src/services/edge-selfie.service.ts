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
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { EDGE_SELFIE_ERROR_CODES } from "@starter/shared/edge";
import type { DeviceTokenPayload } from "@starter/shared/platform";
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
import {
  recordSelfieStorageFull,
  recordSelfieStored,
} from "../edge/selfie-health";
import { getEdgeRuntimeState } from "../edge/runtime";
import { edgeSealedFilePath, edgeSealedObjectKey } from "../edge/selfie-paths";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import {
  SelfieSealError,
  importSealPublicKey,
  sealSelfie,
} from "../lib/selfie-seal";
import {
  processImageFull,
  withScanTenant,
  type MalwareScanner,
} from "./core-image";
import type { StorageAuthorization } from "./core-storage";
import { findActiveDeviceForToken } from "./device-registry-check";
import { assertLivePinProof } from "./staff-pin-proof.service";

type Database = NodePgDatabase<typeof schema>;

export interface EdgeSelfieDeps {
  authorize: StorageAuthorization;
  /** Verified session user id; becomes the object owner and `meta.ownerUserId`. */
  actorUserId: string;
  scanner: MalwareScanner;
  /** Set on the PIN proof path (legend-u7g9w): `staff_pin_proofs.id` the
   * selfie was uploaded under; the outlet clock checks it matches. */
  pinProofId?: string | null;
  /** EDGE_SELFIE_DIR. */
  dir: string;
  /** EDGE_SELFIE_MAX_BYTES: budget for sealed files waiting on this disk. */
  maxBytes: number;
}

/**
 * Bytes of sealed files on this disk that have not left yet: pending uploads,
 * rejected ones still inside their 7 day keep window (counted from
 * rejected_at; only legacy rows with NULL rejected_at fall back to created_at.
 * The file is deleted after 7 days but the row stays, so counting every
 * rejected row would grow the sum for good), plus sealed
 * objects whose clock is not made (no upload row). `uploaded` and `expired`
 * files are already deleted. The sum covers the whole tenant, not the
 * caller's outlet scope: the disk is shared by every outlet of the tenant.
 */
async function pendingSealedBytes(
  database: Database,
  context: ScopedTenantContext,
): Promise<number> {
  const wide = establishScopedTenantContext(context.tenant, { kind: "tenant" });
  return withTenant(database, wide, async (tx) => {
    const result = await tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(size), 0)::text AS total FROM (
        SELECT sealed_bytes::bigint AS size FROM edge_selfie_uploads
          WHERE state = 'pending'
             OR (state = 'rejected'
                 AND COALESCE(rejected_at, created_at) > now() - interval '7 days')
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
  const missing = () =>
    new HttpError(
      503,
      EDGE_SELFIE_ERROR_CODES.SELFIE_SEAL_KEY_MISSING,
      "Kunci segel selfie belum diterima atau tidak valid.",
    );
  if (!row?.kid || !row.publicKey) throw missing();
  // An unusable key answers 503 here, before any budget or image work.
  try {
    importSealPublicKey(row.publicKey);
  } catch {
    throw missing();
  }
  return { kid: row.kid, publicKeyPem: row.publicKey };
}

function fullDisk() {
  // One log line per episode; the health field carries the rest.
  if (recordSelfieStorageFull(new Date()))
    logger.error(
      { code: EDGE_SELFIE_ERROR_CODES.EDGE_SELFIE_STORAGE_FULL },
      "edge selfie storage full",
    );
  return new HttpError(
    507,
    EDGE_SELFIE_ERROR_CODES.EDGE_SELFIE_STORAGE_FULL,
    "Penyimpanan selfie edge penuh.",
  );
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
  // Make the rename durable: after a power cut the file must still be there
  // when the row that names it is.
  const dirHandle = await open(path.dirname(filePath), "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

/** A real full disk is the same answer as a spent budget. */
async function writeSealedFileOr507(
  filePath: string,
  bytes: Buffer,
): Promise<void> {
  try {
    await writeSealedFile(filePath, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw fullDisk();
    throw error;
  }
}

/** Device types that may clock on the edge (the outlet attendance screen). */
const PROOF_UPLOAD_DEVICE_TYPES: readonly string[] = ["pos", "display"];

const proofInvalid = () =>
  new HttpError(
    401,
    "PIN_PROOF_INVALID",
    "Bukti PIN tidak berlaku. Masukkan PIN lagi.",
  );

export interface PinProofUpload {
  /** Outlet-scoped to the device's outlet. */
  context: ScopedTenantContext;
  outletId: OutletId;
  /** The staff member who typed the PIN; becomes the object owner. */
  userId: string;
  proofId: string;
  /** Allows exactly one thing: a selfie upload at the device's outlet. */
  authorize: StorageAuthorization;
}

/**
 * Sessionless selfie upload (legend-u7g9w): the credentials are the signed
 * device token and a live `X-Pin-Proof`. The device must be active in the
 * local registry (at this node's outlet), a pos/display device and not in
 * training mode; the proof must be live for that device. The proof is only
 * read here, never consumed (the outlet clock consumes it). Every failure is
 * the same 401, so nothing tells a caller which part was wrong.
 */
export async function authorizePinProofUpload(
  database: Database,
  tenant: TenantContext,
  deviceToken: DeviceTokenPayload | null,
  proofToken: string,
  now: Date,
): Promise<PinProofUpload> {
  if (
    deviceToken === null ||
    deviceToken.tenantId.toLowerCase() !== tenant.tenantId.toLowerCase() ||
    proofToken === ""
  )
    throw proofInvalid();
  const nodeOutletId = getEdgeRuntimeState().identity?.scope.outletId;
  const device = await findActiveDeviceForToken(
    deviceToken,
    nodeOutletId === undefined ? {} : { outletId: nodeOutletId },
  );
  if (
    device === null ||
    !PROOF_UPLOAD_DEVICE_TYPES.includes(device.type) ||
    device.trainingMode
  )
    throw proofInvalid();
  const outletId = outletIdSchema.parse(device.outletId);
  const context = establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: [outletId],
  });
  const proof = await withTenant(database, context, (tx) =>
    assertLivePinProof(tx, {
      tenantId: tenant.tenantId,
      deviceId: device.id,
      token: proofToken,
      now,
    }),
  );
  return {
    context,
    outletId,
    userId: proof.userId,
    proofId: proof.id,
    authorize: async (action, purpose, outlet, target) =>
      action === "upload" &&
      purpose === "selfie" &&
      outlet?.toLowerCase() === outletId.toLowerCase() &&
      (target?.sourceKind ?? null) === "attendance",
  };
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
  if (used >= deps.maxBytes) throw fullDisk();

  const { full } = await processImageFull(
    bytes,
    policy.maxBytes,
    withScanTenant(deps.scanner, context.tenant.tenantId),
  );
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
  if (used + sealed.length > deps.maxBytes) throw fullDisk();

  const filePath = edgeSealedFilePath(deps.dir, tenantId, id);
  await writeSealedFileOr507(filePath, sealed);
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
        uploadedBy: deps.actorUserId,
        pinProofId: deps.pinProofId ?? null,
        sourceKind,
        sourceId: null,
      }),
    );
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
  recordSelfieStored();
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
