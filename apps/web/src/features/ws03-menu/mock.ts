// Mock mode for the menu back office: serves and mutates the shared Cafe
// Legend menu fixtures, so every screen works with VITE_API_MOCK=true and the
// Playwright spec covers the happy path (docs/frontend.md "Mock mode").
//
// Handlers behave like the API will: strict input parsing (done by the
// runtime), the same error codes, and safe refusals instead of silent data
// loss (delete a category that still has items → 409 CONFLICT).
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { cafeLegendFixtures, type Idr } from "@starter/shared/core";
import {
  MENU_IMAGE_MAX_BYTES,
  MENU_PHOTO_REQUIRED_MESSAGE,
  cafeLegendMenuFixtures,
  createCategory,
  createCombo,
  createItem,
  createModifier,
  createModifierGroup,
  createPriceList,
  createStation,
  createVariant,
  deleteCategory,
  deleteCombo,
  deleteItem,
  deleteModifier,
  deleteModifierGroup,
  deletePriceList,
  deleteStation,
  deleteVariant,
  getItem,
  getItemModifierGroups,
  listAvailability,
  listCategories,
  listCombos,
  listItems,
  listModifierGroups,
  listModifiers,
  listPriceListItems,
  listPriceLists,
  listStations,
  listVariants,
  legacyPhotoMissingItem,
  legacyPhotoMissingPrice,
  menuErrorHttpStatus,
  menuItemAdminSchema,
  menuItemPhotoMissing,
  reorderCategories,
  reorderItems,
  setAvailabilityStatus,
  setItemModifierGroups,
  setPriceListItems,
  transitionAvailability,
  updateAvailability,
  updateCategory,
  updateCombo,
  updateItem,
  updateModifier,
  updateModifierGroup,
  updatePriceList,
  updateStation,
  updateVariant,
  uploadMenuImage,
  type Availability,
  type Category,
  type Combo,
  type MenuFixture,
  type MenuItem,
  type MenuItemAdmin,
  type Modifier,
  type ModifierGroup,
  type PriceList,
  type PriceListItem,
  type Station,
  type Variant,
} from "@starter/shared/menu";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

const { brand, outlets } = cafeLegendFixtures;
const fixtureBrandId = brand.id;
const fixtureOutletId = outlets[0].id;

// Contract ids are RFC 9562 UUIDs (z.uuid rejects a ULID's version nibble),
// so the mock mints real v4 ids instead of the ULID-in-uuid production form.
const nextId = () => newIdempotencyKey();

type MenuState = MenuFixture & {
  /** Item ↔ modifier group links (PRD §8 modifier groups per item). */
  itemGroups: Record<string, string[]>;
  /** Uploaded photos by media id (data URL), served back as mediaUrl. */
  media: Record<string, string>;
};

// The item↔group links come from the shared contract fixture
// (`itemModifierGroups`), folded into the per-item ordered id lists the
// endpoints speak.
// The demo photo map lives in lib/mock so a normal build compiles the sample
// paths out (legend-4pki): items with a photo get a mock media row so the demo
// can restore them after an 86 (a restore needs the photo, Q23).
import { demoPhotos } from "../../lib/mock/demo-photos.ts";

function groupIdsByItem(
  links: MenuFixture["itemModifierGroups"],
): Record<string, string[]> {
  const byItem: Record<string, string[]> = {};
  for (const link of [...links].sort((a, b) => a.sortOrder - b.sortOrder))
    (byItem[link.itemId] ??= []).push(link.groupId);
  return byItem;
}

function seedState(): MenuState {
  const fixtures = structuredClone(cafeLegendMenuFixtures);
  const media: Record<string, string> = {};
  for (const item of fixtures.items) {
    const url = demoPhotos[item.name];
    if (!url || item.mediaId) continue;
    const mediaId = nextId();
    media[mediaId] = url;
    item.mediaId = mediaId;
  }
  return {
    ...fixtures,
    itemGroups: groupIdsByItem(fixtures.itemModifierGroups),
    media,
  };
}

const store = createMockStore<MenuState>(seedState);
/** Idempotency for the 86 action: key → "rowId:action". */
const broadcasts = createMockStore(() => new Map<string, string>());

