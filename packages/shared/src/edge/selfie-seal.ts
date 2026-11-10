// Sealed selfie contract (design docs/design/hris-edge-replication.md 5, 6.1).
// The edge seals each selfie to a cloud public key (format `LSS1`), keeps the
// sealed file, and uploads it with `PUT /api/edge-sync/attendance-selfies/:objectId`.
//
//   "LSS1" | u32 headerLen | header (JSON) | u16 wrappedKeyLen | wrappedKey
//          | iv(12) | ciphertext | tag(16)
//
// The header is plaintext routing data only; `meta` (who, where, when) sits
// inside the ciphertext. AAD = "LSS1" | headerLen | header.

import {
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";

export const LSS1_MAGIC = "LSS1";
export const SEALED_SHA256_HEADER = "X-Legend-Sealed-Sha256";
export const EDGE_SELFIE_SEALED_MAX_BYTES = 6 * 1024 * 1024;
export const EDGE_SELFIE_ALG = "RSA-OAEP-256+A256GCM";

export const lss1HeaderSchema = z.strictObject({
  v: z.literal(1),
  kid: z.string().min(1).max(64),
  alg: z.literal(EDGE_SELFIE_ALG),
  tenantId: tenantIdSchema,
  objectId: uuidSchema,
});
export type Lss1Header = z.infer<typeof lss1HeaderSchema>;

export const lss1MetaSchema = z.strictObject({
  outletId: outletIdSchema,
  ownerUserId: userIdSchema,
  contentType: z.literal("image/webp"),
  width: z.number().int().positive().max(20_000),
  height: z.number().int().positive().max(20_000),
  plainSha256: z.string().regex(/^[0-9a-f]{64}$/, "Lowercase SHA-256 hex"),
  createdAt: isoDateTimeSchema,
});
export type Lss1Meta = z.infer<typeof lss1MetaSchema>;

export const EDGE_SELFIE_PUT_PATH =
  "/api/edge-sync/attendance-selfies/:objectId";

export function edgeSelfieAttendanceSelfiePath(objectId: string): string {
  return `/api/edge-sync/attendance-selfies/${encodeURIComponent(objectId)}`;
}

/** Cloud PUT answers: 201 stored, 200 same hash again, 409 conflict, 403 scope, 413 size, 422 unseal, 400 hash, 503 unavailable. */
export const EDGE_SELFIE_PUT_STATUSES = [
  201, 200, 409, 403, 413, 422, 400, 503,
] as const;
export const edgeSelfiePutStatusSchema = z.union([
  z.literal(201),
  z.literal(200),
  z.literal(409),
  z.literal(403),
  z.literal(413),
  z.literal(422),
  z.literal(400),
  z.literal(503),
]);
export type EdgeSelfiePutStatus = z.infer<typeof edgeSelfiePutStatusSchema>;

/** Error codes with their HTTP status. 507 is answered by the edge itself. */
export const EDGE_SELFIE_ERROR_CODES = {
  OBJECT_ID_TAKEN: "OBJECT_ID_TAKEN",
  SELFIE_SEAL_KEY_MISSING: "SELFIE_SEAL_KEY_MISSING",
  EDGE_SELFIE_STORAGE_FULL: "EDGE_SELFIE_STORAGE_FULL",
  ATTENDANCE_METHOD_NOT_ON_EDGE: "ATTENDANCE_METHOD_NOT_ON_EDGE",
} as const;
export type EdgeSelfieErrorCode = keyof typeof EDGE_SELFIE_ERROR_CODES;

export const EDGE_SELFIE_ERROR_STATUS = {
  OBJECT_ID_TAKEN: 409,
  SELFIE_SEAL_KEY_MISSING: 503,
  EDGE_SELFIE_STORAGE_FULL: 507,
  ATTENDANCE_METHOD_NOT_ON_EDGE: 400,
} as const satisfies Record<EdgeSelfieErrorCode, number>;

export const EDGE_SELFIE_UPLOAD_STATES = [
  "pending",
  "uploaded",
  "rejected",
  "expired",
] as const;
export const edgeSelfieUploadStateSchema = z.enum(EDGE_SELFIE_UPLOAD_STATES);
export type EdgeSelfieUploadState = z.infer<typeof edgeSelfieUploadStateSchema>;
