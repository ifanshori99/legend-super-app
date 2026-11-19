// Shared building blocks of the inventory operation services (bead legend-ugo;
// PRD v1.7 §3 F16, F17, §6 E): access re-checks, the idempotency guard bound to
// a request fingerprint, location locks, the recipe source port and the
// recipe -> stock consumption plan. The services (waste, transfer, production,
// expiry, par alerts, suggestions) import from here; none of this is HTTP.
//
// Lock order used by every write of this bead (and compatible with
// inventory.service.ts, legend-98t):
//   1. the document row the write starts from (production order FOR UPDATE);
//   2. the per-location advisory locks `inventoryLocationLockKey`, ascending;
//   3. the `stock_balances` rows, ascending by item id (FOR UPDATE).
// Advisory locks are transaction-scoped and re-entrant, so the ledger helper
// `recordStockMovementInTransaction` taking them again never self-blocks.

import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  AccessError,
  type AccessTarget,
  type PermissionCode,
} from "@starter/shared/access";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  createUlid,
  decodeCursor,
  divideRounded,
  formatDecimal4,
  parseDecimal4,
  uuidSchema,
  type BusinessDayClock,
  type Decimal4,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  convertQuantity,
  grossRecipeQuantity,
  inventoryErrorHttpStatus,
  type RecipeComponentType,
  type UomConversion,
} from "@starter/shared/inventory";
import type * as schema from "../db/schema/index.ts";
import {
  inventoryItems,
  stockLocations,
  uomConversions,
} from "../db/schema/inventory.ts";
import { inventoryOpsIdempotency } from "../db/schema/inventory-ops.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { HttpError } from "../lib/http-error.ts";
import { translateDomainError } from "./domain-error-http.shared.ts";
import { recordAudit } from "./core-audit.ts";
import { inventoryLocationLockKey } from "./inventory.service.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";

type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type CursorPage<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

/** Tenant default while the rounding setting (PRD F11/WS-05) is not wired. */
export const ROUNDING_MODE = "half_up" as const;
/** Same outbox destination as the other WS-06 writers. */
export const EVENT_DESTINATION = "cloud-sync";
/** Decimal4 scale (10^4) and the scale of a quantity x unit-cost product. */
export const SCALE = 10_000n;
export const COST_PRODUCT_SCALE = SCALE * SCALE;

// ------------------------------------------------------------------ access

/** TEN-03: a requested outlet must be inside the caller's outlet scope. */
export function assertOutlet(
  context: ScopedTenantContext,
  outletId: string,
): void {
  assertTrustedScopedContext(context);
  assertOutletInScope(context.outletScope, outletId);
}

export function outletTarget(outletId: string): AccessTarget {
  return { type: "outlet", id: outletId };
}

/**
 * Server-side permission check on the open tenant transaction, independent of
 * the route middleware (deny by default). Returns the snapshot so a caller can
 * also ask for the cost-view permission without a second load.
 */
export async function requireOpsPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  outletId: string,
) {
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    actorUserId,
    new Date(),
  );
  if (!snapshot.allows(permission, outletTarget(outletId)))
    throw new AccessError("PERMISSION_DENIED");
  return snapshot;
}

/** Financial values (costs, loss values) follow `inventory.cost.view`. */
export function canViewCost(
  snapshot: Awaited<ReturnType<typeof requireOpsPermission>>,
  outletId: string,
): boolean {
  return snapshot.allows("inventory.cost.view", outletTarget(outletId));
}

// ------------------------------------------------------------- pagination

/** Strict cursor decode; a tampered cursor is a 422, never a 500. */
export function cursorKeys(cursor: string | undefined, size: number): string[] {
  if (!cursor) return [];
  let keys: ReturnType<typeof decodeCursor>;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  }
  if (keys.length !== size || keys.some((key) => typeof key !== "string"))
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return keys as string[];
}

/** A UUID cursor key, checked before it reaches a `::uuid` cast. */
export function cursorUuid(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return parsed.data;
}

export function cursorInstant(value: string): Date {
  const at = new Date(value);
  if (Number.isNaN(at.getTime()))
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return at;
}

// ------------------------------------------------------------ outlet clock