const state = () => store.get();

/**
 * legend-qf0i (owner Q23): every demo item now has a photo, so the "active row
 * without a photo" case would disappear from the demo and its refusals would
 * have no end-to-end test. `?mock=photo-missing` adds one legacy row (active,
 * sellable, no photo): the back office lists it with the "Foto wajib" badge and
 * refuses to republish it, while every guest read hides it. Idempotent, and no
 * other scenario ever sees the row.
 */
function ensureLegacyItem(): void {
  if (state().items.some((row) => row.id === legacyPhotoMissingItem.id)) return;
  store.set({
    ...state(),
    items: [...state().items, structuredClone(legacyPhotoMissingItem)],
    priceListItems: [
      ...state().priceListItems,
      structuredClone(legacyPhotoMissingPrice),
    ],
    availability: [
      ...state().availability,
      {
        id: nextId(),
        tenantId: legacyPhotoMissingItem.tenantId,
        outletId: fixtureOutletId,
        menuItemId: legacyPhotoMissingItem.id,
        schedule: [],
        dailyLimit: null,
        soldOutUntil: null,
        status: "available",
      },
    ],
  });
}

/** The legacy row only exists in its scenario (see `ensureLegacyItem`). */
function legacyItemVisible(scenario: string): boolean {
  if (scenario !== "photo-missing") return false;
  ensureLegacyItem();
  return true;
}

/** True for the scenario-only row, so other scenarios can hide it again. */
function isLegacyItem(itemId: string): boolean {
  return itemId === legacyPhotoMissingItem.id;
}

function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

function conflict(message: string): never {
  throw new ApiError(409, "CONFLICT", message);
}

/** Q23: the API refuses an active item without a photo; so does the mock. */
function photoRequired(): never {
  throw new ApiError(
    menuErrorHttpStatus.MENU_PHOTO_REQUIRED,
    "MENU_PHOTO_REQUIRED",
    MENU_PHOTO_REQUIRED_MESSAGE,
  );
}

function requireItem(itemId: string): MenuItem {
  const item = state().items.find((row) => row.id === itemId);
  return item ?? notFound("Item menu");
}

function adminItem(item: MenuItem): MenuItemAdmin {
  const mediaUrl = item.mediaId ? (state().media[item.mediaId] ?? null) : null;
  return menuItemAdminSchema.parse({ ...item, mediaUrl });
}

function currentSortOrder(rows: readonly { sortOrder: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
}

// ---- Categories ----------------------------------------------------------

const categoryRows = (brandId: string, search?: string): Category[] =>
  state()
    .categories.filter((row) => row.brandId === brandId)
    .filter(
      (row) =>
        !search ||
        row.name
          .toLocaleLowerCase("id-ID")
          .includes(search.toLocaleLowerCase("id-ID")),
    )
    .sort((a, b) => a.sortOrder - b.sortOrder);

registerMock(listCategories, ({ query, scenario }) =>
  paginateFixture(
    categoryRows(query.brandId ?? fixtureBrandId, query.search),
    query,
    (row) => row.id,
    scenario,
  ),
);

registerMock(createCategory, ({ body }) => {
  const category: Category = {
    id: nextId(),
    tenantId: state().categories[0].tenantId,
    brandId: body.brandId ?? fixtureBrandId,
    name: body.name,
    parentId: body.parentId ?? null,
    sortOrder:
      body.sortOrder ??
      currentSortOrder(
        state().categories.filter(
          (row) => row.parentId === (body.parentId ?? null),
        ),
      ),
  };
  state().categories.push(category);
  return { data: category };
});

registerMock(updateCategory, ({ params, body }) => {
  const index = state().categories.findIndex(
    (row) => row.id === params.categoryId,
  );
  const category = state().categories[index];
  if (!category) notFound("Kategori");
  if (body.parentId === category.id)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Kategori tidak boleh menjadi induk dirinya sendiri.",
      [{ field: "parentId", message: "Pilih kategori lain atau kosongkan." }],
    );
  state().categories[index] = { ...category, ...body };
  return { data: state().categories[index] };
});

