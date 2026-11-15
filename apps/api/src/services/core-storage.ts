import { randomUUID } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  storageDefaultSourceKind,
  storagePurposePolicy,
  storagePurposeSchema,
  storageSourceKindPurpose,
  uploadStorageMetadataSchema,
  type StoragePurpose,
  type StorageSourceKind,
  type UploadStorageMetadata,
} from "@starter/shared/storage";
import type * as schema from "../db/schema";
import { coreStorageObjects } from "../db/schema/core-storage";
import { withTenant } from "../db/tenant";
import {
  processImage,
  scanUploadBytes,
  type MalwareScanner,
} from "./core-image";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type StorageAuthorization = (
  action: "upload" | "read",
  purpose: StoragePurpose,
  outletId: string | null,
  target?: { objectId?: string; sourceKind?: StorageSourceKind | null },
) => Promise<boolean>;
type Dependencies = {
  storage: ObjectStorage;
  scanner: MalwareScanner;
  authorize: StorageAuthorization;
  /** Verified session user id, stored as the object's owner. Null only for a
   * system job with no user (the scheduled menu print render). */
  actorUserId: string | null;
};

export async function uploadStorage(
  database: Database,
  context: ScopedTenantContext,
  raw: UploadStorageMetadata,
  bytes: Uint8Array,
  deps: Dependencies,
) {
  assertTrustedScopedContext(context);
  const input = uploadStorageMetadataSchema.parse(raw);
  // Only brand_logo has no outlet (schema refine); it needs a tenant-wide scope.
  if (input.outletId) assertOutletInScope(context.outletScope, input.outletId);
  else if (context.outletScope.kind !== "tenant")
    throw new CoreError("OUTLET_OUT_OF_SCOPE", "Permission denied.");
  const sourceKind =
    input.sourceKind ?? storageDefaultSourceKind[input.purpose] ?? null;
  if (
    !(await deps.authorize("upload", input.purpose, input.outletId ?? null, {
      sourceKind,
    }))
  )
    throw new CoreError("FORBIDDEN", "Permission denied.");
  const policy = storagePurposePolicy[input.purpose];
  if (!bytes.byteLength || bytes.byteLength > policy.maxBytes)
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Invalid upload size.");
  const id = randomUUID();
  const base = {
    tenantId: context.tenant.tenantId,
    outletId: input.outletId ?? null,
    reference: id,
    visibility: policy.visibility,
  };
  const written: string[] = [];
  let contentType: string,
    full: Uint8Array,
    thumbnail: Uint8Array | undefined,
    width: number | null = null,
    height: number | null = null;
  if (
    input.purpose === "document" &&
    Buffer.from(bytes).subarray(0, 5).toString("ascii") === "%PDF-"
  ) {
    // Scanner capability, structure (malformed, encrypted, active content: 422)
    // and malware scan; nothing is stored until all pass (legend-851ef).
    const { pageCount } = await scanUploadBytes(bytes, {
      kind: "pdf",
      scanner: deps.scanner,
      maxBytes: policy.maxBytes,
    });
    logger.info({ pageCount }, "storage pdf checked");
    contentType = "application/pdf";
    full = bytes;
  } else {
    const image = await processImage(bytes, policy.maxBytes, deps.scanner);
    full = image.full.bytes;
    thumbnail = image.thumbnail.bytes;
    contentType = image.full.contentType;
    width = image.full.width;
    height = image.full.height;
  }
  const key = `${id}/original.${contentType === "application/pdf" ? "pdf" : "webp"}`;
  const thumbnailKey = thumbnail ? `${id}/thumbnail.webp` : null;
  try {
    await deps.storage.put(context, {
      ...base,
      key,
      contentType,
      content: new Uint8Array(full),
    });
    written.push(key);
    if (thumbnail && thumbnailKey) {
      await deps.storage.put(context, {
        ...base,
        key: thumbnailKey,
        contentType: "image/webp",
        content: new Uint8Array(thumbnail),
      });
      written.push(thumbnailKey);
    }
    await withTenant(database, context, (tx) =>
      tx.insert(coreStorageObjects).values({
        tenantId: base.tenantId,
        outletId: input.outletId ?? null,
        id,
        purpose: input.purpose,
        objectKey: key,
        thumbnailKey,
        contentType,
        sizeBytes: full.byteLength,
        width,
        height,
        ownerUserId: deps.actorUserId,
        uploadedBy: deps.actorUserId,
        sourceKind,
        sourceId: null,
      }),
    );
  } catch (error) {
    await Promise.allSettled(
      written.map((key) => deps.storage.delete(context, { ...base, key })),
    );
    throw error;
  }
  return {
    id,
    purpose: input.purpose,
    contentType,
    sizeBytes: full.byteLength,
    width,
    height,
    publicUrl:
      policy.visibility === "public"
        ? await deps.storage.publicUrl(context, { ...base, key })
        : null,
    thumbnailUrl:
      policy.visibility === "public" && thumbnailKey
        ? await deps.storage.publicUrl(context, { ...base, key: thumbnailKey })
        : null,
  };
}

