// Cloud printer registry API (bead legend-2lp.6; PRD v1.7 §3 F5 "Print
// Agent", "Registri Perangkat"). Mount at /api/printers (cloud only; /edge is
// edge-only).
//
//   GET    /            device.registry.manage on query.outletId
//   POST   /            device.registry.manage on body.outletId; 201
//   GET    /:printerId  device.registry.manage on the printer's outlet
//   PATCH  /:printerId  device.registry.manage on the printer's outlet
//   DELETE /:printerId  device.registry.manage on the printer's outlet; 204,
//                       409 while it is another printer's fallback or has jobs
//
// Staff routes: signed-in, trusted origin, tenant from the domain (TEN-02),
// back-office surface (AUTH-05). Inputs are strict; tenant ids are never
// accepted. A printer id is looked up under tenant-wide RLS first, then the
// permission is checked on its outlet; an unknown printer, another tenant's
// printer and a printer in an outlet the caller cannot reach all answer the
// same 404.
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { AccessError } from "@starter/shared/access";
import { CoreError, outletIdSchema } from "@starter/shared/core";
import {
  createPrinter as createPrinterEndpoint,
  listPrinters as listPrintersEndpoint,
  printerParams,
  updatePrinter as updatePrinterEndpoint,
} from "@starter/shared/edge";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import {
  createPrinter,
  deletePrinter,
  findPrinterOutletId,
  getPrinter,
  listPrinters,
  updatePrinter,
} from "../services/printer-registry.service.ts";

const notFound = () => new CoreError("NOT_FOUND", "Printer tidak ditemukan.");

const backOffice: RequestHandler[] = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
];

/** Reads the outlet for the permission check; Zod rejects bad input (422). */
const bodyOutlet = (req: { body?: unknown }) =>
  outletIdSchema.parse(
    (req.body as { outletId?: unknown } | undefined)?.outletId,
  );

const printerOutlets = new WeakMap<Request, string>();

/**
 * Permission on the outlet of the printer named in the path. Everything that
 * is not "you may manage this printer" is the same 404.
 */
function requirePrinterPermission(): RequestHandler {
  const check = requireOutletPermission("device.registry.manage", (req) => {
    const outletId = printerOutlets.get(req);
    if (!outletId) throw notFound();
    return outletId;
  });
  return async (req: Request, res: Response, next: NextFunction) => {
    const { printerId } = printerParams.parse(req.params);
    const outletId = await findPrinterOutletId(
      getTenantContext(req),
      printerId,
    );
    if (!outletId) throw notFound();
    printerOutlets.set(req, outletId);
    try {
      await check(req, res, () => undefined);
    } catch (error) {
      if (error instanceof AccessError && error.code === "PERMISSION_DENIED")
        throw notFound();
      throw error;
    }
    next();
  };
}

export const printerRouter = Router();

printerRouter.get(
  "/",
  ...backOffice,
  requireOutletPermission(
    "device.registry.manage",
    (req) => listPrintersEndpoint.query.parse(req.query).outletId,
  ),
  async (req, res) => {
    const query = listPrintersEndpoint.query.parse(req.query);
    res.json({ data: await listPrinters(getScopedTenantContext(req), query) });
  },
);

printerRouter.post(
  "/",
  ...backOffice,
  jsonBody,
  requireOutletPermission("device.registry.manage", bodyOutlet),
  async (req, res) => {
    const input = createPrinterEndpoint.body.parse(req.body);
    const printer = await createPrinter(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res
      .status(201)
      .location(`/api/printers/${encodeURIComponent(printer.id)}`)
      .json({ data: printer });
  },
);

printerRouter.get(
  "/:printerId",
  ...backOffice,
  requirePrinterPermission(),
  async (req, res) => {
    const { printerId } = printerParams.parse(req.params);
    res.json({
      data: await getPrinter(getScopedTenantContext(req), printerId),
    });
  },
);

printerRouter.patch(
  "/:printerId",
  ...backOffice,
  jsonBody,
  requirePrinterPermission(),
  async (req, res) => {
    const { printerId } = printerParams.parse(req.params);
    const input = updatePrinterEndpoint.body.parse(req.body);
    res.json({
      data: await updatePrinter(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        printerId,
        input,
      ),
    });
  },
);

printerRouter.delete(
  "/:printerId",
  ...backOffice,
  requirePrinterPermission(),
  async (req, res) => {
    const { printerId } = printerParams.parse(req.params);
    await deletePrinter(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      printerId,
    );
    res.status(204).end();
  },
);
