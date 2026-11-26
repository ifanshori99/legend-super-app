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
import { and, asc, eq, isNull, or } from "drizzle-orm";
import {
  userIdSchema,
  type OutletId,
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
import type { TaxRuleId } from "@starter/shared/tax";
import {
  assertConfigFresh,
  createOnce,
  lockConfigRow,
} from "./facility-config-guard.ts";
import { db } from "../db/index.ts";
import {
  entitlementRules,
  facilityAddons,
  facilityProducts,
  facilitySubscriptionPlans,
} from "../db/schema/facility.ts";
import { menuItems } from "../db/schema/menu.ts";
import { taxRules } from "../db/schema/tax.ts";
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

/**
 * `tax_rule_id` and `menu_item_id` carry no FK (other workstreams own those
 * tables), so the service proves the id is a row of this tenant before it is
 * stored: a tax rule must be tenant-wide or of the facility's own outlet, a
 * menu item must be a live item of the tenant (TEN-01/TEN-03).
 */
async function assertTaxRuleRef(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  taxRuleId: string | null | undefined,
): Promise<void> {
  if (taxRuleId === null || taxRuleId === undefined) return;
  const [row] = await tx
    .select({ id: taxRules.id })
    .from(taxRules)
    .where(
      and(
        eq(taxRules.tenantId, context.tenant.tenantId),
        eq(taxRules.id, taxRuleId as TaxRuleId),
        or(isNull(taxRules.outletId), eq(taxRules.outletId, outletId)),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Aturan pajak");
}

async function assertMenuItemRef(
  tx: Tx,
  context: ScopedTenantContext,
  menuItemId: string | null | undefined,
): Promise<void> {
  if (menuItemId === null || menuItemId === undefined) return;
  const [row] = await tx
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, context.tenant.tenantId),
        eq(menuItems.id, menuItemId),
        isNull(menuItems.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Item menu");
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
    updatedAt: row.updatedAt.toISOString(),
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
    updatedAt: row.updatedAt.toISOString(),
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
    updatedAt: row.updatedAt.toISOString(),
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
    updatedAt: row.updatedAt.toISOString(),
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
    const { idempotencyKey, ...payload } = input;
    return createOnce(tx, context, {
      idempotencyKey,
      payload,
      outletId: facility.outletId,
      resultTable: "facility_products",
      label: "Produk",
      load: async (id) => loadProduct(tx, context, id),
      map: toProduct,
      create: async () => {
        await assertTaxRuleRef(tx, context, facility.outletId, input.taxRuleId);
        await assertMenuItemRef(tx, context, input.menuItemId);
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
            priceIdr: row.priceIdr,
            quota: row.sessions,
            maxPerDay: row.maxPerDay,
            isActive: row.isActive,
          },
        });
        return row;
      },
    });
  });
}

/**
 * Brief 1270 W1: the price, quota and till link of a WFC product are set only
 * by `setWfcProduct`, and switching it on needs the price floor (W1b), so this
 * editor may rename it, change its tax rule or switch it off, nothing else.
 */
