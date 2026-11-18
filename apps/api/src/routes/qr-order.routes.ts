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
import { env } from "../config/env.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { fromNodeHeaders } from "better-auth/node";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { auth } from "../lib/auth.ts";
import { verifyDeviceToken } from "../lib/device-token.ts";
import { logger, serializeError } from "../lib/logger.ts";
import {
  anySharedDeviceActive,
  stampSharedDeviceFromToken,
} from "../services/shared-device.service.ts";
import {
  addCartLine,
  claimSessionPoints,
  createGuestPayment,
  createIssueChargePayment,
  createSessionSplits,
  getGuestPayment,
  getGuestPaymentOptions,
  getMenuSuggestions,
  getOrderEtas,
  getPointClaim,
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
import { guestSessionContext } from "../services/guest-session-scope.ts";
import {
  createSessionSplits as createSessionSplitsService,
  getSplitClaim as getSplitClaimService,
  getSplitClaimByToken as getSplitClaimByTokenService,
} from "../services/bill-split.service.ts";
import {
  getMenuSuggestions as getMenuSuggestionsService,
  getOrderEtas as getOrderEtasService,
} from "../services/qr-guest-reads.service.ts";
import {
  claimSessionPoints as claimSessionPointsService,
  getPointClaim as getPointClaimService,
} from "../services/table-claim.service.ts";
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

// legend-ia54l: the claim token alone opens the claim code for 24 hours, also
// after the table is closed. Registered before "/:sessionId" so the literal
// segment wins. The guest rate limit on this mount covers it, but guessing is
// bounded by the IP and tenant buckets only (a new token is a new bearer
// bucket); the 256-bit token is the real defence. The read is tenant-wide like
// payment link tokens: no outlet is known before the token is resolved.
qrOrderRouter.get("/split-claims/current", ...read, async (req, res) => {
  const rawToken = sessionCredential(req);
  res.json({
    data: await getSplitClaimByTokenService(
      establishScopedTenantContext(getTenantContext(req), { kind: "tenant" }),
      rawToken,
    ),
  });
});

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
// legend-yizsl: a shared-device session (any entry in session.sharedDeviceIds,
// a mark that never lapses, or a valid token of an active flagged shared device
// on this request) is a cashier tablet's owner cookie and counts as anonymous:
// the owner's member profile and points must never attach to a guest order.
async function isSharedDeviceRequest(req: Request): Promise<boolean> {
  const raw = req.get(DEVICE_TOKEN_HEADER);
  if (!raw) return false;
  let deviceId: string | null = null;
  try {
    deviceId = verifyDeviceToken(raw)?.deviceId ?? null;
  } catch {
    // A badly signed token adds nothing.
  }
  if (deviceId === null) return false;
  try {
    return await anySharedDeviceActive([deviceId]);
  } catch (error) {
    // Fail closed: when the lookup fails, treat the request as a shared device
    // (anonymous guest) rather than attach the owner's member profile.
    logger.warn(
      { err: serializeError(error) },
      "qr-order: shared device lookup failed, treating request as anonymous",
    );
    return true;
  }
}

async function optionalMemberUserId(req: Request): Promise<string | null> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
    query: { disableCookieCache: true },
  });
  if (!session) return null;
  const { sharedDeviceIds } = session.session as {
    sharedDeviceIds?: readonly string[] | null;
  };
  if ((sharedDeviceIds?.length ?? 0) > 0) return null;
  // legend-vzvok: record the mark of a flagged shared device's token on the
  // cookie session, so a header-less replay is closed too. The order stays a
  // guest order in every case: marks found, 8-mark limit (null; the session is
  // not closed here) or a failed stamp (503, fail closed).
  try {
    const marks = await stampSharedDeviceFromToken(
      session.session.id,
      sharedDeviceIds,
      req.get(DEVICE_TOKEN_HEADER),
    );
    if (marks === null || marks.length > 0) return null;
  } catch (error) {
    logger.warn(
      { err: serializeError(error) },
      "qr-order: shared device stamp failed, treating request as anonymous",
    );
    return null;
  }
  if (await isSharedDeviceRequest(req)) return null;
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

// POST (not GET) so the payer secret travels in the body, never in a URL log.
// It changes nothing; no Idempotency-Key.
qrOrderRouter.post(
  "/:sessionId/splits/:splitId/claim",
  ...write,
  jsonBody,
  async (req, res) => {
    const { sessionId, splitId } = getSplitClaim.params.parse(req.params);
    const body = getSplitClaim.body.parse(req.body);
    const credential = sessionCredential(req);
    res.json({
      data: await getSplitClaimService(
        await guestContext(req, credential),
        credential,
        sessionId,
        splitId,
        body.payerSecret,
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

qrOrderRouter.get("/:sessionId/order-etas", ...read, async (req, res) => {
  const { sessionId } = getOrderEtas.params.parse(req.params);
  const credential = sessionCredential(req);
  res.json({
    data: await getOrderEtasService(
      await guestContext(req, credential),
      credential,
      sessionId,
    ),
  });
});

// Point claim (legend-n1mp). The guest session stays the Bearer credential;
// the member is the optional signed-in cookie session. Reading works for an
// anonymous guest (`requiresLogin`); claiming needs the member session.
qrOrderRouter.get("/:sessionId/points-claim", ...read, async (req, res) => {
  const { sessionId } = getPointClaim.params.parse(req.params);
  const query = getPointClaim.query.parse(req.query);
  const credential = sessionCredential(req);
  res.json({
    data: await getPointClaimService(
      await guestContext(req, credential),
      credential,
      sessionId,
      { claimToken: query.claimToken, userId: await optionalMemberUserId(req) },
    ),
  });
});

qrOrderRouter.post(
  "/:sessionId/points-claim",
  ...write,
  jsonBody,
  async (req, res) => {
    const edge = getEdgeRuntimeState();
    if (env.EDGE_MODE || edge.edgeMode)
      throw new CoreError(
        "SERVICE_UNAVAILABLE",
        edge.link.cloudLink === "disconnected"
          ? "Klaim poin butuh koneksi internet."
          : "Klaim poin melalui cloud belum tersedia pada perangkat ini.",
      );
    const { sessionId } = claimSessionPoints.params.parse(req.params);
    const body = claimSessionPoints.body.parse(req.body);
    const credential = sessionCredential(req);
    res.json({
      data: await claimSessionPointsService(
        await guestContext(req, credential),
        credential,
        sessionId,
        {
          claimToken: body.claimToken,
          userId: await optionalMemberUserId(req),
          idempotencyKey: body.idempotencyKey,
        },
      ),
    });
  },
);
