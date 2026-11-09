// Tenant fixed asset categories (legend-dux2: "kategori aset" of the aset
// tetap register; schema `asset_categories`). A category belongs to the
// tenant, not to a legal entity or outlet, so reads and writes need tenant
// scope. Names are unique per tenant ignoring case (the unique index is the
// last line of defence; the advisory lock turns a race into a clean 409).

import {
  assetCategorySchema,
  createAssetCategoryInputSchema,
  type AssetCategory,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { assetCategories } from "../db/schema/accounting-ap-fa.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  advisoryLock,
  assertTenantScope,
  auditApFa,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";

type AssetCategoryRow = typeof assetCategories.$inferSelect;

export function toAssetCategory(row: AssetCategoryRow): AssetCategory {
  return assetCategorySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
  });
}

/** A category of this tenant; another tenant's is indistinguishable from a missing one. */
export async function requireAssetCategory(
  tx: TenantTransaction,
  tenantId: string,
  categoryId: string,
): Promise<AssetCategoryRow> {
  const [row] = await tx
    .select()
    .from(assetCategories)
    .where(
      and(
        eq(assetCategories.tenantId, tenantId),
        eq(assetCategories.id, categoryId),
      ),
    )
    .limit(1);
  if (!row)
    throw new HttpError(404, "NOT_FOUND", "Asset category not found.");
  return row;
}

export async function listAssetCategories(
  context: ScopedTenantContext,
): Promise<{ data: AssetCategory[] }> {
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(assetCategories)
      .where(eq(assetCategories.tenantId, context.tenant.tenantId))
      .orderBy(asc(sql`lower(${assetCategories.name})`), asc(assetCategories.id));
    return { data: rows.map(toAssetCategory) };
  });
}

export async function createAssetCategory(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
): Promise<AssetCategory> {
  const input = createAssetCategoryInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await advisoryLock(tx, `fa-category:${tenantId}`);
    const [existing] = await tx
      .select({ id: assetCategories.id })
      .from(assetCategories)
      .where(
        and(
          eq(assetCategories.tenantId, tenantId),
          sql`lower(${assetCategories.name}) = lower(${input.name})`,
        ),
      )
      .limit(1);
    if (existing)
      throw new HttpError(
        409,
        "CONFLICT",
        "An asset category with this name already exists.",
      );
    const [row] = await tx
      .insert(assetCategories)
      .values({ tenantId, name: input.name, createdBy: actorId })
      .returning();
    if (!row) throw new Error("Asset category insert returned no row.");
    await auditApFa(tx, context, {
      actorId,
      action: "accounting.asset_category.created",
      objectType: "asset_category",
      objectId: row.id,
      before: null,
      // Names stay out of the audit row (audit masking is default-deny).
      after: { count: 1 },
    });
    return toAssetCategory(row);
  });
}
