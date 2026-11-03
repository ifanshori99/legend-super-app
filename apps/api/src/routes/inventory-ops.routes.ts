// Inventory operation routes (PRD v1.7 §3 F16 "Batch & Kedaluwarsa", "Par
// Level & Saran Pembelian", "Waste & Spoilage", "Lokasi Stok ... transfer
// antarlokasi"; §3 F17 "Produksi Batch"; AI-08; bead legend-ugo).
//
// Mount at `/api/inventory` next to `inventoryRouter` (the lead wires it in
// routes/index.ts). Paths and bodies of production orders, waste logs and
// transfers come from `@starter/shared/inventory` (`inventoryEndpoints`);
// expiry alerts, stock alerts and purchase suggestions have no contract entry
// yet, so their query/response schemas live next to their services until the
// lead moves them into the shared contract (see the bead report).
//
// The tenant comes from the server-minted context (TEN-02). Outlet-scoped
// reads take `outletId` from the query and creates from the body; the role
// must cover that outlet (TEN-03). The production transition route only knows
// the order id, so it mints the caller's reachable scope and the service
// re-checks the permission against the order's own outlet. Services re-check
// every permission inside their tenant transaction (deny by default).

import {
  expiryAlertQuerySchema,
  stockAlertQuerySchema,
  purchaseSuggestionQuerySchema,
} from "@starter/shared/inventory";
import { Router, type Request } from "express";
import {
  createProductionOrderInputSchema,
  createStockTransferInputSchema,
  createWasteLogInputSchema,
  productionOrderIdSchema,
  productionOrderQuerySchema,
  stockTransferListQuerySchema,
  transitionProductionOrderInputSchema,
  wasteLogQuerySchema,
} from "@starter/shared/inventory";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { listExpiryAlerts } from "../services/inventory-expiry.service.ts";
import { listStockAlerts } from "../services/inventory-par-alerts.service.ts";
import {
  createProductionOrder,
  listProductionOrders,
  PRODUCTION_WRITE_PERMISSION,
  transitionProductionOrderStatus,
} from "../services/inventory-production.service.ts";
import { listPurchaseSuggestions } from "../services/inventory-suggestions.service.ts";
import {
  createStockTransfer,
  listStockTransfers,
} from "../services/inventory-transfer.service.ts";
import {
  createWasteLog,
  listWasteLogs,
} from "../services/inventory-waste.service.ts";

const queryOutlet = (req: Request) => String(req.query.outletId);
/** Create routes: the outlet comes from the (already parsed) JSON body. */
const bodyOutlet = (req: Request) =>
  String((req.body as { outletId?: unknown } | undefined)?.outletId);

export function createInventoryOpsRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const viewOutlet = requireOutletPermission(
    "inventory.stock.view",
    queryOutlet,
  );

  // ------------------------------------------------------ production orders

  router.get("/production-orders", viewOutlet, async (req, res) => {
    const query = productionOrderQuerySchema.parse(req.query);
    res.json(
      await listProductionOrders(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    "/production-orders",
    jsonBody,
    requireOutletPermission(PRODUCTION_WRITE_PERMISSION, bodyOutlet),
    async (req, res) => {
      const input = createProductionOrderInputSchema.parse(req.body);
      const order = await createProductionOrder(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      );
      res.status(201).json({ data: order });
    },
  );

  router.post(
    "/production-orders/:productionOrderId/transitions",
    jsonBody,
    // Reachable scope for the permission (tenant-wide, else the union of the
    // caller's outlets); fails closed without reach. The service checks the
    // order's concrete outlet.
    requireMenuPermission(PRODUCTION_WRITE_PERMISSION),
    async (req, res) => {
      const productionOrderId = productionOrderIdSchema.parse(
        req.params.productionOrderId,
      );
      const input = transitionProductionOrderInputSchema.parse(req.body);
      res.json({
        data: await transitionProductionOrderStatus(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          productionOrderId,
          input,
        ),
      });
    },
  );

  // ------------------------------------------------------------ waste logs

  router.get("/waste-logs", viewOutlet, async (req, res) => {
    const query = wasteLogQuerySchema.parse(req.query);
    res.json(
      await listWasteLogs(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    "/waste-logs",
    jsonBody,
    requireOutletPermission("inventory.waste.record", bodyOutlet),
    async (req, res) => {
      const input = createWasteLogInputSchema.parse(req.body);
      const log = await createWasteLog(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      );
      res.status(201).json({ data: log });
    },
  );

  // ------------------------------------------------------------- transfers

  router.get("/transfers", viewOutlet, async (req, res) => {
    const query = stockTransferListQuerySchema.parse(req.query);
    res.json(
      await listStockTransfers(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    "/transfers",
    jsonBody,
    requireOutletPermission("inventory.stock.transfer", bodyOutlet),
    async (req, res) => {
      const input = createStockTransferInputSchema.parse(req.body);
      const transfer = await createStockTransfer(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      );
      res.status(201).json({ data: transfer });
    },
  );

  // ------------------------------------------------- alerts and suggestions

  router.get("/expiry-alerts", viewOutlet, async (req, res) => {
    const query = expiryAlertQuerySchema.parse(req.query);
    res.json({
      data: await listExpiryAlerts(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    });
  });

  router.get("/stock-alerts", viewOutlet, async (req, res) => {
    const query = stockAlertQuerySchema.parse(req.query);
    res.json(
      await listStockAlerts(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.get("/purchase-suggestions", viewOutlet, async (req, res) => {
    const query = purchaseSuggestionQuerySchema.parse(req.query);
    res.json({
      data: await listPurchaseSuggestions(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    });
  });

  return router;
}
