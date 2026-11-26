// Member WFC pass routes (brief 1270 card W2). Mounted at /api/wfc by the
// route index: a path outside the edge allowlist (brief §2 U7), so an edge
// node never serves them. Same chain as `member.routes.ts`: the profile always
// comes from the session scope, never from the path, query or body; the
// services re-check the sales gate, the cloud and the claim's owner.
import { Router } from "express";
import { wfcClaimParamsSchema } from "@starter/shared/wfc";
import { HttpError } from "../lib/http-error.ts";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { getMemberScope, requireMember } from "../middleware/member.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as sale from "../services/wfc-sale.service.ts";

export const wfcRouter = Router();

const base = [requireTenantContext, requireAuth, requireTrustedOrigin];

function claimIdOf(params: unknown): string {
  const parsed = wfcClaimParamsSchema.safeParse(params);
  if (!parsed.success)
    throw new HttpError(400, "VALIDATION_FAILED", "Input tidak valid.");
  return parsed.data.claimId;
}

wfcRouter.get("/products", ...base, requireMember(), async (req, res) => {
  res.json({
    data: await sale.listWfcSaleProducts(getMemberScope(req), {
      outletId:
        typeof req.query.outletId === "string" ? req.query.outletId : "",
    }),
  });
});

wfcRouter.get("/claims", ...base, requireMember(), async (req, res) => {
  res.json({ data: await sale.listMyWfcClaims(getMemberScope(req)) });
});

wfcRouter.post(
  "/claims",
  ...base,
  jsonBody,
  requireMember(),
  async (req, res) => {
    res
      .status(201)
      .json({ data: await sale.holdWfcSeat(getMemberScope(req), req.body) });
  },
);

wfcRouter.get(
  "/claims/:claimId",
  ...base,
  requireMember(),
  async (req, res) => {
    res.json({
      data: await sale.getWfcClaim(getMemberScope(req), claimIdOf(req.params)),
    });
  },
);

wfcRouter.post(
  "/claims/:claimId/payment",
  ...base,
  requireMember(),
  async (req, res) => {
    res.json({
      data: await sale.refreshWfcPayment(
        getMemberScope(req),
        claimIdOf(req.params),
      ),
    });
  },
);
