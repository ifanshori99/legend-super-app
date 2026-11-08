// Print queue API of the edge node (bead legend-46p; contract
// `listPrintJobs`, `reprintPrintJob`, `retryPrintJob`, `listEdgePrinters` in
// @starter/shared/edge; PRD v1.7 §3 F5 "Print Agent", EDG-05). Mount at
// /api/edge BEFORE edgeRouter: the edge route guard (edge/mode.ts) refuses
// /api/edge/* on the cloud, and these handlers refuse again when the process
// has no edge identity.
//
//   GET  /printers                       listEdgePrinters
//   GET  /print-jobs                     listPrintJobs
//   POST /print-jobs/:printJobId/reprint reprintPrintJob (audited)
//   POST /print-jobs/:printJobId/retry   retryPrintJob
//
// Tenant and outlet are the node's own (from its credential), never the
// request's (TEN-02). Middleware is per route, not router-wide, so the other
// /api/edge routes (health, status) stay untouched.
import { Router, type RequestHandler, type Response } from "express";
import type { PermissionCode } from "@starter/shared/access";
import { AccessError } from "@starter/shared/access";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  listPrintJobs,
  printJobParams,
  reprintPrintJob,
  retryPrintJob,
} from "@starter/shared/edge";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { sessionMfaVerifiedAt } from "../lib/mfa.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { findTenantContext } from "../middleware/tenant.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";
import {
  type PrintAccess,
  listPrintersForOutlet,
  listPrintJobsForOutlet,
  reprintPrintJobForOutlet,
  retryPrintJobForOutlet,
} from "../services/edge-print.service.ts";

/**
 * Operational staff of the outlet may see the print queue. No `order.view`:
 * job content can hold customer names.
 */
export const PRINT_READ_PERMISSIONS: readonly PermissionCode[] = [
  "pos.sale.create",
  "kds.ticket.process",
  "kds.expo.operate",
  "device.registry.manage",
];

/**
 * Reprint and retry can hand out a second receipt: cashiers only. Reprint or
 * retry of a `shift_report` also needs a shift permission (SHIFT_REPORT_PERMISSIONS).
 */
export const PRINT_WRITE_PERMISSIONS: readonly PermissionCode[] = [
  "pos.sale.create",
];

/** Shift report bytes carry cash totals: see or reprint them only with one of these. */
export const SHIFT_REPORT_PERMISSIONS: readonly PermissionCode[] = [
  "shift.cash.view_all",
  "shift.cash.approve_close",
];

function edgeIdentity() {
  const runtime = getEdgeRuntimeState();
  if (!runtime.edgeMode || !runtime.identity)
    throw new HttpError(
      503,
      "EDGE_NOT_READY",
      "Edge node belum siap melayani perangkat.",
    );
  return runtime.identity;
}

/** 503 off-edge first, then a tenant resolved for this request must be the node's. */
const requireNodeTenant: RequestHandler = (req, _res, next) => {
  const identity = edgeIdentity();
  const tenant = findTenantContext(req);
  if (tenant && tenant.tenantId !== identity.scope.tenantId)
    throw new HttpError(
      403,
      "TENANT_MISMATCH",
      "Tenant does not match this edge node.",
    );
  next();
};

/**
 * A signed-in member holding one of `permissions` on the node's outlet. Leaves
 * what the member may see of print content in `res.locals.printAccess`.
 */
function requireNodeOutletPermission(
  permissions: readonly PermissionCode[],
  message: string,
): RequestHandler {
  return async (req, res, next) => {
    const identity = edgeIdentity();
    const userId = getAuth(req).user.id;
    const tenantWide = establishScopedTenantContext(identity.context.tenant, {
      kind: "tenant",
    });
    const data = await loadTenantAccess(tenantWide, userId);
    const snapshot = resolveAccessSnapshot({
      tenant: identity.context.tenant,
      userId,
      ...data,
      mfaVerified: (await sessionMfaVerifiedAt(req)) !== null,
      now: new Date(),
    });
    const holdsAny = (codes: readonly PermissionCode[]) =>
      codes.some(
        (permission) =>
          snapshot.contextFor(permission, {
            type: "outlet",
            id: identity.scope.outletId,
          }) !== null,
      );
    if (!holdsAny(permissions))
      throw new AccessError("PERMISSION_DENIED", message);
    const access: PrintAccess = {
      content: holdsAny(["pos.sale.create"]),
      shiftReport: holdsAny(SHIFT_REPORT_PERMISSIONS),
    };
    res.locals.printAccess = access;
    next();
  };
}

const canRead = requireNodeOutletPermission(
  PRINT_READ_PERMISSIONS,
  "Akun Anda tidak dapat melihat antrean cetak outlet ini.",
);
const canWrite = requireNodeOutletPermission(
  PRINT_WRITE_PERMISSIONS,
  "Akun Anda tidak dapat mencetak ulang atau mengulang tugas cetak outlet ini.",
);

/** Set by canRead / canWrite; always present in the handlers behind them. */
function printAccess(res: Response): PrintAccess {
  return res.locals.printAccess as PrintAccess;
}

export const edgePrintRouter = Router();

edgePrintRouter.get(
  "/printers",
  requireNodeTenant,
  requireAuth,
  canRead,
  async (_req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      data: await listPrintersForOutlet({ context: edgeIdentity().context }),
    });
  },
);

edgePrintRouter.get(
  "/print-jobs",
  requireNodeTenant,
  requireAuth,
  canRead,
  async (req, res) => {
    const query = listPrintJobs.query.parse(req.query);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(
      await listPrintJobsForOutlet({
        context: edgeIdentity().context,
        query,
        access: printAccess(res),
      }),
    );
  },
);

edgePrintRouter.post(
  "/print-jobs/:printJobId/reprint",
  requireNodeTenant,
  requireAuth,
  requireTrustedOrigin,
  jsonBody,
  canWrite,
  async (req, res) => {
    const { printJobId } = printJobParams.parse(req.params);
    const body = reprintPrintJob.body.parse(req.body);
    res.setHeader("Cache-Control", "private, no-store");
    res.status(201).json({
      data: await reprintPrintJobForOutlet({
        context: edgeIdentity().context,
        printJobId,
        idempotencyKey: body.idempotencyKey,
        actorUserId: getAuth(req).user.id,
        access: printAccess(res),
      }),
    });
  },
);

edgePrintRouter.post(
  "/print-jobs/:printJobId/retry",
  requireNodeTenant,
  requireAuth,
  requireTrustedOrigin,
  jsonBody,
  canWrite,
  async (req, res) => {
    const { printJobId } = printJobParams.parse(req.params);
    const body = retryPrintJob.body.parse(req.body);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      data: await retryPrintJobForOutlet({
        context: edgeIdentity().context,
        printJobId,
        idempotencyKey: body.idempotencyKey,
        actorUserId: getAuth(req).user.id,
        access: printAccess(res),
      }),
    });
  },
);
