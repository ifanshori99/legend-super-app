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
  "brand_logo",
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
  // Tenant-level asset: no outlet, no source kind, public like menu photos.
  brand_logo: { visibility: "public", maxBytes: 2 * 1024 * 1024 },
} as const satisfies Record<
  StoragePurpose,
  { visibility: "public" | "private"; maxBytes: number }
>;

/** The feature document a stored object belongs to (bead legend-pszrm).
 * Read access is decided per kind: an invoice matcher does not read a
 * reimbursement receipt. Keep in sync with the `core_storage_objects`
 * source_kind check constraint. */
export const storageSourceKindSchema = z.enum([
  "purchase_invoice",
  "goods_receipt",
  "expense",
  "cash_deposit",
  "reimbursement",
  "attendance",
  "employee_document",
  "employment_contract",
  "leave_request",
  "menu_item",
  "petty_purchase",
  "waste_log",
  "cleaning_task",
  "maintenance_ticket",
  "checklist_evidence",
]);
export type StorageSourceKind = z.infer<typeof storageSourceKindSchema>;

/** The purpose each source kind belongs to. */
export const storageSourceKindPurpose = {
  purchase_invoice: "receipt",
  goods_receipt: "receipt",
  expense: "receipt",
  cash_deposit: "receipt",
  reimbursement: "receipt",
  attendance: "selfie",
  employee_document: "document",
  employment_contract: "document",
  leave_request: "document",
  menu_item: "menu_photo",
  petty_purchase: "receipt",
  // Private photo evidence, using the existing receipt image transport (10 MiB).
  waste_log: "receipt",
  // Facility screens: private evidence photos (checklist also a signature PNG).
  cleaning_task: "receipt",
  maintenance_ticket: "receipt",
  checklist_evidence: "receipt",
} as const satisfies Record<StorageSourceKind, StoragePurpose>;

/** Kind used when an upload names none: only purposes with one obvious kind.
 * A receipt or document without a kind stays unclassified (strict reads). */
export const storageDefaultSourceKind: Partial<
  Record<StoragePurpose, StorageSourceKind>
> = { selfie: "attendance", menu_photo: "menu_item" };

/** Multipart metadata fields. The required binary field is named `file`;
 * enforce its byte limit while reading the multipart stream, before buffering.
 * Tenant identity and the owner are always minted from the authenticated
 * server context. `outletId` is absent exactly for the tenant-level
 * `brand_logo` purpose (multipart cannot send null); every other purpose
 * needs an outlet. */
export const uploadStorageMetadataSchema = z
  .strictObject({
    purpose: storagePurposeSchema,
    outletId: outletIdSchema.optional(),
    sourceKind: storageSourceKindSchema.optional(),
  })
  .refine(
    (input) =>
      input.sourceKind === undefined ||
      storageSourceKindPurpose[input.sourceKind] === input.purpose,
    { path: ["sourceKind"], message: "The kind does not match the purpose." },
  )
  .refine(
    (input) =>
      (input.purpose === "brand_logo") === (input.outletId === undefined),
    {
      path: ["outletId"],
      message:
        "A brand logo has no outlet; every other purpose needs an outlet.",
    },
  );
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

/** What the upload pipeline accepts right now. `documentsAccepted` is false
 * while no malware scanner that handles PDFs is wired, so screens offer photos
 * only. It reads configuration, never the scanner's health. */
export const storageCapabilitiesSchema = z.strictObject({
  documentsAccepted: z.boolean(),
});
export type StorageCapabilities = z.infer<typeof storageCapabilitiesSchema>;
export const getStorageCapabilities = defineEndpoint({
  method: "GET",
  path: "/api/storage/capabilities",
  response: dataResponseSchema(storageCapabilitiesSchema),
});
