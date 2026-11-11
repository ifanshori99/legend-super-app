// WFC bundles, e.g. "Pagi Produktif" = shower single + WFC day pass (PRD v1.7
// §3 F25/F39; bead legend-bz9h). Money rules, each covered by
// test/wfc-bundle.test.ts:
// - M1: prices are read from the database; the caller only reports the amount
//   the payment provider captured (`paidIdr`), which must equal the bundle
//   price.
// - M2: a refund never exceeds what was paid minus the value of what was
//   already used, and a second refund is a no-op.
// - M3: the bundle price is > 0 and <= sum(component list price x quantity);
//   the price paid is split over the components with largest remainder, so
//   the allocations add up to the rupiah.
// - M4: entitlements are issued after the purchase is recorded as paid (one
//   grant per item, `source_ref` = the allocation id, so it is idempotent) and
//   revoked on refund (`cancelEntitlementsForSource`; only what is unredeemed).
//
// Refund policy (bounds the payout, "jangan sampai rugi"): redeemed sessions
// and sessions of an expired grant count as used; the used value of an item is
// allocated_idr x used / granted, rounded UP, so the refundable amount is
// rounded down. A refund revokes every unredeemed entitlement and closes the
// purchase (`refunded`); `refundIdr` may be lower than the refundable amount
// (the outlet keeps the rest) but never higher.
//
// Permissions: create and refund need `facility.config.manage`, purchase and
// list need `facility.booth.operate`, both on the bundle's outlet (TEN-03).
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  idr,
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  allocateBundlePrice,
  createWfcBundleSchema,
  isValidBundlePrice,
  purchaseWfcBundleSchema,
  refundWfcBundleSchema,
  wfcBundlePurchaseSchema,
  wfcBundleSchema,
  WFC_BUNDLE_MAX_SESSIONS_PER_ITEM,
  type CreateWfcBundleInput,
  type ListWfcBundlesQuery,
  type PurchaseWfcBundleInput,
  type RefundWfcBundleInput,
  type WfcBundle,
  type WfcBundlePurchase,
} from "@starter/shared/wfc";
import { db } from "../db/index.ts";
import {
  facilityProducts,
  facilitySubscriptionPlans,
} from "../db/schema/facility.ts";
import { entitlementLedger } from "../db/schema/facility-entitlement.ts";
import {
  wfcBundleItems,
  wfcBundlePurchaseAllocations,
  wfcBundlePurchases,
  wfcBundles,
} from "../db/schema/wfc-bundle.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { createOnce } from "./facility-config-guard.ts";
import {
  cancelEntitlementsForSource,
  issueEntitlement,
  lockCustomer,
} from "./facility-entitlement.service.ts";
import {
  assertFacilityPermission,
  auditFacility,
  CONFIG_PERMISSION,
  loadFacility,
  notFound,
  OPERATE_PERMISSION,
  type Tx,
} from "./facility-shared.ts";

type BundleRow = typeof wfcBundles.$inferSelect;
type ItemRow = typeof wfcBundleItems.$inferSelect;
type PurchaseRow = typeof wfcBundlePurchases.$inferSelect;
type AllocationRow = typeof wfcBundlePurchaseAllocations.$inferSelect;

const DAY_MS = 86_400_000;

/** A resolved component: its grant size and list price per unit. */
type Component = {
  item: ItemRow;
  sessionsPerUnit: number;
  listPriceIdr: number;
};

const invalid = (code: string, message: string) =>
  new HttpError(422, code, message);
const conflict = (code: string, message: string) =>
  new HttpError(409, code, message);

// ---- Mappers ------------------------------------------------------------------

function toBundle(row: BundleRow, items: ItemRow[]): WfcBundle {
  return wfcBundleSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    name: row.name,
    priceIdr: row.priceIdr,
    validityDays: row.validityDays,
    status: row.status,
    items: items.map((item) => ({
      id: item.id,
      bundleId: item.bundleId,
      facilityId: item.facilityId,
      productId: item.productId,
      planId: item.planId,
      quantity: item.quantity,
    })),
    createdAt: row.createdAt.toISOString(),
  });
}