registerMock(deleteCategory, ({ params }) => {
  const category = state().categories.find(
    (row) => row.id === params.categoryId,
  );
  if (!category) notFound("Kategori");
  if (state().items.some((item) => item.categoryId === category.id))
    conflict("Pindahkan item ke kategori lain sebelum menghapus kategori ini.");
  if (state().categories.some((row) => row.parentId === category.id))
    conflict("Pindahkan subkategori sebelum menghapus kategori ini.");
  store.set({
    ...state(),
    categories: state().categories.filter((row) => row.id !== category.id),
  });
});

registerMock(reorderCategories, ({ body }) => {
  const known = new Set(state().categories.map((row) => row.id));
  if (body.orderedIds.some((id) => !known.has(id)))
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Urutan berisi kategori yang tidak dikenal.",
    );
  const position = new Map(body.orderedIds.map((id, index) => [id, index]));
  store.set({
    ...state(),
    categories: state()
      .categories.map((row) => ({
        ...row,
        sortOrder: position.get(row.id) ?? row.sortOrder,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder),
  });
});

// ---- Stations ------------------------------------------------------------

const stationRows = (outletId: string): Station[] =>
  state()
    .stations.filter((row) => row.outletId === outletId)
    .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));

registerMock(listStations, ({ query, scenario }) =>
  paginateFixture(
    stationRows(query.outletId ?? fixtureOutletId),
    query,
    (row) => row.id,
    scenario,
  ),
);

registerMock(createStation, ({ body }) => {
  const station: Station = {
    id: nextId(),
    tenantId: state().stations[0].tenantId,
    outletId: body.outletId ?? fixtureOutletId,
    name: body.name,
    type: body.type,
    printerDeviceId: body.printerDeviceId ?? null,
    targetSeconds: body.targetSeconds ?? null,
    updatedAt: new Date().toISOString(),
  };
  state().stations.push(station);
  return { data: station };
});

registerMock(updateStation, ({ params, body }) => {
  const index = state().stations.findIndex(
    (row) => row.id === params.stationId,
  );
  const station = state().stations[index];
  if (!station) notFound("Stasiun");
  const { expectedUpdatedAt, ...changes } = body;
  // Same rule as the API (legend-4xai): a stale form answers 409.
  if (expectedUpdatedAt && expectedUpdatedAt !== station.updatedAt)
    conflict("Stasiun sudah diubah orang lain. Muat ulang lalu coba lagi.");
  state().stations[index] = {
    ...station,
    ...changes,
    updatedAt: new Date().toISOString(),
  };
  return { data: state().stations[index] };
});

registerMock(deleteStation, ({ params }) => {
  const station = state().stations.find((row) => row.id === params.stationId);
  if (!station) notFound("Stasiun");
  if (
    state().items.some((item) => item.stationId === station.id) ||
    state().modifiers.some((modifier) => modifier.stationId === station.id)
  )
    conflict("Alihkan item dan modifier dari stasiun ini sebelum menghapus.");
  store.set({
    ...state(),
    stations: state().stations.filter((row) => row.id !== station.id),
  });
});

// ---- Items ---------------------------------------------------------------

const sortItems = (rows: MenuItem[], sort: "display" | "name" | "category") => {
  if (sort === "name")
    return rows.sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
  if (sort === "category") {
    const order = new Map(
      state().categories.map((category) => [category.id, category.sortOrder]),
    );
    return rows.sort(
      (a, b) =>
        (order.get(a.categoryId) ?? 0) - (order.get(b.categoryId) ?? 0) ||
        a.sortOrder - b.sortOrder,
    );
  }
  return rows.sort((a, b) => a.sortOrder - b.sortOrder);
};

registerMock(listItems, ({ query, scenario }) => {
  const legacy = legacyItemVisible(scenario);
  const needle = query.search?.trim().toLocaleLowerCase("id-ID") ?? "";
  const rows = sortItems(
    state().items.filter((item) => {
      if (isLegacyItem(item.id) && !legacy) return false;
      if (item.brandId !== (query.brandId ?? fixtureBrandId)) return false;
      if (query.categoryId && item.categoryId !== query.categoryId)
        return false;
      if (query.stationId && item.stationId !== query.stationId) return false;
      if (query.status === "active" && !item.isActive) return false;
      if (query.status === "inactive" && item.isActive) return false;
      if (
        needle &&
        !item.name.toLocaleLowerCase("id-ID").includes(needle) &&
        !item.description.toLocaleLowerCase("id-ID").includes(needle)
      )
        return false;
      return true;
    }),
    query.sort,
  );
  const page = paginateFixture(rows, query, (row) => row.id, scenario);
  return { ...page, data: page.data.map(adminItem) };
});

