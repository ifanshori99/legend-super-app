// Guest QR order routes (bead legend-e2x; PRD v1.7 §3 F10, §4 Alur A/B;
// contracts @starter/shared/qr-order endpoints.ts getTableSession,
// addCartLine, updateCartLine, removeCartLine, quoteTableSession,
// placeQrOrder, getSessionBill, and guest.ts createGuestPayment /
// getGuestPayment / getGuestPaymentOptions).
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
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.ts";
import {
  addCartLine,
  createGuestPayment,
  createIssueChargePayment,
  createSessionSplits,
  getGuestPayment,
  getGuestPaymentOptions,
  getMenuSuggestions,
  getSessionBill,
  getSplitClaim,
  getTableSession,
  listSessionIssueCharges,
  placeQrOrder,
  quoteTableSession,
  removeCartLine,
  updateCartLine,
} from "@starter/shared/qr-order";
import { CoreError, idempotencyKeySchema } from "@starter/shared/core";
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
import { guestSessionContext } from "../services/guest-session-scope.ts";
import {
  createSessionSplits as createSessionSplitsService,
  getSplitClaim as getSplitClaimService,
} from "../services/bill-split.service.ts";
import { getMenuSuggestions as getMenuSuggestionsService } from "../services/qr-guest-reads.service.ts";
import {
  createGuestPayment as createGuestPaymentService,
  getGuestPayment as getGuestPaymentService,
  getGuestPaymentOptions as getGuestPaymentOptionsService,
} from "../services/qr-order-payment.ts";
import {
  createIssueChargePayment as createIssueChargePaymentService,
  listIssueChargesOfSession as listIssueChargesOfSessionService,
} from "../services/order-recovery-charge-payment.ts";

/**
 * The guest acts inside the host's tenant, reaching only the outlet of the
 * session its credential names (TEN-03, legend-7csf). The outlet comes from
 * the verified session row, never from the client.
 */
export function guestContext(req: Request, credential: string) {
  return guestSessionContext(getTenantContext(req), credential);
}

/** `Authorization: Bearer <sessionToken>`; anything else is 401. */
export function sessionCredential(req: Request): string {
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
  const credential = sessionCredential(req);
  res.json({
    data: await getTableSessionView(
      await guestContext(req, credential),
      credential,
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
    const credential = sessionCredential(req);
    res.status(201).json({
      data: await addCartLineService(
        await guestContext(req, credential),
        credential,
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
    const credential = sessionCredential(req);
    res.json({
      data: await updateCartLineService(
        await guestContext(req, credential),
        credential,
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
    const credential = sessionCredential(req);
    res.json({
      data: await removeCartLineService(
        await guestContext(req, credential),
        credential,
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
    const credential = sessionCredential(req);
    res.json({
      data: await quoteTableSessionService(
        await guestContext(req, credential),
        credential,
        sessionId,
        body,
      ),
    });
  },
);

// legend-111j (§5 QR auto-attach): a guest who is also signed in to the
// member app attaches their profile to the order. The session is optional and
// never required here; an impersonated (support) session never attaches.
async function optionalMemberUserId(req: Request): Promise<string | null> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
    query: { disableCookieCache: true },
  });
  if (!session) return null;
  const { impersonatedBy } = session.session as {
    impersonatedBy?: string | null;
  };
  if (impersonatedBy) return null;
  return session.user.id;
}

qrOrderRouter.post(
  "/:sessionId/orders",
  ...write,
  jsonBody,
  async (req, res) => {
    const { sessionId } = placeQrOrder.params.parse(req.params);
    const body = placeQrOrder.body.parse(req.body);
    const credential = sessionCredential(req);
    res.status(201).json({
      data: await placeQrOrderService(
        await guestContext(req, credential),
        credential,
        sessionId,
        body,
        new Date(),
        await optionalMemberUserId(req),
      ),
    });
  },
);

qrOrderRouter.get("/:sessionId/bill", ...read, async (req, res) => {
  const { sessionId } = getSessionBill.params.parse(req.params);
  const credential = sessionCredential(req);
  res.json({
    data: await getSessionBillService(
      await guestContext(req, credential),
      credential,
      sessionId,
    ),
  });
});

qrOrderRouter.post(
  "/:sessionId/splits",
  ...write,
  jsonBody,
  async (req, res) => {
    const { sessionId } = createSessionSplits.params.parse(req.params);
    const body = createSessionSplits.body.parse(req.body);
    const credential = sessionCredential(req);
    res.status(201).json({
      data: await createSessionSplitsService(
        await guestContext(req, credential),
        credential,
        sessionId,
        body,
      ),
    });
  },
);

qrOrderRouter.get(
  "/:sessionId/splits/:splitId/claim",
  ...read,
  async (req, res) => {
    const { sessionId, splitId } = getSplitClaim.params.parse(req.params);
    const credential = sessionCredential(req);
    res.json({
      data: await getSplitClaimService(
        await guestContext(req, credential),
        credential,
        sessionId,
        splitId,
      ),
    });
  },
);

qrOrderRouter.get("/:sessionId/payment-options", ...read, async (req, res) => {
  const { sessionId } = getGuestPaymentOptions.params.parse(req.params);
  const credential = sessionCredential(req);
  res.json({
    data: await getGuestPaymentOptionsService(
      await guestContext(req, credential),
      credential,
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
    const credential = sessionCredential(req);
    res.status(201).json({
      data: await createGuestPaymentService(
        await guestContext(req, credential),
        credential,
        sessionId,
        body,
      ),
    });
  },
);

// legend-i83ls: the dearer-swap difference owed on this session.
qrOrderRouter.get("/:sessionId/issue-charges", ...read, async (req, res) => {
  const { sessionId } = listSessionIssueCharges.params.parse(req.params);
  const credential = sessionCredential(req);
  res.json({
    data: await listIssueChargesOfSessionService(
      await guestContext(req, credential),
      credential,
      sessionId,
    ),
  });
});

qrOrderRouter.post(
  "/:sessionId/issue-charges/:chargeId/payments",
  ...write,
  jsonBody,
  async (req, res) => {
    const { sessionId, chargeId } = createIssueChargePayment.params.parse(
      req.params,
    );
    const body = createIssueChargePayment.body.parse(req.body);
    const credential = sessionCredential(req);
    res.status(201).json({
      data: await createIssueChargePaymentService(
        await guestContext(req, credential),
        credential,
        sessionId,
        chargeId,
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
    const credential = sessionCredential(req);
    res.json({
      data: await getGuestPaymentService(
        await guestContext(req, credential),
        credential,
        sessionId,
        paymentId,
      ),
    });
  },
);

qrOrderRouter.get("/:sessionId/suggestions", ...read, async (req, res) => {
  const { sessionId } = getMenuSuggestions.params.parse(req.params);
  const query = getMenuSuggestions.query.parse(req.query);
  const credential = sessionCredential(req);
  res.json({
    data: await getMenuSuggestionsService(
      await guestContext(req, credential),
      credential,
      sessionId,
      query,
    ),
  });
});
