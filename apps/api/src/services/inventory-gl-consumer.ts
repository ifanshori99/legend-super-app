// Inventory -> GL bridge (PRD v1.7 §3.19 Jurnal Otomatis, Alur J.4; bead
// legend-w1vo). Wired in worker-main.ts next to the order-payment consumer, on
// the cloud only (an edge node never posts the GL): a `stock.moved` event
// posts the journal of the stock source (stock count, waste log, POS sale /
// sales return, production batch) inside the outbox consumption transaction.
// Only tenants with the accounting module on are bridged; others are
// `ignored`.
//
// Money rules (INV-01, INV-03):
// - The value is what the ledger row itself recorded (`quantity` x
//   `unit_cost_idr` of that row), never a recomputation from the current
//   average cost, so a later receipt cannot change an old journal.
// - Rounding follows the emitting module: stock count lines round per row
//   (equals `stock_count_lines.posted_value_idr`), waste rounds once over the
//   whole log (equals `waste_logs.value_idr`); the rounded total is shared over
//   the business dates of the log by largest remainder (`allocateRoundedIdr`),
//   so a log straddling the business-day cutoff never loses a rupiah. Sales
//   round per row.
// - A production batch (bead legend-29vw, card 1252 r2) moves no value
//   between accounts: every stock item (raw and semi-finished) stays on
//   inventory (1301), so the draw and the put-away net to zero there. The only
//   journal is the rounding difference between the output card value (actual
//   qty x unit cost, rounded once) and the material cost (the `production_out`
//   rows rounded once, equals `production_orders.cost_idr`): Dr 1301 / Cr
//   inventory_price_variance (flipped when negative), one per batch, none when
//   it is zero. Splitting semi-finished goods into 1302 is a later bead: every
//   outflow rule credits 1301 today.
// - Negative amounts are never written as negative journal lines: the posting
//   rule flips debit and credit for a negative amount.
// - The untracked rows of a source are grouped by outlet business date and each
//   group posts one journal on its own date, so a backlog never posts a later
//   movement on an earlier date.
//
// - Late adjustment (legend-tgb3, as for sales): a group whose business date
//   falls in a closed fiscal period posts on the first day of the period after
//   the latest closed one, keeps its natural date in
//   `journal_entries.late_adjustment_from` and writes an
//   `accounting.journal.late_adjusted` audit row. Nothing parks on
//   PERIOD_CLOSED any more.
//
// Decoupled from cloud-sync: the posting runs in a savepoint. An expected
// accounting failure (missing or unusable account mapping)
// rolls the savepoint back, records the source in `inventory_gl_blocked` and
// returns `blocked`; the outbox consumption itself still commits, so the
// cloud-sync delivery is never held back by the GL. `retryBlockedInventoryGl`
// (worker sweep) retries blocked sources. Every other error propagates and rolls the
// consumption back (retry, dead letter, `replayOutbox`).
//
// `inventory_gl_postings` tracks every consumed ledger row, so a replay (or
// the event of another row of the same document) is a no-op. A per-source
// advisory lock serializes concurrent consumers and the sweep of one document.

