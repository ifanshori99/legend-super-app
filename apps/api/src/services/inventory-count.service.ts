// Stock opname (PRD v1.7 §3 F16 "Stok Opname", INV-03; §4 Alur J; bead
// legend-j5x).
//
// A count is one session for ONE stock location, `full` (every active item
// plus any item holding a balance there) or `cycle` (the given items).
//
// Snapshot and the delta method (no freeze): `system_qty` and `unit_cost_idr`
// (moving average) are taken at create and REFRESHED at `start`
// (draft -> counting), which is "stok sistem saat opname dimulai". Sales and
// receipts keep posting to the location while it is counted, so the physical
// count describes the stock AT THE SNAPSHOT, and the adjustment posted per
// line is `counted_qty - system_qty(snapshot)`, never `counted - current
// balance`. Movements after the snapshot stay in the ledger untouched: the
// final balance is counted + the movements since the snapshot.
//
// Blind count: the system quantity and variance never reach a counter. The
// counter uses the sheet endpoints (no system qty / cost / variance keys at
// all); the full detail of a blind count is approver-only and only once it is
// submitted; create answers with no lines.
//
// Approval (INV-03, fail closed): `submit` computes the line variances, binds
// the approval to the lines (`count_version` + sha256 `lines_hash`) and opens
// an `approval_requests` chain (`stock_adjustment`, amount = Σ|variance|). No
// policy routing means 409 STOCK_COUNT_APPROVAL_UNROUTED. The approver can
// never be the creator or any line counter. `approve`/`reject` decide the
// current level, then SETTLE the chain on the locked count row; approvals made
// in the generic inbox are honoured by `post` (or any later approve), which
// only settles. An approved chain posts in the same transaction (PRD J.4) and
// the terminal `posted` status makes the approval single-use.
//
// Posting (INV-01): one `adjustment` / `stock_count` ledger row per non-zero
// line through `recordStockMovementInTransaction`, valued at the snapshot
// moving-average cost, idempotency key `stock-count:<countId>:<lineId>`
// (`:<n>` for the 2nd+ batch row of a split). A decrease is drawn FEFO across
// the batches (the part above the current on-hand goes unbatched); an increase
// has no batch to attribute to and is posted unbatched.
//
// Lock order: the count row FOR UPDATE, then the per-location advisory lock,
// then the balance rows (ledger helper), compatible with inventory-ops.shared.

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import {
  CoreError,
  encodeCursor,
  formatDecimal4,
  parseDecimal4,
  type Decimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  assertStockCountApproval,
  stockCountDetailSchema,
  stockCountSheetSchema,
  stockCountVarianceIdr,
  transitionStockCount as nextStockCountStatus,
  type createStockCountInputSchema,
  type StockCount,
  type StockCountDetail,
  type StockCountLine,
  type StockCountSheet,
  type StockCountSheetLine,
  type stockCountQuerySchema,
  type transitionStockCountInputSchema,
  type updateStockCountLineInputSchema,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { db } from "../db/index.ts";
import {
  inventoryItems,
  stockBalances,
  stockLocations,
} from "../db/schema/inventory.ts";
import { stockCountLines, stockCounts } from "../db/schema/inventory-count.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  allocateFefo,
  fefoAvailability,
  type FefoAllocation,
} from "./inventory-expiry.service.ts";
import {
  COUNT_APPROVAL_MODULE,
  countError,
  countLinesHash,
  lineDelta,
  loadBatchRemaining,
  OPEN_COUNT_STATUSES,
  sumVariance,
  toSheetLine,
  toStockCount,
  toStockCountLine,
  translateCountError,
  type CountRow,
  type LineRow,
} from "./inventory-count.shared.ts";
import {
  assertOutlet,
  cursorInstant,
  cursorKeys,
  cursorUuid,
  lockLocations,
  outletTarget,
  recordOpsAudit,
  requestFingerprint,
  ROUNDING_MODE,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import { evaluateParAlertsInTransaction } from "./inventory-par-alerts.service.ts";
import { recordStockMovementInTransaction } from "./inventory.service.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import {
  cancelApprovalRequest,
  decideApprovalRequest,
  getApprovalChainOutcome,
  openApprovalRequest,
} from "./platform-approval.service.ts";

export type StockCountQuery = z.infer<typeof stockCountQuerySchema>;
export type CreateStockCountInput = z.infer<typeof createStockCountInputSchema>;
export type UpdateStockCountLineInput = z.infer<
  typeof updateStockCountLineInputSchema
>;
export type TransitionStockCountInput = z.infer<
  typeof transitionStockCountInputSchema
>;

const CREATE_OPERATION = "stock_count.create";
const LINE_INSERT_CHUNK = 500;
const COUNT_AUDIT_FIELDS = [
  "status",
  "type",
  "blind",
  "locationId",
  "countVersion",
  "totalVarianceIdr",
  "grossVarianceIdr",
  "approvalChainId",
] as const;

const PERM_COUNT = "inventory.opname.count";
const PERM_APPROVE = "inventory.adjustment.approve";
const PERM_VIEW = "inventory.stock.view";

const ACTION_PERMISSIONS: Record<
  TransitionStockCountInput["action"],
  readonly PermissionCode[]
> = {
  start: [PERM_COUNT],
  submit: [PERM_COUNT],
  cancel: [PERM_COUNT],
  approve: [PERM_APPROVE],
  reject: [PERM_APPROVE],
  // Posting only settles an already decided chain; every check that matters
  // (second person, version binding, approver permission) runs while settling.
  post: [PERM_APPROVE, PERM_COUNT],
};