registerMock(getItem, ({ params, scenario }) => {
  // The "empty" scenario has no items, so the detail screen can show its
  // honest not-found empty state.
  if (scenario === "empty") notFound("Item menu");
  if (isLegacyItem(params.itemId) && !legacyItemVisible(scenario))
    notFound("Item menu");
  return { data: adminItem(requireItem(params.itemId)) };
});

registerMock(createItem, ({ body }) => {
  if (!state().categories.some((row) => row.id === body.categoryId))
    throw new ApiError(400, "VALIDATION_ERROR", "Kategori tidak dikenal.", [
      { field: "categoryId", message: "Pilih kategori yang ada." },
    ]);
  // Q23: publishing a new item needs its photo; the default is a draft.
  if (menuItemPhotoMissing(body)) photoRequired();
  const item: MenuItem = {
    id: nextId(),
    tenantId: state().items[0].tenantId,
    brandId: body.brandId ?? fixtureBrandId,
    categoryId: body.categoryId,
    name: body.name,
    description: body.description,
    type: body.type,
    stationId: body.stationId ?? null,
    stationType: body.stationType ?? null,
    course: body.course ?? null,
    recipeId: body.recipeId ?? null,
    taxRuleId: body.taxRuleId ?? null,
    labels: body.labels,
    allergens: body.allergens,
    mediaId: body.mediaId ?? null,
    isActive: body.isActive,
    isBreakfast: body.isBreakfast,
    sortOrder:
      body.sortOrder ??
      currentSortOrder(
        state().items.filter((row) => row.categoryId === body.categoryId),
      ),
  };
  store.set({
    ...state(),
    items: [...state().items, item],
    // Every item is sellable in every outlet until an availability row says
    // otherwise (PRD §8 "status habis" is per outlet).
    availability: [
      ...state().availability,
      {
        id: nextId(),
        tenantId: item.tenantId,
        outletId: fixtureOutletId,
        menuItemId: item.id,
        schedule: [],
        dailyLimit: null,
        soldOutUntil: null,
        status: "available",
      },
    ],
  });
  return { data: adminItem(item) };
});

registerMock(updateItem, ({ params, body, scenario }) => {
  if (isLegacyItem(params.itemId) && !legacyItemVisible(scenario))
    notFound("Item menu");
  const index = state().items.findIndex((row) => row.id === params.itemId);
  const item = state().items[index];
  if (!item) notFound("Item menu");
  if (
    body.categoryId &&
    !state().categories.some((row) => row.id === body.categoryId)
  )
    throw new ApiError(400, "VALIDATION_ERROR", "Kategori tidak dikenal.", [
      { field: "categoryId", message: "Pilih kategori yang ada." },
    ]);
  // Q23: same rule as the API — activation and photo removal are the writes
  // that could publish an item without a photo.
  const isActive = body.isActive ?? item.isActive;
  const mediaId = body.mediaId !== undefined ? body.mediaId : item.mediaId;
  if (
    menuItemPhotoMissing({ isActive, mediaId }) &&
    (body.isActive === true || body.mediaId === null)
  )
    photoRequired();
  state().items[index] = { ...item, ...body };
  return { data: adminItem(state().items[index]) };
});

registerMock(deleteItem, ({ params }) => {
  const item = requireItem(params.itemId);
  if (state().combos.some((combo) => combo.comboItemId === item.id))
    conflict("Hapus paket yang memakai item ini sebelum menghapus item.");
  const variants = state().variants.filter((row) => row.menuItemId === item.id);
  store.set({
    ...state(),
    items: state().items.filter((row) => row.id !== item.id),
    variants: state().variants.filter((row) => row.menuItemId !== item.id),
    availability: state().availability.filter(
      (row) => row.menuItemId !== item.id,
    ),
    priceListItems: state().priceListItems.filter(
      (row) => row.itemId !== item.id,
    ),
    itemGroups: Object.fromEntries(
      Object.entries(state().itemGroups).filter(([id]) => id !== item.id),
    ),
    combos: state().combos.map((combo) => ({
      ...combo,
      components: combo.components.map((component) => ({
        ...component,
        options: component.options.filter(
          (option) => !variants.some((variant) => variant.id === option),
        ),
      })),
    })),
  });
});

