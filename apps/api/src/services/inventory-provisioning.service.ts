// Default inventory provisioning (PRD v1.7 §3.19 and §16 "Lokasi Stok"; beads
// legend-a7x7, legend-4ryw): the standard UOM catalog per tenant and the six
// standard stock locations per outlet.
//
// Rules that live here:
// - Every function runs inside the caller's tenant transaction, so rows commit
//   or roll back together with the tenant/outlet that asked for them.
// - Idempotent and additive: existing rows are never updated or removed. UOMs
//   conflict-skip on (tenant_id, code); locations are added per missing type
//   (type, not name) under the per-outlet `lockOutletStockLocations` advisory
//   lock (shared with the location create/rename routes), because the table
//   has no unique per type. A missing type whose default name is already
//   taken (case-insensitive) is still added, under the first free
//   "<name> 2", "<name> 3", ... so a name clash never leaves a type missing.
//   A type counts as present even when its row is inactive; such a row is
//   the owner's choice and is not replaced.
// - One audit row per call that inserted something; a call that inserted
//   nothing writes no audit.

import { and, asc, eq } from "drizzle-orm";
import {
  createUlid,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  STANDARD_STOCK_LOCATIONS,
  STANDARD_UOM_CATALOG,
  type StockLocationType,
} from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { outlets, stockLocations, uoms } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import type { TenantTransaction } from "./accounting-shared.ts";
import { recordAudit } from "./core-audit.ts";
import { lockOutletStockLocations } from "./tenant-config-locks.ts";

/** Audit field names kept unmasked: counts and catalog codes, no free text. */
const AUDIT_SAFE_FIELDS = ["count", "uomCodes", "locationTypes"] as const;

async function auditProvisioning(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  actorId: UserId | null,
  input: {
    action: string;
    objectType: string;
    objectId: string;
    outletId: string | null;
    after: Record<string, unknown>;
  },
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: actorId === null ? "system" : "user",
      actorId,
      deviceId: null,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      reason: null,
      maskedChanges: { before: null, after: input.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: new Date().toISOString(),
    },
    AUDIT_SAFE_FIELDS,
  );
}

/** Adds the standard UOMs this tenant lacks; existing rows stay untouched. */
export async function provisionStandardUoms(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  actorId: UserId | null,
): Promise<{ inserted: number }> {
  const tenantId = context.tenant.tenantId;
  const rows = await tx
    .insert(uoms)
    .values(
      STANDARD_UOM_CATALOG.map((uom) => ({
        tenantId,
        code: uom.code,
        name: uom.name,
        isSystem: true,
      })),
    )
    .onConflictDoNothing({ target: [uoms.tenantId, uoms.code] })
    .returning({ code: uoms.code });
  if (rows.length > 0)
    await auditProvisioning(tx, context, actorId, {
      action: "inventory.uoms.provisioned",
      // The tenant-wide UOM catalog, not the tenant record itself: tenant
      // audits (status changes) stay separate from inventory master data.
      objectType: "uom_catalog",
      objectId: tenantId,
      outletId: null,
      after: { count: rows.length, uomCodes: rows.map((row) => row.code) },
    });
  return { inserted: rows.length };
}

/** Adds the standard stock location types this outlet lacks. */
export async function provisionOutletStockLocations(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  outletId: string,
  actorId: UserId | null,
): Promise<{ inserted: number }> {
  const tenantId = context.tenant.tenantId;
  // Same key as `lockOutletLocations` in inventory-setup.service.ts, so
  // provisioning and the location create/rename routes serialise per outlet:
  // two writers can never both see a type or a name as free.
  await lockOutletStockLocations(tx, tenantId, outletId);
  const existing = await tx
    .select({ type: stockLocations.type, name: stockLocations.name })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.tenantId, tenantId),
        eq(stockLocations.outletId, outletId),
      ),
    );
  const present = new Set<string>(existing.map((row) => row.type));
  // Names are unique per outlet, case-insensitively (`assertLocationNameFree`).
  // A missing type whose default name is taken gets the first free
  // "<name> 2", "<name> 3", ...; existing rows are never renamed or touched.
  // Names picked earlier in this batch count as taken too.
  const takenNames = new Set(existing.map((row) => row.name.toLowerCase()));
  const missing: { type: StockLocationType; name: string }[] = [];
  for (const location of STANDARD_STOCK_LOCATIONS) {
    if (present.has(location.type)) continue;
    let name: string = location.name;
    for (let n = 2; takenNames.has(name.toLowerCase()); n += 1)
      name = `${location.name} ${n}`;
    takenNames.add(name.toLowerCase());
    missing.push({ type: location.type, name });
  }
  if (missing.length === 0) return { inserted: 0 };
  await tx.insert(stockLocations).values(
    missing.map((location) => ({
      tenantId,
      outletId,
      name: location.name,
      type: location.type,
    })),
  );
  await auditProvisioning(tx, context, actorId, {
    action: "inventory.stock_locations.provisioned",
    objectType: "outlet",
    objectId: outletId,
    outletId,
    after: {
      count: missing.length,
      locationTypes: missing.map((location) => location.type),
    },
  });
  return { inserted: missing.length };
}

/** Tenant-wide context for a backfill; the id comes from the operator script. */
function backfillScope(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

/** Fills UOMs and every outlet's stock locations for one existing tenant. */
export async function backfillTenantInventoryDefaults(
  tenantId: string,
): Promise<{
  uomsInserted: number;
  outlets: number;
  locationsInserted: number;
}> {
  const context = backfillScope(tenantId);
  return withTenant(db, context, async (tx) => {
    const { inserted: uomsInserted } = await provisionStandardUoms(
      tx,
      context,
      null,
    );
    const outletRows = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(eq(outlets.tenantId, tenantId))
      // Fixed lock order: two backfills of one tenant cannot deadlock on the
      // per-outlet location locks.
      .orderBy(asc(outlets.id));
    let locationsInserted = 0;
    for (const outlet of outletRows) {
      const result = await provisionOutletStockLocations(
        tx,
        context,
        outlet.id,
        null,
      );
      locationsInserted += result.inserted;
    }
    return { uomsInserted, outlets: outletRows.length, locationsInserted };
  });
}
