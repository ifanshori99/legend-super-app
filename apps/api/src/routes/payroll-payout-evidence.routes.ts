// Upload of a resolve/return payment proof (bead legend-zoqh1). One multipart
// `file` part; the object storage and the malware scanner are required, so the
// router answers 503 before multer buffers anything when either is missing.
// Mounted at `/api/hris/payroll` by `createStorageApiRouter`, for its own path
// only. It changes no batch or item: the returned `evidenceKey` goes into
// resolve or return.

import { Router, type RequestHandler } from "express";
import multer from "multer";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  PAYOUT_EVIDENCE_MAX_BYTES,
  payoutBatchParamsSchema,
} from "@starter/shared/validators/payroll-payout";
import { HttpError } from "../lib/http-error.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireTenantStepUpMfa } from "../middleware/identity.ts";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import type { MalwareScanner } from "../services/core-image.ts";
import { PAYOUT_STEP_UP_MAX_AGE_MINUTES } from "../services/payroll-payout-evidence.ts";
import { uploadPayoutEvidence } from "../services/payroll-payout-evidence-upload.service.ts";

/** Only this path enters the router (it runs the session guards on each request it sees). */
export const PAYROLL_PAYOUT_EVIDENCE_PATH =
  /^\/disbursement-batches\/[^/]+\/evidence$/;

// Same recent second factor as resolve and return, whose proof this stores.
const stepUp = requireTenantStepUpMfa({
  maxAgeMinutes: PAYOUT_STEP_UP_MAX_AGE_MINUTES,
});

export function createPayrollPayoutEvidenceRouter(options: {
  storage?: ObjectStorage | null;
  scanner?: MalwareScanner | null;
}): Router {
  const router = Router();
  const storage = (): ObjectStorage => {
    if (!options.storage)
      throw new HttpError(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan berkas belum tersedia.",
      );
    return options.storage;
  };
  // Fail closed: uploads are never stored unscanned.
  const scanner = (): MalwareScanner => {
    if (!options.scanner)
      throw new HttpError(
        503,
        "SERVICE_UNAVAILABLE",
        "Pemindai malware belum tersedia.",
      );
    return options.scanner;
  };
  const multipart = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: PAYOUT_EVIDENCE_MAX_BYTES,
      files: 1,
      fields: 0,
      parts: 1,
    },
  }).single("file");
  const parseUpload: RequestHandler = (req, res, next) => {
    if (!req.is("multipart/form-data"))
      return next(
        new HttpError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Send multipart form data.",
        ),
      );
    multipart(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        const oversized = error.code === "LIMIT_FILE_SIZE";
        return next(
          new HttpError(
            oversized ? 413 : 422,
            oversized ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR",
            "Invalid upload.",
          ),
        );
      }
      if (error)
        return next(
          new HttpError(422, "VALIDATION_ERROR", "Invalid multipart upload."),
        );
      next();
    });
  };

  router.post(
    "/disbursement-batches/:id/evidence",
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
    requireTenantPermission("payroll.disburse.approve"),
    stepUp,
    // 503 before multer buffers up to 5 MiB when no storage or scanner is wired.
    (_req, _res, next) => {
      storage();
      scanner();
      next();
    },
    parseUpload,
    async (req, res) => {
      const { id } = payoutBatchParamsSchema.parse(req.params);
      if (!req.file)
        throw new HttpError(422, "VALIDATION_ERROR", "A file is required.");
      const data = await uploadPayoutEvidence(
        getScopedTenantContext(req),
        id,
        req.file.buffer,
        { storage: storage(), scanner: scanner() },
      );
      res.status(201).json({ data });
    },
  );

  return router;
}
