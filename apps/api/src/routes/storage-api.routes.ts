import { Router, type RequestHandler } from "express";
import multer from "multer";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ObjectStorage } from "@starter/shared/adapters";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import {
  storageObjectSchema,
  uploadStorageMetadataSchema,
} from "@starter/shared/storage";
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";
import { verifyDeviceToken } from "../lib/device-token";
import { requireAuth } from "../middleware/auth";
import { noStore } from "../middleware/no-store";
import { requireTrustedOrigin } from "../middleware/origin";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import {
  createSelfieUploadScanner,
  NoopMalwareScanner,
  type MalwareScanner,
} from "../services/core-image";
import { createCoreStorageRouterWithAccess } from "../services/core-storage-access";
import {
  authorizePinProofUpload,
  uploadEdgeSelfie,
  type PinProofUpload,
} from "../services/edge-selfie.service";
import { PIN_PROOF_HEADER } from "../services/staff-pin-proof.service";
import type { MessagingProvider } from "@starter/shared/adapters";
import type { StorageRuntime } from "../services/core-storage-runtime";
import type * as schema from "../db/schema";
import { createEdgeSelfieReceiveRouter } from "./edge-selfie-receive.routes";
import { createAccountingTaxFileRouter } from "./accounting.routes";
import { createHrisAttendanceAdminRouter } from "./hris-attendance-admin.routes";
import { createHrisAttendanceRouter } from "./hris-attendance.routes";
import { createHrisLeaveRouter } from "./hris-leave.routes";
import { createHrisPayslipRouter } from "./hris-payslip.routes";
import { createHrisRouter } from "./hris.routes";
import { createMenuImportRouter } from "./menu-import.routes";
import { createMenuRouter } from "./menu.routes";
import {
  createPayrollExportRouter,
  PAYROLL_EXPORT_PATH,
} from "./payroll-export.routes";
import {
  createPayrollPayoutEvidenceRouter,
  PAYROLL_PAYOUT_EVIDENCE_PATH,
} from "./payroll-payout-evidence.routes";
import { createPublicSiteRouter } from "./public-site.routes";
import { createQrRouter } from "./qr.routes";
import { createShareholderDocumentsRouter } from "./shareholder-documents.routes";
import { createBrandLogoUrl } from "../services/guest-theme.service";
import { createMenuMediaUrls } from "../services/menu-media.service";
import { dbShareholderMembership } from "../services/profit-share-membership";

/**
 * First path segments of /api/hris owned by `hrisRouter` and `hrisLeaveRouter`
 * (`/me` is matched exactly, beside it). Keep in sync with their routes: a
 * test walks both route stacks and fails on a segment missing here.
 */
export const HRIS_SIGNED_SEGMENTS: ReadonlySet<string> = new Set([
  "employees",
  "employment-contracts",
  "org-units",
  "position-grades",
  "positions",
  "holidays",
  "leave",
  "overtime-formulas",
  "overtime-requests",
]);

/**
 * Exact `/me...` paths (lower case, no trailing slash) owned by `hrisRouter`:
 * the own employee row and the own attendance policy (legend-j06v).
 */
export const HRIS_OWNED_ME_PATHS: ReadonlySet<string> = new Set([
  "/me",
  "/me/attendance-policy",
]);

/**
 * The /api routes that need the object storage (legend-dzh9q): core-storage
 * upload and signed URL, plus the attendance routers that mint selfie URLs.
 * Mounted by createApp ahead of `apiRouter`. Without a runtime, uploads answer
 * 503 and attendance logs carry no photo URL; everything else is unaffected.
 */