// ------------------------------------------------------------------ access

type Snapshot = Awaited<ReturnType<typeof accessSnapshotInTransaction>>;

async function loadSnapshot(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<Snapshot> {
  return accessSnapshotInTransaction(tx, context, actorUserId, new Date());
}

function allows(
  snapshot: Snapshot,
  permission: PermissionCode,
  outletId: string,
) {
  return snapshot.allows(permission, outletTarget(outletId));
}

/** Deny by default: at least one of `permissions` on the outlet. */
async function requireAnyPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permissions: readonly PermissionCode[],
  outletId: string,
): Promise<Snapshot> {
  const snapshot = await loadSnapshot(tx, context, actorUserId);
  if (!permissions.some((permission) => allows(snapshot, permission, outletId)))
    throw new AccessError("PERMISSION_DENIED");
  return snapshot;
}

// -------------------------------------------------------------------- reads

const notFound = () =>
  new HttpError(404, "NOT_FOUND", "Stock count not found.");

async function loadCount(
  tx: Tx,
  context: ScopedTenantContext,
  stockCountId: string,
  lock: boolean,
): Promise<CountRow> {
  const query = tx
    .select()
    .from(stockCounts)
    .where(eq(stockCounts.id, stockCountId));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound();
  assertOutlet(context, row.outletId);
  return row;
}

/** Lines in a stable display order (item name, then id). */
async function loadLines(tx: Tx, stockCountId: string): Promise<LineRow[]> {
  const rows = await tx
    .select({ line: stockCountLines })
    .from(stockCountLines)
    .innerJoin(
      inventoryItems,
      and(
        eq(inventoryItems.tenantId, stockCountLines.tenantId),
        eq(inventoryItems.id, stockCountLines.inventoryItemId),
      ),
    )
    .where(eq(stockCountLines.stockCountId, stockCountId))
    .orderBy(asc(inventoryItems.name), asc(stockCountLines.id));
  return rows.map((row) => row.line);
}

/**
 * Lower-cased ids of everyone who entered a quantity: creator, the append-only
 * `counter_ids` history (survives a recount) and the current line counters.
 */
function counterIds(row: CountRow, lines: readonly LineRow[]): Set<string> {
  const ids = new Set([row.countedBy.toLowerCase()]);
  for (const id of row.counterIds) ids.add(id.toLowerCase());
  for (const line of lines)
    if (line.countedBy !== null) ids.add(line.countedBy.toLowerCase());
  return ids;
}

function selfApproval(): HttpError {
  return countError(
    "STOCK_COUNT_SELF_APPROVAL",
    "A person who counted this stock count cannot approve it.",
  );
}

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  action: string,
  before: CountRow | null,
  after: CountRow,
  reason?: string | null,
): Promise<void> {
  const view = (row: CountRow) => ({
    status: row.status,
    type: row.type,
    blind: row.blind,
    locationId: row.locationId,
    countVersion: row.countVersion,
    totalVarianceIdr: row.totalVarianceIdr,
    grossVarianceIdr: row.grossVarianceIdr,
    approvalChainId: row.approvalChainId,
  });
  await recordOpsAudit(tx, context, {
    actorUserId,
    outletId: after.outletId,
    action,
    objectType: "stock_count",
    objectId: after.id,
    before: before === null ? null : view(before),
    after: view(after),
    safeFields: COUNT_AUDIT_FIELDS,
    reason: reason ?? null,
  });
}

// --------------------------------------------------------------------- list

