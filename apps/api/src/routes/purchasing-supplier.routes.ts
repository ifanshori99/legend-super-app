// Supplier routes (PRD v1.7 §3.18 Supplier; bead legend-9yz slice C).
//
// Mount at `/api/inventory` next to the other inventory routers (the engineer
// wires it in routes/index.ts). Paths, bodies and queries come from the shared
// purchasing contract (`@starter/shared/inventory`).
//
// Writes need `purchasing.supplier.manage` over the tenant. Reads accept any of
// the purchasing permissions, each through its reachable scope (an outlet
// buyer or approver reads the tenant-level supplier list). The services
// re-check the permission inside their tenant transaction (deny by default).

import {
  createSupplierCatalogItemInputSchema,
  createSupplierContactInputSchema,
  createSupplierInputSchema,
  supplierIdSchema,
  supplierPriceHistoryQuerySchema,
  supplierQuerySchema,
  updateSupplierInputSchema,
} from "@starter/shared/inventory";
import { cursorPageQuerySchema } from "@starter/shared/core";
import { AccessError } from "@starter/shared/access";
import { Router, type Request, type RequestHandler } from "express";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  createSupplier,
  createSupplierCatalogItem,
  createSupplierContact,
  getSupplierDetail,
  getSupplierPriceHistory,
  listSupplierCatalog,
  listSuppliers,
  SUPPLIER_READ_PERMISSIONS,
  SUPPLIER_WRITE_PERMISSION,
  updateSupplier,
} from "../services/purchasing-supplier.service.ts";

const supplierIdOf = (req: Request) =>
  supplierIdSchema.parse(req.params.supplierId);

/** First read permission whose reachable scope the caller has; else 403. */
const requireSupplierRead: RequestHandler = async (req, res, next) => {
  for (const permission of SUPPLIER_READ_PERMISSIONS) {
    try {
      await new Promise<void>((resolve, reject) => {
        const gate = requireMenuPermission(permission)(
          req,
          res,
          (error?: unknown) => (error ? reject(error) : resolve()),
        );
        Promise.resolve(gate).catch(reject);
      });
      next();
      return;
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
    }
  }
  throw new AccessError(
    "PERMISSION_DENIED",
    "Your account cannot view suppliers in this tenant.",
  );
};

export function createPurchasingSupplierRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const write = requireTenantPermission(SUPPLIER_WRITE_PERMISSION);

  router.get("/suppliers", requireSupplierRead, async (req, res) => {
    const query = supplierQuerySchema.parse(req.query);
    res.json(
      await listSuppliers(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post("/suppliers", jsonBody, write, async (req, res) => {
    const input = createSupplierInputSchema.parse(req.body);
    const supplier = await createSupplier(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res.status(201).json({ data: supplier });
  });

  router.get(
    "/suppliers/:supplierId",
    requireSupplierRead,
    async (req, res) => {
      res.json({
        data: await getSupplierDetail(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          supplierIdOf(req),
        ),
      });
    },
  );

  router.patch("/suppliers/:supplierId", jsonBody, write, async (req, res) => {
    const supplierId = supplierIdOf(req);
    const input = updateSupplierInputSchema.parse(req.body);
    res.json({
      data: await updateSupplier(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        supplierId,
        input,
      ),
    });
  });

  router.post(
    "/suppliers/:supplierId/contacts",
    jsonBody,
    write,
    async (req, res) => {
      const supplierId = supplierIdOf(req);
      const input = createSupplierContactInputSchema.parse(req.body);
      const contact = await createSupplierContact(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        supplierId,
        input,
      );
      res.status(201).json({ data: contact });
    },
  );

  router.get(
    "/suppliers/:supplierId/catalog",
    requireSupplierRead,
    async (req, res) => {
      const supplierId = supplierIdOf(req);
      const query = cursorPageQuerySchema.parse(req.query);
      res.json(
        await listSupplierCatalog(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          supplierId,
          query,
        ),
      );
    },
  );

  router.post(
    "/suppliers/:supplierId/catalog",
    jsonBody,
    write,
    async (req, res) => {
      const supplierId = supplierIdOf(req);
      const input = createSupplierCatalogItemInputSchema.parse(req.body);
      const price = await createSupplierCatalogItem(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        supplierId,
        input,
      );
      res.status(201).json({ data: price });
    },
  );

  router.get(
    "/suppliers/:supplierId/prices",
    requireSupplierRead,
    async (req, res) => {
      const supplierId = supplierIdOf(req);
      const query = supplierPriceHistoryQuerySchema.parse(req.query);
      res.json({
        data: await getSupplierPriceHistory(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          supplierId,
          query,
        ),
      });
    },
  );

  return router;
}