function toPurchase(
  row: PurchaseRow,
  allocations: AllocationRow[],
): WfcBundlePurchase {
  return wfcBundlePurchaseSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    bundleId: row.bundleId,
    customerProfileId: row.customerProfileId,
    pricePaidIdr: row.pricePaidIdr,
    refundedIdr: row.refundedIdr,
    status: row.status,
    paymentRef: row.paymentRef,
    allocations: allocations.map((allocation) => ({
      id: allocation.id,
      purchaseId: allocation.purchaseId,
      itemId: allocation.itemId,
      allocatedIdr: allocation.allocatedIdr,
    })),
    createdAt: row.createdAt.toISOString(),
  });
}

// ---- Loaders ------------------------------------------------------------------

async function loadItems(
  tx: Tx,
  context: ScopedTenantContext,
  bundleId: string,
): Promise<ItemRow[]> {
  return tx
    .select()
    .from(wfcBundleItems)
    .where(
      and(
        eq(wfcBundleItems.tenantId, context.tenant.tenantId),
        eq(wfcBundleItems.bundleId, bundleId),
      ),
    )
    .orderBy(asc(wfcBundleItems.createdAt), asc(wfcBundleItems.id));
}

async function loadBundleRow(
  tx: Tx,
  context: ScopedTenantContext,
  bundleId: string,
): Promise<BundleRow | undefined> {
  const [row] = await tx
    .select()
    .from(wfcBundles)
    .where(
      and(
        eq(wfcBundles.tenantId, context.tenant.tenantId),
        eq(wfcBundles.id, bundleId),
      ),
    )
    .limit(1);
  return row;
}

async function loadBundle(
  tx: Tx,
  context: ScopedTenantContext,
  bundleId: string,
): Promise<WfcBundle | undefined> {
  const row = await loadBundleRow(tx, context, bundleId);
  return row ? toBundle(row, await loadItems(tx, context, row.id)) : undefined;
}

async function loadAllocations(
  tx: Tx,
  context: ScopedTenantContext,
  purchaseId: string,
): Promise<AllocationRow[]> {
  return tx
    .select()
    .from(wfcBundlePurchaseAllocations)
    .where(
      and(
        eq(wfcBundlePurchaseAllocations.tenantId, context.tenant.tenantId),
        eq(wfcBundlePurchaseAllocations.purchaseId, purchaseId),
      ),
    )
    .orderBy(
      asc(wfcBundlePurchaseAllocations.createdAt),
      asc(wfcBundlePurchaseAllocations.id),
    );
}

/** Resolves every item to its grant size and list price, from the database (M1). */
async function resolveComponents(
  tx: Tx,
  context: ScopedTenantContext,
  items: ItemRow[],
): Promise<Component[]> {
  const tenantId = context.tenant.tenantId;
  const components: Component[] = [];
  for (const item of items) {
    if (item.productId !== null) {
      const [product] = await tx
        .select()
        .from(facilityProducts)
        .where(
          and(
            eq(facilityProducts.tenantId, tenantId),
            eq(facilityProducts.id, item.productId),
          ),
        )
        .limit(1);
      if (!product) throw notFound("Produk");
      if (product.facilityId !== item.facilityId)
        throw invalid(
          "BUNDLE_ITEM_FACILITY",
          "Produk bukan milik fasilitas item.",
        );
      if (product.type !== "single")
        throw invalid(
          "BUNDLE_ITEM_TYPE",
          "Hanya produk tiket tunggal yang bisa masuk paket.",
        );
      if (!product.isActive)
        throw conflict(
          "BUNDLE_ITEM_INACTIVE",
          "Produk dalam paket sudah tidak aktif.",
        );
      components.push({
        item,
        sessionsPerUnit: product.sessions,
        listPriceIdr: product.priceIdr,
      });
    } else if (item.planId !== null) {
      const [plan] = await tx
        .select()
        .from(facilitySubscriptionPlans)
        .where(
          and(
            eq(facilitySubscriptionPlans.tenantId, tenantId),
            eq(facilitySubscriptionPlans.id, item.planId),
          ),
        )
        .limit(1);
      if (!plan) throw notFound("Paket langganan");
      if (plan.facilityId !== item.facilityId)
        throw invalid(
          "BUNDLE_ITEM_FACILITY",
          "Paket langganan bukan milik fasilitas item.",
        );
      if (!plan.isActive)
        throw conflict(
          "BUNDLE_ITEM_INACTIVE",
          "Paket langganan dalam paket sudah tidak aktif.",
        );
      // No subscription grant path exists yet: the bundle grants the plan's
      // quota of one period as sessions (brief of legend-bz9h).
      components.push({
        item,
        sessionsPerUnit: plan.quotaPerPeriod,
        listPriceIdr: plan.priceIdr,
      });
    } else {
      throw invalid(
        "BUNDLE_ITEM_COMPONENT",
        "Item paket tanpa produk atau paket langganan.",
      );
    }
  }
  for (const component of components)
    if (
      component.sessionsPerUnit * component.item.quantity >
      WFC_BUNDLE_MAX_SESSIONS_PER_ITEM
    )
      throw invalid(
        "BUNDLE_ITEM_SESSIONS",
        "Sesi satu item paket melebihi 100.",
      );
  return components;
}