/** GET stock counts of one outlet, newest first. Needs `inventory.stock.view`. */
export async function listStockCounts(
  context: ScopedTenantContext,
  actorUserId: string,
  query: StockCountQuery,
): Promise<CursorPage<StockCount>> {
  assertOutlet(context, query.outletId);
  try {
    return await withTenant(db, context, async (tx) => {
      await requireAnyPermission(
        tx,
        context,
        actorUserId,
        [PERM_VIEW],
        query.outletId,
      );
      const filters: SQL[] = [eq(stockCounts.outletId, query.outletId)];
      if (query.locationId)
        filters.push(eq(stockCounts.locationId, query.locationId));
      if (query.status) filters.push(eq(stockCounts.status, query.status));
      if (query.type) filters.push(eq(stockCounts.type, query.type));
      const [createdAt, id] = cursorKeys(query.cursor, 2);
      if (createdAt !== undefined && id !== undefined) {
        const at = cursorInstant(createdAt);
        filters.push(
          or(
            lt(stockCounts.createdAt, at),
            and(
              eq(stockCounts.createdAt, at),
              sql`${stockCounts.id} < ${cursorUuid(id)}::uuid`,
            ),
          )!,
        );
      }
      const rows = await tx
        .select()
        .from(stockCounts)
        .where(and(...filters))
        .orderBy(desc(stockCounts.createdAt), desc(stockCounts.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map(toStockCount),
        meta: {
          limit: query.limit,
          nextCursor:
            rows.length > query.limit && last
              ? encodeCursor([last.createdAt.toISOString(), last.id])
              : null,
        },
      };
    });
  } catch (error) {
    throw translateCountError(error);
  }
}

// ------------------------------------------------------------------- detail

/**
 * GET full detail (system qty + variance). Non-blind: `inventory.stock.view`.
 * Blind: 403 STOCK_COUNT_BLIND_HIDDEN while draft/counting (everyone), to a
 * counter of the count, and to anyone without `inventory.adjustment.approve`,
 * until the count is posted or cancelled.
 */
export async function getStockCountDetail(
  context: ScopedTenantContext,
  actorUserId: string,
  stockCountId: string,
): Promise<StockCountDetail> {
  try {
    return await withTenant(db, context, async (tx) => {
      const row = await loadCount(tx, context, stockCountId, false);
      const snapshot = await loadSnapshot(tx, context, actorUserId);
      const canView = allows(snapshot, PERM_VIEW, row.outletId);
      const canApprove = allows(snapshot, PERM_APPROVE, row.outletId);
      const lines = await loadLines(tx, row.id);
      if (!row.blind) {
        if (!canView) throw new AccessError("PERMISSION_DENIED");
      } else {
        if (!canView && !canApprove) throw new AccessError("PERMISSION_DENIED");
        const finished = row.status === "posted" || row.status === "cancelled";
        const hidden =
          !finished &&
          (row.status === "draft" ||
            row.status === "counting" ||
            !canApprove ||
            counterIds(row, lines).has(actorUserId.toLowerCase()));
        if (hidden)
          throw countError(
            "STOCK_COUNT_BLIND_HIDDEN",
            "The system quantity of a blind count is hidden from you.",
          );
      }
      return stockCountDetailSchema.parse({
        count: toStockCount(row),
        lines: lines.map(toStockCountLine),
      });
    });
  } catch (error) {
    throw translateCountError(error);
  }
}

/** GET the counter sheet: lines without system qty, unit cost or variance. */
export async function getStockCountSheet(
  context: ScopedTenantContext,
  actorUserId: string,
  stockCountId: string,
): Promise<StockCountSheet> {
  try {
    return await withTenant(db, context, async (tx) => {
      const row = await loadCount(tx, context, stockCountId, false);
      await requireAnyPermission(
        tx,
        context,
        actorUserId,
        [PERM_COUNT],
        row.outletId,
      );
      const lines = await loadLines(tx, row.id);
      return stockCountSheetSchema.parse({
        count: toStockCount(row),
        lines: lines.map(toSheetLine),
      });
    });
  } catch (error) {
    throw translateCountError(error);
  }
}

// ------------------------------------------------------------------- create

type Snapshotted = { quantity: Decimal4; avgCostIdr: Decimal4 };

/** Current balance + moving-average cost of every item held at the location. */
async function locationBalances(
  tx: Tx,
  locationId: string,
): Promise<Map<string, Snapshotted>> {
  const rows = await tx
    .select({
      inventoryItemId: stockBalances.inventoryItemId,
      quantity: stockBalances.quantity,
      avgCostIdr: stockBalances.avgCostIdr,
    })
    .from(stockBalances)
    .where(eq(stockBalances.locationId, locationId));
  return new Map(
    rows.map((row) => [
      row.inventoryItemId,
      { quantity: row.quantity, avgCostIdr: row.avgCostIdr },
    ]),
  );
}

/** Full count scope: every active item plus any item with a balance row. */
async function fullCountItemIds(
  tx: Tx,
  balances: ReadonlyMap<string, Snapshotted>,
): Promise<string[]> {
  const active = await tx
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(eq(inventoryItems.isActive, true));
  return [...new Set([...active.map((row) => row.id), ...balances.keys()])];
}

const ZERO = formatDecimal4(0n);

async function insertLines(
  tx: Tx,
  row: CountRow,
  itemIds: readonly string[],
  balances: ReadonlyMap<string, Snapshotted>,
): Promise<void> {
  for (let index = 0; index < itemIds.length; index += LINE_INSERT_CHUNK) {
    const chunk = itemIds.slice(index, index + LINE_INSERT_CHUNK);
    await tx
      .insert(stockCountLines)
      .values(
        chunk.map((inventoryItemId) => ({
          tenantId: row.tenantId,
          outletId: row.outletId,
          stockCountId: row.id,
          inventoryItemId,
          systemQty: balances.get(inventoryItemId)?.quantity ?? ZERO,
          unitCostIdr: balances.get(inventoryItemId)?.avgCostIdr ?? ZERO,
        })),
      )
      .onConflictDoNothing();
  }
}

async function findCountByKey(
  tx: Tx,
  tenantId: CountRow["tenantId"],
  key: string,
) {
  const [row] = await tx
    .select()
    .from(stockCounts)
    .where(
      and(
        eq(stockCounts.tenantId, tenantId),
        eq(stockCounts.createIdempotencyKey, key),
      ),
    );
  return row ?? null;
}

function reusedKey(): CoreError {
  return new CoreError(
    "IDEMPOTENCY_KEY_REUSED",
    "This idempotency key was used for a different request.",
  );
}

/** The create response: a blind count never returns its lines (no leak). */
async function createResponse(
  tx: Tx,
  row: CountRow,
): Promise<StockCountDetail> {
  const lines = row.blind ? [] : await loadLines(tx, row.id);
  return stockCountDetailSchema.parse({
    count: toStockCount(row),
    lines: lines.map(toStockCountLine),
  });
}

/**
 * POST a count (status `draft`) with the snapshot of the location. Needs
 * `inventory.opname.count` on the outlet. Replaying the same body with the
 * same key returns the same count; a different body is a 409. A second open
 * count on the location is a 409 STOCK_COUNT_LOCATION_BUSY.
 */
export async function createStockCount(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateStockCountInput,
): Promise<StockCountDetail> {
  assertOutlet(context, input.outletId);
  const cycleIds =
    input.type === "cycle"
      ? [...new Set(input.inventoryItemIds ?? [])].sort()
      : null;
  const fingerprint = requestFingerprint(CREATE_OPERATION, actorUserId, {
    outletId: input.outletId,
    locationId: input.locationId,
    type: input.type,
    blind: input.blind,
    businessDate: input.businessDate,
    inventoryItemIds: cycleIds,
    note: input.note ?? null,
  });
  try {
    return await withTenant(db, context, async (tx) => {
      await requireAnyPermission(
        tx,
        context,
        actorUserId,
        [PERM_COUNT],
        input.outletId,
      );
      const tenantId = context.tenant.tenantId;
      const replayOf = async (existing: CountRow) => {
        if (existing.createFingerprint !== fingerprint) throw reusedKey();
        return createResponse(tx, existing);
      };
      const existing = await findCountByKey(tx, tenantId, input.idempotencyKey);
      if (existing) return replayOf(existing);

      const [location] = await tx
        .select({ id: stockLocations.id, isActive: stockLocations.isActive })
        .from(stockLocations)
        .where(
          and(
            eq(stockLocations.id, input.locationId),
            eq(stockLocations.outletId, input.outletId),
          ),
        );
      if (!location)
        throw new HttpError(404, "NOT_FOUND", "Stock location not found.");
      if (!location.isActive)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "The stock location is not active.",
        );

      const busy = async () => {
        const [open] = await tx
          .select({ id: stockCounts.id })
          .from(stockCounts)
          .where(
            and(
              eq(stockCounts.locationId, input.locationId),
              inArray(stockCounts.status, [...OPEN_COUNT_STATUSES]),
            ),
          );
        return open !== undefined;
      };
      const busyError = () =>
        countError(
          "STOCK_COUNT_LOCATION_BUSY",
          "This location already has an open stock count.",
        );
      if (await busy()) throw busyError();

      const balances = await locationBalances(tx, input.locationId);
      let itemIds: string[];
      if (input.type === "full") {
        itemIds = await fullCountItemIds(tx, balances);
      } else {
        if (cycleIds === null || cycleIds.length === 0)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "A cycle count needs the items to count.",
          );
        const known = await tx
          .select({ id: inventoryItems.id })
          .from(inventoryItems)
          .where(inArray(inventoryItems.id, cycleIds));
        if (known.length !== cycleIds.length)
          throw new HttpError(
            422,
            "VALIDATION_ERROR",
            "A listed inventory item does not exist.",
          );
        itemIds = cycleIds;
      }
      if (itemIds.length === 0)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "There is no item to count.",
        );

      const [inserted] = await tx
        .insert(stockCounts)
        .values({
          id: randomUUID(),
          tenantId,
          outletId: input.outletId,
          locationId: input.locationId,
          type: input.type,
          status: "draft",
          blind: input.blind,
          businessDate: input.businessDate,
          note: input.note ?? null,
          countedBy: actorUserId,
          counterIds: [actorUserId],
          createIdempotencyKey: input.idempotencyKey,
          createFingerprint: fingerprint,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted) {
        // A concurrent request won the key (or the location): replay it.
        const winner = await findCountByKey(tx, tenantId, input.idempotencyKey);
        if (winner) return replayOf(winner);
        throw busyError();
      }
      await insertLines(tx, inserted, itemIds, balances);
      await audit(
        tx,
        context,
        actorUserId,
        "inventory.stock_count_created",
        null,
        inserted,
      );
      return createResponse(tx, inserted);
    });
  } catch (error) {
    throw translateCountError(error);
  }
}