registerMock(reorderItems, ({ body }) => {
  const known = new Set(state().items.map((row) => row.id));
  if (body.orderedIds.some((id) => !known.has(id)))
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Urutan berisi item yang tidak dikenal.",
    );
  const position = new Map(body.orderedIds.map((id, index) => [id, index]));
  store.set({
    ...state(),
    items: state().items.map((row) => ({
      ...row,
      sortOrder: position.get(row.id) ?? row.sortOrder,
    })),
  });
});

registerMock(getItemModifierGroups, ({ params }) => {
  requireItem(params.itemId);
  return { data: { groupIds: state().itemGroups[params.itemId] ?? [] } };
});

registerMock(setItemModifierGroups, ({ params, body }) => {
  requireItem(params.itemId);
  const known = new Set(state().modifierGroups.map((row) => row.id));
  const unknown = body.groupIds.find((id) => !known.has(id));
  if (unknown)
    throw new ApiError(400, "VALIDATION_ERROR", "Grup modifier tidak dikenal.");
  const groupIds = [...new Set(body.groupIds)];
  store.set({
    ...state(),
    itemGroups: { ...state().itemGroups, [params.itemId]: groupIds },
  });
  return { data: { groupIds } };
});

// ---- Variants ------------------------------------------------------------

registerMock(listVariants, ({ params, query, scenario }) => {
  requireItem(params.itemId);
  return paginateFixture(
    state().variants.filter((row) => row.menuItemId === params.itemId),
    query,
    (row) => row.id,
    scenario,
  );
});

registerMock(createVariant, ({ params, body }) => {
  const item = requireItem(params.itemId);
  const variant: Variant = {
    id: nextId(),
    tenantId: item.tenantId,
    menuItemId: item.id,
    name: body.name,
    recipeId: body.recipeId ?? null,
  };
  state().variants.push(variant);
  return { data: variant };
});

registerMock(updateVariant, ({ params, body }) => {
  const index = state().variants.findIndex(
    (row) => row.id === params.variantId,
  );
  const variant = state().variants[index];
  if (!variant) notFound("Varian");
  state().variants[index] = { ...variant, ...body };
  return { data: state().variants[index] };
});

registerMock(deleteVariant, ({ params }) => {
  const variant = state().variants.find((row) => row.id === params.variantId);
  if (!variant) notFound("Varian");
  store.set({
    ...state(),
    variants: state().variants.filter((row) => row.id !== variant.id),
    priceListItems: state().priceListItems.filter(
      (row) => row.variantId !== variant.id,
    ),
    combos: state().combos.map((combo) => ({
      ...combo,
      components: combo.components.map((component) => ({
        ...component,
        options: component.options.filter((option) => option !== variant.id),
      })),
    })),
  });
});

// ---- Modifier groups and modifiers ---------------------------------------