const listTotal = (components: Component[]): number =>
  components.reduce(
    (sum, component) => sum + component.listPriceIdr * component.item.quantity,
    0,
  );

// ---- Create / list ------------------------------------------------------------

/** M3: a bundle price is a discount only (> 0 and <= sum of component list prices). */
export async function createWfcBundle(
  context: ScopedTenantContext,
  actorUserId: string,
  rawInput: CreateWfcBundleInput,
  now = new Date(),
): Promise<WfcBundle> {
  const actor = userIdSchema.parse(actorUserId);
  // Strict parse at the service boundary: callers cannot bypass the schema.
  const input = createWfcBundleSchema.parse(rawInput);
  return withTenant(db, context, async (tx) => {
    if (input.items.length === 0)
      throw invalid("BUNDLE_EMPTY", "Paket butuh minimal satu item.");
    const firstFacility = await loadFacility(
      tx,
      context,
      input.items[0]!.facilityId,
    );
    const outletId = firstFacility.outletId;
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      outletId,
    );

    const seen = new Set<string>();
    for (const item of input.items) {
      const facility = await loadFacility(tx, context, item.facilityId);
      if (facility.outletId !== outletId)
        throw invalid(
          "BUNDLE_OUTLET_MISMATCH",
          "Semua item paket harus di outlet yang sama.",
        );
      const key = item.productId
        ? `product:${item.productId}`
        : `plan:${item.planId}`;
      if (seen.has(key))
        throw invalid(
          "BUNDLE_ITEM_DUPLICATE",
          "Item paket yang sama muncul dua kali; gabungkan jumlahnya.",
        );
      seen.add(key);
    }

    const { idempotencyKey, ...payload } = input;
    return createOnce<WfcBundle, WfcBundle>(tx, context, {
      idempotencyKey,
      payload,
      outletId,
      resultTable: "wfc_bundles",
      label: "Paket",
      load: (id) => loadBundle(tx, context, id),
      map: (bundle) => bundle,
      create: async () => {
        const draftItems = input.items.map(
          (item) =>
            ({
              id: "",
              tenantId: context.tenant.tenantId,
              outletId,
              bundleId: "",
              facilityId: item.facilityId,
              productId: item.productId ?? null,
              planId: item.planId ?? null,
              quantity: item.quantity,
              createdAt: now,
            }) as ItemRow,
        );
        const components = await resolveComponents(tx, context, draftItems);
        if (!isValidBundlePrice(input.priceIdr, listTotal(components)))
          throw invalid(
            "BUNDLE_PRICE_INVALID",
            "Harga paket harus lebih dari 0 dan tidak boleh melebihi jumlah harga normal item.",
          );
        const [bundle] = await tx
          .insert(wfcBundles)
          .values({
            tenantId: context.tenant.tenantId,
            outletId,
            name: input.name,
            priceIdr: idr(input.priceIdr),
            validityDays: input.validityDays ?? 1,
            status: "active",
            createdAt: now,
          })
          .returning();
        if (!bundle) throw new Error("Bundle was not created");
        const items = await tx
          .insert(wfcBundleItems)
          .values(
            draftItems.map((item) => ({
              tenantId: context.tenant.tenantId,
              outletId,
              bundleId: bundle.id,
              facilityId: item.facilityId,
              productId: item.productId,
              planId: item.planId,
              quantity: item.quantity,
              createdAt: now,
            })),
          )
          .returning();
        await auditFacility(tx, context, actor, now, {
          action: "wfc_bundle.created",
          objectType: "wfc_bundle",
          objectId: bundle.id,
          outletId,
          before: null,
          after: {
            id: bundle.id,
            priceIdr: bundle.priceIdr,
            itemCount: items.length,
          },
        });
        return toBundle(bundle, items);
      },
    });
  });
}

