// Facility products, add-ons, entitlement rules and subscription plans
// (PRD v1.7 §3 F22/F25 "Produk & Hak Akses", "Add-on Opsional", "Langganan
// Bulanan"; bead legend-8dpm). Routes: routes/facility.routes.ts; the same
// lists feed the config read model (facility-config.service.ts).
//
// Writes run inside `withTenant` (RLS scopes rows to the tenant and the
// caller's outlets), re-check `facility.config.manage` on the concrete
// facility's outlet (TEN-03) and land an audit entry. Reads are exported as
// transaction-scoped list functions so the config read and the write results
// share one transaction and one permission check.
import { and, asc, eq } from "drizzle-orm";
import {
  userIdSchema,
  type ScopedTenantContext,
  type TenantId,
  type z,
} from "@starter/shared/core";
import {
  entitlementRuleSchema,
  facilityAddonSchema,
  facilityProductSchema,
  subscriptionPlanSchema,
  type CreateFacilityAddonInput,
  type CreateFacilityProductInput,
  type CreateSubscriptionPlanInput,
  type EntitlementRule,
  type FacilityAddon,
  type FacilityProduct,
  type PutEntitlementRuleInput,
  type SubscriptionPlan,
  type updateFacilityAddonSchema,
  type updateFacilityProductSchema,
  type updateSubscriptionPlanSchema,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import {
  entitlementRules,
  facilityAddons,
  facilityProducts,
  facilitySubscriptionPlans,
} from "../db/schema/facility.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertFacilityPermission,
  auditFacility,
  CONFIG_PERMISSION,
  loadFacility,
  notFound,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
  type Tx,
} from "./facility-shared.ts";

type UpdateProductInput = z.output<typeof updateFacilityProductSchema>;
type UpdateAddonInput = z.output<typeof updateFacilityAddonSchema>;
type UpdatePlanInput = z.output<typeof updateSubscriptionPlanSchema>;

type ProductRow = typeof facilityProducts.$inferSelect;
type AddonRow = typeof facilityAddons.$inferSelect;
type RuleRow = typeof entitlementRules.$inferSelect;
type PlanRow = typeof facilitySubscriptionPlans.$inferSelect;

/** 23503 = foreign_key_violation (an inventory item of another tenant). */
const PG_FOREIGN_KEY_VIOLATION = "23503";

/**
 * Runs one write and translates the foreign-key failure of an unknown
 * inventory item into a 404. Only the write is wrapped, so an audit failure
 * never turns into a misleading "item not found".
 */
async function guardingInventoryItem<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION)
      throw new HttpError(404, "NOT_FOUND", "Item inventori tidak ditemukan.");
    throw error;
  }
}

/** Runs one PUT write and translates a duplicate client id into a 409. */
async function guardingClientId<T>(
  code: string,
  message: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
      throw new HttpError(409, code, message);
    throw error;
  }
}

// ---- Mappers ---------------------------------------------------------------

export function toProduct(row: ProductRow): FacilityProduct {
  return facilityProductSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    facilityId: row.facilityId,
    name: row.name,
    type: row.type,
    priceIdr: row.priceIdr,
    taxRuleId: row.taxRuleId,
    sessions: row.sessions,
    maxPerDay: row.maxPerDay,
    menuItemId: row.menuItemId,
    isActive: row.isActive,
  });
}

export function toAddon(row: AddonRow): FacilityAddon {
  return facilityAddonSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    facilityId: row.facilityId,
    name: row.name,
    priceIdr: row.priceIdr,
    inventoryItemId: row.inventoryItemId,
    isEnabled: row.isEnabled,
    sortOrder: row.sortOrder,
  });
}

export function toEntitlementRule(row: RuleRow): EntitlementRule {
  return entitlementRuleSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    facilityId: row.facilityId,
    type: row.type,
    condition: row.condition,
    sessions: row.sessions,
    validity: row.validity,
    isEnabled: row.isEnabled,
  });
}

export function toSubscriptionPlan(row: PlanRow): SubscriptionPlan {
  return subscriptionPlanSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    facilityId: row.facilityId,
    name: row.name,
    priceIdr: row.priceIdr,
    quotaPerPeriod: row.quotaPerPeriod,
    interval: row.interval,
    maxPerDay: row.maxPerDay,
    providerPlanId: row.providerPlanId,
    isActive: row.isActive,
  });
}

