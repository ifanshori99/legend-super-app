// Payout payment-proof upload (bead legend-zoqh1; design
// docs/design/payroll-disbursement.md 7.7). The proof is stored first, then
// its key goes into resolve or return as `evidenceKey`. This service changes
// no batch or item row: it only checks the batch is the caller's and stores
// the scanned bytes as a private object inside that batch's folder:
// `tenants/<tenantId>/payroll-payout/<batchId>/<uuid>.<pdf|jpg|png>`.
// The type comes from the bytes, never from what the client declares. Only a
// manual bank batch in a state where resolve or return can run takes a proof.
// JPEG and PNG are decoded and re-encoded (metadata such as EXIF/GPS dropped);
// the stored bytes and `sizeBytes` are the re-encoded ones. PDF is stored as is.
// Fingerprint (legend-w3691): the SHA-256 of the ORIGINAL uploaded bytes goes
// into `payroll_payout_evidence_files` BEFORE the object is stored, in its own
// tenant transaction. A failed insert refuses the upload, so a stored proof
// never lacks its fingerprint; a fingerprint without an object (the put
// failed) is harmless. A return claim reads it to refuse the same file content
// under a new key (payroll-payout-manual.service.ts).

import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  PAYOUT_EVIDENCE_MAX_BYTES,
  type PayoutEvidenceContentType,
} from "@starter/shared/validators/payroll-payout";
import type { PayrollPayoutEvidenceUploadDto } from "@starter/shared/types";
import { db } from "../db/index.ts";
import {
  payrollDisbursementBatches,
  payrollPayoutEvidenceFiles,
} from "../db/schema/payroll-payout.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { scanUploadBytes, type MalwareScanner } from "./core-image.ts";
import { assertEvidenceKeyForBatch } from "./payroll-payout-evidence.ts";

const KINDS: Record<
  PayoutEvidenceContentType,
  { extension: "pdf" | "jpg" | "png"; magic: readonly number[] }
> = {
  "application/pdf": {
    extension: "pdf",
    magic: [0x25, 0x50, 0x44, 0x46, 0x2d],
  },
  "image/jpeg": { extension: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/png": {
    extension: "png",
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
};

// Batch states where resolve (exported) or return (paid items exist) can run.
const EVIDENCE_BATCH_STATUSES: readonly string[] = [
  "exported",
  "completed",
  "partially_failed",
];

/** Decode and re-encode in the sniffed format; drops EXIF/GPS and other metadata. */
async function reencodeImage(
  bytes: Uint8Array,
  contentType: "image/jpeg" | "image/png",
): Promise<Uint8Array> {
  const invalid = () =>
    new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Gambar bukti tidak bisa dibaca.",
    );
  try {
    const image = sharp(Buffer.from(bytes), {
      limitInputPixels: 50_000_000,
      failOn: "error",
    });
    const metadata = await image.metadata();
    const format = contentType === "image/jpeg" ? "jpeg" : "png";
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1)
      throw invalid();
    const pipeline = image.rotate();
    const out = await (
      format === "jpeg" ? pipeline.jpeg({ quality: 90 }) : pipeline.png()
    ).toBuffer();
    return new Uint8Array(out);
  } catch (error) {
    throw error instanceof HttpError ? error : invalid();
  }
}

function sniffContentType(bytes: Uint8Array): PayoutEvidenceContentType | null {
  for (const [type, kind] of Object.entries(KINDS))
    if (kind.magic.every((byte, index) => bytes[index] === byte))
      return type as PayoutEvidenceContentType;
  return null;
}

export async function uploadPayoutEvidence(
  context: ScopedTenantContext,
  batchId: string,
  bytes: Uint8Array,
  deps: {
    storage: ObjectStorage;
    scanner: MalwareScanner;
    /** Verified user id of the uploader (the route always passes it). */
    userId?: string;
  },
): Promise<PayrollPayoutEvidenceUploadDto> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  if (bytes.byteLength === 0)
    throw new HttpError(422, "VALIDATION_ERROR", "Berkas bukti kosong.");
  if (bytes.byteLength > PAYOUT_EVIDENCE_MAX_BYTES)
    throw new HttpError(
      413,
      "PAYLOAD_TOO_LARGE",
      "Berkas bukti terlalu besar (maksimal 5 MB).",
    );
  const contentType = sniffContentType(bytes);
  if (!contentType)
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Bukti harus berupa PDF, JPEG, atau PNG.",
    );
  // Before any blob is stored: no such batch in this tenant is the same 404 as
  // another tenant's batch.
  const [batch] = await withTenant(db, context, (tx) =>
    tx
      .select({
        id: payrollDisbursementBatches.id,
        channel: payrollDisbursementBatches.channel,
        status: payrollDisbursementBatches.status,
      })
      .from(payrollDisbursementBatches)
      .where(
        and(
          eq(payrollDisbursementBatches.tenantId, tenantId),
          eq(payrollDisbursementBatches.id, batchId),
        ),
      ),
  );
  if (!batch)
    throw new HttpError(
      404,
      "PAYOUT_BATCH_NOT_FOUND",
      "Batch pembayaran tidak ditemukan.",
    );
  if (batch.channel !== "manual_bank")
    throw new HttpError(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Bukti hanya untuk batch transfer bank manual.",
    );
  if (!EVIDENCE_BATCH_STATUSES.includes(batch.status))
    throw new HttpError(
      409,
      "PAYOUT_BATCH_NOT_EXPORTED",
      "Batch ini belum di tahap yang menerima bukti.",
    );
  // Scanner capability, PDF structure and malware scan, before any blob is
  // stored (legend-egrrp). A detection or an unsafe PDF is a 422 with this
  // module's own code and message; an unavailable scanner or checker is a 503.
  try {
    await scanUploadBytes(bytes, {
      kind: contentType === "application/pdf" ? "pdf" : "image",
      scanner: deps.scanner,
      maxBytes: PAYOUT_EVIDENCE_MAX_BYTES,
      tenantKey: tenantId,
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 422)
      throw new HttpError(
        422,
        "PAYOUT_EVIDENCE_REJECTED",
        "Berkas bukti ditolak pemindai. Unggah berkas lain.",
      );
    throw error;
  }
  const stored =
    contentType === "application/pdf"
      ? bytes
      : await reencodeImage(bytes, contentType);
  if (stored.byteLength > PAYOUT_EVIDENCE_MAX_BYTES)
    throw new HttpError(
      413,
      "PAYLOAD_TOO_LARGE",
      "Berkas bukti terlalu besar (maksimal 5 MB).",
    );
  const id = randomUUID();
  const evidenceKey = assertEvidenceKeyForBatch(
    { tenantId, batchId: batch.id },
    `tenants/${tenantId}/payroll-payout/${batch.id}/${id}.${KINDS[contentType].extension}`,
  );
  // Fingerprint first: if this insert fails the upload is refused and no
  // object exists, so a stored proof can never be used without a fingerprint.
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  await withTenant(db, context, (tx) =>
    tx.insert(payrollPayoutEvidenceFiles).values({
      tenantId,
      batchId: batch.id,
      evidenceKey,
      contentSha256,
      createdBy: (deps.userId ?? "system") as UserId,
    }),
  );
  await deps.storage.put(context, {
    tenantId,
    outletId: null,
    reference: id,
    key: evidenceKey,
    contentType,
    content: new Uint8Array(stored),
    visibility: "private",
  });
  return { evidenceKey, contentType, sizeBytes: stored.byteLength };
}
