// AP/AR aging, fixed assets + depreciation, budgets HTTP routes (PRD v1.7
// §3.19 Utang & Piutang, Aset Tetap, Anggaran; bead legend-hpgo). Paths and
// schemas are the `@starter/shared/accounting` endpoint objects the FE client
// and mock mode use. Tenant comes from the server-minted context (TEN-02),
// never from params or bodies; permissions come from stored role assignments
// (TEN-03):
//
// - reads: `accounting.journal.view`; writes: `accounting.asset.manage`
//   (fixed assets, depreciation) and `accounting.budget.manage` (budgets);
// - a request naming an outlet (aging/budget filters, an outlet asset) needs
//   the permission on that outlet (requireOutletPermission); anything else
//   needs it tenant-wide (requireTenantPermission). Services re-check the
//   outlet of every row they touch, so the gate never widens what is shown.
//
// Mounted by the squad lead under /api/accounting next to the core router.

import { Router, type Request, type RequestHandler } from "express";
import {
  createAssetCategory,
  createFixedAsset,
  disposeFixedAsset,
  getAgingReport,
  getBudgetVsActual,
  getFixedAsset,
  listAssetCategories,
  listBudgets,
  listDepreciationRuns,
  listFixedAssets,
  listOpenItems,
  revalueFixedAsset,
  runDepreciation,
  upsertBudgets,
} from "@starter/shared/accounting";
import type { PermissionCode } from "@starter/shared/access";
import { userIdSchema } from "@starter/shared/core";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireOutletPermission,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  getAgingReport as getAgingReportService,
  listOpenItems as listOpenItemsService,
} from "../services/accounting-open-items.service.ts";
import {
  createAssetCategory as createAssetCategoryService,
  listAssetCategories as listAssetCategoriesService,
} from "../services/accounting-asset-categories.service.ts";
import {
  createFixedAsset as createFixedAssetService,
  disposeFixedAsset as disposeFixedAssetService,
  getFixedAsset as getFixedAssetService,
  listDepreciationRuns as listDepreciationRunsService,
  listFixedAssets as listFixedAssetsService,
  revalueFixedAsset as revalueFixedAssetService,
  runDepreciation as runDepreciationService,
} from "../services/accounting-fixed-assets.service.ts";
import {
  getBudgetVsActual as getBudgetVsActualService,
  listBudgets as listBudgetsService,
  upsertBudgets as upsertBudgetsService,
} from "../services/accounting-budgets.service.ts";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

/**
 * Outlet permission when the request names an outlet, tenant permission
 * otherwise (deny by default: no outlet named = whole tenant needed).
 */
function outletOrTenant(
  permission: PermissionCode,
  outletOf: (req: Request) => unknown,
): RequestHandler {
  const tenantWide = requireTenantPermission(permission);
  return (req, res, next) => {
    const outletId = outletOf(req);
    if (typeof outletId === "string")
      return requireOutletPermission(permission, () => outletId)(
        req,
        res,
        next,
      );
    return tenantWide(req, res, next);
  };
}

const queryOutlet = (req: Request) =>
  (req.query as Record<string, unknown>).outletId;
const bodyOutlet = (req: Request) =>
  (req.body as Record<string, unknown> | undefined)?.outletId;