// ---- Reads (shared with the config read model) -----------------------------

export async function listFacilityProducts(
  tx: Tx,
  tenantId: TenantId,
  facilityId: string,
): Promise<FacilityProduct[]> {
  const rows = await tx
    .select()
    .from(facilityProducts)
    .where(
      and(
        eq(facilityProducts.tenantId, tenantId),
        eq(facilityProducts.facilityId, facilityId),
      ),
    )
    .orderBy(asc(facilityProducts.createdAt), asc(facilityProducts.id));
  return rows.map(toProduct);
}

export async function listFacilityAddons(
  tx: Tx,
  tenantId: TenantId,
  facilityId: string,
): Promise<FacilityAddon[]> {
  const rows = await tx
    .select()
    .from(facilityAddons)
    .where(
      and(
        eq(facilityAddons.tenantId, tenantId),
        eq(facilityAddons.facilityId, facilityId),
      ),
    )
    .orderBy(
      asc(facilityAddons.sortOrder),
      asc(facilityAddons.name),
      asc(facilityAddons.id),
    );
  return rows.map(toAddon);
}

export async function listEntitlementRules(
  tx: Tx,
  tenantId: TenantId,
  facilityId: string,
): Promise<EntitlementRule[]> {
  const rows = await tx
    .select()
    .from(entitlementRules)
    .where(
      and(
        eq(entitlementRules.tenantId, tenantId),
        eq(entitlementRules.facilityId, facilityId),
      ),
    )
    .orderBy(asc(entitlementRules.createdAt), asc(entitlementRules.id));
  return rows.map(toEntitlementRule);
}

export async function listFacilitySubscriptionPlans(
  tx: Tx,
  tenantId: TenantId,
  facilityId: string,
): Promise<SubscriptionPlan[]> {
  const rows = await tx
    .select()
    .from(facilitySubscriptionPlans)
    .where(
      and(
        eq(facilitySubscriptionPlans.tenantId, tenantId),
        eq(facilitySubscriptionPlans.facilityId, facilityId),
      ),
    )
    .orderBy(
      asc(facilitySubscriptionPlans.priceIdr),
      asc(facilitySubscriptionPlans.id),
    );
  return rows.map(toSubscriptionPlan);
}

// ---- Products --------------------------------------------------------------

export async function createFacilityProduct(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateFacilityProductInput,
  now = new Date(),
): Promise<FacilityProduct> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, input.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      facility.outletId,
    );
    const [row] = await tx
      .insert(facilityProducts)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: facility.outletId,
        facilityId: facility.id,
        name: input.name,
        type: input.type,
        priceIdr: input.priceIdr,
        taxRuleId: input.taxRuleId ?? null,
        sessions: input.sessions,
        maxPerDay: input.maxPerDay ?? null,
        menuItemId: input.menuItemId ?? null,
        isActive: input.isActive ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await auditFacility(tx, context, actor, now, {
      action: "facility_product.created",
      objectType: "facility_product",
      objectId: row.id,
      outletId: row.outletId,
      before: null,
      after: {
        id: row.id,
        facilityId: row.facilityId,
        type: row.type,
      },
    });
    return toProduct(row);
  });
}

export async function updateFacilityProduct(
  context: ScopedTenantContext,
  actorUserId: string,
  productId: string,
  input: UpdateProductInput,
  now = new Date(),
): Promise<FacilityProduct> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const existing = await loadProduct(tx, context, productId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      existing.outletId,
    );
    const [row] = await tx
      .update(facilityProducts)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.priceIdr !== undefined && { priceIdr: input.priceIdr }),
        ...(input.taxRuleId !== undefined && { taxRuleId: input.taxRuleId }),
        ...(input.sessions !== undefined && { sessions: input.sessions }),
        ...(input.maxPerDay !== undefined && { maxPerDay: input.maxPerDay }),
        ...(input.menuItemId !== undefined && {
          menuItemId: input.menuItemId,
        }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        updatedAt: now,
      })
      .where(
        and(
          eq(facilityProducts.tenantId, context.tenant.tenantId),
          eq(facilityProducts.id, productId),
        ),
      )
      .returning();
    await auditFacility(tx, context, actor, now, {
      action: "facility_product.updated",
      objectType: "facility_product",
      objectId: row.id,
      outletId: row.outletId,
      before: {
        id: existing.id,
        facilityId: existing.facilityId,
        type: existing.type,
      },
      after: {
        id: row.id,
        facilityId: row.facilityId,
        type: row.type,
      },
    });
    return toProduct(row);
  });
}

