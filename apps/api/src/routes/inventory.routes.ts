// Inventory routes (PRD v1.7 §16, §6 E; bead legend-98t, INV-01). Paths and
// payloads come from `@starter/shared/inventory` (`inventoryEndpoints`); this
// router implements the slice owned by this bead (items, UOMs, locations,
// ledger, balances, batches) and leaves counts/waste/recipes/production to the
// beads that own them.
//
// The tenant comes from the server-minted context (TEN-02), never from the
// request. Tenant-wide master data needs a tenant-scope permission; the
// outlet-scoped lists take `outletId` from the query and require the caller's
// role to cover that outlet (TEN-03). The services re-check both.

import { Router } from "express";
import { cursorPageQuerySchema } from "@starter/shared/core";
import {
  createInventoryItemInputSchema,
  inventoryItemIdSchema,
  inventoryItemListQuerySchema,
  stockBalanceQuerySchema,
  stockBatchQuerySchema,
  stockLedgerQuerySchema,
  stockLocationListQuerySchema,
  updateInventoryItemInputSchema,
} from "@starter/shared/inventory";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireAnyTenantPermission,
  requireOutletPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  createInventoryItem,
  getInventoryItem,
  listInventoryItems,
  listStockBalances,
  listStockBatches,
  listStockLedger,
  listStockLocations,
  listUomConversions,
  listUoms,
  updateInventoryItem,
} from "../services/inventory.service";

export const inventoryRouter = Router();

inventoryRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

// Transitional (legend-1ozj): tenants created before the code existed hold
// `inventory.stock.receive` but not `inventory.item.manage` until a backfill
// migration lands, so either code writes item master data.
const manageItemsTenant = requireAnyTenantPermission([
  "inventory.item.manage",
  "inventory.stock.receive",
]);
// Catalog reads reach the caller's tenant or outlets; the service re-checks.
const viewCatalog = requireMenuPermission("inventory.stock.view");
const viewOutlet = requireOutletPermission("inventory.stock.view", (req) =>
  String(req.query.outletId),
);

// ------------------------------------------------------------ item master

inventoryRouter.get("/items", viewCatalog, async (req, res) => {
  const query = inventoryItemListQuerySchema.parse(req.query);
  res.json(
    await listInventoryItems(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

inventoryRouter.get("/items/:itemId", viewCatalog, async (req, res) => {
  const itemId = inventoryItemIdSchema.parse(req.params.itemId);
  res.json({
    data: await getInventoryItem(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      itemId,
    ),
  });
});

inventoryRouter.get(
  "/items/:itemId/uom-conversions",
  viewCatalog,
  async (req, res) => {
    const itemId = inventoryItemIdSchema.parse(req.params.itemId);
    res.json({
      data: await listUomConversions(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        itemId,
      ),
    });
  },
);

inventoryRouter.post(
  "/items",
  manageItemsTenant,
  jsonBody,
  async (req, res) => {
    const input = createInventoryItemInputSchema.parse(req.body);
    const item = await createInventoryItem(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res
      .status(201)
      .location(`/api/inventory/items/${item.id}`)
      .json({ data: item });
  },
);

inventoryRouter.patch(
  "/items/:itemId",
  manageItemsTenant,
  jsonBody,
  async (req, res) => {
    const itemId = inventoryItemIdSchema.parse(req.params.itemId);
    const input = updateInventoryItemInputSchema.parse(req.body);
    res.json({
      data: await updateInventoryItem(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        itemId,
        input,
      ),
    });
  },
);

// ------------------------------------------------------------------ units

inventoryRouter.get("/uoms", viewCatalog, async (req, res) => {
  const query = cursorPageQuerySchema.parse(req.query);
  res.json(
    await listUoms(getScopedTenantContext(req), getAuth(req).user.id, query),
  );
});

// ---------------------------------------------------- outlet-scoped lists

inventoryRouter.get("/locations", viewOutlet, async (req, res) => {
  const query = stockLocationListQuerySchema.parse(req.query);
  res.json(
    await listStockLocations(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

inventoryRouter.get("/stock-ledger", viewOutlet, async (req, res) => {
  const query = stockLedgerQuerySchema.parse(req.query);
  res.json(
    await listStockLedger(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

inventoryRouter.get("/balances", viewOutlet, async (req, res) => {
  const query = stockBalanceQuerySchema.parse(req.query);
  res.json(
    await listStockBalances(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

inventoryRouter.get("/batches", viewOutlet, async (req, res) => {
  const query = stockBatchQuerySchema.parse(req.query);
  res.json(
    await listStockBatches(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});
