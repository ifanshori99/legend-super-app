// POS receipt routes (bead legend-93a; PRD v1.7 §3 F11 "Struk & Kuitansi";
// POS-06, POS-07; contract @starter/shared/pos endpoints.ts — issuePosReceipt,
// getPosReceiptDocument, getPosReceiptByNumber, createPosReceiptLink,
// createPosInvoice) plus the PDF downloads and the public e-receipt page.
//
// Mounts (lead, routes/index.ts):
//   apiRouter.use("/outlets/:outletId/pos", posReceiptRouter)
//   apiRouter.use("/public/receipts", publicReceiptRouter)
//
// - posReceiptRouter: requireAuthAllowSharedDevice + requireTrustedOrigin + requireTenantContext,
//   then requireOutletPermission on the path's outlet (TEN-03). Issue/reprint,
//   link and invoice need `pos.payment.accept`; reads and PDFs `order.view`.
// - publicReceiptRouter: no session. The tenant comes from the request host
//   (TEN-02) like routes/qr.routes.ts; the token is looked up by its SHA-256
//   inside that tenant and an unknown or expired token is one and the same 404.
//   No trusted-origin check: it reads no cookie.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { userIdSchema, type OutletId } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  createPosInvoice,
  createPosReceiptLink,
  getPosReceiptByNumber,
  getPosReceiptDocument,
  invoiceDocumentSchema,
  issuePosReceipt,
} from "@starter/shared/pos";
import type { PermissionCode } from "@starter/shared/access";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import { requireAuthAllowSharedDevice } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requirePosWriteOnCloud } from "../middleware/pos-on-cloud.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import * as delivery from "../services/pos-receipt-delivery.service.ts";

export const posReceiptRouter = Router({ mergeParams: true });
export const publicReceiptRouter = Router();

posReceiptRouter.use(
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
);

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const can = (permission: PermissionCode) =>
  requireOutletPermission(permission, outletOf);

const view = can("order.view");
const pay = can("pos.payment.accept");

const pdfQuery = z.strictObject({
  kind: z.enum(["receipt", "kuitansi"]).default("receipt"),
});
const pdfParams = z.strictObject({
  outletId: getPosReceiptDocument.params.shape.outletId,
  receiptId: getPosReceiptDocument.params.shape.receiptId,
});
const invoicePdfParams = z.strictObject({
  outletId: getPosReceiptDocument.params.shape.outletId,
  invoiceId: z.uuid().toLowerCase(),
});
const publicTokenParams = z.strictObject({ token: z.string().min(1).max(200) });

function caller(req: Request) {
  return { userId: userIdSchema.parse(actorOf(req)) };
}

function sendPdf(res: Response, file: delivery.PdfFile): void {
  res
    .status(200)
    .type("application/pdf")
    .setHeader("Content-Disposition", `inline; filename="${file.filename}"`)
    .setHeader("Cache-Control", "private, no-store")
    .send(file.pdf);
}

// ---- Issue / documents -------------------------------------------------------------

posReceiptRouter.post(
  "/orders/:orderId/receipts",
  pay,
  requirePosWriteOnCloud,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = issuePosReceipt.params.parse(req.params);
    const body = issuePosReceipt.body.parse(req.body);
    res.json({
      data: await delivery.issueReceiptDeliveries(
        getScopedTenantContext(req),
        caller(req),
        outletId,
        orderId,
        body,
      ),
    });
  },
);

// Before `/receipts/:receiptId`, which would take "by-number" as an id.
posReceiptRouter.get("/receipts/by-number/:number", view, async (req, res) => {
  const { outletId, number } = getPosReceiptByNumber.params.parse(req.params);
  res.json({
    data: await delivery.getReceiptByNumber(
      getScopedTenantContext(req),
      outletId,
      number,
    ),
  });
});

posReceiptRouter.get("/receipts/:receiptId", view, async (req, res) => {
  const { outletId, receiptId } = getPosReceiptDocument.params.parse(
    req.params,
  );
  res.json({
    data: await delivery.getReceiptDocument(
      getScopedTenantContext(req),
      outletId,
      receiptId,
    ),
  });
});

posReceiptRouter.get("/receipts/:receiptId/pdf", view, async (req, res) => {
  const { outletId, receiptId } = pdfParams.parse(req.params);
  const { kind } = pdfQuery.parse(req.query);
  sendPdf(
    res,
    await delivery.getReceiptPdf(
      getScopedTenantContext(req),
      outletId,
      receiptId,
      kind,
    ),
  );
});

posReceiptRouter.post(
  "/receipts/:receiptId/link",
  pay,
  requirePosWriteOnCloud,
  jsonBody,
  async (req, res) => {
    const { outletId, receiptId } = createPosReceiptLink.params.parse(
      req.params,
    );
    const body = createPosReceiptLink.body.parse(req.body);
    res.json({
      data: await delivery.createReceiptLink(
        getScopedTenantContext(req),
        caller(req),
        outletId,
        receiptId,
        body.idempotencyKey,
      ),
    });
  },
);

// ---- Invoices ----------------------------------------------------------------------

posReceiptRouter.post(
  "/orders/:orderId/invoices",
  pay,
  requirePosWriteOnCloud,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = createPosInvoice.params.parse(req.params);
    const body = createPosInvoice.body.parse(req.body);
    const document = await delivery.createInvoice(
      getScopedTenantContext(req),
      caller(req),
      outletId as OutletId,
      orderId,
      body,
    );
    res.status(201).json({ data: invoiceDocumentSchema.parse(document) });
  },
);

posReceiptRouter.get("/invoices/:invoiceId/pdf", view, async (req, res) => {
  const { outletId, invoiceId } = invoicePdfParams.parse(req.params);
  sendPdf(
    res,
    await delivery.getInvoicePdf(
      getScopedTenantContext(req),
      outletId,
      invoiceId,
    ),
  );
});

// ---- Public e-receipt (tenant from host) ---------------------------------------------

publicReceiptRouter.use(requireTenantContext);

const publicContext = (req: Request) =>
  establishScopedTenantContext(getTenantContext(req), { kind: "tenant" });

publicReceiptRouter.get("/:token", async (req, res) => {
  const { token } = publicTokenParams.parse(req.params);
  // The document is personal: never cached by a shared proxy.
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    data: await delivery.getPublicReceiptDocument(publicContext(req), token),
  });
});

publicReceiptRouter.get("/:token/pdf", async (req, res) => {
  const { token } = publicTokenParams.parse(req.params);
  const { kind } = pdfQuery.parse(req.query);
  sendPdf(
    res,
    await delivery.getPublicReceiptPdf(publicContext(req), token, kind),
  );
});