export function createStorageApiRouter(options: {
  runtime: StorageRuntime | null;
  database: NodePgDatabase<typeof schema>;
  /** @deprecated Unused since legend-9h2oj: the PIN reset no longer sends a WhatsApp message. */
  messaging?: MessagingProvider | null;
}): Router {
  const { runtime, database } = options;
  const router = Router();
  router.use(noStore);

  // The core-storage router's own paths start with /storage and it requires a
  // session on every request it sees, so only hand it /storage/* requests.
  const storage = env.EDGE_MODE
    ? edgeStorageRouter(database, runtime?.scanner)
    : runtime
      ? createCoreStorageRouterWithAccess({
          database,
          storage: runtime.storage,
          scanner: runtime.scanner,
        })
      : unavailableStorageRouter();
  router.use((req, res, next) =>
    req.path.startsWith("/storage/") ? storage(req, res, next) : next(),
  );

  // Menu back office (legend-7nv1): the photo upload needs the storage and the
  // scanner. The menu router runs the auth guards on every /menu/* request,
  // as it did in apiRouter; the menu import router follows below.
  router.use(
    "/menu",
    createMenuRouter({
      storage: runtime?.storage ?? null,
      scanner: runtime?.scanner,
    }),
  );

  // Guest QR menu and public site menu (legend-tct6, legend-8qri): photo and
  // brand logo URLs come from the storage; without it they stay null.
  const resolveMediaUrls = createMenuMediaUrls(runtime?.storage ?? null);
  router.use(
    "/qr",
    createQrRouter({
      resolveMediaUrls,
      resolveLogoUrl: createBrandLogoUrl(runtime?.storage ?? null),
    }),
  );
  router.use("/public/site", createPublicSiteRouter(resolveMediaUrls));

  // Menu import + printable menu (legend-0w2wy): the print PDF is stored, so
  // it needs the storage and the scanner (a scanner that refuses documents
  // makes print answer 503 before any render or write). No PDF renderer is
  // deployed yet: print answers 503 until one is injected here. Only its own
  // paths enter the router, which runs the session and tenant guards on every
  // request it sees.
  const menuImport = createMenuImportRouter({
    storage: runtime?.storage ?? null,
    renderer: null,
    scanner: runtime?.scanner,
  });
  router.use("/menu", (req, res, next) =>
    req.path.startsWith("/import/") ||
    req.path === "/print" ||
    req.path.startsWith("/print/")
      ? menuImport(req, res, next)
      : next(),
  );

  // Edge selfie upload (legend-0wvoz): edge credential, no session. Only its
  // own prefix enters the router, so its pre-auth limiter never counts other
  // /api/edge-sync traffic. Needs the storage and the scanner (503 without).
  const edgeSelfies = createEdgeSelfieReceiveRouter({
    database,
    storage: runtime?.storage ?? null,
    scanner: runtime?.scanner ?? null,
  });
  router.use("/edge-sync/attendance-selfies", edgeSelfies);

  // Only attendance paths enter these routers: each runs the session and
  // tenant guards on every request it sees, which would double that work for
  // the other /hris routers that live in apiRouter.
  const attendance = Router();
  attendance.use(
    createHrisAttendanceRouter({ fileSigner: runtime?.fileSigner }),
    createHrisAttendanceAdminRouter({ signPhoto: runtime?.fileSigner }),
  );
  router.use("/hris", (req, res, next) =>
    req.path.startsWith("/attendance/") ? attendance(req, res, next) : next(),
  );

  // Payroll bank transfer file and Coretax PPh 21 export (legend-34qx): the
  // files go to the object storage. Only the three export paths enter.
  const payrollExport = createPayrollExportRouter({ runtime });
  router.use("/hris/payroll", (req, res, next) =>
    PAYROLL_EXPORT_PATH.test(req.path) ? payrollExport(req, res, next) : next(),
  );

  // Payout payment-proof upload (legend-zoqh1): the proof goes to the object
  // storage after a malware scan. Only its own path enters; resolve and return
  // stay in apiRouter.
  const payoutEvidence = createPayrollPayoutEvidenceRouter({
    storage: runtime?.storage ?? null,
    scanner: runtime?.scanner,
  });
  router.use("/hris/payroll", (req, res, next) =>
    PAYROLL_PAYOUT_EVIDENCE_PATH.test(req.path)
      ? payoutEvidence(req, res, next)
      : next(),
  );

  // Tax report export and download (legend-5nhkp) mint or read stored files.
  // Only those two paths enter this router; the rest of /accounting stays in
  // apiRouter.
  const taxFiles = createAccountingTaxFileRouter({ runtime });
  router.use("/accounting", (req, res, next) =>
    /^\/tax-reports\/[^/]+\/(export|download)$/.test(req.path)
      ? taxFiles(req, res, next)
      : next(),
  );

  // Shareholder documents (legend-68if): upload and signed URL need the storage
  // and the scanner (503 without), and the membership is the real one (approved
  // share allocation). The router guards only its own resource path, so other
  // /accounting requests pass straight on.
  router.use(
    "/accounting",
    createShareholderDocumentsRouter({
      storage: runtime?.storage ?? null,
      scanner: runtime?.scanner ?? null,
      membership: dbShareholderMembership,
    }),
  );

  // HRIS employees, contracts, documents, leave, overtime and holidays mint
  // private document URLs (legend-2ect), so they are mounted here with the
  // runtime's signer instead of as static routers in apiRouter. Same rule as
  // above: only their own first path segments enter, so the guards run once
  // per request. The payroll routers that own /hris/payroll/*, /hris/me/loans
  // and /hris/me/reimbursements live in apiRouter, mounted after this router.
  // They do not collide: their segments never overlap the ones below (`me` is
  // matched exactly).
  // Employee payslips and the payslip PIN (legend-2ap3). The router guards
  // only its own paths (/me/payslips, /me/payslip-pin,
  // /employees/:id/payslip-pin), so other /hris requests pass straight on.
  // The PIN reset runs through an inbound WhatsApp message (legend-9h2oj): the
  // API sends nothing, so it needs no messaging provider.
  router.use(
    "/hris",
    createHrisPayslipRouter({
      fileSigner: runtime?.hrisDocumentSigner,
    }),
  );

  const hris = Router();
  hris.use(
    createHrisRouter({ fileSigner: runtime?.hrisDocumentSigner }),
    createHrisLeaveRouter({
      fileSigner: runtime?.hrisDocumentSigner,
      storage: runtime?.storage,
      scanner: runtime?.scanner,
    }),
  );
  router.use("/hris", (req, res, next) => {
    // Express routes case-insensitively, so the gate must too.
    const segment = req.path.split("/").filter(Boolean)[0]?.toLowerCase();
    const owned =
      segment !== undefined &&
      (HRIS_SIGNED_SEGMENTS.has(segment) ||
        (segment === "me" &&
          HRIS_OWNED_ME_PATHS.has(req.path.replace(/\/+$/, "").toLowerCase())));
    return owned ? hris(req, res, next) : next();
  });
  return router;
}