export async function listWfcBundles(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListWfcBundlesQuery,
): Promise<WfcBundle[]> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      query.outletId,
    );
    const rows = await tx
      .select()
      .from(wfcBundles)
      .where(
        and(
          eq(wfcBundles.tenantId, context.tenant.tenantId),
          eq(wfcBundles.outletId, outletIdSchema.parse(query.outletId)),
          ...(query.status ? [eq(wfcBundles.status, query.status)] : []),
        ),
      )
      .orderBy(asc(wfcBundles.createdAt), asc(wfcBundles.id));
    const result: WfcBundle[] = [];
    for (const row of rows)
      result.push(toBundle(row, await loadItems(tx, context, row.id)));
    return result;
  });
}

// ---- Purchase -----------------------------------------------------------------

/**
 * M1/M3/M4: records a paid purchase (`paidIdr` must equal the stored bundle
 * price), splits the price over the items and issues one entitlement per item.
 * A replay of the same `paymentRef` returns the first purchase and issues
 * nothing new; the same ref for another bundle, customer or amount is a 409.
 */
export async function purchaseWfcBundle(
  context: ScopedTenantContext,
  actorUserId: string,
  rawInput: PurchaseWfcBundleInput,
  now = new Date(),
): Promise<WfcBundlePurchase> {
  const actor = userIdSchema.parse(actorUserId);
  // Strict parse at the service boundary: callers cannot bypass the schema.
  const input = purchaseWfcBundleSchema.parse(rawInput);
  return withTenant(db, context, async (tx) => {
    const bundle = await loadBundleRow(tx, context, input.bundleId);
    if (!bundle) throw notFound("Paket");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      bundle.outletId,
    );

    const replay = async (): Promise<WfcBundlePurchase | null> => {
      const [existing] = await tx
        .select()
        .from(wfcBundlePurchases)
        .where(
          and(
            eq(wfcBundlePurchases.tenantId, context.tenant.tenantId),
            eq(wfcBundlePurchases.paymentRef, input.paymentRef),
          ),
        )
        .limit(1);
      if (!existing) return null;
      if (
        existing.bundleId !== input.bundleId ||
        existing.customerProfileId !== input.customerProfileId ||
        existing.pricePaidIdr !== input.paidIdr
      )
        throw conflict(
          "PAYMENT_REF_REUSED",
          "Referensi pembayaran sudah dipakai pembelian lain.",
        );
      return toPurchase(
        existing,
        await loadAllocations(tx, context, existing.id),
      );
    };

    const prior = await replay();
    if (prior) return prior;

    if (bundle.status !== "active")
      throw conflict("BUNDLE_INACTIVE", "Paket tidak aktif.");
    // M1: the amount captured must be exactly the stored price.
    if (input.paidIdr !== bundle.priceIdr)
      throw conflict(
        "PAID_AMOUNT_MISMATCH",
        "Jumlah dibayar tidak sama dengan harga paket.",
      );

    const items = await loadItems(tx, context, bundle.id);
    const components = await resolveComponents(tx, context, items);
    // The list prices may have been edited since the bundle was created.
    if (!isValidBundlePrice(bundle.priceIdr, listTotal(components)))
      throw conflict(
        "BUNDLE_PRICE_INVALID",
        "Harga paket melebihi jumlah harga normal item; paket perlu ditinjau.",
      );
    const parts = allocateBundlePrice(
      bundle.priceIdr,
      components.map(
        (component) => component.listPriceIdr * component.item.quantity,
      ),
    );

    const [purchase] = await tx
      .insert(wfcBundlePurchases)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: bundle.outletId,
        bundleId: bundle.id,
        customerProfileId: input.customerProfileId,
        pricePaidIdr: bundle.priceIdr,
        refundedIdr: idr(0),
        status: "paid",
        paymentRef: input.paymentRef,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!purchase) {
      // A concurrent request with the same payment ref won the insert.
      const raced = await replay();
      if (raced) return raced;
      throw new Error("Bundle purchase conflict without a stored purchase");
    }

    const allocations = await tx
      .insert(wfcBundlePurchaseAllocations)
      .values(
        components.map((component, index) => ({
          tenantId: context.tenant.tenantId,
          outletId: bundle.outletId,
          purchaseId: purchase.id,
          itemId: component.item.id,
          allocatedIdr: parts[index]!,
          createdAt: now,
        })),
      )
      .returning();

    const expiresAt = new Date(now.getTime() + bundle.validityDays * DAY_MS);
    for (const allocation of allocations) {
      const component = components.find(
        (candidate) => candidate.item.id === allocation.itemId,
      )!;
      const result = await issueEntitlement(tx, context, {
        facilityId: component.item.facilityId,
        customerProfileId: input.customerProfileId,
        source: "package",
        sourceRef: allocation.id,
        ruleId: null,
        sessions: component.sessionsPerUnit * component.item.quantity,
        expiresAt,
        paid: true,
        conditionsMet: true,
        actorUserId: actor,
        occurredAt: now,
      });
      if (result.status === "rejected")
        throw new Error(`Bundle entitlement rejected: ${result.reason}`);
    }

    await auditFacility(tx, context, actor, now, {
      action: "wfc_bundle.purchased",
      objectType: "wfc_bundle_purchase",
      objectId: purchase.id,
      outletId: purchase.outletId,
      before: null,
      after: {
        id: purchase.id,
        bundleId: purchase.bundleId,
        pricePaidIdr: purchase.pricePaidIdr,
        itemCount: allocations.length,
      },
    });
    return toPurchase(purchase, allocations);
  });
}