registerMock(listModifierGroups, ({ query, scenario }) => {
  const needle = query.search?.trim().toLocaleLowerCase("id-ID") ?? "";
  const rows = state()
    .modifierGroups.filter(
      (row) => !needle || row.name.toLocaleLowerCase("id-ID").includes(needle),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(createModifierGroup, ({ body }) => {
  const group: ModifierGroup = {
    id: nextId(),
    tenantId: state().modifierGroups[0].tenantId,
    name: body.name,
    minSelect: body.minSelect,
    maxSelect: body.maxSelect,
  };
  state().modifierGroups.push(group);
  return { data: group };
});

registerMock(updateModifierGroup, ({ params, body }) => {
  const index = state().modifierGroups.findIndex(
    (row) => row.id === params.groupId,
  );
  const group = state().modifierGroups[index];
  if (!group) notFound("Grup modifier");
  const next = { ...group, ...body };
  if (next.minSelect > next.maxSelect)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Jumlah maksimum tidak boleh kurang dari minimum.",
      [
        {
          field: "maxSelect",
          message: "Naikkan maksimum atau turunkan minimum.",
        },
      ],
    );
  state().modifierGroups[index] = next;
  return { data: next };
});

registerMock(deleteModifierGroup, ({ params }) => {
  const group = state().modifierGroups.find((row) => row.id === params.groupId);
  if (!group) notFound("Grup modifier");
  const attached = Object.entries(state().itemGroups).some(([, ids]) =>
    ids.includes(group.id),
  );
  if (attached) conflict("Lepas grup ini dari item sebelum menghapusnya.");
  store.set({
    ...state(),
    modifierGroups: state().modifierGroups.filter((row) => row.id !== group.id),
    modifiers: state().modifiers.filter((row) => row.groupId !== group.id),
  });
});

registerMock(listModifiers, ({ params, query, scenario }) => {
  if (!state().modifierGroups.some((row) => row.id === params.groupId))
    notFound("Grup modifier");
  return paginateFixture(
    state().modifiers.filter((row) => row.groupId === params.groupId),
    query,
    (row) => row.id,
    scenario,
  );
});

registerMock(createModifier, ({ params, body }) => {
  const group = state().modifierGroups.find((row) => row.id === params.groupId);
  if (!group) notFound("Grup modifier");
  const modifier: Modifier = {
    id: nextId(),
    tenantId: group.tenantId,
    groupId: group.id,
    name: body.name,
    priceIdr: body.priceIdr as Idr,
    recipeId: body.recipeId ?? null,
    stationId: body.stationId ?? null,
  };
  state().modifiers.push(modifier);
  return { data: modifier };
});

registerMock(updateModifier, ({ params, body }) => {
  const index = state().modifiers.findIndex(
    (row) => row.id === params.modifierId,
  );
  const modifier = state().modifiers[index];
  if (!modifier) notFound("Modifier");
  state().modifiers[index] = { ...modifier, ...body };
  return { data: state().modifiers[index] };
});

registerMock(deleteModifier, ({ params }) => {
  const modifier = state().modifiers.find(
    (row) => row.id === params.modifierId,
  );
  if (!modifier) notFound("Modifier");
  store.set({
    ...state(),
    modifiers: state().modifiers.filter((row) => row.id !== modifier.id),
  });
});

// ---- Combos --------------------------------------------------------------

const comboRows = (search?: string): Combo[] => {
  const needle = search?.trim().toLocaleLowerCase("id-ID") ?? "";
  const nameOf = new Map(state().items.map((item) => [item.id, item.name]));
  return state()
    .combos.filter(
      (combo) =>
        !needle ||
        (nameOf.get(combo.comboItemId) ?? "")
          .toLocaleLowerCase("id-ID")
          .includes(needle),
    )
    .sort((a, b) =>
      (nameOf.get(a.comboItemId) ?? "").localeCompare(
        nameOf.get(b.comboItemId) ?? "",
        "id-ID",
      ),
    );
};

registerMock(listCombos, ({ query, scenario }) =>
  paginateFixture(comboRows(query.search), query, (row) => row.id, scenario),
);

function assertComponents(components: Combo["components"]): void {
  const items = new Set(state().items.map((row) => row.id));
  const variants = new Set(state().variants.map((row) => row.id));
  for (const component of components) {
    if (!items.has(component.menuItemId))
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Isi paket berisi item yang tidak dikenal.",
        [{ field: "components", message: "Pilih item yang ada." }],
      );
    if (component.options.some((option) => !variants.has(option)))
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Isi paket berisi varian yang tidak dikenal.",
      );
  }
}

registerMock(createCombo, ({ body }) => {
  const item = requireItem(body.comboItemId);
  if (item.type !== "combo")
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Item paket harus bertipe combo.",
      [{ field: "comboItemId", message: "Buat item bertipe paket dulu." }],
    );
  assertComponents(body.components);
  const combo: Combo = {
    id: nextId(),
    tenantId: item.tenantId,
    comboItemId: item.id,
    components: body.components,
  };
  state().combos.push(combo);
  return { data: combo };
});