export function createAccountingApFaRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const VIEW: PermissionCode = "accounting.journal.view";
  const ASSET: PermissionCode = "accounting.asset.manage";
  const BUDGET: PermissionCode = "accounting.budget.manage";
  const view = requireTenantPermission(VIEW);
  const manageAssets = requireTenantPermission(ASSET);
  const manageBudgets = requireTenantPermission(BUDGET);

  // ---- AP / AR aging ----------------------------------------------------
  router.get(
    route(getAgingReport.path),
    outletOrTenant(VIEW, queryOutlet),
    async (req, res) => {
      const query = getAgingReport.query.parse(req.query);
      res.json({
        data: await getAgingReportService(getScopedTenantContext(req), query),
      });
    },
  );

  router.get(
    route(listOpenItems.path),
    outletOrTenant(VIEW, queryOutlet),
    async (req, res) => {
      const query = listOpenItems.query.parse(req.query);
      res.json(await listOpenItemsService(getScopedTenantContext(req), query));
    },
  );

  // ---- Fixed assets -------------------------------------------------------
  router.get(route(listFixedAssets.path), view, async (req, res) => {
    const { legalEntityId } = listFixedAssets.params.parse(req.params);
    res.json(
      await listFixedAssetsService(getScopedTenantContext(req), legalEntityId),
    );
  });

  router.post(
    route(createFixedAsset.path),
    jsonBody,
    outletOrTenant(ASSET, bodyOutlet),
    async (req, res) => {
      const input = createFixedAsset.body.parse(req.body);
      const asset = await createFixedAssetService(
        getScopedTenantContext(req),
        input,
        actorId(req),
      );
      res
        .status(201)
        .location(`${BASE}/fixed-assets/${asset.id}`)
        .json({ data: asset });
    },
  );

  router.get(route(getFixedAsset.path), view, async (req, res) => {
    const { fixedAssetId } = getFixedAsset.params.parse(req.params);
    res.json({
      data: await getFixedAssetService(
        getScopedTenantContext(req),
        fixedAssetId,
      ),
    });
  });

  router.post(
    route(disposeFixedAsset.path),
    manageAssets,
    jsonBody,
    async (req, res) => {
      const { fixedAssetId } = disposeFixedAsset.params.parse(req.params);
      const input = disposeFixedAsset.body.parse(req.body);
      res.json({
        data: await disposeFixedAssetService(
          getScopedTenantContext(req),
          fixedAssetId,
          input,
          actorId(req),
        ),
      });
    },
  );

  router.post(
    route(revalueFixedAsset.path),
    manageAssets,
    jsonBody,
    async (req, res) => {
      const { fixedAssetId } = revalueFixedAsset.params.parse(req.params);
      const input = revalueFixedAsset.body.parse(req.body);
      res.json({
        data: await revalueFixedAssetService(
          getScopedTenantContext(req),
          fixedAssetId,
          input,
          actorId(req),
        ),
      });
    },
  );

  // Asset categories are tenant-level: tenant-wide permission, no outlet.
  router.get(route(listAssetCategories.path), view, async (req, res) => {
    res.json(await listAssetCategoriesService(getScopedTenantContext(req)));
  });

  router.post(
    route(createAssetCategory.path),
    manageAssets,
    jsonBody,
    async (req, res) => {
      const input = createAssetCategory.body.parse(req.body);
      const category = await createAssetCategoryService(
        getScopedTenantContext(req),
        input,
        actorId(req),
      );
      res.status(201).json({ data: category });
    },
  );

  router.get(route(listDepreciationRuns.path), view, async (req, res) => {
    const { legalEntityId } = listDepreciationRuns.params.parse(req.params);
    res.json(
      await listDepreciationRunsService(
        getScopedTenantContext(req),
        legalEntityId,
      ),
    );
  });

  router.post(
    route(runDepreciation.path),
    manageAssets,
    jsonBody,
    async (req, res) => {
      const input = runDepreciation.body.parse(req.body);
      const run = await runDepreciationService(
        getScopedTenantContext(req),
        input,
        actorId(req),
      );
      res.status(201).json({ data: run });
    },
  );

  // ---- Budgets ------------------------------------------------------------
  router.get(
    route(listBudgets.path),
    outletOrTenant(VIEW, queryOutlet),
    async (req, res) => {
      const query = listBudgets.query.parse(req.query);
      res.json(await listBudgetsService(getScopedTenantContext(req), query));
    },
  );

  router.put(
    route(upsertBudgets.path),
    manageBudgets,
    jsonBody,
    async (req, res) => {
      const input = upsertBudgets.body.parse(req.body);
      res.json(
        await upsertBudgetsService(
          getScopedTenantContext(req),
          input,
          actorId(req),
        ),
      );
    },
  );

  router.get(
    route(getBudgetVsActual.path),
    outletOrTenant(VIEW, queryOutlet),
    async (req, res) => {
      const query = getBudgetVsActual.query.parse(req.query);
      res.json(
        await getBudgetVsActualService(getScopedTenantContext(req), query),
      );
    },
  );

  return router;
}