// ---- Refund -------------------------------------------------------------------

/** Value of the sessions of one allocation that are used, rounded up (never pays more). */
function usedValue(
  allocatedIdr: number,
  usedSessions: number,
  grantedSessions: number,
): number {
  if (grantedSessions <= 0 || usedSessions >= grantedSessions)
    return allocatedIdr;
  if (usedSessions <= 0) return 0;
  return Math.min(
    allocatedIdr,
    Math.ceil((allocatedIdr * usedSessions) / grantedSessions),
  );
}

/**
 * Amount of the price paid that is still refundable: price paid minus the
 * value of redeemed or expired sessions (M2). A missing grant counts as fully
 * used, the conservative answer.
 */
async function refundableIdr(
  tx: Tx,
  context: ScopedTenantContext,
  purchase: PurchaseRow,
  allocations: AllocationRow[],
  now: Date,
): Promise<number> {
  const tenantId = context.tenant.tenantId;
  const grants =
    allocations.length === 0
      ? []
      : await tx
          .select({
            id: entitlementLedger.id,
            sourceRef: entitlementLedger.sourceRef,
            sessions: entitlementLedger.sessions,
            expiresAt: entitlementLedger.expiresAt,
          })
          .from(entitlementLedger)
          .where(
            and(
              eq(entitlementLedger.tenantId, tenantId),
              eq(entitlementLedger.type, "grant"),
              eq(entitlementLedger.sourceType, "package"),
              inArray(
                entitlementLedger.sourceRef,
                allocations.map((allocation) => allocation.id),
              ),
            ),
          );
  const usedRows =
    grants.length === 0
      ? []
      : await tx
          .select({
            grantId: entitlementLedger.grantEntryId,
            used: sql<string>`COALESCE(SUM(${entitlementLedger.sessions}), 0)`,
          })
          .from(entitlementLedger)
          .where(
            and(
              eq(entitlementLedger.tenantId, tenantId),
              inArray(entitlementLedger.type, ["redeem", "expire"]),
              inArray(
                entitlementLedger.grantEntryId,
                grants.map((grant) => grant.id),
              ),
            ),
          )
          .groupBy(entitlementLedger.grantEntryId);
  const usedByGrant = new Map(
    usedRows.map((row) => [row.grantId, Number(row.used)]),
  );

  let used = 0;
  for (const allocation of allocations) {
    const grant = grants.find(
      (candidate) => candidate.sourceRef === allocation.id,
    );
    if (!grant) {
      used += allocation.allocatedIdr;
      continue;
    }
    // A grant past its expiry can no longer be redeemed: nothing of it is refundable.
    const lapsed = grant.expiresAt !== null && grant.expiresAt <= now;
    const usedSessions = lapsed
      ? grant.sessions
      : (usedByGrant.get(grant.id) ?? 0);
    used += usedValue(allocation.allocatedIdr, usedSessions, grant.sessions);
  }
  return Math.max(0, purchase.pricePaidIdr - used - purchase.refundedIdr);
}