// -------------------------------------------------------------- line entry

type LineEditMode = "full" | "sheet";

/** Shared line write: only in `counting`; every edit bumps `count_version`. */
async function editLine(
  context: ScopedTenantContext,
  actorUserId: string,
  stockCountId: string,
  lineId: string,
  input: UpdateStockCountLineInput,
  mode: LineEditMode,
): Promise<LineRow> {
  try {
    return await withTenant(db, context, async (tx) => {
      const row = await loadCount(tx, context, stockCountId, true);
      await requireAnyPermission(
        tx,
        context,
        actorUserId,
        [PERM_COUNT],
        row.outletId,
      );
      if (mode === "full" && row.blind)
        throw countError(
          "STOCK_COUNT_BLIND_USE_SHEET",
          "Enter the quantities of a blind count through the sheet.",
        );
      if (row.status !== "counting")
        throw countError(
          "STOCK_COUNT_NOT_EDITABLE",
          `Lines can only be edited while counting, not in ${row.status}.`,
        );
      const now = new Date();
      const [line] = await tx
        .update(stockCountLines)
        .set({
          countedQty: formatDecimal4(parseDecimal4(input.countedQty)),
          countedBy: actorUserId,
          countedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(stockCountLines.id, lineId),
            eq(stockCountLines.stockCountId, row.id),
          ),
        )
        .returning();
      if (!line)
        throw new HttpError(404, "NOT_FOUND", "Stock count line not found.");
      await tx
        .update(stockCounts)
        .set({
          countVersion: sql`${stockCounts.countVersion} + 1`,
          counterIds: sql`CASE WHEN ${actorUserId}::text = ANY(${stockCounts.counterIds}) THEN ${stockCounts.counterIds} ELSE array_append(${stockCounts.counterIds}, ${actorUserId}::text) END`,
          updatedAt: now,
        })
        .where(eq(stockCounts.id, row.id));
      return line;
    });
  } catch (error) {
    throw translateCountError(error);
  }
}

