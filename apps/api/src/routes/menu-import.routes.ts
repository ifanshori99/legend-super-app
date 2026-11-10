// Menu bulk import + printable menu routes (bead legend-dmi; PRD v1.7 §3 F8).
// The body/query schemas live in the shared menu contract
// (`@starter/shared/menu`, import.ts). XLSX and CSV are both parsed here, on
// the server (legend-az32).
//
//   POST /api/menu/import/validate   per-row report, writes nothing
//   POST /api/menu/import/preview    report + normalised rows
//   POST /api/menu/import/commit     atomic; header Idempotency-Key required
//   GET  /api/menu/print             latest printable PDF (signed URL)
//   POST /api/menu/print/refresh     regenerate now

import express, { Router, type RequestHandler } from "express";
import type { ObjectStorage } from "@starter/shared/adapters";
import { idempotencyKeySchema } from "@starter/shared/core";
import {
  menuImportInputSchema,
  menuPrintQuerySchema,
} from "@starter/shared/menu";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  commitMenuImport,
  MenuImportInvalidError,
  previewMenuImport,
  validateMenuImport,
} from "../services/menu-import.service.ts";
import {
  getLatestMenuPrint,
  refreshMenuPrintNow,
  type MenuPdfRenderer,
} from "../services/menu-print.service.ts";
import { IMPORT_MAX_FILE_BYTES } from "../services/menu-import-parse.ts";
import type { MalwareScanner } from "../services/core-image.ts";

const BODY_LIMIT = Math.ceil((IMPORT_MAX_FILE_BYTES * 4) / 3) + 4096;

const importBody: RequestHandler = (req, res, next) => {
  const type = req.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json")
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Send an application/json body.",
    );
  express.json({ limit: BODY_LIMIT, strict: true })(req, res, next);
};

export function createMenuImportRouter(options: {
  storage?: ObjectStorage | null;
  renderer?: MenuPdfRenderer | null;
  scanner?: MalwareScanner;
}): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);
  const manage = requireMenuPermission("menu.item.manage");
  const view = requireMenuPermission("menu.item.view");
  const printDeps = () => {
    if (!options.storage)
      throw new HttpError(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan belum tersedia.",
      );
    // Fail closed: a PDF is never stored without a scanner (legend-0w2wy).
    if (!options.scanner)
      throw new HttpError(
        503,
        "SERVICE_UNAVAILABLE",
        "Pemindai malware belum tersedia.",
      );
    return {
      storage: options.storage,
      renderer: options.renderer ?? null,
      scanner: options.scanner,
    };
  };

  router.post("/import/validate", manage, importBody, async (req, res) => {
    const body = menuImportInputSchema.parse(req.body);
    res.json({
      data: await validateMenuImport(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
      ),
    });
  });

  router.post("/import/preview", manage, importBody, async (req, res) => {
    const body = menuImportInputSchema.parse(req.body);
    res.json({
      data: await previewMenuImport(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
      ),
    });
  });

  router.post("/import/commit", manage, importBody, async (req, res) => {
    const body = menuImportInputSchema.parse(req.body);
    const raw = req.get("Idempotency-Key");
    if (raw === undefined)
      throw new HttpError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Header Idempotency-Key wajib diisi.",
      );
    const key = idempotencyKeySchema.parse(raw);
    try {
      const result = await commitMenuImport(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        key,
        body,
      );
      res.status(result.replayed ? 200 : 201).json({ data: result });
    } catch (error) {
      if (error instanceof MenuImportInvalidError) {
        res.status(422).json({
          error: {
            code: error.code,
            message: error.message,
            details: {
              rows: error.report.rows.filter((r) => r.errors.length > 0),
            },
          },
        });
        return;
      }
      throw error;
    }
  });

  router.get("/print", view, async (req, res) => {
    const query = menuPrintQuerySchema.parse(req.query);
    res.json({
      data: await getLatestMenuPrint(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
        printDeps(),
      ),
    });
  });

  router.post("/print/refresh", manage, importBody, async (req, res) => {
    const body = menuPrintQuerySchema.parse(req.body ?? {});
    res.json({
      data: await refreshMenuPrintNow(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
        printDeps(),
      ),
    });
  });

  return router;
}
