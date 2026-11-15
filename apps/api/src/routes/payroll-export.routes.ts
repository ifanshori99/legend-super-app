// Payroll exports (bead legend-34qx): bank transfer file and Coretax PPh 21
// import. Contract: hris/payroll endpoints.ts `createBankTransferFile`,
// `listBankTransferFiles`, `createPayrollTaxExport`. Creating a file needs
// `payroll.lock`, listing needs `payroll.view` (both tenant-wide, re-checked in
// the service). The files live in the object storage, so createStorageApiRouter
// mounts this router with the runtime at `/api/hris/payroll`; without a runtime
// every call answers 503 after the permission check.

import { Router } from "express";
import {
  createBankTransferFile,
  createPayrollTaxExport,
  listBankTransferFiles,
} from "@starter/shared/hris/payroll";
import { HttpError } from "../lib/http-error";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import type { StorageRuntime } from "../services/core-storage-runtime";
import * as exports_ from "../services/payroll-export.service";

const BASE = /^\/api\/hris\/payroll/;
const route = (path: string) => path.replace(BASE, "");

/** Only these paths enter the router (it runs the session guards on each request it sees). */
export const PAYROLL_EXPORT_PATH =
  /^\/(runs\/[^/]+\/bank-transfer-files|tax-exports)\/?$/i;

export function createPayrollExportRouter(options: {
  runtime: StorageRuntime | null;
}): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);
  const runtime = (): StorageRuntime => {
    if (!options.runtime)
      throw new HttpError(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan berkas belum tersedia.",
      );
    return options.runtime;
  };

  router.post(
    route(createBankTransferFile.path),
    requireTenantPermission("payroll.lock"),
    jsonBody,
    async (req) => {
      createBankTransferFile.params.parse(req.params);
      createBankTransferFile.body.parse(req.body);
      // Legacy path closed (bead legend-yjbjb): a bank file made outside an
      // approved payout batch is a payment instruction without the batch's
      // approval, sealed amounts, and return proof. Refuse before any DB work.
      throw new HttpError(
        409,
        "LEGACY_BANK_EXPORT_DISABLED",
        "Pembuatan berkas transfer lama sudah ditutup. Ekspor pembayaran lewat batch payout yang disetujui.",
      );
    },
  );

  router.get(
    route(listBankTransferFiles.path),
    requireTenantPermission("payroll.view"),
    async (req, res) => {
      const { payrollRunId } = listBankTransferFiles.params.parse(req.params);
      const query = listBankTransferFiles.query.parse(req.query);
      res.json(
        await exports_.listBankTransferFiles(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          payrollRunId,
          query,
          runtime(),
        ),
      );
    },
  );

  router.post(
    route(createPayrollTaxExport.path),
    requireTenantPermission("payroll.lock"),
    jsonBody,
    async (req, res) => {
      const { idempotencyKey, ...input } = createPayrollTaxExport.body.parse(
        req.body,
      );
      const data = await exports_.createPayrollTaxExport(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        { ...input, idempotencyKey },
        runtime(),
      );
      res.status(201).json({ data });
    },
  );

  return router;
}