/** PATCH a line of a NON-blind count (full line back). Blind: 409 USE_SHEET. */
export async function updateStockCountLine(
  context: ScopedTenantContext,
  actorUserId: string,
  stockCountId: string,
  lineId: string,
  input: UpdateStockCountLineInput,
): Promise<StockCountLine> {
  return toStockCountLine(
    await editLine(context, actorUserId, stockCountId, lineId, input, "full"),
  );
}

/** PATCH a line from the counter sheet (works for blind and non-blind). */
export async function updateStockCountSheetLine(
  context: ScopedTenantContext,
  actorUserId: string,
  stockCountId: string,
  lineId: string,
  input: UpdateStockCountLineInput,
): Promise<StockCountSheetLine> {
  return toSheetLine(
    await editLine(context, actorUserId, stockCountId, lineId, input, "sheet"),
  );
}

// -------------------------------------------------------------- transitions

/**
 * POST a state change. Permissions per action: start/submit/cancel need
 * `inventory.opname.count`; approve/reject need `inventory.adjustment.approve`
 * (and may not be a counter); post accepts either. Replaying an action whose
 * target state is already reached returns the current count, no side effects.
 */
export async function transitionStockCount(
  context: ScopedTenantContext,
  actorUserId: string,
  stockCountId: string,
  input: TransitionStockCountInput,
  options: { mfaVerified: boolean; now?: Date },
): Promise<StockCount> {
  try {
    if (input.action === "approve" || input.action === "reject")
      return await decide(context, actorUserId, stockCountId, input, options);
    return await withTenant(db, context, async (tx) => {
      const row = await loadCount(tx, context, stockCountId, true);
      await requireAnyPermission(
        tx,
        context,
        actorUserId,
        ACTION_PERMISSIONS[input.action],
        row.outletId,
      );
      const now = options.now ?? new Date();
      switch (input.action) {
        case "start":
          return toStockCount(await start(tx, context, actorUserId, row, now));
        case "submit":
          return toStockCount(
            await submit(tx, context, actorUserId, row, input, now),
          );
        case "cancel":
          return toStockCount(
            await cancel(tx, context, actorUserId, row, input, now),
          );
        default:
          return toStockCount(await post(tx, context, actorUserId, row, now));
      }
    });
  } catch (error) {
    throw translateCountError(error);
  }
}

/**
 * Re-takes the snapshot: system quantity and moving-average cost of every line
 * from the current balance (a full count also picks up items stocked or
 * activated since). The caller holds the count row FOR UPDATE.
 */
async function refreshSnapshot(tx: Tx, row: CountRow): Promise<void> {
  await lockLocations(tx, row.tenantId, [row.locationId]);
  const balances = await locationBalances(tx, row.locationId);
  if (row.type === "full") {
    // Items stocked or activated since create join the count.
    const itemIds = await fullCountItemIds(tx, balances);
    await insertLines(tx, row, itemIds, balances);
  }
  await tx.execute(sql`
    UPDATE stock_count_lines AS l
    SET system_qty = COALESCE((
          SELECT b.quantity FROM stock_balances b
          WHERE b.tenant_id = l.tenant_id
            AND b.location_id = ${row.locationId}::uuid
            AND b.inventory_item_id = l.inventory_item_id), 0),
        unit_cost_idr = COALESCE((
          SELECT b.avg_cost_idr FROM stock_balances b
          WHERE b.tenant_id = l.tenant_id
            AND b.location_id = ${row.locationId}::uuid
            AND b.inventory_item_id = l.inventory_item_id), 0),
        updated_at = now()
    WHERE l.stock_count_id = ${row.id}::uuid`);
}

/** draft -> counting: refreshes the snapshot ("stok sistem saat opname dimulai"). */
async function start(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  row: CountRow,
  now: Date,
): Promise<CountRow> {
  if (row.status === "counting") return row;
  nextStockCountStatus(row.status, "start");
  await refreshSnapshot(tx, row);
  const [updated] = await tx
    .update(stockCounts)
    .set({ status: "counting", snapshotAt: now, updatedAt: now })
    .where(eq(stockCounts.id, row.id))
    .returning();
  await audit(
    tx,
    context,
    actorUserId,
    "inventory.stock_count_started",
    row,
    updated!,
  );
  return updated!;
}

/**
 * counting -> pending_approval: every line counted, variances stored, the
 * approval chain opened and bound to this version of the lines.
 */