import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  lte,
  max,
  ne,
  sql,
} from "drizzle-orm";
import {
  AccountingError,
  defaultPostingRules,
  periodOf,
  resolveAutoJournalDate,
  resolvePostingRule,
} from "@starter/shared/accounting";
import {
  businessDateOf,
  assertTrustedScopedContext,
  createUlid,
  extendCostIdr,
  parseDecimal4,
  ulidSchema,
  type BusinessDate,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  stockMovedEventPayloadSchema,
  type StockMovementType,
  type StockSourceType,
} from "@starter/shared/inventory";
import { isModuleEnabled } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import {
  accountMappings,
  fiscalPeriods,
  inventoryGlBlocked,
  inventoryGlPostings,
  journalLines,
  outlets,
  stockLedger,
  stockNegativeRevaluations,
  tenants,
  type InventoryGlSourceType,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { isTrainingOrder } from "./device-training.ts";
import { postJournalFromRuleInTransaction } from "./accounting-journal.service.ts";
import { wouldPostingBeBlockedByClosedPeriod } from "./accounting-period.service.ts";
import { recordAudit } from "./core-audit.ts";
import { sourceIdFromDb, sourceIdToDb } from "./inventory.service.ts";
import {
  COST_PRODUCT_SCALE,
  scaledCostToIdr,
  type Tx,
} from "./inventory-ops.shared.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";

export type InventoryGlResult =
  | { status: "ignored" }
  | { status: "already_posted" }
  | { status: "blocked"; code: BlockingCode }
  | { status: "zero_value"; ledgerEntryIds: string[] }
  | {
      status: "posted";
      /** The first journal; a source spanning business dates posts several. */
      journalEntryId: string;
      journalEntryIds: string[];
      ledgerEntryIds: string[];
    };

/** Expected accounting failures that park a source instead of failing it. */
const BLOCKING_CODES = [
  "PERIOD_CLOSED",
  "ACCOUNT_MAPPING_MISSING",
  "ACCOUNT_INACTIVE",
  "ACCOUNT_NOT_POSTABLE",
  "ACCOUNT_ENTITY_MISMATCH",
  // Card 1252: a production batch whose output and material cost differ by
  // more than rounding (a draw still in transit or dead-lettered on an edge
  // push). Retried by the sweep; booked once the draws are complete.
  "PRODUCTION_INCOMPLETE",
] as const;
type BlockingCode = (typeof BLOCKING_CODES)[number];

/** Thrown inside the savepoint: nothing of the batch is booked or tracked. */
class ProductionIncompleteError extends Error {
  readonly code = "PRODUCTION_INCOMPLETE";
}

function blockingCodeOf(error: unknown): BlockingCode | null {
  if (error instanceof ProductionIncompleteError) return error.code;
  if (!(error instanceof AccountingError)) return null;
  return (BLOCKING_CODES as readonly string[]).includes(error.code)
    ? (error.code as BlockingCode)
    : null;
}

type GlMapping = {
  readonly sourceType: InventoryGlSourceType;
  readonly movementTypes: readonly StockMovementType[];
  readonly eventName:
    "stock.adjusted" | "stock.deducted" | "production.completed";
  readonly variant: "count" | "waste" | "negative_revaluation" | null;
  readonly amountKey: "differenceIdr" | "costIdr" | "roundingVarianceIdr";
};

/** Sources the bridge posts; every other (movementType, sourceType) is ignored. */
const MAPPINGS: readonly GlMapping[] = [
  {
    sourceType: "stock_count",
    movementTypes: ["adjustment"],
    eventName: "stock.adjusted",
    variant: "count",
    amountKey: "differenceIdr",
  },
  {
    sourceType: "waste_log",
    movementTypes: ["waste"],
    eventName: "stock.adjusted",
    variant: "waste",
    amountKey: "costIdr",
  },
  {
    sourceType: "order",
    movementTypes: ["sale", "return"],
    eventName: "stock.deducted",
    variant: null,
    amountKey: "costIdr",
  },
  // Card 1252 r2: a production batch books only its rounding difference.
  {
    sourceType: "production_order",
    movementTypes: ["production_out", "production_in"],
    eventName: "production.completed",
    variant: null,
    amountKey: "roundingVarianceIdr",
  },
  // Bead 1214: a goods receipt row that landed on a negative balance. Its
  // `stock_negative_revaluations` row (not the ledger row: the receipt journal
  // already books the receipt) posts Dr HPP / Cr inventory, reversed when the
  // new cost is below the old average. Bead legend-slssv (1232): every inflow
  // onto a negative balance records one (transfer, production output, order
  // return, positive count adjustment), keyed by its own source id.
  {
    sourceType: "negative_stock_revaluation",
    movementTypes: [
      "receipt",
      "transfer_in",
      "production_in",
      "return",
      "adjustment",
    ],
    eventName: "stock.deducted",
    variant: "negative_revaluation",
    amountKey: "costIdr",
  },
];

/**
 * The GL sources a ledger movement feeds: its own source when the bridge maps
 * it (a goods receipt is booked by the AP side, never here), and the
 * revaluation source of any inflow (it has a row only when the inflow landed
 * on a negative balance; otherwise it is ignored).
 */
function glSourceTypesOf(payload: {
  sourceType: StockSourceType;
  movementType: StockMovementType;
  quantity: string;
}): InventoryGlSourceType[] {
  const sources: InventoryGlSourceType[] = [];
  if (
    payload.sourceType !== "goods_receipt" &&
    mappingOf(payload.sourceType, payload.movementType)
  )
    sources.push(payload.sourceType);
  if (
    parseDecimal4(payload.quantity) > 0n &&
    mappingOf("negative_stock_revaluation", payload.movementType)
  )
    sources.push("negative_stock_revaluation");
  return sources;
}

const LATE_AUDIT_FIELDS = [
  "journalId",
  "trigger",
  "sourceId",
  "originalDate",
  "entryDate",
] as const;

const IDEMPOTENCY_KEY_MAX = 100;
const RETRY_BATCH = 100;
/**
 * Backoff between retries of one blocked source: the sweep runs on every relay
 * tick, and a closed period can stay closed for weeks.
 */
export const RETRY_AFTER_MS = 10 * 60 * 1000;

function mappingOf(
  sourceType: string,
  movementType?: string,
): GlMapping | undefined {
  return MAPPINGS.find(
    (mapping) =>
      mapping.sourceType === sourceType &&
      (movementType === undefined ||
        (mapping.movementTypes as readonly string[]).includes(movementType)),
  );
}

/** DB (uuid) form for ledger queries, domain form (ULID for orders) for the rest. */
function normalizeSource(source: {
  sourceType: InventoryGlSourceType;
  sourceId: string;
}) {
  const dbId = sourceIdToDb(source.sourceId);
  // A revaluation keeps the id form of the document behind it (bead 1232):
  // an order's ULID stays a ULID (its uuid storage form is not a valid
  // journal source id), a uuid document stays a uuid. The event payload and
  // the blocked row both carry that domain form, so it is stable per source.
  const domainId =
    source.sourceType === "negative_stock_revaluation"
      ? ulidSchema.safeParse(source.sourceId).success
        ? source.sourceId
        : dbId
      : sourceIdFromDb(source.sourceType, dbId);
  return { sourceType: source.sourceType, dbId, domainId };
}

/** Outlet of a source's first row (ledger or revaluation), or null. */
async function outletOfSource(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  target: ReturnType<typeof normalizeSource>,
): Promise<string | null> {
  if (target.sourceType === "negative_stock_revaluation") {
    const [row] = await tx
      .select({ outletId: stockNegativeRevaluations.outletId })
      .from(stockNegativeRevaluations)
      .where(
        and(
          eq(stockNegativeRevaluations.tenantId, tenantId),
          eq(stockNegativeRevaluations.sourceId, target.dbId),
        ),
      )
      .limit(1);
    return row?.outletId ?? null;
  }
  const [ledger] = await tx
    .select({ outletId: stockLedger.outletId })
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.tenantId, tenantId),
        eq(stockLedger.sourceType, target.sourceType),
        eq(stockLedger.sourceId, target.dbId),
      ),
    )
    .limit(1);
  return ledger?.outletId ?? null;
}

