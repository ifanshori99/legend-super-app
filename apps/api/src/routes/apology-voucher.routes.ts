// Apology voucher routes (bead legend-4qu; PRD v1.7 ORD-08; contracts
// @starter/shared/qr-order endpoints.ts `issueApologyVoucher` and
// `getApologyVoucher`).
//
// Mount (routes/index.ts): `apiRouter.use("/apology-vouchers",
// apologyVoucherRouter)`, so the contract paths `/api/apology-vouchers` and
// `/api/apology-vouchers/:code` are served here.
//
// - requireAuthAllowSharedDevice + requireTrustedOrigin + requireTenantContext;
//   the tenant comes from the server-minted context (TEN-02), never the body.
// - Shared tablet (legend-13vhb): resolveActingStaff + requireActingStaffOnSharedDevice
//   demand the cashier PIN token; the issuer and permission subject is `actorOf(req)`.
// - requireMenuPermission mints the outlet-reach context for the permission;
//   the service re-checks the outlet of the order issue and the approval
//   matrix limit (above the cap only with an approved request).
// - Reading by code is open to either `order.apology_voucher.issue` or
//   `order.recovery.handle` (the cashier looks the code up to redeem it).
// - Issuing without an `orderIssueId` requires an `Idempotency-Key` header (422).
// - Strict contract schemas parse params and body.

import { and, eq } from "drizzle-orm";
import { Router, type Request, type RequestHandler } from "express";
import { AccessError } from "@starter/shared/access";
import { idempotencyKeySchema, userIdSchema } from "@starter/shared/core";
import {
  getApologyVoucher,
  issueApologyVoucher,
} from "@starter/shared/qr-order";
import { memberTenantContext } from "../db/member-scope.ts";
import { db } from "../db/index.ts";
import { apologyVouchers } from "../db/schema/apology-vouchers.ts";
import { vouchers as crmVouchers } from "../db/schema/crm-promo.ts";
import { orderIssues } from "../db/schema/kds-issues.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  actorOf,
  refuseActingStaffOtherOutlet,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import { requireAuthAllowSharedDevice } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as vouchers from "../services/apology-voucher.service.ts";
import { hashPromoCode } from "../services/crm-promo-engine.ts";

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

/**
 * The path carries no outlet, so resolveActingStaff could not compare it: a
 * cashier token issued for another outlet is refused (403 OUTLET_MISMATCH) by
 * the shared helper. Unlike the helper's default, an unknown outlet (missing
 * resource, or no sole outlet to infer) is left to the service (404), so it
 * resolves to the token's own outlet here. Without an acting staff (regular
 * browser) nothing changes.
 */
function refuseOtherOutlet(
  outletOf: (req: Request) => Promise<string | null>,
): RequestHandler {
  return refuseActingStaffOtherOutlet(
    async (req) => (await outletOf(req)) ?? req.actingStaff?.outletId ?? null,
  );
}

/** Outlet of the order issue in the body, else the caller's sole outlet. */
async function issueOutletOf(req: Request): Promise<string | null> {
  const body = issueApologyVoucher.body.parse(req.body);
  const context = getScopedTenantContext(req);
  if (body.orderIssueId === undefined) {
    const scope = context.outletScope;
    return scope.kind === "outlets" && scope.outletIds.length === 1
      ? (scope.outletIds[0] ?? null)
      : null;
  }
  const orderIssueId = body.orderIssueId;
  return withTenant(
    db,
    memberTenantContext(context.tenant.tenantId),
    async (tx) => {
      const [row] = await tx
        .select({ outletId: orderIssues.outletId })
        .from(orderIssues)
        .where(
          and(
            eq(orderIssues.tenantId, context.tenant.tenantId),
            eq(orderIssues.id, orderIssueId),
          ),
        )
        .limit(1);
      return row?.outletId ?? null;
    },
  );
}

/** Outlet of the apology voucher named by the `:code` param. */
async function voucherOutletOf(req: Request): Promise<string | null> {
  const { code } = getApologyVoucher.params.parse(req.params);
  const tenantId = getScopedTenantContext(req).tenant.tenantId;
  const digest = hashPromoCode(code.trim().toUpperCase().replaceAll("-", ""));
  return withTenant(db, memberTenantContext(tenantId), async (tx) => {
    const [row] = await tx
      .select({ outletId: apologyVouchers.outletId })
      .from(crmVouchers)
      .innerJoin(
        apologyVouchers,
        and(
          eq(apologyVouchers.tenantId, crmVouchers.tenantId),
          eq(apologyVouchers.voucherId, crmVouchers.id),
        ),
      )
      .where(
        and(
          eq(crmVouchers.tenantId, tenantId),
          eq(crmVouchers.codeHash, digest),
        ),
      )
      .limit(1);
    return row?.outletId ?? null;
  });
}

const base = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
];

apologyVoucherRouter.post(
  "/",
  ...base,
  requireMenuPermission("order.apology_voucher.issue"),
  jsonBody,
  refuseOtherOutlet(issueOutletOf),
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
        userIdSchema.parse(actorOf(req)),
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
  refuseOtherOutlet(voucherOutletOf),
  async (req, res) => {
    const { code } = getApologyVoucher.params.parse(req.params);
    res.json({
      data: await vouchers.getApologyVoucherByCode(
        getScopedTenantContext(req),
        userIdSchema.parse(actorOf(req)),
        code,
        new Date(),
      ),
    });
  },
);