async function submit(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  row: CountRow,
  input: TransitionStockCountInput,
  now: Date,
): Promise<CountRow> {
  if (row.status === "pending_approval") return row;
  nextStockCountStatus(row.status, "submit");
  const lines = await loadLines(tx, row.id);
  if (lines.length === 0 || lines.some((line) => line.countedQty === null))
    throw countError(
      "STOCK_COUNT_LINES_INCOMPLETE",
      "Every line must be counted before the count is submitted.",
    );
  const varianceIdrs: number[] = [];
  for (const line of lines) {
    const countedQty = line.countedQty!;
    const varianceIdr = stockCountVarianceIdr(
      {
        systemQty: line.systemQty,
        countedQty,
        unitCostIdr: line.unitCostIdr,
      },
      ROUNDING_MODE,
    );
    varianceIdrs.push(varianceIdr);
    await tx
      .update(stockCountLines)
      .set({
        varianceQty: formatDecimal4(lineDelta(line)),
        varianceIdr,
        updatedAt: now,
      })
      .where(eq(stockCountLines.id, line.id));
  }
  const { total, gross } = sumVariance(varianceIdrs);
  const linesHash = countLinesHash(lines);
  // The requester (a counter) can read their own request: a blind count must
  // not carry any variance there. No amount means every tier applies.
  const approvalAmount = row.blind ? null : gross;
  const approvalPayload = row.blind
    ? { countVersion: row.countVersion, linesHash, blind: true }
    : {
        countVersion: row.countVersion,
        linesHash,
        totalVarianceIdr: total,
        grossVarianceIdr: gross,
      };
  const opened = await openApprovalRequest(tx, context, {
    sourceModule: COUNT_APPROVAL_MODULE,
    actionType: "stock_adjustment",
    objectType: "stock_count",
    objectId: row.id,
    amountIdr: approvalAmount,
    outletId: row.outletId,
    requestedBy: actorUserId,
    source: "user",
    requestReason: input.note?.trim() || "Persetujuan selisih stok opname",
    payload: approvalPayload,
    idempotencyKey: input.idempotencyKey,
    now,
  });
  // INV-03 always needs a second person: no routing means no submit.
  if (!opened.required)
    throw countError(
      "STOCK_COUNT_APPROVAL_UNROUTED",
      "No approval policy routes this stock count to an approver.",
    );
  if (
    opened.replayed &&
    (await getApprovalChainOutcome(tx, {
      chainId: opened.chainId,
      sourceModule: COUNT_APPROVAL_MODULE,
    })) !== "pending"
  )
    throw reusedKey();
  const [updated] = await tx
    .update(stockCounts)
    .set({
      status: "pending_approval",
      approvalChainId: opened.chainId,
      approvalVersion: row.countVersion,
      linesHash,
      totalVarianceIdr: total,
      grossVarianceIdr: gross,
      countedAt: now,
      updatedAt: now,
    })
    .where(eq(stockCounts.id, row.id))
    .returning();
  await audit(
    tx,
    context,
    actorUserId,
    "inventory.stock_count_submitted",
    row,
    updated!,
    input.note ?? null,
  );
  return updated!;
}

/** draft/counting/pending_approval -> cancelled (withdraws a pending chain). */
async function cancel(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  row: CountRow,
  input: TransitionStockCountInput,
  now: Date,
): Promise<CountRow> {
  if (row.status === "cancelled") return row;
  nextStockCountStatus(row.status, "cancel");
  if (row.status === "pending_approval" && row.approvalChainId !== null)
    await cancelApprovalRequest(tx, context, {
      chainId: row.approvalChainId,
      sourceModule: COUNT_APPROVAL_MODULE,
      actorUserId,
      now,
    });
  const [updated] = await tx
    .update(stockCounts)
    .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
    .where(eq(stockCounts.id, row.id))
    .returning();
  await audit(
    tx,
    context,
    actorUserId,
    "inventory.stock_count_cancelled",
    row,
    updated!,
    input.note ?? null,
  );
  return updated!;
}

/** approved -> posted; pending_approval -> settles a chain decided elsewhere. */
async function post(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  row: CountRow,
  now: Date,
): Promise<CountRow> {
  if (row.status === "posted") return row;
  if (row.status === "approved" || row.status === "pending_approval") {
    const settled = await settle(tx, context, actorUserId, row, now);
    if (settled.status === "pending_approval")
      throw countError(
        "STOCK_COUNT_INVALID_TRANSITION",
        "The stock count is still waiting for its approval.",
      );
    return settled;
  }
  nextStockCountStatus(row.status, "post");
  return row;
}

// ----------------------------------------------------------- approve / reject

type PendingLevel = { id: string; deadlineAt: Date };

/**
 * approve / reject. Phase 1 reads and checks (second person), phase 2 records
 * the decision on the current approval level (its own transaction, as the
 * approval module requires), phase 3 settles the chain on the locked row.
 */
async function decide(
  context: ScopedTenantContext,
  actorUserId: string,
  stockCountId: string,
  input: TransitionStockCountInput,
  options: { mfaVerified: boolean; now?: Date },
): Promise<StockCount> {
  const now = options.now ?? new Date();
  const approving = input.action === "approve";
  const reached = (row: CountRow) =>
    approving
      ? row.status === "approved" || row.status === "posted"
      : row.status === "counting";

  const prepared = await withTenant(db, context, async (tx) => {
    const row = await loadCount(tx, context, stockCountId, false);
    await requireAnyPermission(
      tx,
      context,
      actorUserId,
      ACTION_PERMISSIONS[input.action],
      row.outletId,
    );
    if (reached(row)) return { done: toStockCount(row) };
    nextStockCountStatus(row.status, input.action);
    assertStockCountApproval(toStockCount(row), actorUserId);
    const lines = await loadLines(tx, row.id);
    if (counterIds(row, lines).has(actorUserId.toLowerCase()))
      throw selfApproval();
    let pending: PendingLevel | null = null;
    if (row.approvalChainId !== null) {
      const [level] = await tx
        .select({
          id: approvalRequests.id,
          deadlineAt: approvalRequests.deadlineAt,
        })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.chainId, row.approvalChainId),
            eq(approvalRequests.status, "pending"),
          ),
        )
        .orderBy(asc(approvalRequests.level))
        .limit(1);
      pending = level ?? null;
    }
    return { done: null, pending };
  });
  if (prepared.done) return prepared.done;

  // Past its deadline the level cannot be decided; settling expires it.
  if (
    prepared.pending &&
    prepared.pending.deadlineAt.getTime() > now.getTime()
  ) {
    try {
      await decideApprovalRequest(
        context.tenant,
        actorUserId,
        prepared.pending.id,
        {
          decision: approving ? "approved" : "rejected",
          reason:
            input.note?.trim() ||
            (approving
              ? "Selisih stok opname disetujui"
              : "Selisih stok opname ditolak"),
        },
        {
          idempotencyKey: input.idempotencyKey,
          mfaVerified: options.mfaVerified,
          now,
        },
      );
    } catch (error) {
      // A concurrent identical request may have decided and settled already.
      const current = await withTenant(db, context, async (tx) =>
        loadCount(tx, context, stockCountId, false),
      );
      if (reached(current)) return toStockCount(current);
      throw error;
    }
  }

  return withTenant(db, context, async (tx) => {
    const row = await loadCount(tx, context, stockCountId, true);
    if (reached(row)) return toStockCount(row);
    if (!approving) {
      // A reject never posts: once the chain is approved only approve/post
      // may settle it, so a late reject changes nothing.
      const invalid = () =>
        countError(
          "STOCK_COUNT_INVALID_TRANSITION",
          "The stock count is already approved and cannot be rejected.",
        );
      if (row.status === "approved" || row.status === "posted") throw invalid();
      if (
        row.status === "pending_approval" &&
        row.approvalChainId !== null &&
        (await getApprovalChainOutcome(tx, {
          chainId: row.approvalChainId,
          sourceModule: COUNT_APPROVAL_MODULE,
        })) === "approved"
      )
        throw invalid();
    }
    return toStockCount(await settle(tx, context, actorUserId, row, now));
  });
}