async function accountingEnabled(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<boolean> {
  const [row] = await tx
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, context.tenant.tenantId))
    .limit(1);
  return isModuleEnabled(row?.featureFlags ?? null, "accounting");
}

export async function deliverInventoryGlEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<InventoryGlResult> {
  if (event.name !== "stock.moved") return { status: "ignored" };
  if (event.tenantId !== context.tenant.tenantId) return { status: "ignored" };
  const payload = stockMovedEventPayloadSchema.parse(event.payload);
  const sourceTypes = glSourceTypesOf(payload);
  if (sourceTypes.length === 0) return { status: "ignored" };
  if (!(await accountingEnabled(tx, context))) return { status: "ignored" };
  // The movement's own source first; its result is reported unless it was
  // ignored or booked nothing (a revaluation-only inflow reports the
  // revaluation).
  let result: InventoryGlResult = { status: "ignored" };
  for (const sourceType of sourceTypes) {
    const settled = await settleStockSource(
      tx,
      context,
      { sourceType, sourceId: payload.sourceId },
      now,
    );
    // A source with nothing to book (a valueless put-away row, no draw) does
    // not hide the posted revaluation of the same row. A put-away with value
    // and no draw is parked as PRODUCTION_INCOMPLETE instead.
    if (
      result.status === "ignored" ||
      (result.status === "zero_value" && settled.status === "posted")
    )
      result = settled;
  }
  return result;
}

