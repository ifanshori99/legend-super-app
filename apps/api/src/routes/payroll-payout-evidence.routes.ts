// Upload of a resolve/return payment proof (bead legend-zoqh1), plus its read
// path and the list of proposals waiting for a second person (legend-t58lr).
// One multipart `file` part plus an optional `password` field (the same
// step-up as resolve, legend-dz8g3); the object storage and the malware scanner are required, so the
// router answers 503 before multer buffers anything when either is missing.
// Mounted at `/api/hris/payroll` by `createStorageApiRouter`, for its own path
// only. It changes no batch or item: the returned `evidenceKey` goes into
// resolve or return. The two GET routes only read and need the same
// `payroll.disburse.approve` as the second step they inform.

import { Router, type RequestHandler } from "express";
import multer from "multer";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  PAYOUT_EVIDENCE_MAX_BYTES,
  payoutBatchParamsSchema,
  payoutEvidenceReadQuerySchema,
} from "@starter/shared/validators/payroll-payout";
import { HttpError } from "../lib/http-error.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  requireTenantStepUpMfa,
  requireTenantStepUpPassword,
} from "../middleware/identity.ts";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import type { MalwareScanner } from "../services/core-image.ts";
import { PAYOUT_STEP_UP_MAX_AGE_MINUTES } from "../services/payroll-payout-evidence.ts";
import {
  listPayoutProposals,
  readPayoutEvidence,
} from "../services/payroll-payout-evidence-read.service.ts";
import { uploadPayoutEvidence } from "../services/payroll-payout-evidence-upload.service.ts";

/** Only this path enters the router (it runs the session guards on each request it sees). */
export const PAYROLL_PAYOUT_EVIDENCE_PATH =
  /^\/disbursement-batches\/[^/]+\/(?:evidence|resolution-proposals)$/;

// Same recent second factor as resolve and return, whose proof this stores.
const stepUp = requireTenantStepUpMfa({
  maxAgeMinutes: PAYOUT_STEP_UP_MAX_AGE_MINUTES,
});
// Same password gate as resolve (legend-dz8g3); reads the multipart `password`
// field, so it runs after the upload is parsed.
const passwordStepUp = requireTenantStepUpPassword();

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
      // One text field: `password`, for the step-up (legend-dz8g3).
      fields: 1,
      fieldSize: 1024,
      parts: 2,
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
    passwordStepUp,
    async (req, res) => {
      const { id } = payoutBatchParamsSchema.parse(req.params);
      if (!req.file)
        throw new HttpError(422, "VALIDATION_ERROR", "A file is required.");
      const data = await uploadPayoutEvidence(
        getScopedTenantContext(req),
        id,
        req.file.buffer,
        {
          storage: storage(),
          scanner: scanner(),
          userId: getAuth(req).user.id,
        },
      );
      res.status(201).json({ data });
    },
  );

  // Read path: a short-lived signed URL for one proof of THIS batch. No step-up:
  // it moves no money. A key of another batch or tenant is 422, an unknown one 404.
  router.get(
    "/disbursement-batches/:id/evidence",
    requireAuth,
    requireTenantContext,
    requireTenantPermission("payroll.disburse.approve"),
    async (req, res) => {
      const { id } = payoutBatchParamsSchema.parse(req.params);
      const { key } = payoutEvidenceReadQuerySchema.parse(req.query);
      const data = await readPayoutEvidence(
        getScopedTenantContext(req),
        id,
        key,
        { storage: storage() },
      );
      res.set("Cache-Control", "no-store").json({ data });
    },
  );

  // Proposals waiting for the second person: outcome, proof key, proposer, time.
  router.get(
    "/disbursement-batches/:id/resolution-proposals",
    requireAuth,
    requireTenantContext,
    requireTenantPermission("payroll.disburse.approve"),
    async (req, res) => {
      const { id } = payoutBatchParamsSchema.parse(req.params);
      const data = await listPayoutProposals(getScopedTenantContext(req), id);
      res.set("Cache-Control", "no-store").json({ data });
    },
  );

  return router;
}
