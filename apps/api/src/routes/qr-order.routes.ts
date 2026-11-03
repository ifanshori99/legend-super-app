// Guest QR order routes (bead legend-e2x; PRD v1.7 §3 F10, §4 Alur A/B;
// contracts @starter/shared/qr-order endpoints.ts getTableSession,
// addCartLine, updateCartLine, removeCartLine, quoteTableSession,
// placeQrOrder, getSessionBill, and guest.ts createGuestPayment /
// getGuestPayment).
//
// Mounted on /api/table-sessions next to the staff lifecycle router
// (table-sessions.routes.ts: confirm, close). Guests are not users (ORD-01):
// every route authenticates the opaque session credential from the scan
// (`Authorization: Bearer <sessionToken>`), which the service resolves by hash
// inside the tenant transaction and refuses once the session is closed
// (ORD-04). The tenant comes from the request host (TEN-02). Mutations also
// pass the trusted-origin check (defense in depth: the QR web app runs on the
// configured web origin). Guards are attached per route, like the staff
// router, so neither router's middleware can reach the other's routes.

import { Router, type Request } from "express";
import {
  addCartLine,
  createGuestPayment,
  getGuestPayment,
  getSessionBill,
  getTableSession,
  placeQrOrder,
  quoteTableSession,
  removeCartLine,
  updateCartLine,
} from "@starter/shared/qr-order";
import { CoreError, idempotencyKeySchema } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import {
  addCartLine as addCartLineService,
  getSessionBill as getSessionBillService,
  getTableSessionView,
  placeQrOrder as placeQrOrderService,
  quoteTableSession as quoteTableSessionService,
  removeCartLine as removeCartLineService,
  updateCartLine as updateCartLineService,
} from "../services/qr-order.service.ts";
import {
  createGuestPayment as createGuestPaymentService,
  getGuestPayment as getGuestPaymentService,
} from "../services/qr-order-payment.ts";

/** The guest acts tenant-wide inside the host's tenant; the session names the outlet. */
function guestContext(req: Request) {
  return establishScopedTenantContext(getTenantContext(req), {
    kind: "tenant",
  });
}

/** `Authorization: Bearer <sessionToken>`; anything else is 401. */
function sessionCredential(req: Request): string {
  const header = req.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(header);
  if (!match)
    throw new CoreError(
      "UNAUTHORIZED",
      "Sesi meja tidak dikenali; pindai QR meja lagi.",
    );
  return match[1];
}

const read = [requireTenantContext];
const write = [requireTenantContext, requireTrustedOrigin];

export const qrOrderRouter = Router();

qrOrderRouter.get("/:sessionId", ...read, async (req, res) => {
  const { sessionId } = getTableSession.params.parse(req.params);
  res.json({
    data: await getTableSessionView(
      guestContext(req),
      sessionCredential(req),
      sessionId,
    ),
  });
});

qrOrderRouter.post(
  "/:sessionId/cart/lines",
  ...write,
  jsonBody,
  async (req, res) => {
    const { sessionId } = addCartLine.params.parse(req.params);
    const body = addCartLine.body.parse(req.body);
    res.status(201).json({
      data: await addCartLineService(
        guestContext(req),
        sessionCredential(req),
        sessionId,
        body,
      ),
    });
  },
);

qrOrderRouter.patch(
  "/:sessionId/cart/lines/:lineId",
  ...write,
  jsonBody,
  async (req, res) => {
    const { sessionId, lineId } = updateCartLine.params.parse(req.params);
    const body = updateCartLine.body.parse(req.body);
    res.json({
      data: await updateCartLineService(
        guestContext(req),
        sessionCredential(req),
        sessionId,
        lineId,
        body,
      ),
    });
  },
);

qrOrderRouter.delete(
  "/:sessionId/cart/lines/:lineId",
  ...write,
  async (req, res) => {
    const { sessionId, lineId } = removeCartLine.params.parse(req.params);
    const query = removeCartLine.query.parse(req.query);
    const key = req.get("idempotency-key");
    res.json({
      data: await removeCartLineService(
        guestContext(req),
        sessionCredential(req),
        sessionId,
        lineId,
        {
          expectedCartVersion: query.expectedCartVersion,
          idempotencyKey:
            key === undefined ? null : idempotencyKeySchema.parse(key),
        },
      ),
    });
  },
);

qrOrderRouter.post(
  "/:sessionId/quote",
  ...write,
  jsonBody,
  async (req, res) => {
    const { sessionId } = quoteTableSession.params.parse(req.params);
    const body = quoteTableSession.body.parse(req.body);
    res.json({
      data: await quoteTableSessionService(
        guestContext(req),
        sessionCredential(req),
        sessionId,
        body,
      ),
    });
  },
);

qrOrderRouter.post(
  "/:sessionId/orders",
  ...write,
  jsonBody,
  async (req, res) => {
    const { sessionId } = placeQrOrder.params.parse(req.params);
    const body = placeQrOrder.body.parse(req.body);
    res.status(201).json({
      data: await placeQrOrderService(
        guestContext(req),
        sessionCredential(req),
        sessionId,
        body,
      ),
    });
  },
);

qrOrderRouter.get("/:sessionId/bill", ...read, async (req, res) => {
  const { sessionId } = getSessionBill.params.parse(req.params);
  res.json({
    data: await getSessionBillService(
      guestContext(req),
      sessionCredential(req),
      sessionId,
    ),
  });
});

qrOrderRouter.post(
  "/:sessionId/payments",
  ...write,
  jsonBody,
  async (req, res) => {
    const { sessionId } = createGuestPayment.params.parse(req.params);
    const body = createGuestPayment.body.parse(req.body);
    res.status(201).json({
      data: await createGuestPaymentService(
        guestContext(req),
        sessionCredential(req),
        sessionId,
        body,
      ),
    });
  },
);

qrOrderRouter.get(
  "/:sessionId/payments/:paymentId",
  ...read,
  async (req, res) => {
    const { sessionId, paymentId } = getGuestPayment.params.parse(req.params);
    res.json({
      data: await getGuestPaymentService(
        guestContext(req),
        sessionCredential(req),
        sessionId,
        paymentId,
      ),
    });
  },
);