function assertWfcProductUntouched(
  existing: ProductRow,
  input: UpdateProductInput,
): void {
  if (existing.wfcKind === null) return;
  const changes = (key: "priceIdr" | "sessions" | "maxPerDay" | "menuItemId") =>
    input[key] !== undefined && input[key] !== existing[key];
  if (
    changes("priceIdr") ||
    changes("sessions") ||
    changes("maxPerDay") ||
    changes("menuItemId") ||
    (input.isActive === true && !existing.isActive)
  )
    throw new HttpError(
      409,
      "WFC_PRODUCT_MANAGED",
      "Harga, kuota, dan status jual produk WFC diatur di pengaturan WFC.",
    );
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
    const found = await loadProduct(tx, context, productId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      found.outletId,
    );
    await lockConfigRow(tx, "facility_products", context, productId);
    const existing = await loadProduct(tx, context, productId);
    assertConfigFresh(existing.updatedAt, input.expectedUpdatedAt);
    assertWfcProductUntouched(existing, input);
    await assertTaxRuleRef(tx, context, existing.outletId, input.taxRuleId);
    await assertMenuItemRef(tx, context, input.menuItemId);
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
        priceIdr: existing.priceIdr,
        quota: existing.sessions,
        maxPerDay: existing.maxPerDay,
        isActive: existing.isActive,
      },
      after: {
        id: row.id,
        facilityId: row.facilityId,
        type: row.type,
        priceIdr: row.priceIdr,
        quota: row.sessions,
        maxPerDay: row.maxPerDay,
        isActive: row.isActive,
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
    const { idempotencyKey, ...payload } = input;
    return createOnce(tx, context, {
      idempotencyKey,
      payload,
      outletId: facility.outletId,
      resultTable: "facility_addons",
      label: "Add-on",
      load: async (id) => loadAddon(tx, context, id),
      map: toAddon,
      create: async () => {
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
            priceIdr: row.priceIdr,
            isEnabled: row.isEnabled,
          },
        });
        return row;
      },
    });
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
    const found = await loadAddon(tx, context, addonId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      found.outletId,
    );
    await lockConfigRow(tx, "facility_addons", context, addonId);
    const existing = await loadAddon(tx, context, addonId);
    assertConfigFresh(existing.updatedAt, input.expectedUpdatedAt);
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
      before: {
        id: existing.id,
        sortOrder: existing.sortOrder,
        priceIdr: existing.priceIdr,
        isEnabled: existing.isEnabled,
      },
      after: {
        id: row.id,
        sortOrder: row.sortOrder,
        priceIdr: row.priceIdr,
        isEnabled: row.isEnabled,
      },
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
    // A replace may move the rule to another facility: the caller must also
    // hold the permission on the outlet the rule leaves (TEN-03).
    if (existing && existing.outletId !== facility.outletId)
      await assertFacilityPermission(
        tx,
        context,
        actor,
        CONFIG_PERMISSION,
        existing.outletId,
      );
    assertConfigFresh(existing?.updatedAt ?? null, input.expectedUpdatedAt);
    if (input.type === "package")
      await assertMenuItemRef(tx, context, input.condition.menuItemId);
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
      before: existing ? ruleAuditValues(existing) : null,
      after: ruleAuditValues(row),
    });
    return toEntitlementRule(row);
  });
}

/** Quota and threshold of a rule, kept readable in the audit (old + new). */
function ruleAuditValues(row: RuleRow): Record<string, unknown> {
  const condition = row.condition as { minSpendIdr?: number };
  return {
    id: row.id,
    facilityId: row.facilityId,
    type: row.type,
    quota: row.sessions,
    isEnabled: row.isEnabled,
    ...(condition.minSpendIdr !== undefined && {
      minSpendIdr: condition.minSpendIdr,
    }),
  };
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
    const { idempotencyKey, ...payload } = input;
    return createOnce(tx, context, {
      idempotencyKey,
      payload,
      outletId: facility.outletId,
      resultTable: "facility_subscription_plans",
      label: "Paket langganan",
      load: async (id) => loadSubscriptionPlan(tx, context, id),
      map: toSubscriptionPlan,
      create: async () => {
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
          after: planAuditValues(row),
        });
        return row;
      },
    });
  });
}

/** Price and quota of a plan, kept readable in the audit (old + new). */
function planAuditValues(row: PlanRow): Record<string, unknown> {
  return {
    id: row.id,
    facilityId: row.facilityId,
    priceIdr: row.priceIdr,
    quotaPerPeriod: row.quotaPerPeriod,
    interval: row.interval,
    maxPerDay: row.maxPerDay,
    isActive: row.isActive,
  };
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
    const found = await loadSubscriptionPlan(tx, context, planId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      CONFIG_PERMISSION,
      found.outletId,
    );
    await lockConfigRow(tx, "facility_subscription_plans", context, planId);
    const existing = await loadSubscriptionPlan(tx, context, planId);
    assertConfigFresh(existing.updatedAt, input.expectedUpdatedAt);
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
      before: planAuditValues(existing),
      after: planAuditValues(row),
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