/**
 * One source through the savepoint path: post, or park it in
 * `inventory_gl_blocked` on an expected accounting failure.
 */
async function settleStockSource(
  tx: Tx,
  context: ScopedTenantContext,
  source: { sourceType: InventoryGlSourceType; sourceId: string },
  now: Date,
): Promise<InventoryGlResult> {
  const tenantId = context.tenant.tenantId;
  const target = normalizeSource(source);
  await lockSource(tx, tenantId, target);
  let result: InventoryGlResult;
  try {
    result = await tx.transaction((savepoint) =>
      postStockSourceToGl(savepoint, context, source, now),
    );
  } catch (error) {
    const code = blockingCodeOf(error);
    if (!code) throw error;
    const outletId = await outletOfSource(tx, tenantId, target);
    if (!outletId) throw error;
    await tx
      .insert(inventoryGlBlocked)
      .values({
        tenantId,
        outletId,
        sourceType: target.sourceType,
        sourceId: target.domainId,
        errorCode: code,
        firstFailedAt: now,
        lastFailedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          inventoryGlBlocked.tenantId,
          inventoryGlBlocked.sourceType,
          inventoryGlBlocked.sourceId,
        ],
        set: {
          errorCode: code,
          attempts: sql`${inventoryGlBlocked.attempts} + 1`,
          lastFailedAt: now,
        },
      });
    return { status: "blocked", code };
  }
  if (result.status !== "ignored") await clearBlocked(tx, tenantId, target);
  return result;
}

async function clearBlocked(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  target: ReturnType<typeof normalizeSource>,
): Promise<void> {
  await tx
    .delete(inventoryGlBlocked)
    .where(
      and(
        eq(inventoryGlBlocked.tenantId, tenantId),
        eq(inventoryGlBlocked.sourceType, target.sourceType),
        eq(inventoryGlBlocked.sourceId, target.domainId),
      ),
    );
}

async function lockSource(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  target: ReturnType<typeof normalizeSource>,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stock-gl:${tenantId}:${target.sourceType}:${target.dbId}`}, 0))`,
  );
}

export type RetryBlockedResult = {
  readonly posted: number;
  readonly stillBlocked: number;
  readonly failed: number;
};

/**
 * Worker sweep: retry the oldest blocked sources of one tenant (bounded
 * batch). Each source runs in its own transaction, so one failure never holds
 * the others. A tenant without the accounting module is skipped.
 */
export async function retryBlockedInventoryGl(
  context: ScopedTenantContext,
  now = new Date(),
): Promise<RetryBlockedResult> {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Inventory GL retry requires tenant-wide scope");
  const tenantId = context.tenant.tenantId;
  const blocked = await withTenant(db, context, async (tx) => {
    if (!(await accountingEnabled(tx, context))) return [];
    return tx
      .select({
        sourceType: inventoryGlBlocked.sourceType,
        sourceId: inventoryGlBlocked.sourceId,
      })
      .from(inventoryGlBlocked)
      .where(
        and(
          eq(inventoryGlBlocked.tenantId, tenantId),
          lte(
            inventoryGlBlocked.lastFailedAt,
            new Date(now.getTime() - RETRY_AFTER_MS),
          ),
        ),
      )
      .orderBy(
        asc(inventoryGlBlocked.firstFailedAt),
        asc(inventoryGlBlocked.sourceId),
      )
      .limit(RETRY_BATCH);
  });
  let posted = 0;
  let stillBlocked = 0;
  let failed = 0;
  for (const source of blocked) {
    try {
      const result = await withTenant(db, context, (tx) =>
        settleStockSource(tx, context, source, now),
      );
      if (result.status === "blocked") stillBlocked += 1;
      else posted += 1;
    } catch (error) {
      failed += 1;
      // An unexpected error keeps the backoff too, so a row that keeps
      // failing neither retries every tick nor starves newer blocked sources.
      console.error(
        `Inventory GL retry failed for ${source.sourceType}: ${error instanceof Error ? error.name : "unknown"}`,
      );
      await withTenant(db, context, (tx) =>
        tx
          .update(inventoryGlBlocked)
          .set({
            attempts: sql`${inventoryGlBlocked.attempts} + 1`,
            lastFailedAt: now,
          })
          .where(
            and(
              eq(inventoryGlBlocked.tenantId, tenantId),
              eq(inventoryGlBlocked.sourceType, source.sourceType),
              eq(inventoryGlBlocked.sourceId, source.sourceId),
            ),
          ),
      ).catch(() => undefined);
    }
  }
  return { posted, stillBlocked, failed };
}

