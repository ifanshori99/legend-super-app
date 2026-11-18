// Menu back-office routes (bead legend-lmk; PRD v1.7 §8 "Master Menu & Harga").
// Thin Express handlers: parse with the shared contract schemas, call the
// service inside the caller's server-minted scope, choose the status. Every
// route runs after requireAuth, the origin check, requireTenantContext and a
// menu permission gate; services re-check the concrete brand/outlet target.
// /availability alone also serves the KDS on a shared device (legend-3z0ds).
//
// One exception to the API's 100 kB body limit: the menu-image upload carries
// a base64 JPEG (contract MENU_IMAGE_MAX_BYTES ≈ 600 kB decoded), so this
// router mounts a 1 MiB parser for that path only (contract note on
// menuImageUploadInputSchema).

import express, { Router, type RequestHandler } from "express";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  createCategory,
  createCombo,
  createItem,
  createModifier,
  createModifierGroup,
  createStation,
  createVariant,
  deleteCategory,
  deleteCombo,
  deleteItem,
  deleteModifier,
  deleteModifierGroup,
  deleteStation,
  deleteVariant,
  getItem,
  getItemModifierGroups,
  listCategories,
  listCombos,
  listItems,
  listModifierGroups,
  listModifiers,
  listStations,
  listVariants,
  reorderCategories,
  reorderItems,
  setItemModifierGroups,
  updateCategory,
  updateCombo,
  updateItem,
  updateModifier,
  updateModifierGroup,
  updateStation,
  updateVariant,
} from "../services/menu.service";
import {
  createPriceList,
  deletePriceList,
  listAvailability,
  listPriceListItems,
  listPriceLists,
  setAvailabilityStatus,
  setPriceListItems,
  updateAvailability,
  updatePriceList,
} from "../services/menu-pricing.service";
import {
  createMenuMediaUrls,
  uploadMenuPhoto,
  type MenuMediaDeps,
} from "../services/menu-media.service";
import {
  createCategory as createCategoryEndpoint,
  createCombo as createComboEndpoint,
  createItem as createItemEndpoint,
  createModifier as createModifierEndpoint,
  createModifierGroup as createModifierGroupEndpoint,
  createPriceList as createPriceListEndpoint,
  createStation as createStationEndpoint,
  createVariant as createVariantEndpoint,
  deleteCategory as deleteCategoryEndpoint,
  deleteCombo as deleteComboEndpoint,
  deleteItem as deleteItemEndpoint,
  deleteModifier as deleteModifierEndpoint,
  deleteModifierGroup as deleteModifierGroupEndpoint,
  deletePriceList as deletePriceListEndpoint,
  deleteStation as deleteStationEndpoint,
  deleteVariant as deleteVariantEndpoint,
  getItem as getItemEndpoint,
  getItemModifierGroups as getItemModifierGroupsEndpoint,
  listAvailability as listAvailabilityEndpoint,
  listCategories as listCategoriesEndpoint,
  listCombos as listCombosEndpoint,
  listItems as listItemsEndpoint,
  listModifierGroups as listModifierGroupsEndpoint,
  listModifiers as listModifiersEndpoint,
  listPriceListItems as listPriceListItemsEndpoint,
  listPriceLists as listPriceListsEndpoint,
  listStations as listStationsEndpoint,
  listVariants as listVariantsEndpoint,
  reorderCategories as reorderCategoriesEndpoint,
  reorderItems as reorderItemsEndpoint,
  setAvailabilityStatus as setAvailabilityStatusEndpoint,
  setItemModifierGroups as setItemModifierGroupsEndpoint,
  setPriceListItems as setPriceListItemsEndpoint,
  updateAvailability as updateAvailabilityEndpoint,
  updateCategory as updateCategoryEndpoint,
  updateCombo as updateComboEndpoint,
  updateItem as updateItemEndpoint,
  updateModifier as updateModifierEndpoint,
  updateModifierGroup as updateModifierGroupEndpoint,
  updatePriceList as updatePriceListEndpoint,
  updateStation as updateStationEndpoint,
  updateVariant as updateVariantEndpoint,
  uploadMenuImage as uploadMenuImageEndpoint,
} from "@starter/shared/menu";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff";
import {
  getAuth,
  requireAuth,
  requireAuthAllowSharedDevice,
} from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  requireMenuPermission,
  requireStationPermission,
  requireStationScopePermission,
  getStationScope,
} from "../middleware/permissions";
import { getScopedTenantContext } from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import { HttpError } from "../lib/http-error";