registerMock(updateCombo, ({ params, body }) => {
  const index = state().combos.findIndex((row) => row.id === params.comboId);
  const combo = state().combos[index];
  if (!combo) notFound("Paket");
  assertComponents(body.components);
  state().combos[index] = { ...combo, components: body.components };
  return { data: state().combos[index] };
});

registerMock(deleteCombo, ({ params }) => {
  if (!state().combos.some((row) => row.id === params.comboId))
    notFound("Paket");
  store.set({
    ...state(),
    combos: state().combos.filter((row) => row.id !== params.comboId),
  });
});

// ---- Price lists ---------------------------------------------------------

const priceListRows = (outletId: string, channel?: string): PriceList[] =>
  state()
    .priceLists.filter(
      (row) =>
        row.outletId === outletId && (!channel || row.channel === channel),
    )
    .sort(
      (a, b) =>
        a.channel.localeCompare(b.channel) ||
        b.effectiveFrom.localeCompare(a.effectiveFrom),
    );

registerMock(listPriceLists, ({ query, scenario }) =>
  paginateFixture(
    priceListRows(query.outletId ?? fixtureOutletId, query.channel),
    query,
    (row) => row.id,
    scenario,
  ),
);

registerMock(createPriceList, ({ body }) => {
  const outletId = body.outletId ?? fixtureOutletId;
  const duplicate = state().priceLists.some(
    (row) =>
      row.outletId === outletId &&
      row.channel === body.channel &&
      row.effectiveFrom === body.effectiveFrom,
  );
  if (duplicate)
    conflict(
      "Daftar harga untuk kanal dan tanggal efektif ini sudah ada. Ubah tanggalnya.",
    );
  const priceList: PriceList = {
    id: nextId(),
    tenantId: state().priceLists[0].tenantId,
    outletId,
    channel: body.channel,
    effectiveFrom: body.effectiveFrom,
  };
  state().priceLists.push(priceList);
  return { data: priceList };
});

registerMock(updatePriceList, ({ params, body }) => {
  const index = state().priceLists.findIndex(
    (row) => row.id === params.priceListId,
  );
  const priceList = state().priceLists[index];
  if (!priceList) notFound("Daftar harga");
  const next = { ...priceList, ...body };
  const duplicate = state().priceLists.some(
    (row) =>
      row.id !== priceList.id &&
      row.outletId === next.outletId &&
      row.channel === next.channel &&
      row.effectiveFrom === next.effectiveFrom,
  );
  if (duplicate) conflict("Daftar harga dengan tanggal efektif itu sudah ada.");
  state().priceLists[index] = next;
  return { data: next };
});

registerMock(deletePriceList, ({ params }) => {
  if (!state().priceLists.some((row) => row.id === params.priceListId))
    notFound("Daftar harga");
  store.set({
    ...state(),
    priceLists: state().priceLists.filter(
      (row) => row.id !== params.priceListId,
    ),
    priceListItems: state().priceListItems.filter(
      (row) => row.priceListId !== params.priceListId,
    ),
  });
});

registerMock(listPriceListItems, ({ params, query, scenario }) => {
  if (!state().priceLists.some((row) => row.id === params.priceListId))
    notFound("Daftar harga");
  return paginateFixture(
    state()
      .priceListItems.filter((row) => row.priceListId === params.priceListId)
      .sort((a, b) => a.itemId.localeCompare(b.itemId)),
    query,
    (row) => row.id,
    scenario,
  );
});

registerMock(setPriceListItems, ({ params, body }) => {
  const priceList = state().priceLists.find(
    (row) => row.id === params.priceListId,
  );
  if (!priceList) notFound("Daftar harga");
  const items = new Set(state().items.map((row) => row.id));
  const variants = new Set(state().variants.map((row) => row.id));
  for (const entry of body.items) {
    if (!items.has(entry.itemId))
      throw new ApiError(400, "VALIDATION_ERROR", "Item tidak dikenal.", [
        { field: "items", message: "Muat ulang lalu coba lagi." },
      ]);
    if (entry.variantId && !variants.has(entry.variantId))
      throw new ApiError(400, "VALIDATION_ERROR", "Varian tidak dikenal.");
  }
  const key = (row: { itemId: string; variantId: string | null }) =>
    `${row.itemId}:${row.variantId ?? ""}`;
  const existing = new Map(
    state()
      .priceListItems.filter((row) => row.priceListId === priceList.id)
      .map((row) => [key(row), row]),
  );
  const kept: PriceListItem[] = body.items.map((entry) => {
    const current = existing.get(key(entry));
    return {
      id: current?.id ?? nextId(),
      tenantId: priceList.tenantId,
      priceListId: priceList.id,
      itemId: entry.itemId,
      variantId: entry.variantId,
      priceIdr: entry.priceIdr as Idr,
    };
  });
  store.set({
    ...state(),
    priceListItems: [
      ...state().priceListItems.filter(
        (row) => row.priceListId !== priceList.id,
      ),
      ...kept,
    ],
  });
});