/**
 * Shares the half-up rounded total of `scaledParts` (non-negative or signed,
 * the absolute value counts) over its parts in whole rupiah by largest
 * remainder: every part gets floor(|part| / scale), the leftover units go to
 * the parts with the largest fractional remainder, ties to the lowest index
 * (the caller passes the oldest business date first). Deterministic, so a
 * replay or a later posting of a parked part gets the same amount. The result
 * is non-negative and sums to round_half_up(Σ|part| / scale).
 */
export function allocateRoundedIdr(
  scaledParts: readonly bigint[],
  scale: bigint,
): number[] {
  const abs = scaledParts.map((part) => (part < 0n ? -part : part));
  const total =
    (abs.reduce((sum, part) => sum + part, 0n) + scale / 2n) / scale;
  const floors = abs.map((part) => part / scale);
  let leftover = Number(total - floors.reduce((sum, part) => sum + part, 0n));
  const result = floors.map((part) => Number(part));
  const order = abs
    .map((part, index) => ({ index, remainder: part % scale }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  for (
    let i = 0;
    leftover > 0 && order.length > 0;
    i = (i + 1) % order.length
  ) {
    result[order[i]!.index]! += 1;
    leftover -= 1;
  }
  return result;
}

/** Latest closed month of the entity, or null (read under the entity lock). */
async function latestClosedPeriod(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  legalEntityId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ period: max(fiscalPeriods.period) })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.tenantId, tenantId),
        eq(fiscalPeriods.legalEntityId, legalEntityId),
        eq(fiscalPeriods.status, "closed"),
      ),
    );
  return row?.period ?? null;
}

function idempotencyKeyOf(
  sourceType: string,
  sourceId: string,
  firstLedgerId: string,
): string {
  const key = `stock-gl:${sourceType}:${sourceId}:${firstLedgerId}`;
  if (key.length <= IDEMPOTENCY_KEY_MAX) return key;
  return `stock-gl:${createHash("sha256").update(key).digest("hex")}`;
}

/**
 * Net rounding already booked for a production batch (positive = Dr 1301 /
 * Cr 5106): credit minus debit on inventory_price_variance over the journals
 * of the batch's tracked rows.
 */