// ---- Add-ons ---------------------------------------------------------------

export async function createFacilityAddon(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateFacilityAddonInput,
  now = new Date(),
): Promise<FacilityAddon> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, input.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      facility.outletId,
    );
    const [row] = await guardingInventoryItem(() =>
      tx
        .insert(facilityAddons)
        .values({
          tenantId: context.tenant.tenantId,
          outletId: facility.outletId,
          facilityId: facility.id,
          name: input.name,
          priceIdr: input.priceIdr,
          inventoryItemId: input.inventoryItemId ?? null,
          isEnabled: input.isEnabled ?? true,
          sortOrder: input.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );
    await auditFacility(tx, context, actor, now, {
      action: "facility_addon.created",
      objectType: "facility_addon",
      objectId: row.id,
      outletId: row.outletId,
      before: null,
      after: {
        id: row.id,
        facilityId: row.facilityId,
        sortOrder: row.sortOrder,
      },
    });
    return toAddon(row);
  });
}

export async function updateFacilityAddon(
  context: ScopedTenantContext,
  actorUserId: string,
  addonId: string,
  input: UpdateAddonInput,
  now = new Date(),
): Promise<FacilityAddon> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const existing = await loadAddon(tx, context, addonId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      existing.outletId,
    );
    const [row] = await guardingInventoryItem(() =>
      tx
        .update(facilityAddons)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.priceIdr !== undefined && { priceIdr: input.priceIdr }),
          ...(input.inventoryItemId !== undefined && {
            inventoryItemId: input.inventoryItemId,
          }),
          ...(input.isEnabled !== undefined && { isEnabled: input.isEnabled }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
          updatedAt: now,
        })
        .where(
          and(
            eq(facilityAddons.tenantId, context.tenant.tenantId),
            eq(facilityAddons.id, addonId),
          ),
        )
        .returning(),
    );
    await auditFacility(tx, context, actor, now, {
      action: "facility_addon.updated",
      objectType: "facility_addon",
      objectId: row.id,
      outletId: row.outletId,
      before: { id: existing.id, sortOrder: existing.sortOrder },
      after: { id: row.id, sortOrder: row.sortOrder },
    });
    return toAddon(row);
  });
}

// ---- Entitlement rules (PUT replaces the rule wholesale) -------------------

/**
 * PUT semantics: the rule id is the key. An absent row is created with that
 * id, a present one is replaced wholesale (the contract requires the whole
 * condition every time), so a rule can never keep a stale threshold.
 */
export async function putEntitlementRule(
  context: ScopedTenantContext,
  actorUserId: string,
  ruleId: string,
  input: PutEntitlementRuleInput,
  now = new Date(),
): Promise<EntitlementRule> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, input.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      facility.outletId,
    );
    const [existing] = await tx
      .select()
      .from(entitlementRules)
      .where(
        and(
          eq(entitlementRules.tenantId, context.tenant.tenantId),
          eq(entitlementRules.id, ruleId),
        ),
      )
      .limit(1)
      .for("update");
    const values = {
      tenantId: context.tenant.tenantId,
      outletId: facility.outletId,
      facilityId: facility.id,
      type: input.type,
      condition: input.condition,
      sessions: input.sessions,
      validity: input.validity,
      isEnabled: input.isEnabled,
      updatedAt: now,
    };
    const [row] = await guardingClientId(
      "ENTITLEMENT_RULE_ID_TAKEN",
      "Id aturan hak akses sudah dipakai.",
      () =>
        existing
          ? tx
              .update(entitlementRules)
              .set(values)
              .where(
                and(
                  eq(entitlementRules.tenantId, context.tenant.tenantId),
                  eq(entitlementRules.id, ruleId),
                ),
              )
              .returning()
          : tx
              .insert(entitlementRules)
              .values({ id: ruleId, createdAt: now, ...values })
              .returning(),
    );
    await auditFacility(tx, context, actor, now, {
      action: existing
        ? "entitlement_rule.replaced"
        : "entitlement_rule.created",
      objectType: "entitlement_rule",
      objectId: row.id,
      outletId: row.outletId,
      before: existing
        ? {
            id: existing.id,
            facilityId: existing.facilityId,
            type: existing.type,
          }
        : null,
      after: { id: row.id, facilityId: row.facilityId, type: row.type },
    });
    return toEntitlementRule(row);
  });
}