export async function signedStorageUrl(
  database: Database,
  context: ScopedTenantContext,
  id: string,
  variant: "original" | "thumbnail",
  deps: Pick<Dependencies, "storage" | "authorize">,
  options: { downloadFileName?: string } = {},
) {
  assertTrustedScopedContext(context);
  return withTenant(database, context, (tx) =>
    signedStorageUrlInTx(tx, context, id, variant, deps, options),
  );
}

/** Same as `signedStorageUrl`, inside the caller's tenant transaction (`tx`
 * is already scoped to `context`): no extra pooled connection per call. */
export async function signedStorageUrlInTx(
  tx: Transaction,
  context: ScopedTenantContext,
  id: string,
  variant: "original" | "thumbnail",
  deps: Pick<Dependencies, "storage" | "authorize">,
  options: { downloadFileName?: string } = {},
) {
  assertTrustedScopedContext(context);
  const row = (
    await tx
      .select()
      .from(coreStorageObjects)
      .where(
        and(
          eq(coreStorageObjects.tenantId, context.tenant.tenantId),
          eq(coreStorageObjects.id, id),
        ),
      )
      .limit(1)
  )[0];
  if (!row) throw new CoreError("NOT_FOUND", "Object not found.");
  // A tenant-level row (no outlet) is only ever a public purpose: no signed URL.
  if (row.outletId === null)
    throw new CoreError("FORBIDDEN", "Permission denied.");
  const outletId = outletIdSchema.parse(row.outletId);
  assertOutletInScope(context.outletScope, outletId);
  const purpose = storagePurposeSchema.parse(row.purpose);
  if (
    storagePurposePolicy[purpose].visibility !== "private" ||
    !(await deps.authorize("read", purpose, outletId, { objectId: id }))
  )
    throw new CoreError("FORBIDDEN", "Permission denied.");
  const key = variant === "original" ? row.objectKey : row.thumbnailKey;
  if (!key) throw new CoreError("NOT_FOUND", "Variant not found.");
  const expiresInSeconds = 300;
  const url = await deps.storage.signedGetUrl(context, {
    tenantId: context.tenant.tenantId,
    outletId,
    reference: id,
    key,
    visibility: "private",
    expiresInSeconds,
    ...(options.downloadFileName && {
      downloadFileName: options.downloadFileName,
    }),
  });
  return {
    url,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  };
}

/** Attach an uploaded object to the feature document that uses it. Runs in the
 * caller's tenant transaction, so the link commits or rolls back with the
 * document. An object links once, only to a kind of its own purpose, and only
 * by the user who uploaded it: nobody can move someone else's file into a
 * document they control (which would change who may read it), and only at
 * the document's outlet. Rows with no owner (before 0177, or a system render)
 * never link. */
export async function linkStorageObjectSource(
  tx: Transaction,
  link: {
    tenantId: string;
    objectId: string;
    sourceKind: StorageSourceKind;
    sourceId: string;
    /** Verified user doing the link; must be the object's current owner. */
    actorUserId: string;
    /** New owner (the subject, e.g. the employee); kept when omitted. */
    ownerUserId?: string;
    /** The outlet the document lives at; the object must be stored there, so
     * the reviewers of that outlet are the ones who can read it. */
    outletId: string;
  },
) {
  const updated = await tx
    .update(coreStorageObjects)
    .set({
      sourceKind: link.sourceKind,
      sourceId: link.sourceId,
      ...(link.ownerUserId ? { ownerUserId: link.ownerUserId } : {}),
    })
    .where(
      and(
        eq(coreStorageObjects.tenantId, link.tenantId),
        eq(coreStorageObjects.id, link.objectId),
        eq(
          coreStorageObjects.purpose,
          storageSourceKindPurpose[link.sourceKind],
        ),
        isNull(coreStorageObjects.sourceId),
        eq(coreStorageObjects.outletId, link.outletId),
        eq(coreStorageObjects.ownerUserId, link.actorUserId),
        or(
          isNull(coreStorageObjects.sourceKind),
          eq(coreStorageObjects.sourceKind, link.sourceKind),
        ),
      ),
    )
    .returning({ id: coreStorageObjects.id });
  if (!updated.length)
    throw new CoreError(
      "VALIDATION_ERROR",
      "The file cannot be attached here.",
    );
}