/** Outlet time zone + business-day cutoff (D-CORE-6, owner Q39). */
export async function loadOutletClock(
  tx: Tx,
  outletId: string,
): Promise<BusinessDayClock> {
  const [outlet] = await tx
    .select({
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(eq(outlets.id, outletId));
  if (!outlet) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
  return outletBusinessDayClock({
    timezone: outlet.timezone,
    businessDayCutoff: outlet.businessDayCutoff,
  });
}

/** Outlets the alert jobs evaluate: every outlet that is not closed. */
export async function listJobOutletIds(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<string[]> {
  const rows = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        sql`${outlets.status} <> 'closed'`,
      ),
    );
  return rows
    .map((row) => row.id as string)
    .filter((id) =>
      context.outletScope.kind === "tenant"
        ? true
        : context.outletScope.outletIds.some(
            (outletId) => outletId.toLowerCase() === id.toLowerCase(),
          ),
    )
    .sort();
}

// ----------------------------------------------------------- idempotency

/**
 * SHA-256 of the canonical request plus the actor: the same key from another
 * user, or with any field changed, is a different request (409), never a
 * replay of someone else's result.
 */
export function requestFingerprint(
  operation: string,
  actorUserId: string,
  canonicalRequest: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, actorUserId, canonicalRequest]))
    .digest("hex");
}

export type IdempotencyClaim = {
  operation: string;
  key: string;
  fingerprint: string;
  outletId: string;
};

async function findClaim(
  tx: Tx,
  context: ScopedTenantContext,
  claim: IdempotencyClaim,
) {
  const [row] = await tx
    .select()
    .from(inventoryOpsIdempotency)
    .where(
      and(
        eq(inventoryOpsIdempotency.tenantId, context.tenant.tenantId),
        eq(inventoryOpsIdempotency.operation, claim.operation),
        eq(inventoryOpsIdempotency.idempotencyKey, claim.key),
      ),
    );
  return row ?? null;
}

function replayOf(
  row: { requestFingerprint: string; response: unknown },
  claim: IdempotencyClaim,
): { replay: unknown } {
  if (row.requestFingerprint !== claim.fingerprint || row.response === null)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was used for a different request.",
    );
  return { replay: row.response };
}

/**
 * Claims `key` for this request inside the caller's transaction, BEFORE any
 * stock moves. Returns the stored response for a replay (same fingerprint),
 * throws IDEMPOTENCY_KEY_REUSED for a different request, or null when this
 * transaction now owns the key. A concurrent retry blocks on the primary key
 * until the owner commits (then replays) or rolls back (then owns the key).
 * A key held by another outlet is invisible under outlet RLS; the conflict
 * still fires and is answered as a reuse (fail closed).
 */
export async function claimIdempotency(
  tx: Tx,
  context: ScopedTenantContext,
  claim: IdempotencyClaim,
): Promise<{ replay: unknown } | null> {
  const existing = await findClaim(tx, context, claim);
  if (existing) return replayOf(existing, claim);
  const inserted = await tx
    .insert(inventoryOpsIdempotency)
    .values({
      tenantId: context.tenant.tenantId,
      outletId: claim.outletId,
      operation: claim.operation,
      idempotencyKey: claim.key,
      requestFingerprint: claim.fingerprint,
      response: null,
    })
    .onConflictDoNothing()
    .returning({ key: inventoryOpsIdempotency.idempotencyKey });
  if (inserted.length > 0) return null;
  const winner = await findClaim(tx, context, claim);
  if (!winner)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was used for a different request.",
    );
  return replayOf(winner, claim);
}

/** Stores the response the claim replays from now on (same transaction). */
export async function completeIdempotency(
  tx: Tx,
  context: ScopedTenantContext,
  claim: IdempotencyClaim,
  response: unknown,
): Promise<void> {
  await tx
    .update(inventoryOpsIdempotency)
    .set({ response })
    .where(
      and(
        eq(inventoryOpsIdempotency.tenantId, context.tenant.tenantId),
        eq(inventoryOpsIdempotency.operation, claim.operation),
        eq(inventoryOpsIdempotency.idempotencyKey, claim.key),
      ),
    );
}