// ------------------------------------------------------------------ settle

/**
 * Back to `counting` for a recount: chain, version binding and variances are
 * cleared, the snapshot is re-taken from the current balance and every line's
 * counted quantity is cleared, so the recount is against the NEW snapshot
 * (the delta method posts `counted - system` of one snapshot). The version is
 * bumped; `counter_ids` keeps everyone who ever counted.
 */
async function revertToCounting(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  row: CountRow,
  now: Date,
  reason: string,
): Promise<CountRow> {
  await refreshSnapshot(tx, row);
  const [updated] = await tx
    .update(stockCounts)
    .set({
      status: "counting",
      countVersion: sql`${stockCounts.countVersion} + 1`,
      snapshotAt: now,
      approvalChainId: null,
      approvalVersion: null,
      linesHash: null,
      totalVarianceIdr: null,
      grossVarianceIdr: null,
      countedAt: null,
      approvedBy: null,
      approvedAt: null,
      updatedAt: now,
    })
    .where(eq(stockCounts.id, row.id))
    .returning();
  await tx
    .update(stockCountLines)
    .set({
      countedQty: null,
      varianceQty: null,
      varianceIdr: null,
      countedBy: null,
      countedAt: null,
      updatedAt: now,
    })
    .where(eq(stockCountLines.stockCountId, row.id));
  await audit(
    tx,
    context,
    actorUserId,
    "inventory.stock_count_returned",
    row,
    updated!,
    reason,
  );
  return updated!;
}

/**
 * Settles the approval chain of a count whose row the caller holds FOR UPDATE.
 * Approved: re-verifies the approver (not a counter, still allowed to approve)
 * and the version binding, then posts in the same transaction. Rejected or
 * expired: back to `counting`. Cancelled by the module: cancelled. Pending:
 * unchanged. Safe to call repeatedly.
 */
async function settle(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  row: CountRow,
  now: Date,
): Promise<CountRow> {
  if (row.status === "approved")
    return postLines(tx, context, row.approvedBy ?? actorUserId, row, now);
  if (row.status !== "pending_approval") return row;
  if (row.approvalChainId === null)
    throw new Error("A pending stock count has no approval chain");
  let outcome = await getApprovalChainOutcome(tx, {
    chainId: row.approvalChainId,
    sourceModule: COUNT_APPROVAL_MODULE,
  });
  const levels = await tx
    .select({
      decidedBy: approvalRequests.decidedBy,
      deadlineAt: approvalRequests.deadlineAt,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.chainId, row.approvalChainId))
    .orderBy(desc(approvalRequests.level));
  const last = levels[0];
  if (!last) throw notFound();
  // Past the deadline the count stays blocked even before the sweep runs; the
  // still open request is withdrawn so a resubmit is not blocked by it.
  if (outcome === "pending" && last.deadlineAt.getTime() <= now.getTime()) {
    await cancelApprovalRequest(tx, context, {
      chainId: row.approvalChainId,
      sourceModule: COUNT_APPROVAL_MODULE,
      actorUserId: null,
      now,
    });
    outcome = "expired";
  }
  if (outcome === "pending") return row;
  if (outcome === "cancelled") {
    const [cancelled] = await tx
      .update(stockCounts)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(eq(stockCounts.id, row.id))
      .returning();
    await audit(
      tx,
      context,
      actorUserId,
      "inventory.stock_count_cancelled",
      row,
      cancelled!,
      "approval_cancelled",
    );
    return cancelled!;
  }
  if (outcome !== "approved")
    return revertToCounting(tx, context, actorUserId, row, now, outcome);

  const lines = await loadLines(tx, row.id);
  // Every level's approver counts: none may be a counter and each must still
  // be allowed to approve at the outlet.
  const counters = counterIds(row, lines);
  const approvers = new Set<string>();
  for (const level of levels) {
    if (level.decidedBy === null || counters.has(level.decidedBy.toLowerCase()))
      return revertToCounting(
        tx,
        context,
        actorUserId,
        row,
        now,
        "approver_is_counter",
      );
    approvers.add(level.decidedBy);
  }
  for (const id of approvers) {
    const approverSnapshot = await loadSnapshot(tx, context, id);
    if (!allows(approverSnapshot, PERM_APPROVE, row.outletId))
      return revertToCounting(
        tx,
        context,
        actorUserId,
        row,
        now,
        "approver_lacks_permission",
      );
  }
  const approver = last.decidedBy!;
  // The approval belongs to the lines it was opened for.
  if (
    row.approvalVersion === null ||
    row.countVersion !== row.approvalVersion ||
    countLinesHash(lines) !== row.linesHash
  )
    throw countError(
      "STOCK_COUNT_VERSION_MISMATCH",
      "The counted lines changed after the approval request was opened.",
    );
  const [approved] = await tx
    .update(stockCounts)
    .set({
      status: "approved",
      approvedBy: approver,
      approvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(stockCounts.id, row.id),
        eq(stockCounts.status, "pending_approval"),
      ),
    )
    .returning();
  if (!approved) throw new Error("Stock count changed under its row lock");
  await audit(
    tx,
    context,
    approver,
    "inventory.stock_count_approved",
    row,
    approved,
  );
  return postLines(tx, context, approver, approved, now);
}

