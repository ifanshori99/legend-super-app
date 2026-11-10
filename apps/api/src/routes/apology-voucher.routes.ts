// Apology voucher routes (bead legend-4qu; PRD v1.7 ORD-08; contracts
// @starter/shared/qr-order endpoints.ts `issueApologyVoucher` and
// `getApologyVoucher`).
//
// Mount (routes/index.ts): `apiRouter.use("/apology-vouchers",
// apologyVoucherRouter)`, so the contract paths `/api/apology-vouchers` and
// `/api/apology-vouchers/:code` are served here.
//
// - requireAuth + requireTrustedOrigin + requireTenantContext; the tenant comes
//   from the server-minted context (TEN-02), never the body.
// - requireMenuPermission mints the outlet-reach context for the permission;
//   the service re-checks the outlet of the order issue and the approval
//   matrix limit (above the cap only with an approved request).
// - Reading by code is open to either `order.apology_voucher.issue` or
//   `order.recovery.handle` (the cashier looks the code up to redeem it).
// - Issuing without an `orderIssueId` requires an `Idempotency-Key` header (422).
// - Strict contract schemas parse params and body.

import { Router, type Request, type RequestHandler } from "express";
import { AccessError } from "@starter/shared/access";
import { idempotencyKeySchema, userIdSchema } from "@starter/shared/core";
import {
  getApologyVoucher,
  issueApologyVoucher,
} from "@starter/shared/qr-order";
import { HttpError } from "../lib/http-error.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as vouchers from "../services/apology-voucher.service.ts";

export const apologyVoucherRouter = Router();

/**
 * Passes when the caller reaches the scope for ANY of the permissions. The
 * first denial is tried against the next permission; other errors propagate.
 */
function anyMenuPermission(
  ...permissions: Parameters<typeof requireMenuPermission>[0][]
): RequestHandler {
  const gates = permissions.map((permission) =>
    requireMenuPermission(permission),
  );
  return async (req, res, next) => {
    let denial: unknown;
    for (const gate of gates) {
      let passed = false;
      try {
        await gate(req, res, () => {
          passed = true;
        });
      } catch (error) {
        if (!(error instanceof AccessError)) throw error;
        denial = error;
      }
      if (passed) return next();
    }
    throw denial;
  };
}

/** Optional `Idempotency-Key` header; a malformed key is a 422. */
function idempotencyKeyOf(req: Request): string | null {
  const raw = req.get("Idempotency-Key");
  return raw === undefined ? null : idempotencyKeySchema.parse(raw);
}

const base = [requireAuth, requireTrustedOrigin, requireTenantContext];

apologyVoucherRouter.post(
  "/",
  ...base,
  requireMenuPermission("order.apology_voucher.issue"),
  jsonBody,
  async (req, res) => {
    const body = issueApologyVoucher.body.parse(req.body);
    const idempotencyKey = idempotencyKeyOf(req);
    // Without an order issue nothing else stops a double click from issuing twice.
    if (body.orderIssueId === undefined && idempotencyKey === null)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Header Idempotency-Key wajib diisi untuk voucher maaf tanpa laporan item gagal.",
      );
    res.status(201).json({
      data: await vouchers.issueApologyVoucherForStaff(
        getScopedTenantContext(req),
        userIdSchema.parse(getAuth(req).user.id),
        body,
        new Date(),
        idempotencyKey,
      ),
    });
  },
);

apologyVoucherRouter.get(
  "/:code",
  ...base,
  anyMenuPermission("order.apology_voucher.issue", "order.recovery.handle"),
  async (req, res) => {
    const { code } = getApologyVoucher.params.parse(req.params);
    res.json({
      data: await vouchers.getApologyVoucherByCode(
        getScopedTenantContext(req),
        userIdSchema.parse(getAuth(req).user.id),
        code,
        new Date(),
      ),
    });
  },
);
