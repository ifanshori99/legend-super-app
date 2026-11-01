import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  storagePurposePolicy,
  storagePurposeSchema,
  uploadStorageMetadataSchema,
  type StoragePurpose,
  type UploadStorageMetadata,
} from "@starter/shared/storage";
import type * as schema from "../db/schema";
import { coreStorageObjects } from "../db/schema/core-storage";
import { withTenant } from "../db/tenant";
import { processImage, type MalwareScanner } from "./core-image";
import { HttpError } from "../lib/http-error";

type Database = NodePgDatabase<typeof schema>;
type Authorization = (
  action: "upload" | "read",
  purpose: StoragePurpose,
  outletId: string,
  objectId?: string,
) => Promise<boolean>;
type Dependencies = {
  storage: ObjectStorage;
  scanner: MalwareScanner;
  authorize: Authorization;
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
  assertOutletInScope(context.outletScope, input.outletId);
  if (!(await deps.authorize("upload", input.purpose, input.outletId)))
    throw new CoreError("FORBIDDEN", "Permission denied.");
  const policy = storagePurposePolicy[input.purpose];
  if (!bytes.byteLength || bytes.byteLength > policy.maxBytes)
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Invalid upload size.");
  const id = randomUUID();
  const base = {
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
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
    await deps.scanner.scan(bytes);
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
        outletId: input.outletId,
        id,
        purpose: input.purpose,
        objectKey: key,
        thumbnailKey,
        contentType,
        sizeBytes: full.byteLength,
        width,
        height,
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
) {
  assertTrustedScopedContext(context);
  const row = await withTenant(
    database,
    context,
    async (tx) =>
      (
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
      )[0],
  );
  if (!row) throw new CoreError("NOT_FOUND", "Object not found.");
  const outletId = outletIdSchema.parse(row.outletId);
  assertOutletInScope(context.outletScope, outletId);
  const purpose = storagePurposeSchema.parse(row.purpose);
  if (
    storagePurposePolicy[purpose].visibility !== "private" ||
    !(await deps.authorize("read", purpose, outletId, id))
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
  });
  return {
    url,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  };
}