/** Router-relative path of a contract endpoint ("/api/menu/x" -> "/x"). */
function relative(endpoint: AnyEndpoint): string {
  return endpoint.path.replace(/^\/api\/menu/, "") || "/";
}

/** Contract path as the Location header: the created id, or a path param. */
function location(endpoint: AnyEndpoint, id: string): string {
  return /:[A-Za-z]/.test(endpoint.path)
    ? endpoint.path.replace(/:[A-Za-z][A-Za-z0-9]*/, id)
    : `${endpoint.path}/${id}`;
}

const AVAILABILITY_PATH = /^\/availability(?:\/|$)/i;

/** Skips `guard` for /availability, which has its own guard chain above it. */
function exceptAvailability(guard: RequestHandler): RequestHandler {
  return (req, res, next) =>
    AVAILABILITY_PATH.test(req.path) ? next() : guard(req, res, next);
}

const IMAGE_BODY_LIMIT_BYTES = 1024 * 1024;

/** JSON parser with a larger limit, for the image upload path only. */
const menuImageBody: RequestHandler = (req, res, next) => {
  const contentType = req
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json")
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Send an application/json body.",
    );
  express.json({ limit: IMAGE_BODY_LIMIT_BYTES, strict: true })(req, res, next);
};

export function createMenuRouter(
  options: {
    storage?: ObjectStorage | null;
    scanner?: MenuMediaDeps["scanner"];
  } = {},
): Router {
  const router = Router();
  const resolveMediaUrls = createMenuMediaUrls(options.storage ?? null);
  // Availability is the one POS/KDS part ("sold out" button): it opts in to
  // shared devices and then needs the cashier token there. Every other menu
  // route is back office and refuses a session used on a shared device.
  router.use(
    "/availability",
    requireAuthAllowSharedDevice,
    requireTrustedOrigin,
    requireTenantContext,
    resolveActingStaff,
    requireActingStaffOnSharedDevice,
  );
  router.use(
    exceptAvailability(requireAuth),
    exceptAvailability(requireTrustedOrigin),
    exceptAvailability(requireTenantContext),
  );

  const view = requireMenuPermission("menu.item.view");
  const manage = requireMenuPermission("menu.item.manage");
  const priceView = requireMenuPermission("menu.price.view");
  const priceManage = requireMenuPermission("menu.price.manage");
  const availabilityToggle = requireMenuPermission("menu.availability.toggle");
  // Station-bound list: also admits a station-scoped grant; the service
  // narrows the rows to the caller's stations (legend-fsb7).
  const viewStations = requireStationScopePermission("menu.item.view");
  // Station-bound config routes authorize the station target itself, so a
  // station-scoped grant manages only its own station (legend-fsb7, TEN-03).
  const manageStation = requireStationPermission("menu.item.manage", (req) =>
    typeof req.params.stationId === "string" ? req.params.stationId : undefined,
  );

  // ------------------------------------------------------------ categories

  router.get(relative(listCategoriesEndpoint), view, async (req, res) => {
    const query = listCategoriesEndpoint.query.parse(req.query);
    res.json(
      await listCategories(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    relative(createCategoryEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const body = createCategoryEndpoint.body.parse(req.body);
      const category = await createCategory(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
      );
      res
        .status(201)
        .location(location(createCategoryEndpoint, category.id))
        .json({ data: category });
    },
  );

  router.put(
    relative(reorderCategoriesEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const body = reorderCategoriesEndpoint.body.parse(req.body);
      await reorderCategories(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body.orderedIds,
      );
      res.status(204).end();
    },
  );

  router.patch(
    relative(updateCategoryEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const params = updateCategoryEndpoint.params.parse(req.params);
      const body = updateCategoryEndpoint.body.parse(req.body);
      res.json({
        data: await updateCategory(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.categoryId,
          body,
        ),
      });
    },
  );

  router.delete(relative(deleteCategoryEndpoint), manage, async (req, res) => {
    const params = deleteCategoryEndpoint.params.parse(req.params);
    await deleteCategory(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      params.categoryId,
    );
    res.status(204).end();
  });

  // -------------------------------------------------------------- stations

  router.get(relative(listStationsEndpoint), viewStations, async (req, res) => {
    const query = listStationsEndpoint.query.parse(req.query);
    // Station scope, not getScopedTenantContext: listStations narrows the
    // rows to the caller's stations (legend-fsb7).
    res.json(
      await listStations(
        getStationScope(req).context,
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    relative(createStationEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const body = createStationEndpoint.body.parse(req.body);
      const station = await createStation(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
      );
      res
        .status(201)
        .location(location(createStationEndpoint, station.id))
        .json({ data: station });
    },
  );

  router.patch(
    relative(updateStationEndpoint),
    manageStation,
    jsonBody,
    async (req, res) => {
      const params = updateStationEndpoint.params.parse(req.params);
      const body = updateStationEndpoint.body.parse(req.body);
      res.json({
        data: await updateStation(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.stationId,
          body,
        ),
      });
    },
  );

  router.delete(
    relative(deleteStationEndpoint),
    manageStation,
    async (req, res) => {
      const params = deleteStationEndpoint.params.parse(req.params);
      await deleteStation(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        params.stationId,
      );
      res.status(204).end();
    },
  );

  // ----------------------------------------------------------------- items

  router.get(relative(listItemsEndpoint), view, async (req, res) => {
    const query = listItemsEndpoint.query.parse(req.query);
    res.json(
      await listItems(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
        new Date(),
        resolveMediaUrls,
      ),
    );
  });

  router.post(
    relative(createItemEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const body = createItemEndpoint.body.parse(req.body);
      const item = await createItem(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
        new Date(),
        resolveMediaUrls,
      );
      res
        .status(201)
        .location(location(createItemEndpoint, item.id))
        .json({ data: item });
    },
  );

  router.put(
    relative(reorderItemsEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const body = reorderItemsEndpoint.body.parse(req.body);
      await reorderItems(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body.orderedIds,
      );
      res.status(204).end();
    },
  );

  router.get(relative(getItemEndpoint), view, async (req, res) => {
    const params = getItemEndpoint.params.parse(req.params);
    res.json({
      data: await getItem(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        params.itemId,
        new Date(),
        resolveMediaUrls,
      ),
    });
  });

  router.patch(
    relative(updateItemEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const params = updateItemEndpoint.params.parse(req.params);
      const body = updateItemEndpoint.body.parse(req.body);
      res.json({
        data: await updateItem(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.itemId,
          body,
          new Date(),
          resolveMediaUrls,
        ),
      });
    },
  );

  router.delete(relative(deleteItemEndpoint), manage, async (req, res) => {
    const params = deleteItemEndpoint.params.parse(req.params);
    await deleteItem(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      params.itemId,
    );
    res.status(204).end();
  });

  router.get(
    relative(getItemModifierGroupsEndpoint),
    view,
    async (req, res) => {
      const params = getItemModifierGroupsEndpoint.params.parse(req.params);
      res.json({
        data: await getItemModifierGroups(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.itemId,
        ),
      });
    },
  );

  router.put(
    relative(setItemModifierGroupsEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const params = setItemModifierGroupsEndpoint.params.parse(req.params);
      const body = setItemModifierGroupsEndpoint.body.parse(req.body);
      res.json({
        data: await setItemModifierGroups(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.itemId,
          body.groupIds,
        ),
      });
    },
  );

  // -------------------------------------------------------------- variants

  router.get(relative(listVariantsEndpoint), view, async (req, res) => {
    const params = listVariantsEndpoint.params.parse(req.params);
    const query = listVariantsEndpoint.query.parse(req.query);
    res.json(
      await listVariants(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        params.itemId,
        query,
      ),
    );
  });

  router.post(
    relative(createVariantEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const params = createVariantEndpoint.params.parse(req.params);
      const body = createVariantEndpoint.body.parse(req.body);
      const variant = await createVariant(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        params.itemId,
        body,
      );
      res
        .status(201)
        .location(location(createVariantEndpoint, variant.id))
        .json({ data: variant });
    },
  );

  router.patch(
    relative(updateVariantEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const params = updateVariantEndpoint.params.parse(req.params);
      const body = updateVariantEndpoint.body.parse(req.body);
      res.json({
        data: await updateVariant(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.variantId,
          body,
        ),
      });
    },
  );

  router.delete(relative(deleteVariantEndpoint), manage, async (req, res) => {
    const params = deleteVariantEndpoint.params.parse(req.params);
    await deleteVariant(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      params.variantId,
    );
    res.status(204).end();
  });

  // ------------------------------------------------------- modifier groups

  router.get(relative(listModifierGroupsEndpoint), view, async (req, res) => {
    const query = listModifierGroupsEndpoint.query.parse(req.query);
    res.json(
      await listModifierGroups(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    relative(createModifierGroupEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const body = createModifierGroupEndpoint.body.parse(req.body);
      const group = await createModifierGroup(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
      );
      res
        .status(201)
        .location(location(createModifierGroupEndpoint, group.id))
        .json({ data: group });
    },
  );

  router.patch(
    relative(updateModifierGroupEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const params = updateModifierGroupEndpoint.params.parse(req.params);
      const body = updateModifierGroupEndpoint.body.parse(req.body);
      res.json({
        data: await updateModifierGroup(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.groupId,
          body,
        ),
      });
    },
  );

  router.delete(
    relative(deleteModifierGroupEndpoint),
    manage,
    async (req, res) => {
      const params = deleteModifierGroupEndpoint.params.parse(req.params);
      await deleteModifierGroup(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        params.groupId,
      );
      res.status(204).end();
    },
  );

  router.get(relative(listModifiersEndpoint), view, async (req, res) => {
    const params = listModifiersEndpoint.params.parse(req.params);
    const query = listModifiersEndpoint.query.parse(req.query);
    res.json(
      await listModifiers(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        params.groupId,
        query,
      ),
    );
  });

  router.post(
    relative(createModifierEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const params = createModifierEndpoint.params.parse(req.params);
      const body = createModifierEndpoint.body.parse(req.body);
      const modifier = await createModifier(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        params.groupId,
        body,
      );
      res
        .status(201)
        .location(location(createModifierEndpoint, modifier.id))
        .json({ data: modifier });
    },
  );

  router.patch(
    relative(updateModifierEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const params = updateModifierEndpoint.params.parse(req.params);
      const body = updateModifierEndpoint.body.parse(req.body);
      res.json({
        data: await updateModifier(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.modifierId,
          body,
        ),
      });
    },
  );

  router.delete(relative(deleteModifierEndpoint), manage, async (req, res) => {
    const params = deleteModifierEndpoint.params.parse(req.params);
    await deleteModifier(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      params.modifierId,
    );
    res.status(204).end();
  });

  // ---------------------------------------------------------------- combos

  router.get(relative(listCombosEndpoint), view, async (req, res) => {
    const query = listCombosEndpoint.query.parse(req.query);
    res.json(
      await listCombos(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    relative(createComboEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const body = createComboEndpoint.body.parse(req.body);
      const combo = await createCombo(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
      );
      res
        .status(201)
        .location(location(createComboEndpoint, combo.id))
        .json({ data: combo });
    },
  );

  router.patch(
    relative(updateComboEndpoint),
    manage,
    jsonBody,
    async (req, res) => {
      const params = updateComboEndpoint.params.parse(req.params);
      const body = updateComboEndpoint.body.parse(req.body);
      res.json({
        data: await updateCombo(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.comboId,
          body,
        ),
      });
    },
  );

  router.delete(relative(deleteComboEndpoint), manage, async (req, res) => {
    const params = deleteComboEndpoint.params.parse(req.params);
    await deleteCombo(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      params.comboId,
    );
    res.status(204).end();
  });

  // ----------------------------------------------------------- price lists

  router.get(relative(listPriceListsEndpoint), priceView, async (req, res) => {
    const query = listPriceListsEndpoint.query.parse(req.query);
    res.json(
      await listPriceLists(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    relative(createPriceListEndpoint),
    priceManage,
    jsonBody,
    async (req, res) => {
      const body = createPriceListEndpoint.body.parse(req.body);
      const list = await createPriceList(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
      );
      res
        .status(201)
        .location(location(createPriceListEndpoint, list.id))
        .json({ data: list });
    },
  );

  router.patch(
    relative(updatePriceListEndpoint),
    priceManage,
    jsonBody,
    async (req, res) => {
      const params = updatePriceListEndpoint.params.parse(req.params);
      const body = updatePriceListEndpoint.body.parse(req.body);
      res.json({
        data: await updatePriceList(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.priceListId,
          body,
        ),
      });
    },
  );

  router.delete(
    relative(deletePriceListEndpoint),
    priceManage,
    async (req, res) => {
      const params = deletePriceListEndpoint.params.parse(req.params);
      await deletePriceList(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        params.priceListId,
      );
      res.status(204).end();
    },
  );

  router.get(
    relative(listPriceListItemsEndpoint),
    priceView,
    async (req, res) => {
      const params = listPriceListItemsEndpoint.params.parse(req.params);
      const query = listPriceListItemsEndpoint.query.parse(req.query);
      res.json(
        await listPriceListItems(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.priceListId,
          query,
        ),
      );
    },
  );

  router.put(
    relative(setPriceListItemsEndpoint),
    priceManage,
    jsonBody,
    async (req, res) => {
      const params = setPriceListItemsEndpoint.params.parse(req.params);
      const body = setPriceListItemsEndpoint.body.parse(req.body);
      await setPriceListItems(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        params.priceListId,
        body.items,
      );
      res.status(204).end();
    },
  );

  // ---------------------------------------------------------- availability

  router.get(relative(listAvailabilityEndpoint), view, async (req, res) => {
    const query = listAvailabilityEndpoint.query.parse(req.query);
    res.json(
      await listAvailability(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.patch(
    relative(updateAvailabilityEndpoint),
    availabilityToggle,
    jsonBody,
    async (req, res) => {
      const params = updateAvailabilityEndpoint.params.parse(req.params);
      const body = updateAvailabilityEndpoint.body.parse(req.body);
      res.json({
        data: await updateAvailability(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.availabilityId,
          body,
        ),
      });
    },
  );

  router.post(
    relative(setAvailabilityStatusEndpoint),
    availabilityToggle,
    jsonBody,
    async (req, res) => {
      const params = setAvailabilityStatusEndpoint.params.parse(req.params);
      const body = setAvailabilityStatusEndpoint.body.parse(req.body);
      res.json({
        data: await setAvailabilityStatus(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          params.availabilityId,
          body,
        ),
      });
    },
  );

  // ----------------------------------------------------------------- media

  router.post(
    relative(uploadMenuImageEndpoint),
    manage,
    menuImageBody,
    async (req, res) => {
      const body = uploadMenuImageEndpoint.body.parse(req.body);
      if (!options.storage)
        throw new HttpError(
          503,
          "SERVICE_UNAVAILABLE",
          "Penyimpanan foto belum tersedia.",
        );
      res.status(201).json({
        data: await uploadMenuPhoto(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          body,
          { storage: options.storage, scanner: options.scanner },
        ),
      });
    },
  );

  return router;
}
