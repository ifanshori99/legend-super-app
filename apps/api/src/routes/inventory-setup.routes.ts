// Inventory setup routes (PRD v1.7 §16 "Lokasi Stok", "Item Bahan & Satuan",
// "Par Level & Saran Pembelian", "Pemotongan Otomatis"; bead legend-gjmk).
// Paths and payloads come from `@starter/shared/inventory`
// (`inventoryEndpoints`). Mount at `/api/inventory` next to `inventoryRouter`;
// the lead wires it in routes/index.ts.
//
// The tenant comes from the server-minted context (TEN-02). Tenant-wide master
// data (alternates, conversions, settings) needs a tenant-scope permission.
// Outlet-owned writes take the outlet from the body (create) or from the stored
// row (id-only routes: the service loads the row under RLS and re-checks the
// permission against its outlet, TEN-03). Routes stay thin; services re-check
// permission and scope.

import { Router } from "express";
import {
  createInventoryItemAlternateInputSchema,
  createParLevelInputSchema,
  createStockLocationInputSchema,
  createUomConversionInputSchema,
  inventoryItemAlternateIdSchema,
  inventoryItemIdSchema,
  parLevelIdSchema,
  parLevelQuerySchema,
  stockLocationIdSchema,
  uomConversionIdSchema,
  updateInventorySettingsInputSchema,
  updateParLevelInputSchema,
  updateStockLocationInputSchema,
} from "@starter/shared/inventory";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  createInventoryItemAlternate,
  createParLevel,
  createStockLocation,
  createUomConversion,
  deleteInventoryItemAlternate,
  deleteParLevel,
  deleteUomConversion,
  listInventoryItemAlternates,
  listParLevels,
  updateParLevel,
  updateStockLocation,
} from "../services/inventory-setup.service";
import {
  getInventorySettings,
  updateInventorySettings,
} from "../services/inventory-settings.service";

export function createInventorySetupRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const viewTenant = requireTenantPermission("inventory.stock.view");
  const writeTenant = requireTenantPermission("inventory.stock.receive");
  const manageSettings = requireTenantPermission(
    "inventory.adjustment.approve",
  );
  const viewOutlet = requireOutletPermission("inventory.stock.view", (req) =>
    String(req.query.outletId),
  );
  // Create routes: the outlet comes from the (already parsed) body.
  const writeBodyOutlet = requireOutletPermission(
    "inventory.stock.receive",
    (req) => String((req.body as { outletId?: unknown } | undefined)?.outletId),
  );
  // Id-only outlet-owned routes: mints the caller's reachable scope for the
  // permission (tenant-wide, else the union of their outlets); the service
  // then checks the concrete row's outlet. Fails closed without reach.
  const writeReachable = requireMenuPermission("inventory.stock.receive");

  // ------------------------------------------------------------ locations

  router.post("/locations", jsonBody, writeBodyOutlet, async (req, res) => {
    const input = createStockLocationInputSchema.parse(req.body);
    const location = await createStockLocation(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res
      .status(201)
      .location(`/api/inventory/locations/${location.id}`)
      .json({ data: location });
  });

  router.patch(
    "/locations/:locationId",
    jsonBody,
    writeReachable,
    async (req, res) => {
      const locationId = stockLocationIdSchema.parse(req.params.locationId);
      const input = updateStockLocationInputSchema.parse(req.body);
      res.json({
        data: await updateStockLocation(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          locationId,
          input,
        ),
      });
    },
  );

  // ------------------------------------------------------------ alternates

  router.get("/items/:itemId/alternates", viewTenant, async (req, res) => {
    const itemId = inventoryItemIdSchema.parse(req.params.itemId);
    res.json({
      data: await listInventoryItemAlternates(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        itemId,
      ),
    });
  });

  router.post(
    "/items/:itemId/alternates",
    writeTenant,
    jsonBody,
    async (req, res) => {
      const itemId = inventoryItemIdSchema.parse(req.params.itemId);
      const input = createInventoryItemAlternateInputSchema.parse(req.body);
      const alternate = await createInventoryItemAlternate(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        itemId,
        input,
      );
      res.status(201).json({ data: alternate });
    },
  );

  router.delete(
    "/items/:itemId/alternates/:alternateId",
    writeTenant,
    async (req, res) => {
      const itemId = inventoryItemIdSchema.parse(req.params.itemId);
      const alternateId = inventoryItemAlternateIdSchema.parse(
        req.params.alternateId,
      );
      await deleteInventoryItemAlternate(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        itemId,
        alternateId,
      );
      res.status(204).end();
    },
  );

  // ------------------------------------------------------- UOM conversions

  router.post(
    "/items/:itemId/uom-conversions",
    writeTenant,
    jsonBody,
    async (req, res) => {
      const itemId = inventoryItemIdSchema.parse(req.params.itemId);
      const input = createUomConversionInputSchema.parse(req.body);
      const conversion = await createUomConversion(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        itemId,
        input,
      );
      res.status(201).json({ data: conversion });
    },
  );

  router.delete(
    "/items/:itemId/uom-conversions/:conversionId",
    writeTenant,
    async (req, res) => {
      const itemId = inventoryItemIdSchema.parse(req.params.itemId);
      const conversionId = uomConversionIdSchema.parse(req.params.conversionId);
      await deleteUomConversion(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        itemId,
        conversionId,
      );
      res.status(204).end();
    },
  );

  // ------------------------------------------------------------ par levels

  router.get("/par-levels", viewOutlet, async (req, res) => {
    const query = parLevelQuerySchema.parse(req.query);
    res.json(
      await listParLevels(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post("/par-levels", jsonBody, writeBodyOutlet, async (req, res) => {
    const input = createParLevelInputSchema.parse(req.body);
    const par = await createParLevel(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res
      .status(201)
      .location(`/api/inventory/par-levels/${par.id}`)
      .json({ data: par });
  });

  router.patch(
    "/par-levels/:parLevelId",
    jsonBody,
    writeReachable,
    async (req, res) => {
      const parLevelId = parLevelIdSchema.parse(req.params.parLevelId);
      const input = updateParLevelInputSchema.parse(req.body);
      res.json({
        data: await updateParLevel(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          parLevelId,
          input,
        ),
      });
    },
  );

  router.delete("/par-levels/:parLevelId", writeReachable, async (req, res) => {
    const parLevelId = parLevelIdSchema.parse(req.params.parLevelId);
    await deleteParLevel(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      parLevelId,
    );
    res.status(204).end();
  });

  // -------------------------------------------------------------- settings

  router.get("/settings", viewTenant, async (req, res) => {
    res.json({
      data: await getInventorySettings(
        getScopedTenantContext(req),
        getAuth(req).user.id,
      ),
    });
  });

  router.put("/settings", manageSettings, jsonBody, async (req, res) => {
    const input = updateInventorySettingsInputSchema.parse(req.body);
    res.json({
      data: await updateInventorySettings(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      ),
    });
  });

  return router;
}
