// Work-from-cafe routes: seats, seat reservations, day passes, bundles and
// RevPASH (PRD v1.7 §3 F25/F39, FAC-14; bead legend-bz9h). Thin handlers over
// the wfc-* services; bodies and queries are the strict `@starter/shared/wfc`
// schemas. Mount at `/api/facility/wfc`.
//
// The tenant comes from the server-minted context, never the request
// (TEN-02). No route accepts a price: the only amount a client sends is what
// the payment provider reported (`paidIdr`) or the refund asked for
// (`refundIdr`), and the services compare both with the stored price. The
// services re-check the permission on the record's outlet (TEN-03).
//
// Config (seats, product kind, bundle create) and refunds are gated by
// `facility.config.manage`; the floor reads and operations by
// `facility.booth.operate`. RevPASH is a config-level report. The min-spend
// evaluator (`evaluateMinSpend`) is a scheduled job with no actor and takes a
// caller-supplied clock, so it is deliberately not exposed here.
import { Router } from "express";
import {
  cancelWfcReservationSchema,
  confirmWfcReservationPaidSchema,
  createWfcBundleSchema,
  createWfcSeatSchema,
  getRevpashInputSchema,
  listWfcBundlesQuerySchema,
  listWfcSeatsQuerySchema,
  purchaseDayPassSchema,
  purchaseWfcBundleSchema,
  refundDayPassSchema,
  refundWfcBundleSchema,
  refundWfcReservationSchema,
  reserveWfcSeatSchema,
  setWfcProductKindSchema,
} from "@starter/shared/wfc";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as bundles from "../services/wfc-bundle.service.ts";
import * as revpash from "../services/wfc-revpash.service.ts";
import * as seats from "../services/wfc-seat.service.ts";

const operate = requireMenuPermission("facility.booth.operate");
const manage = requireMenuPermission("facility.config.manage");

export const wfcRouter = Router();
wfcRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

// ------------------------------------------------------------------- seats

wfcRouter.get("/seats", operate, async (req, res) => {
  const query = listWfcSeatsQuerySchema.parse(req.query);
  res.json({
    data: await seats.listWfcSeats(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  });
});

wfcRouter.post("/seats", manage, jsonBody, async (req, res) => {
  const input = createWfcSeatSchema.parse(req.body);
  const seat = await seats.createWfcSeat(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res.status(201).json({ data: seat });
});

wfcRouter.put("/product-kind", manage, jsonBody, async (req, res) => {
  const input = setWfcProductKindSchema.parse(req.body);
  res.json({
    data: await seats.setWfcProductKind(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    ),
  });
});

// ----------------------------------------------------------- reservations

wfcRouter.post("/reservations", operate, jsonBody, async (req, res) => {
  const input = reserveWfcSeatSchema.parse(req.body);
  const reservation = await seats.reserveWfcSeat(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res.status(201).json({ data: reservation });
});

wfcRouter.post(
  "/reservations/confirm-paid",
  operate,
  jsonBody,
  async (req, res) => {
    const input = confirmWfcReservationPaidSchema.parse(req.body);
    res.json({
      data: await seats.confirmWfcReservationPaid(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      ),
    });
  },
);

wfcRouter.post("/reservations/cancel", operate, jsonBody, async (req, res) => {
  const input = cancelWfcReservationSchema.parse(req.body);
  res.json({
    data: await seats.cancelWfcReservation(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    ),
  });
});

wfcRouter.post("/reservations/refund", manage, jsonBody, async (req, res) => {
  const input = refundWfcReservationSchema.parse(req.body);
  res.json({
    data: await seats.refundWfcReservation(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    ),
  });
});

// --------------------------------------------------------------- day passes

wfcRouter.post("/day-passes", operate, jsonBody, async (req, res) => {
  const input = purchaseDayPassSchema.parse(req.body);
  const purchase = await seats.purchaseDayPass(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res.status(201).json({ data: purchase });
});

wfcRouter.post("/day-passes/refund", manage, jsonBody, async (req, res) => {
  const input = refundDayPassSchema.parse(req.body);
  res.json({
    data: await seats.refundDayPass(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    ),
  });
});

// ----------------------------------------------------------------- bundles

wfcRouter.get("/bundles", operate, async (req, res) => {
  const query = listWfcBundlesQuerySchema.parse(req.query);
  res.json({
    data: await bundles.listWfcBundles(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  });
});

wfcRouter.post("/bundles", manage, jsonBody, async (req, res) => {
  const input = createWfcBundleSchema.parse(req.body);
  const bundle = await bundles.createWfcBundle(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res.status(201).json({ data: bundle });
});

// Fixed paths; no `/bundles/:id` route exists to shadow them.
wfcRouter.post("/bundles/purchase", operate, jsonBody, async (req, res) => {
  const input = purchaseWfcBundleSchema.parse(req.body);
  const purchase = await bundles.purchaseWfcBundle(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res.status(201).json({ data: purchase });
});

wfcRouter.post("/bundles/refund", manage, jsonBody, async (req, res) => {
  const input = refundWfcBundleSchema.parse(req.body);
  res.json({
    data: await bundles.refundWfcBundle(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    ),
  });
});

// ----------------------------------------------------------------- RevPASH

wfcRouter.get("/revpash", manage, async (req, res) => {
  const query = getRevpashInputSchema.parse(req.query);
  res.json({
    data: await revpash.getRevpash(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  });
});