/**
 * The edge has no object storage. Its only upload is the selfie, sealed to the
 * cloud key and written to EDGE_SELFIE_DIR (legend-we0yc); every other purpose
 * answers 503 and no signed URL exists, so the storage port refuses all calls.
 */
function edgeStorageRouter(
  database: NodePgDatabase<typeof schema>,
  scanner: MalwareScanner = new NoopMalwareScanner(),
): Router {
  const refuse = (): never => {
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan berkas tidak tersedia di edge.",
    );
  };
  const sessionUpload = createCoreStorageRouterWithAccess({
    database,
    storage: {
      put: refuse,
      delete: refuse,
      publicUrl: refuse,
      signedGetUrl: refuse,
    } as unknown as ObjectStorage,
    scanner,
    upload: (db, context, metadata, bytes, deps) =>
      uploadEdgeSelfie(db, context, metadata, bytes, {
        authorize: deps.authorize,
        actorUserId: deps.actorUserId as string,
        scanner: deps.scanner,
        dir: env.EDGE_SELFIE_DIR,
        maxBytes: env.EDGE_SELFIE_MAX_BYTES,
      }),
  });
  // A request carrying X-Pin-Proof takes the proof path (no session); every
  // other request keeps the session behaviour of the core-storage router.
  const proofUpload = pinProofUploadRouter(database, scanner);
  const router = Router();
  router.post("/storage/uploads", (req, res, next) =>
    req.get(PIN_PROOF_HEADER) === undefined
      ? next()
      : proofUpload(req, res, next),
  );
  router.use(sessionUpload);
  return router;
}

/**
 * POST /storage/uploads with X-Pin-Proof (legend-u7g9w): the outlet attendance
 * screen uploads the selfie right after the PIN check, with no session. The
 * device token and the proof are checked BEFORE the multipart body is read, so
 * an anonymous caller cannot make the edge buffer an image. The owner, the
 * outlet and `pin_proof_id` come from the proof and the device, never from the
 * client; only the purpose `selfie` is served. The proof is not consumed here.
 */
function pinProofUploadRouter(
  database: NodePgDatabase<typeof schema>,
  scanner: MalwareScanner,
): Router {
  const router = Router();
  const selfieScanner = createSelfieUploadScanner(scanner);
  const proofs = new WeakMap<object, PinProofUpload>();
  const authenticate: RequestHandler = async (req, _res, next) => {
    const raw = req.get(DEVICE_TOKEN_HEADER);
    proofs.set(
      req,
      await authorizePinProofUpload(
        database,
        getTenantContext(req),
        raw ? verifyDeviceToken(raw) : null,
        req.get(PIN_PROOF_HEADER) ?? "",
        new Date(),
      ),
    );
    next();
  };
  const multipart = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
      fields: 3,
      parts: 4,
      fieldSize: 256,
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
        const oversized =
          error.code === "LIMIT_FILE_SIZE" ||
          error.code === "LIMIT_FIELD_VALUE";
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
    "/storage/uploads",
    requireTenantContext,
    authenticate,
    parseUpload,
    async (req, res) => {
      const proof = proofs.get(req)!;
      const metadata = uploadStorageMetadataSchema.parse(req.body);
      if (metadata.purpose !== "selfie")
        throw new HttpError(
          503,
          "SERVICE_UNAVAILABLE",
          "Hanya selfie yang bisa diunggah di edge.",
        );
      if (!req.file)
        throw new HttpError(422, "VALIDATION_ERROR", "A file is required.");
      const data = await uploadEdgeSelfie(
        database,
        proof.context,
        // The outlet is the device's, whatever the client sent.
        { ...metadata, outletId: proof.outletId },
        req.file.buffer,
        {
          authorize: proof.authorize,
          actorUserId: proof.userId,
          pinProofId: proof.proofId,
          scanner: selfieScanner,
          dir: env.EDGE_SELFIE_DIR,
          maxBytes: env.EDGE_SELFIE_MAX_BYTES,
        },
      );
      res.status(201).json({ data: storageObjectSchema.parse(data) });
    },
  );
  return router;
}

function unavailableStorageRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, () => {
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan berkas belum tersedia.",
    );
  });
  return router;
}