// ------------------------------------------------------------------ locks

/**
 * legend-89zm: which of `locationIds` are stock locations of this outlet, with
 * their active flag. A recipe is brand-wide, so a recipe line may name a
 * location of another outlet; the deduction and the HPP snapshot share this
 * lookup to tell such a foreign location (fallback to the outlet sale
 * location) from an own one.
 */
export async function outletLocationStates(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  locationIds: readonly string[],
): Promise<Map<string, boolean>> {
  if (locationIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: stockLocations.id, isActive: stockLocations.isActive })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.tenantId, tenantId),
        eq(stockLocations.outletId, outletId),
        inArray(stockLocations.id, [...new Set(locationIds)]),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.isActive]));
}

/**
 * Takes the per-location advisory locks in ascending order (same key as the
 * ledger helper and the balance rebuild, legend-98t pre-review :1102/:1190).
 */
export async function lockLocations(
  tx: Tx,
  tenantId: string,
  locationIds: readonly string[],
): Promise<void> {
  for (const locationId of [...new Set(locationIds)].sort())
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${inventoryLocationLockKey(tenantId, locationId)}, 0))`,
    );
}

// ------------------------------------------------------------------ errors

/** No negative-stock bypass for explicit movements (waste/transfer/production). */
export function insufficientStock(itemId: string): HttpError {
  // The item id is the caller's own tenant data, so it stays in the message.
  return new HttpError(
    inventoryErrorHttpStatus.INSUFFICIENT_STOCK,
    "INSUFFICIENT_STOCK",
    `The location does not hold enough stock of item ${itemId}.`,
  );
}

/**
 * A counter of an open blind count tried to move that item out of the counted
 * location. Same status and generic message whatever the stock, so the answer
 * cannot leak the hidden quantity.
 */
export function blindCountLocked(): HttpError {
  return new HttpError(
    inventoryErrorHttpStatus.BLIND_COUNT_LOCKED,
    "BLIND_COUNT_LOCKED",
    "This item is locked for you while a blind stock count is open.",
  );
}

/** Contract status and safe message per code (see domain-error-http.shared.ts). */
export function translateInventoryError(error: unknown): unknown {
  return translateDomainError(error);
}

// ------------------------------------------------------------------- audit

export async function recordOpsAudit(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    actorUserId: string;
    outletId: string | null;
    action: string;
    objectType: string;
    objectId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
    safeFields: readonly string[];
    reason?: string | null;
  },
): Promise<void> {
  const now = new Date();
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: "user",
      actorId: input.actorUserId,
      deviceId: null,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      reason: input.reason ?? null,
      maskedChanges: {
        before:
          input.before === null
            ? null
            : maskAuditChanges(input.before, input.safeFields),
        after: maskAuditChanges(input.after, input.safeFields),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    input.safeFields,
  );
}

// ------------------------------------------------------ recipe source port

/**
 * The slice of a recipe version the stock operations need (PRD §17 "Resep
 * Bertingkat"). `nestedOutputItemIds` maps every nested recipe a line points
 * at to its output item: a nested component is drawn from that semi-finished
 * item's stock, which an earlier production batch put away.
 */
export type RecipeForStock = {
  recipeId: string;
  isActive: boolean;
  outputItemId: string | null;
  yieldQuantity: Decimal4;
  yieldUomId: string;
  lines: readonly {
    componentType: RecipeComponentType;
    componentId: string;
    quantity: Decimal4;
    uomId: string;
    wastePctBp: number;
  }[];
  nestedOutputItemIds: ReadonlyMap<string, string | null>;
};

/**
 * Port to the recipe/BOM engine (legend-db6), which owns the recipe tables.
 * Until it is wired the default answers "no recipe", so production orders and
 * menu-portion waste fail closed (404 RECIPE_NOT_FOUND) instead of guessing.
 */
export type InventoryRecipeSource = {
  loadRecipe(
    tx: Tx,
    context: ScopedTenantContext,
    recipeId: string,
  ): Promise<RecipeForStock | null>;
  /** The active recipe of a menu item (base portion), for menu waste. */
  loadMenuItemRecipe(
    tx: Tx,
    context: ScopedTenantContext,
    menuItemId: string,
  ): Promise<RecipeForStock | null>;
};

const unavailableRecipeSource: InventoryRecipeSource = {
  loadRecipe: async () => null,
  loadMenuItemRecipe: async () => null,
};

let recipeSource: InventoryRecipeSource = unavailableRecipeSource;

/** Wiring point for legend-db6 (and test doubles). */
export function setInventoryRecipeSource(
  source: InventoryRecipeSource | null,
): void {
  recipeSource = source ?? unavailableRecipeSource;
}

export function inventoryRecipeSource(): InventoryRecipeSource {
  return recipeSource;
}

/**
 * INV-02 consumption plan: the gross base-unit quantity of every stock item a
 * recipe draws for `multiplier` yield units (production: the planned batch;
 * menu waste: the wasted portions). Each line is scaled by
 * multiplier / yieldQuantity, converted to the item's base unit with the
 * stored conversions and grossed up by its prep loss (gross = net ÷ (1 −
 * waste), owner Q19). Lines on the same item are summed.
 */
export async function recipeConsumptionPlan(
  tx: Tx,
  recipe: RecipeForStock,
  multiplier: Decimal4,
): Promise<Map<string, Decimal4>> {
  const yieldQuantity = parseDecimal4(recipe.yieldQuantity);
  if (yieldQuantity <= 0n)
    throw new HttpError(422, "VALIDATION_ERROR", "The recipe yields nothing.");
  const componentItem = (line: RecipeForStock["lines"][number]): string => {
    if (line.componentType === "item") return line.componentId;
    const output = recipe.nestedOutputItemIds.get(line.componentId);
    if (!output)
      throw new HttpError(
        422,
        "RECIPE_OUTPUT_MISSING",
        `Nested recipe ${line.componentId} has no output item.`,
      );
    return output;
  };
  const itemIds = [...new Set(recipe.lines.map(componentItem))];
  if (itemIds.length === 0)
    throw new HttpError(422, "VALIDATION_ERROR", "The recipe has no lines.");
  const items = await tx
    .select({ id: inventoryItems.id, baseUomId: inventoryItems.baseUomId })
    .from(inventoryItems)
    .where(inArray(inventoryItems.id, itemIds));
  const baseUom = new Map(items.map((item) => [item.id, item.baseUomId]));
  const conversionRows = await tx
    .select()
    .from(uomConversions)
    .where(inArray(uomConversions.inventoryItemId, itemIds));
  const conversions: UomConversion[] = conversionRows.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    inventoryItemId: row.inventoryItemId,
    fromUomId: row.fromUomId,
    toUomId: row.toUomId,
    factor: row.factor,
  })) as UomConversion[];

  const plan = new Map<string, bigint>();
  for (const line of recipe.lines) {
    const itemId = componentItem(line);
    const base = baseUom.get(itemId);
    if (!base)
      throw new HttpError(
        422,
        "RECIPE_COMPONENT_MISSING",
        `Recipe references missing item ${itemId}.`,
      );
    // Decimal4 x Decimal4 / Decimal4 stays at Decimal4 scale: one rounding.
    const net = formatDecimal4(
      divideRounded(
        parseDecimal4(line.quantity) * parseDecimal4(multiplier),
        yieldQuantity,
        ROUNDING_MODE,
      ),
    );
    const baseNet = convertQuantity(
      net,
      line.uomId,
      base,
      conversions.filter((conversion) => conversion.inventoryItemId === itemId),
      ROUNDING_MODE,
    );
    const gross = grossRecipeQuantity(baseNet, line.wastePctBp, ROUNDING_MODE);
    plan.set(itemId, (plan.get(itemId) ?? 0n) + parseDecimal4(gross));
  }
  const result = new Map<string, Decimal4>();
  for (const [itemId, scaled] of plan)
    if (scaled > 0n) result.set(itemId, formatDecimal4(scaled));
  return result;
}

/** Σ |quantity| x unit cost at COST_PRODUCT_SCALE -> whole rupiah, rounded once. */
export function scaledCostToIdr(scaled: bigint): number {
  return Number(divideRounded(scaled, COST_PRODUCT_SCALE, ROUNDING_MODE));
}
