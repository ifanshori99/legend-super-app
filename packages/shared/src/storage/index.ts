// Storage HTTP contracts (PRD v1.7 §2, §5 and §7). Uploads are mediated by
// the API so that scanning, byte validation and image processing precede S3.
import {
  z,
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  uuidIdSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";

export const storagePurposeSchema = z.enum([
  "menu_photo",
  "selfie",
  "document",
  "receipt",
]);
export type StoragePurpose = z.infer<typeof storagePurposeSchema>;
export const storageObjectIdSchema = uuidIdSchema<"StorageObjectId">();
export const storageVariantSchema = z.enum(["original", "thumbnail"]);
export type StorageVariant = z.infer<typeof storageVariantSchema>;

// Coordinator-authorized defaults: uploads are bounded at 10 MiB overall;
// personal documents are never public. Limits are bytes, not decimal MB.
export const storagePurposePolicy = {
  menu_photo: { visibility: "public", maxBytes: 5 * 1024 * 1024 },
  selfie: { visibility: "private", maxBytes: 5 * 1024 * 1024 },
  document: { visibility: "private", maxBytes: 10 * 1024 * 1024 },
  receipt: { visibility: "private", maxBytes: 10 * 1024 * 1024 },
} as const satisfies Record<
  StoragePurpose,
  { visibility: "public" | "private"; maxBytes: number }
>;

/** Multipart metadata fields. The required binary field is named `file`;
 * enforce its byte limit while reading the multipart stream, before buffering.
 * Tenant identity is always minted from the authenticated server context. */
export const uploadStorageMetadataSchema = z.strictObject({
  purpose: storagePurposeSchema,
  outletId: outletIdSchema,
});
export type UploadStorageMetadata = z.infer<typeof uploadStorageMetadataSchema>;
export const storageObjectSchema = z.strictObject({
  id: storageObjectIdSchema,
  purpose: storagePurposeSchema,
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  publicUrl: z.url().nullable(),
  thumbnailUrl: z.url().nullable(),
});
export type StorageObject = z.infer<typeof storageObjectSchema>;
export const signedStorageUrlBodySchema = z.strictObject({
  variant: storageVariantSchema.default("original"),
});
export const signedStorageUrlSchema = z.strictObject({
  url: z.url(),
  expiresAt: isoDateTimeSchema,
});
export const uploadStorageObject = defineEndpoint({
  method: "POST",
  path: "/api/storage/uploads",
  body: uploadStorageMetadataSchema,
  response: dataResponseSchema(storageObjectSchema),
});
export const createStorageSignedUrl = defineEndpoint({
  method: "POST",
  path: "/api/storage/objects/:objectId/signed-url",
  params: z.strictObject({ objectId: storageObjectIdSchema }),
  body: signedStorageUrlBodySchema,
  response: dataResponseSchema(signedStorageUrlSchema),
});
