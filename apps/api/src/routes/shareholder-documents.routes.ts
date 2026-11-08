// Shareholder documents HTTP routes (PRD v1.7 §3.35 Dokumen; SH-01; bead
// legend-69yq). Paths and schemas are the `@starter/shared/accounting` endpoint
// objects the FE client uses. Tenant comes from the server-minted context
// (TEN-02), never from params or bodies.
//
// - upload / create / publish: `profit_share.registry.manage` over the tenant;
// - list / signed URL: a manager sees every document, a shareholder
//   (`profit_share.own.view`) only published own ones; anyone else is denied.
//
// Mounted under /api/accounting before the accounting core router.

import { Router, type Request, type RequestHandler } from "express";
import multer from "multer";
import {
  createShareholderDocument,
  createShareholderDocumentSignedUrl,
  listShareholderDocuments,
  publishShareholderDocument,
  shareholderDocumentSchema,
  uploadShareholderDocumentFile,
} from "@starter/shared/accounting";
import { AccessError } from "@starter/shared/access";
import type { ObjectStorage } from "@starter/shared/adapters";
import { userIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { HttpError } from "../lib/http-error";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  loadRequestAccess,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  createShareholderDocumentService,
  failClosedShareholderMembership,
  listShareholderDocumentsService,
  publishShareholderDocumentService,
  shareholderDocumentSignedUrlService,
  uploadShareholderDocumentFileService,
  type ShareholderDocumentViewer,
  type ShareholderMembership,
} from "../services/shareholder-documents.service";
import type { MalwareScanner } from "../services/core-image";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

/** Manager first, then shareholder; no other caller reads documents. */
async function resolveViewer(req: Request): Promise<{
  context: ScopedTenantContext;
  viewer: ShareholderDocumentViewer;
}> {
  const snapshot = await loadRequestAccess(req);
  const manager = snapshot.contextFor("profit_share.registry.manage", {
    type: "tenant",
  });
  if (manager) return { context: manager, viewer: { kind: "manager" } };
  const shareholder = snapshot.contextFor("profit_share.own.view", {
    type: "tenant",
  });
  if (shareholder)
    return {
      context: shareholder,
      viewer: { kind: "shareholder", userId: getAuth(req).user.id },
    };
  throw new AccessError(
    "PERMISSION_DENIED",
    "Your account cannot perform this action in this tenant.",
  );
}

export function createShareholderDocumentsRouter(
  options: {
    storage?: ObjectStorage | null;
    scanner?: MalwareScanner | null;
    membership?: ShareholderMembership;
  } = {},
) {
  const router = Router();
  const membership = options.membership ?? failClosedShareholderMembership;
  const storage = (): ObjectStorage => {
    if (!options.storage)
      throw new HttpError(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan dokumen belum tersedia.",
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
  // Scoped to this resource: the router shares the /accounting mount with the
  // core and AP/FA routers, which run their own guards.
  router.use(
    route(listShareholderDocuments.path),
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
  );

  const manage = requireTenantPermission("profit_share.registry.manage");
  const multipart = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
      fields: 1,
      parts: 2,
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

  // Registered before the `:shareholderDocumentId` routes; the path differs
  // (`/files`), the method order keeps the intent obvious.
  router.post(
    route(uploadShareholderDocumentFile.path),
    manage,
    // 503 before multer buffers up to 10 MiB when no storage or scanner is wired.
    (_req, _res, next) => {
      storage();
      scanner();
      next();
    },
    parseUpload,
    async (req, res) => {
      const metadata = uploadShareholderDocumentFile.body.parse(req.body);
      if (!req.file)
        throw new HttpError(422, "VALIDATION_ERROR", "A file is required.");
      const data = await uploadShareholderDocumentFileService(
        getScopedTenantContext(req),
        actorId(req),
        metadata,
        req.file.buffer,
        { storage: storage(), scanner: scanner() },
      );
      res.status(201).json({ data });
    },
  );

  router.get(route(listShareholderDocuments.path), async (req, res) => {
    // Permission before validation: a caller without access gets 403, not 422.
    const { context, viewer } = await resolveViewer(req);
    const query = listShareholderDocuments.query.parse(req.query);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(
      await listShareholderDocumentsService(context, viewer, query, {
        membership,
      }),
    );
  });

  router.post(
    route(createShareholderDocument.path),
    manage,
    jsonBody,
    async (req, res) => {
      const input = createShareholderDocument.body.parse(req.body);
      const data = await createShareholderDocumentService(
        getScopedTenantContext(req),
        actorId(req),
        input,
      );
      res.status(201).json({ data: shareholderDocumentSchema.parse(data) });
    },
  );

  router.post(
    route(publishShareholderDocument.path),
    manage,
    jsonBody,
    async (req, res) => {
      const { shareholderDocumentId } = publishShareholderDocument.params.parse(
        req.params,
      );
      const body = publishShareholderDocument.body.parse(req.body);
      const data = await publishShareholderDocumentService(
        getScopedTenantContext(req),
        actorId(req),
        shareholderDocumentId,
        body,
      );
      res.json({ data: shareholderDocumentSchema.parse(data) });
    },
  );

  router.post(
    route(createShareholderDocumentSignedUrl.path),
    // Permission before body parsing: a caller without access gets 403, not
    // 415/400 from jsonBody.
    async (req, res, next) => {
      res.locals.shareholderAccess = await resolveViewer(req);
      next();
    },
    jsonBody,
    async (req, res) => {
      const { context, viewer } = res.locals.shareholderAccess as Awaited<
        ReturnType<typeof resolveViewer>
      >;
      const { shareholderDocumentId } =
        createShareholderDocumentSignedUrl.params.parse(req.params);
      createShareholderDocumentSignedUrl.body.parse(req.body);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        data: await shareholderDocumentSignedUrlService(
          context,
          viewer,
          shareholderDocumentId,
          { storage: storage(), membership },
        ),
      });
    },
  );

  return router;
}
