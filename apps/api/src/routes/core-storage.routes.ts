import { Router, type Request, type RequestHandler } from "express";
import multer from "multer";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  createStorageSignedUrl,
  signedStorageUrlBodySchema,
  signedStorageUrlSchema,
  storageObjectIdSchema,
  storageObjectSchema,
  uploadStorageMetadataSchema,
  uploadStorageObject,
} from "@starter/shared/storage";
import { HttpError } from "../lib/http-error";
import { requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import { signedStorageUrl, uploadStorage } from "../services/core-storage";
import { createSelfieUploadScanner } from "../services/core-image";

type UploadDependencies = Parameters<typeof uploadStorage>[4];
type Database = Parameters<typeof uploadStorage>[0];
type ResolveRequest = (request: Request) => Promise<{
  context: ScopedTenantContext;
  authorize: UploadDependencies["authorize"];
  actorUserId: string;
}>;

/** The caller supplies a server-side identity/scope and authorization resolver.
 * The real resolver is services/core-storage-access.ts. No router is mounted
 * until an object storage provider exists (legend-7nv1). */
export function createStorageRouter(options: {
  database: Database;
  storage: UploadDependencies["storage"];
  scanner: UploadDependencies["scanner"];
  resolveRequest: ResolveRequest;
  /** Replaces `uploadStorage`. The edge passes the sealing upload here
   * (services/edge-selfie.service.ts); the cloud leaves it unset. */
  upload?: typeof uploadStorage;
}) {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin);
  const selfieScanner = createSelfieUploadScanner(options.scanner);
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
    uploadStorageObject.path.replace(/^\/api/, ""),
    parseUpload,
    async (req, res) => {
      const metadata = uploadStorageMetadataSchema.parse(req.body);
      if (!req.file)
        throw new HttpError(422, "VALIDATION_ERROR", "A file is required.");
      const resolved = await options.resolveRequest(req);
      assertTrustedScopedContext(resolved.context);
      const data = await (options.upload ?? uploadStorage)(
        options.database,
        resolved.context,
        metadata,
        req.file.buffer,
        {
          storage: options.storage,
          scanner:
            metadata.purpose === "selfie" ? selfieScanner : options.scanner,
          authorize: resolved.authorize,
          actorUserId: resolved.actorUserId,
        },
      );
      res.status(201).json({ data: storageObjectSchema.parse(data) });
    },
  );
  router.post(
    createStorageSignedUrl.path.replace(/^\/api/, ""),
    jsonBody,
    async (req, res) => {
      const id = storageObjectIdSchema.parse(req.params.objectId);
      const body = signedStorageUrlBodySchema.parse(req.body);
      const resolved = await options.resolveRequest(req);
      assertTrustedScopedContext(resolved.context);
      const data = await signedStorageUrl(
        options.database,
        resolved.context,
        id,
        body.variant,
        {
          storage: options.storage,
          authorize: resolved.authorize,
        },
      );
      res.json({ data: signedStorageUrlSchema.parse(data) });
    },
  );
  return router;
}
