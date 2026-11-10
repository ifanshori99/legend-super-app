// Sales target API (WS-11, bead legend-ne81z). Mount (routes/index.ts):
// `apiRouter.use("/outlets/:outletId/sales-targets", salesTargetsRouter)`; the
// router merges params. The outlet comes from the path, never the body.
//
//   GET    /api/outlets/:outletId/sales-targets?from=&to=   report.sales.view
//   PUT    /api/outlets/:outletId/sales-targets             org.settings.manage
//          body { targets: [{ targetDate, targetIdr }] }    (1-62 distinct days)
//   PUT    /api/outlets/:outletId/sales-targets/month       org.settings.manage
//          body { month: "YYYY-MM", targetIdr }             spread evenly per day
//   DELETE /api/outlets/:outletId/sales-targets/:date       org.settings.manage
//
// Answers `{ data: SalesTargetDto[] }` (DELETE: 204). Staff session + trusted
// origin + tenant like the other outlet routers; the permission must reach the
// path's outlet (403 otherwise).
import { Router } from "express";
import { businessDateSchema, outletIdSchema, z } from "@starter/shared/core";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import * as salesTargets from "../services/sales-targets.service.ts";

export const salesTargetsRouter = Router({ mergeParams: true });

salesTargetsRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

const MAX_RANGE_DAYS = 366;
const MAX_DAYS_PER_WRITE = 62;
const MAX_TARGET_IDR = 1_000_000_000_000; // Rp 1 trillion per day

const outletParams = z.strictObject({ outletId: outletIdSchema });
const dateParams = z.strictObject({
  outletId: outletIdSchema,
  date: businessDateSchema,
});
const targetIdrSchema = z.number().int().min(0).max(MAX_TARGET_IDR);

const listQuery = z.strictObject({
  from: businessDateSchema,
  to: businessDateSchema,
});
const upsertBody = z.strictObject({
  targets: z
    .array(
      z.strictObject({
        targetDate: businessDateSchema,
        targetIdr: targetIdrSchema,
      }),
    )
    .min(1)
    .max(MAX_DAYS_PER_WRITE)
    .refine(
      (targets) =>
        new Set(targets.map((target) => target.targetDate)).size ===
        targets.length,
      "Target dates must be distinct",
    ),
});
const monthBody = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  targetIdr: targetIdrSchema,
});

const view = requireOutletPermission("report.sales.view", (req) =>
  String(req.params.outletId ?? ""),
);
const manage = requireOutletPermission("org.settings.manage", (req) =>
  String(req.params.outletId ?? ""),
);

salesTargetsRouter.get("/", view, async (req, res) => {
  const { outletId } = outletParams.parse(req.params);
  const range = listQuery.parse(req.query);
  const spanDays =
    (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
  if (spanDays < 1 || spanDays > MAX_RANGE_DAYS)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      `from..to must span 1-${MAX_RANGE_DAYS} days.`,
    );
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    data: await salesTargets.listSalesTargets(
      getScopedTenantContext(req),
      outletId,
      range,
    ),
  });
});

salesTargetsRouter.put("/", manage, jsonBody, async (req, res) => {
  const { outletId } = outletParams.parse(req.params);
  const { targets } = upsertBody.parse(req.body);
  res.json({
    data: await salesTargets.upsertSalesTargets(
      getScopedTenantContext(req),
      outletId,
      targets,
      getAuth(req).user.id,
    ),
  });
});

salesTargetsRouter.put("/month", manage, jsonBody, async (req, res) => {
  const { outletId } = outletParams.parse(req.params);
  const { month, targetIdr } = monthBody.parse(req.body);
  res.json({
    data: await salesTargets.upsertMonthTarget(
      getScopedTenantContext(req),
      outletId,
      month,
      targetIdr,
      getAuth(req).user.id,
    ),
  });
});

salesTargetsRouter.delete("/:date", manage, async (req, res) => {
  const { outletId, date } = dateParams.parse(req.params);
  const removed = await salesTargets.deleteSalesTarget(
    getScopedTenantContext(req),
    outletId,
    date,
    getAuth(req).user.id,
  );
  if (!removed)
    throw new HttpError(404, "NOT_FOUND", "No target for this date.");
  res.status(204).end();
});