// ----------------------------------------------------------------- posting

/**
 * approved -> posted: one `adjustment` ledger row per non-zero line
 * (`counted - snapshot`), valued at the snapshot moving-average cost. The
 * caller holds the count row FOR UPDATE and the status guard makes a replay
 * post nothing; the per-row idempotency key backs that up in the ledger.
 */
async function postLines(
  tx: Tx,
  context: ScopedTenantContext,
  postedBy: string,
  row: CountRow,
  now: Date,
): Promise<CountRow> {
  const lines = await loadLines(tx, row.id);
  await lockLocations(tx, row.tenantId, [row.locationId]);
  const moved: { locationId: string; inventoryItemId: string }[] = [];
  for (const line of [...lines].sort((left, right) =>
    left.inventoryItemId < right.inventoryItemId ? -1 : 1,
  )) {
    if (line.countedQty === null)
      throw new Error("An approved stock count has an uncounted line");
    const delta = lineDelta(line);
    if (delta === 0n) continue;
    await postLine(tx, context, postedBy, row, line, delta);
    moved.push({
      locationId: row.locationId,
      inventoryItemId: line.inventoryItemId,
    });
  }
  if (moved.length > 0)
    await evaluateParAlertsInTransaction(tx, context, row.outletId, {
      pairs: moved,
    });
  const [posted] = await tx
    .update(stockCounts)
    .set({ status: "posted", postedAt: now, updatedAt: now })
    .where(and(eq(stockCounts.id, row.id), eq(stockCounts.status, "approved")))
    .returning();
  if (!posted) throw new Error("Stock count changed under its row lock");
  await audit(
    tx,
    context,
    postedBy,
    "inventory.stock_count_posted",
    row,
    posted,
  );
  return posted;
}

/** Splits a decrease FEFO over the batches; what the batches cannot hold goes unbatched. */
async function decreaseAllocations(
  tx: Tx,
  row: CountRow,
  line: LineRow,
  quantity: bigint,
): Promise<FefoAllocation[]> {
  const [balance] = await tx
    .select({ quantity: stockBalances.quantity })
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.outletId, row.outletId),
        eq(stockBalances.locationId, row.locationId),
        eq(stockBalances.inventoryItemId, line.inventoryItemId),
      ),
    );
  const onHand = balance ? parseDecimal4(balance.quantity) : 0n;
  const fromStock = onHand <= 0n ? 0n : quantity < onHand ? quantity : onHand;
  const allocations =
    fromStock > 0n
      ? allocateFefo(
          fefoAvailability(
            await loadBatchRemaining(
              tx,
              row.outletId,
              row.locationId,
              line.inventoryItemId,
            ),
            formatDecimal4(onHand),
          ),
          formatDecimal4(fromStock),
        )
      : [];
  const rest = quantity - fromStock;
  if (rest > 0n) {
    const open = allocations.find((allocation) => allocation.batch === null);
    if (open)
      open.quantity = formatDecimal4(parseDecimal4(open.quantity) + rest);
    else allocations.push({ batch: null, quantity: formatDecimal4(rest) });
  }
  return allocations;
}

async function postLine(
  tx: Tx,
  context: ScopedTenantContext,
  postedBy: string,
  row: CountRow,
  line: LineRow,
  delta: bigint,
): Promise<void> {
  const key = `stock-count:${row.id}:${line.id}`;
  const base = {
    outletId: row.outletId,
    locationId: row.locationId,
    inventoryItemId: line.inventoryItemId,
    movementType: "adjustment" as const,
    unitCostIdr: line.unitCostIdr,
    sourceType: "stock_count" as const,
    sourceId: row.id,
    actor: { type: "user" as const, id: postedBy },
  };
  if (delta > 0n) {
    await recordStockMovementInTransaction(tx, context, {
      ...base,
      quantity: formatDecimal4(delta),
      batchId: null,
      idempotencyKey: key,
    });
    return;
  }
  const allocations = await decreaseAllocations(tx, row, line, -delta);
  for (const [index, allocation] of allocations.entries())
    await recordStockMovementInTransaction(tx, context, {
      ...base,
      quantity: formatDecimal4(-parseDecimal4(allocation.quantity)),
      batchId: allocation.batch?.id ?? null,
      idempotencyKey: index === 0 ? key : `${key}:${index}`,
    });
}
