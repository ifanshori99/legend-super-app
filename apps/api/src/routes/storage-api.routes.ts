import { Router } from "express";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ObjectStorage } from "@starter/shared/adapters";
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";
import { requireAuth } from "../middleware/auth";
import { noStore } from "../middleware/no-store";
import { requireTrustedOrigin } from "../middleware/origin";
import { NoopMalwareScanner } from "../services/core-image";
import { createCoreStorageRouterWithAccess } from "../services/core-storage-access";
import { uploadEdgeSelfie } from "../services/edge-selfie.service";
import type { MessagingProvider } from "@starter/shared/adapters";
import { createPayslipPinWhatsappSender } from "../services/payslip-pin-whatsapp-sender";
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
 * The /api routes that need the object storage (legend-dzh9q): core-storage
 * upload and signed URL, plus the attendance routers that mint selfie URLs.
 * Mounted by createApp ahead of `apiRouter`. Without a runtime, uploads answer
 * 503 and attendance logs carry no photo URL; everything else is unaffected.
 */
export function createStorageApiRouter(options: {
  runtime: StorageRuntime | null;
  database: NodePgDatabase<typeof schema>;
  /** Sends the payslip PIN reset code by WhatsApp (legend-qih2m). Null: that reset answers 503. */
  messaging?: MessagingProvider | null;
}): Router {
  const { runtime, database, messaging = null } = options;
  const router = Router();
  router.use(noStore);

  // The core-storage router's own paths start with /storage and it requires a
  // session on every request it sees, so only hand it /storage/* requests.
  const storage = env.EDGE_MODE
    ? edgeStorageRouter(database)
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

  // Tax report export and download (legend-5nhkp) mint or read stored files.
  // Only those two paths enter this router; the rest of /accounting stays in
  // apiRouter.
  const taxFiles = createAccountingTaxFileRouter({ runtime });
  router.use("/accounting", (req, res, next) =>
    /^\/tax-reports\/[^/]+\/(export|download)$/.test(req.path)
      ? taxFiles(req, res, next)
      : next(),
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
  // The OTP reset sends its code through the messaging provider (legend-qih2m);
  // without one it answers 503.
  router.use(
    "/hris",
    createHrisPayslipRouter({
      fileSigner: runtime?.hrisDocumentSigner,
      otpSender: messaging ? createPayslipPinWhatsappSender(messaging) : null,
    }),
  );

  const hris = Router();
  hris.use(
    createHrisRouter({ fileSigner: runtime?.hrisDocumentSigner }),
    createHrisLeaveRouter({ fileSigner: runtime?.hrisDocumentSigner }),
  );
  router.use("/hris", (req, res, next) => {
    // Express routes case-insensitively, so the gate must too.
    const segment = req.path.split("/").filter(Boolean)[0]?.toLowerCase();
    const owned =
      segment !== undefined &&
      (HRIS_SIGNED_SEGMENTS.has(segment) ||
        (segment === "me" &&
          req.path.replace(/\/+$/, "").toLowerCase() === "/me"));
    return owned ? hris(req, res, next) : next();
  });
  return router;
}

/**
 * The edge has no object storage. Its only upload is the selfie, sealed to the
 * cloud key and written to EDGE_SELFIE_DIR (legend-we0yc); every other purpose
 * answers 503 and no signed URL exists, so the storage port refuses all calls.
 */
function edgeStorageRouter(database: NodePgDatabase<typeof schema>): Router {
  const refuse = (): never => {
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan berkas tidak tersedia di edge.",
    );
  };
  return createCoreStorageRouterWithAccess({
    database,
    storage: {
      put: refuse,
      delete: refuse,
      publicUrl: refuse,
      signedGetUrl: refuse,
    } as unknown as ObjectStorage,
    scanner: new NoopMalwareScanner(),
    upload: (db, context, metadata, bytes, deps) =>
      uploadEdgeSelfie(db, context, metadata, bytes, {
        authorize: deps.authorize,
        actorUserId: deps.actorUserId as string,
        scanner: deps.scanner,
        dir: env.EDGE_SELFIE_DIR,
        maxBytes: env.EDGE_SELFIE_MAX_BYTES,
      }),
  });
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