// ---- Subscription plans ----------------------------------------------------

export async function createSubscriptionPlan(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateSubscriptionPlanInput,
  now = new Date(),
): Promise<SubscriptionPlan> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, input.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      facility.outletId,
    );
    const [row] = await tx
      .insert(facilitySubscriptionPlans)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: facility.outletId,
        facilityId: facility.id,
        name: input.name,
        priceIdr: input.priceIdr,
        quotaPerPeriod: input.quotaPerPeriod,
        interval: input.interval,
        maxPerDay: input.maxPerDay ?? null,
        providerPlanId: input.providerPlanId ?? null,
        isActive: input.isActive ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await auditFacility(tx, context, actor, now, {
      action: "facility_subscription_plan.created",
      objectType: "facility_subscription_plan",
      objectId: row.id,
      outletId: row.outletId,
      before: null,
      after: { id: row.id, facilityId: row.facilityId },
    });
    return toSubscriptionPlan(row);
  });
}

export async function updateSubscriptionPlan(
  context: ScopedTenantContext,
  actorUserId: string,
  planId: string,
  input: UpdatePlanInput,
  now = new Date(),
): Promise<SubscriptionPlan> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const existing = await loadSubscriptionPlan(tx, context, planId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      existing.outletId,
    );
    const [row] = await tx
      .update(facilitySubscriptionPlans)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.priceIdr !== undefined && { priceIdr: input.priceIdr }),
        ...(input.quotaPerPeriod !== undefined && {
          quotaPerPeriod: input.quotaPerPeriod,
        }),
        ...(input.interval !== undefined && { interval: input.interval }),
        ...(input.maxPerDay !== undefined && { maxPerDay: input.maxPerDay }),
        ...(input.providerPlanId !== undefined && {
          providerPlanId: input.providerPlanId,
        }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        updatedAt: now,
      })
      .where(
        and(
          eq(facilitySubscriptionPlans.tenantId, context.tenant.tenantId),
          eq(facilitySubscriptionPlans.id, planId),
        ),
      )
      .returning();
    await auditFacility(tx, context, actor, now, {
      action: "facility_subscription_plan.updated",
      objectType: "facility_subscription_plan",
      objectId: row.id,
      outletId: row.outletId,
      before: { id: existing.id, facilityId: existing.facilityId },
      after: { id: row.id, facilityId: row.facilityId },
    });
    return toSubscriptionPlan(row);
  });
}

// ---- Loaders ---------------------------------------------------------------

/** A product of this tenant; RLS hides other outlets, so this is also TEN-03. */
async function loadProduct(
  tx: Tx,
  context: ScopedTenantContext,
  productId: string,
): Promise<ProductRow> {
  const [row] = await tx
    .select()
    .from(facilityProducts)
    .where(
      and(
        eq(facilityProducts.tenantId, context.tenant.tenantId),
        eq(facilityProducts.id, productId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Produk");
  return row;
}

async function loadAddon(
  tx: Tx,
  context: ScopedTenantContext,
  addonId: string,
): Promise<AddonRow> {
  const [row] = await tx
    .select()
    .from(facilityAddons)
    .where(
      and(
        eq(facilityAddons.tenantId, context.tenant.tenantId),
        eq(facilityAddons.id, addonId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Add-on");
  return row;
}

async function loadSubscriptionPlan(
  tx: Tx,
  context: ScopedTenantContext,
  planId: string,
): Promise<PlanRow> {
  const [row] = await tx
    .select()
    .from(facilitySubscriptionPlans)
    .where(
      and(
        eq(facilitySubscriptionPlans.tenantId, context.tenant.tenantId),
        eq(facilitySubscriptionPlans.id, planId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Paket langganan");
  return row;
}