async function bookedProductionVarianceIdr(
  tx: Tx,
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  legalEntityId: string,
  sourceId: string,
): Promise<number> {
  const journals = tx
    .selectDistinct({ id: inventoryGlPostings.journalEntryId })
    .from(inventoryGlPostings)
    .where(
      and(
        eq(inventoryGlPostings.tenantId, tenantId),
        eq(inventoryGlPostings.sourceType, "production_order"),
        eq(inventoryGlPostings.sourceId, sourceId),
        isNotNull(inventoryGlPostings.journalEntryId),
      ),
    );
  const [booked] = await tx
    .select({
      net: sql<string>`COALESCE(sum(${journalLines.creditIdr} - ${journalLines.debitIdr}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(
      accountMappings,
      and(
        eq(accountMappings.tenantId, journalLines.tenantId),
        eq(accountMappings.accountId, journalLines.accountId),
        eq(accountMappings.legalEntityId, legalEntityId),
        eq(accountMappings.role, "inventory_price_variance"),
      ),
    )
    .where(
      and(
        eq(journalLines.tenantId, tenantId),
        inArray(journalLines.entryId, journals),
      ),
    );
  return Number(booked?.net ?? 0);
}

export async function postStockSourceToGl(
  tx: Tx,
  context: ScopedTenantContext,
  source: { sourceType: InventoryGlSourceType; sourceId: string },
  now = new Date(),
): Promise<InventoryGlResult> {
  const mapping = mappingOf(source.sourceType);
  if (!mapping) return { status: "ignored" };
  const tenantId = context.tenant.tenantId;
  const target = normalizeSource(source);
  // legend-gkc6b: stock moved by a training order never reaches the books. A
  // source that already has posted rows (posted before this rule existed) keeps
  // posting, so its return reverses in the books. A training source that was
  // blocked earlier is released: nothing is left to retry.
  if (
    source.sourceType === "order" &&
    (await isTrainingOrder(tx, tenantId, target.domainId))
  ) {
    const [posted] = await tx
      .select({ id: inventoryGlPostings.ledgerEntryId })
      .from(inventoryGlPostings)
      .innerJoin(
        stockLedger,
        and(
          eq(stockLedger.tenantId, inventoryGlPostings.tenantId),
          eq(stockLedger.id, inventoryGlPostings.ledgerEntryId),
        ),
      )
      .where(
        and(
          eq(stockLedger.tenantId, tenantId),
          eq(stockLedger.sourceType, "order"),
          eq(stockLedger.sourceId, target.dbId),
          // A revaluation posted on the same row is not an order posting.
          eq(inventoryGlPostings.sourceType, "order"),
        ),
      )
      .limit(1);
    if (!posted) {
      await clearBlocked(tx, tenantId, target);
      return { status: "ignored" };
    }
  }
  await lockSource(tx, tenantId, target);
  let rows =
    target.sourceType === "negative_stock_revaluation"
      ? await tx
          .select({
            id: stockNegativeRevaluations.ledgerEntryId,
            outletId: stockNegativeRevaluations.outletId,
            quantity: stockNegativeRevaluations.priorQuantity,
            unitCostIdr: stockNegativeRevaluations.unitCostIdr,
            occurredAt: stockNegativeRevaluations.occurredAt,
            valueIdr: stockNegativeRevaluations.valueIdr,
            postedLedgerEntryId: inventoryGlPostings.ledgerEntryId,
          })
          .from(stockNegativeRevaluations)
          .leftJoin(
            inventoryGlPostings,
            and(
              eq(
                inventoryGlPostings.tenantId,
                stockNegativeRevaluations.tenantId,
              ),
              eq(
                inventoryGlPostings.ledgerEntryId,
                stockNegativeRevaluations.ledgerEntryId,
              ),
              eq(inventoryGlPostings.sourceType, "negative_stock_revaluation"),
            ),
          )
          .where(
            and(
              eq(stockNegativeRevaluations.tenantId, tenantId),
              eq(stockNegativeRevaluations.sourceId, target.dbId),
            ),
          )
          .orderBy(
            asc(stockNegativeRevaluations.occurredAt),
            asc(stockNegativeRevaluations.ledgerEntryId),
          )
      : (
          await tx
            .select({
              id: stockLedger.id,
              outletId: stockLedger.outletId,
              quantity: stockLedger.quantity,
              unitCostIdr: stockLedger.unitCostIdr,
              occurredAt: stockLedger.occurredAt,
              postedLedgerEntryId: inventoryGlPostings.ledgerEntryId,
            })
            .from(stockLedger)
            .leftJoin(
              inventoryGlPostings,
              and(
                eq(inventoryGlPostings.tenantId, stockLedger.tenantId),
                eq(inventoryGlPostings.ledgerEntryId, stockLedger.id),
                // The same row's revaluation posting is a separate source.
                ne(
                  inventoryGlPostings.sourceType,
                  "negative_stock_revaluation",
                ),
              ),
            )
            .where(
              and(
                eq(stockLedger.tenantId, tenantId),
                eq(stockLedger.sourceType, target.sourceType),
                eq(stockLedger.sourceId, target.dbId),
                inArray(stockLedger.movementType, [...mapping.movementTypes]),
              ),
            )
            .orderBy(asc(stockLedger.occurredAt), asc(stockLedger.id))
        ).map((row) => ({
          ...row,
          // Signed stock effect in whole rupiah (positive = stock in).
          valueIdr: Number(
            extendCostIdr(row.quantity, row.unitCostIdr, "half_up"),
          ),
        }));
  // A receipt that did not land on a negative balance has nothing to revalue.
  if (rows.length === 0 && target.sourceType === "negative_stock_revaluation")
    return { status: "ignored" };
  // Every ledger row of the source (posted or not) feeds the waste allocation;
  // only the unposted ones are posted below.
  const allRows = rows;
  rows = allRows.filter((row) => row.postedLedgerEntryId === null);
  const first = rows[0];
  if (!first) return { status: "already_posted" };
  if (allRows.some((row) => row.outletId !== first.outletId))
    throw new Error("Stock source spans more than one outlet");
  // A put-away without any draw and without value has nothing to book or
  // track. A put-away without any draw but WITH value is an incomplete batch
  // (a draw still in transit or dead-lettered on an edge push): it is parked
  // as PRODUCTION_INCOMPLETE, strictly, with no rounding allowance, and booked
  // once the draws arrive.
  const isProduction = mapping.eventName === "production.completed";
  if (
    isProduction &&
    !allRows.some((row) => parseDecimal4(row.quantity) < 0n)
  ) {
    const outputScaled = allRows.reduce(
      (sum, row) =>
        sum + parseDecimal4(row.quantity) * parseDecimal4(row.unitCostIdr),
      0n,
    );
    if (scaledCostToIdr(outputScaled) !== 0)
      throw new ProductionIncompleteError(
        "Production batch has output but no material draw",
      );
    return { status: "zero_value", ledgerEntryIds: [] };
  }

  const [outlet] = await tx
    .select({
      legalEntityId: outlets.legalEntityId,
      timezone: outlets.timezone,
      businessDayCutoff: outlets.businessDayCutoff,
    })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, first.outletId)));
  if (!outlet) throw new Error("Outlet of the stock ledger row not found");
  const clock = outletBusinessDayClock(outlet);

  // One group per outlet business date, oldest first (rows are time ordered).
  // A production batch is one journal on the date of its first row: its draw
  // and put-away rows are written together, and splitting them over a cutoff
  // would leave each journal with a one-sided amount.
  const groups = new Map<BusinessDate, typeof rows>();
  for (const row of rows) {
    const date = businessDateOf(
      isProduction ? first.occurredAt : row.occurredAt,
      clock,
    );
    groups.set(date, [...(groups.get(date) ?? []), row]);
  }

  // Waste: exact scaled value of every row of the source per business date,
  // then the rounded total of the log is shared over the dates (oldest first).
  const wasteAmounts = new Map<BusinessDate, number>();
  if (mapping.variant === "waste") {
    const scaledByDate = new Map<BusinessDate, bigint>();
    for (const row of allRows) {
      const date = businessDateOf(row.occurredAt, clock);
      scaledByDate.set(
        date,
        (scaledByDate.get(date) ?? 0n) -
          parseDecimal4(row.quantity) * parseDecimal4(row.unitCostIdr),
      );
    }
    const dates = [...scaledByDate.keys()].sort();
    const scaledParts = dates.map((date) => scaledByDate.get(date)!);
    const sameSign =
      scaledParts.every((part) => part >= 0n) ||
      scaledParts.every((part) => part <= 0n);
    // Mixed signs (not produced by waste logs): keep the per-date rounding.
    const allocated = sameSign
      ? allocateRoundedIdr(scaledParts, COST_PRODUCT_SCALE)
      : null;
    const sign = scaledParts.some((part) => part < 0n) ? -1 : 1;
    dates.forEach((date, index) => {
      wasteAmounts.set(
        date,
        allocated
          ? sign * allocated[index]!
          : scaledCostToIdr(scaledParts[index]!),
      );
    });
  }

  const journalEntryIds: string[] = [];
  for (const [naturalDate, group] of groups) {
    // Signed stock effect of each row in whole rupiah (positive = stock in).
    // A revaluation row carries its own value (prior qty x cost change).
    const rowValues = group.map((row) => row.valueIdr);
    const rowSum = rowValues.reduce((sum, value) => sum + value, 0);
    let amount: number;
    if (mapping.variant === "waste") {
      // Waste rounds once over the whole log (equals waste_logs.value_idr),
      // shared over its business dates by largest remainder.
      amount = wasteAmounts.get(naturalDate)!;
    } else if (isProduction) {
      // Output card value minus material cost over every row of the batch,
      // each rounded once, less the rounding already booked on 5106 for it
      // (a draw that arrives after the batch was booked).
      let outputScaled = 0n;
      let materialScaled = 0n;
      let outputQty = 0n;
      for (const row of allRows) {
        const quantity = parseDecimal4(row.quantity);
        const scaled = quantity * parseDecimal4(row.unitCostIdr);
        if (quantity > 0n) {
          outputQty += quantity;
          outputScaled += scaled;
        } else materialScaled -= scaled;
      }
      const variance =
        scaledCostToIdr(outputScaled) - scaledCostToIdr(materialScaled);
      // The unit cost is rounded to 4 decimals, so a complete batch differs
      // by at most ceil(actualQty x 0.00005) + 1 rupiah. Beyond that a draw
      // (or the output) is missing: park it, never a 5106 gain or loss.
      const bound =
        Number((outputQty * 5n + 999_999_999n) / 1_000_000_000n) + 1;
      if (Math.abs(variance) > bound)
        throw new ProductionIncompleteError(
          "Production batch rows are incomplete",
        );
      amount =
        variance -
        (await bookedProductionVarianceIdr(
          tx,
          tenantId,
          outlet.legalEntityId,
          target.domainId,
        ));
    } else if (mapping.variant === "count") {
      amount = rowSum;
    } else {
      amount = -rowSum;
    }

    let journalEntryId: string | null = null;
    if (amount !== 0) {
      // Takes the entity FOR SHARE lock: close/reopen cannot race this post.
      const closed = await wouldPostingBeBlockedByClosedPeriod(
        tx,
        tenantId,
        outlet.legalEntityId,
        periodOf(naturalDate),
      );
      const { entryDate, lateAdjustmentFrom } = resolveAutoJournalDate(
        naturalDate,
        closed
          ? await latestClosedPeriod(tx, tenantId, outlet.legalEntityId)
          : null,
      );
      const journal = await postJournalFromRuleInTransaction(
        tx,
        context,
        {
          eventName: mapping.eventName,
          variant: mapping.variant,
          amounts: { [mapping.amountKey]: amount },
          legalEntityId: outlet.legalEntityId,
          outletId: first.outletId,
          entryDate: entryDate as BusinessDate,
          sourceId: target.domainId,
          postedBy: null,
          idempotencyKey: idempotencyKeyOf(
            target.sourceType,
            target.domainId,
            group[0]!.id,
          ),
          lateAdjustmentFrom,
          ...(lateAdjustmentFrom === null
            ? {}
            : {
                description: `${
                  resolvePostingRule(defaultPostingRules, {
                    eventName: mapping.eventName,
                    variant: mapping.variant ?? undefined,
                  }).description
                } (penyesuaian terlambat dari ${lateAdjustmentFrom})`,
              }),
        },
        now,
      );
      if (lateAdjustmentFrom !== null)
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(now.getTime()),
            tenantId,
            outletId: first.outletId,
            actorType: "system",
            actorId: null,
            deviceId: null,
            action: "accounting.journal.late_adjusted",
            objectType: "journal_entry",
            objectId: journal.id,
            reason: null,
            maskedChanges: {
              before: null,
              after: {
                journalId: journal.id,
                trigger: mapping.eventName,
                sourceId: target.domainId,
                originalDate: lateAdjustmentFrom,
                entryDate,
              },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: now.toISOString(),
          },
          LATE_AUDIT_FIELDS,
        );
      journalEntryId = journal.id;
      journalEntryIds.push(journal.id);
    }
    const inserted = await tx
      .insert(inventoryGlPostings)
      .values(
        group.map((row, index) => ({
          tenantId,
          ledgerEntryId: row.id,
          outletId: row.outletId,
          sourceType: target.sourceType,
          sourceId: target.domainId,
          journalEntryId,
          valueIdr: rowValues[index]!,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: inventoryGlPostings.ledgerEntryId });
    if (inserted.length !== group.length)
      throw new Error("Inventory GL tracking rows were not all inserted");
  }

  const ledgerEntryIds = rows.map((row) => row.id);
  const [firstJournal] = journalEntryIds;
  return firstJournal === undefined
    ? { status: "zero_value", ledgerEntryIds }
    : {
        status: "posted",
        journalEntryId: firstJournal,
        journalEntryIds,
        ledgerEntryIds,
      };
}