/**
 * M2/M4: refunds up to the refundable amount and revokes the unredeemed
 * entitlements. A purchase that is already refunded answers with its stored
 * state and changes nothing, so a replay never pays twice.
 */
export async function refundWfcBundle(
  context: ScopedTenantContext,
  actorUserId: string,
  rawInput: RefundWfcBundleInput,
  now = new Date(),
): Promise<WfcBundlePurchase> {
  const actor = userIdSchema.parse(actorUserId);
  // Strict parse at the service boundary: callers cannot bypass the schema.
  const input = refundWfcBundleSchema.parse(rawInput);
  return withTenant(db, context, async (tx) => {
    const [visible] = await tx
      .select()
      .from(wfcBundlePurchases)
      .where(
        and(
          eq(wfcBundlePurchases.tenantId, context.tenant.tenantId),
          eq(wfcBundlePurchases.id, input.purchaseId),
        ),
      )
      .limit(1);
    if (!visible) throw notFound("Pembelian paket");
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      visible.outletId,
    );

    // Serialise refunds of one purchase, then read the state that is compared.
    const [purchase] = await tx
      .select()
      .from(wfcBundlePurchases)
      .where(
        and(
          eq(wfcBundlePurchases.tenantId, context.tenant.tenantId),
          eq(wfcBundlePurchases.id, input.purchaseId),
        ),
      )
      .limit(1)
      .for("update");
    if (!purchase) throw notFound("Pembelian paket");
    const allocations = await loadAllocations(tx, context, purchase.id);
    if (purchase.status === "refunded")
      return toPurchase(purchase, allocations);

    if (!Number.isSafeInteger(input.refundIdr) || input.refundIdr <= 0)
      throw invalid(
        "REFUND_AMOUNT_INVALID",
        "Jumlah refund harus lebih dari 0.",
      );

    // Lock the customer's rights per facility (sorted) before reading what was
    // used, so a racing redemption is already in the ledger.
    const itemRows = await loadItems(tx, context, purchase.bundleId);
    const facilityIds = [
      ...new Set(itemRows.map((item) => item.facilityId)),
    ].sort();
    for (const facilityId of facilityIds)
      await lockCustomer(tx, context, purchase.customerProfileId, facilityId);

    const refundable = await refundableIdr(
      tx,
      context,
      purchase,
      allocations,
      now,
    );
    if (input.refundIdr > refundable)
      throw conflict(
        "REFUND_EXCEEDS_REFUNDABLE",
        "Refund melebihi nilai yang masih bisa dikembalikan.",
      );

    for (const allocation of allocations)
      await cancelEntitlementsForSource(tx, context, {
        sourceRef: allocation.id,
        sourceTypes: ["package"],
        reason: "Refund paket WFC",
        occurredAt: now,
      });

    const [updated] = await tx
      .update(wfcBundlePurchases)
      .set({ status: "refunded", refundedIdr: idr(input.refundIdr) })
      .where(
        and(
          eq(wfcBundlePurchases.tenantId, context.tenant.tenantId),
          eq(wfcBundlePurchases.id, purchase.id),
          eq(wfcBundlePurchases.status, "paid"),
        ),
      )
      .returning();
    if (!updated) throw conflict("REFUND_RACE", "Pembelian sudah di-refund.");
    await auditFacility(tx, context, actor, now, {
      action: "wfc_bundle.refunded",
      objectType: "wfc_bundle_purchase",
      objectId: purchase.id,
      outletId: purchase.outletId,
      before: { status: purchase.status, refundedIdr: purchase.refundedIdr },
      after: { status: updated.status, refundedIdr: updated.refundedIdr },
    });
    return toPurchase(updated, allocations);
  });
}