// ---- Availability --------------------------------------------------------

registerMock(listAvailability, ({ query, scenario }) => {
  const legacy = legacyItemVisible(scenario);
  const rows = state()
    .availability.filter(
      (row) =>
        row.outletId === (query.outletId ?? fixtureOutletId) &&
        (!query.status || row.status === query.status) &&
        (!isLegacyItem(row.menuItemId) || legacy),
    )
    .sort((a, b) => a.menuItemId.localeCompare(b.menuItemId));
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

const requireAvailability = (availabilityId: string): Availability => {
  const row = state().availability.find((item) => item.id === availabilityId);
  return row ?? notFound("Ketersediaan");
};

registerMock(updateAvailability, ({ params, body, scenario }) => {
  if (!legacyItemVisible(scenario)) {
    const existing = state().availability.find(
      (row) => row.id === params.availabilityId,
    );
    if (existing && isLegacyItem(existing.menuItemId)) notFound("Ketersediaan");
  }
  const index = state().availability.findIndex(
    (row) => row.id === params.availabilityId,
  );
  const row = requireAvailability(params.availabilityId);
  state().availability[index] = { ...row, ...body };
  return { data: state().availability[index] };
});

registerMock(setAvailabilityStatus, ({ params, body, scenario }) => {
  if (!legacyItemVisible(scenario)) {
    const existing = state().availability.find(
      (row) => row.id === params.availabilityId,
    );
    if (existing && isLegacyItem(existing.menuItemId)) notFound("Ketersediaan");
  }
  const row = requireAvailability(params.availabilityId);
  const fingerprint = `${row.id}:${body.action}`;
  const seen = broadcasts.get().get(body.idempotencyKey);
  if (seen) {
    if (seen !== fingerprint)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai untuk aksi lain.",
      );
    return { data: row };
  }
  // Q23: a restore republishes the item, so it needs its photo (like the API,
  // checked after an idempotent replay so a retry keeps its outcome).
  if (body.action === "restore") {
    const item = requireItem(row.menuItemId);
    if (menuItemPhotoMissing({ isActive: true, mediaId: item.mediaId }))
      photoRequired();
  }
  const status = transitionAvailability(row.status, body.action);
  const next: Availability = {
    ...row,
    status,
    soldOutUntil: status === "sold_out" ? (body.soldOutUntil ?? null) : null,
  };
  const index = state().availability.findIndex((item) => item.id === row.id);
  state().availability[index] = next;
  broadcasts.get().set(body.idempotencyKey, fingerprint);
  return { data: next };
});

// ---- Media ---------------------------------------------------------------

registerMock(uploadMenuImage, ({ body }) => {
  const padding = body.dataBase64.endsWith("==")
    ? 2
    : body.dataBase64.endsWith("=")
      ? 1
      : 0;
  const byteSize = Math.floor((body.dataBase64.length * 3) / 4) - padding;
  if (byteSize > MENU_IMAGE_MAX_BYTES)
    throw new ApiError(
      413,
      "VALIDATION_ERROR",
      "Gambar masih terlalu besar setelah diperkecil.",
      [{ field: "dataBase64", message: "Pilih gambar lain atau perkecil." }],
    );
  const mediaId = nextId();
  const mediaUrl = `data:${body.contentType};base64,${body.dataBase64}`;
  store.set({ ...state(), media: { ...state().media, [mediaId]: mediaUrl } });
  return { data: { mediaId, mediaUrl } };
});
