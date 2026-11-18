// Goods receipt with partial receiving, QC and photos (PRD v1.7 §3.18, §4 Alur
// I step 3; INV-05; bead legend-o1o4s).
//
// - One receipt records, per PO line, what arrived (`quantityReceived`) and
//   what QC rejected (`quantityRejected`). Only the accepted quantity enters
//   stock, in the item base unit, through the stock ledger (source
//   `goods_receipt`). Receipts are immutable once written.
// - The PO row is locked FOR UPDATE first, so two receipts of one PO never run
//   side by side: the second one sees the first one's lines and is refused when
//   the accepted total would pass the ordered quantity.
// - Numbering `GR/<YYYYMM>/<0001>` from `purchasing_document_sequences`.
// - The PO moves to `partially_received` / `received` through the contract
//   `transitionPurchaseOrder`; a receipt that accepted nothing leaves it as is.
// - Photos are `core_storage_objects` of this outlet with purpose `receipt`.
// - Event `goods_receipt.recorded` goes through the transactional outbox. No
//   journal is posted here.

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import {
  businessDateOf,
  CoreError,
  createUlid,
  divideRounded,
  encodeCursor,
  formatDecimal4,
  parseDecimal4,
  type Decimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  assertGoodsReceiptMatchesOrder,
  convertQuantity,
  goodsReceiptDetailSchema,
  goodsReceiptSchema,
  goodsReceiptValueIdr,
  purchaseOrderStatusAfterReceipt,
  purchasingEvents,
  transitionPurchaseOrder,
  PurchasingError,
  type createGoodsReceiptInputSchema,
  type goodsReceiptQuerySchema,
  type GoodsReceipt,
  type GoodsReceiptDetail,
  type GoodsReceiptLine,
  type PurchaseOrderLine,
  type UomConversion,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { coreStorageObjects } from "../db/schema/core-storage.ts";
import {
  goodsReceiptLines,
  goodsReceiptMedia,
  goodsReceipts,
} from "../db/schema/inventory-receiving.ts";
import {
  inventoryItems,
  stockBatches,
  stockLocations,
  uomConversions,
} from "../db/schema/inventory.ts";
import {
  purchaseOrderLines,
  purchaseOrders,
  purchasingDocumentSequences,
} from "../db/schema/purchasing.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { appendOutbox } from "./core-outbox.ts";
import { linkStorageObjectSource } from "./core-storage.ts";
import { recordStockMovementInTransaction } from "./inventory.service.ts";
import {
  assertOutlet,
  cursorInstant,
  cursorKeys,
  cursorUuid,
  EVENT_DESTINATION,
  loadOutletClock,
  outletTarget,
  recordOpsAudit,
  requestFingerprint,
  requireOpsPermission,
  ROUNDING_MODE,
  translateInventoryError,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import {
  claimPurchasingIdempotency,
  completePurchasingIdempotency,
  guardMoneyMath,
  PURCHASING_READ_PERMISSIONS,
  translatePurchasingError,
} from "./purchasing-flow.shared.ts";

export type CreateGoodsReceiptInput = z.infer<
  typeof createGoodsReceiptInputSchema
>;
export type GoodsReceiptQuery = z.infer<typeof goodsReceiptQuerySchema>;

const CREATE_OPERATION = "goods_receipt.create";
const RECEIVE_PERMISSION = "inventory.stock.receive";
const PHOTO_PURPOSE = "goods_receipt_photo";
/** A receipt photo must be taken at most this long before the receipt. */
const PHOTO_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECEIPT_AUDIT_FIELDS = [
  "number",
  "purchaseOrderId",
  "supplierId",
  "receivedOn",
  "lineCount",
  "receivedValueIdr",
] as const;
const ORDER_AUDIT_FIELDS = ["status", "goodsReceiptId"] as const;

/** Reads: the receive permission or any purchasing read permission. */
export const GOODS_RECEIPT_READ_PERMISSIONS: readonly PermissionCode[] = [
  RECEIVE_PERMISSION,
  ...PURCHASING_READ_PERMISSIONS,
];

type ReceiptRow = typeof goodsReceipts.$inferSelect;
type ReceiptLineRow = typeof goodsReceiptLines.$inferSelect;
type OrderLineRow = typeof purchaseOrderLines.$inferSelect;

function invalid(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

function toReceipt(row: ReceiptRow, mediaIds: readonly string[]): GoodsReceipt {
  return goodsReceiptSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    purchaseOrderId: row.purchaseOrderId,
    supplierId: row.supplierId,
    number: row.number,
    receivedBy: row.receivedBy,
    receivedAt: row.receivedAt.toISOString(),
    receivedOn: row.receivedOn,
    qcNotes: row.qcNotes,
    mediaIds: [...mediaIds],
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  });
}

function toLine(row: ReceiptLineRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    goodsReceiptId: row.goodsReceiptId,
    purchaseOrderLineId: row.purchaseOrderLineId,
    inventoryItemId: row.inventoryItemId,
    locationId: row.locationId,
    quantityReceived: row.quantityReceived,
    quantityRejected: row.quantityRejected,
    unitCostIdr: row.unitCostIdr,
    batchCode: row.batchCode,
    expiresOn: row.expiresOn,
  };
}

async function loadMediaIds(
  tx: Tx,
  tenantId: ReceiptRow["tenantId"],
  outletId: ReceiptRow["outletId"],
  receiptIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byReceipt = new Map<string, string[]>();
  if (receiptIds.length === 0) return byReceipt;
  const rows = await tx
    .select({
      goodsReceiptId: goodsReceiptMedia.goodsReceiptId,
      storageObjectId: goodsReceiptMedia.storageObjectId,
    })
    .from(goodsReceiptMedia)
    .where(
      and(
        eq(goodsReceiptMedia.tenantId, tenantId),
        eq(goodsReceiptMedia.outletId, outletId),
        inArray(goodsReceiptMedia.goodsReceiptId, [...receiptIds]),
      ),
    )
    .orderBy(
      asc(goodsReceiptMedia.goodsReceiptId),
      asc(goodsReceiptMedia.position),
    );
  for (const row of rows) {
    const ids = byReceipt.get(row.goodsReceiptId) ?? [];
    ids.push(row.storageObjectId);
    byReceipt.set(row.goodsReceiptId, ids);
  }
  return byReceipt;
}

export async function detailOf(
  tx: Tx,
  row: ReceiptRow,
): Promise<GoodsReceiptDetail> {
  const lines = await tx
    .select()
    .from(goodsReceiptLines)
    .where(
      and(
        eq(goodsReceiptLines.tenantId, row.tenantId),
        eq(goodsReceiptLines.goodsReceiptId, row.id),
      ),
    )
    .orderBy(asc(goodsReceiptLines.lineNo));
  const media = await loadMediaIds(tx, row.tenantId, row.outletId, [row.id]);
  return goodsReceiptDetailSchema.parse({
    receipt: toReceipt(row, media.get(row.id) ?? []),
    lines: lines.map(toLine),
  });
}

/** `GR/<YYYYMM>/<0001>`: next value of the tenant's monthly counter. */
async function nextGrNumber(
  tx: Tx,
  context: ScopedTenantContext,
  businessDate: string,
): Promise<string> {
  const period = `${businessDate.slice(0, 4)}${businessDate.slice(5, 7)}`;
  const [row] = await tx
    .insert(purchasingDocumentSequences)
    .values({
      tenantId: context.tenant.tenantId,
      kind: "GR",
      period,
      lastValue: 1,
    })
    .onConflictDoUpdate({
      target: [
        purchasingDocumentSequences.tenantId,
        purchasingDocumentSequences.kind,
        purchasingDocumentSequences.period,
      ],
      set: {
        lastValue: sql`${purchasingDocumentSequences.lastValue} + 1`,
      },
    })
    .returning({ value: purchasingDocumentSequences.lastValue });
  return `GR/${period}/${String(row!.value).padStart(4, "0")}`;
}

function canonicalInput(input: CreateGoodsReceiptInput, mediaIds: string[]) {
  return {
    outletId: input.outletId,
    purchaseOrderId: input.purchaseOrderId,
    receivedOn: input.receivedOn ?? null,
    qcNotes: input.qcNotes ?? null,
    note: input.note ?? null,
    mediaIds,
    lines: input.lines.map((line) => ({
      purchaseOrderLineId: line.purchaseOrderLineId,
      locationId: line.locationId,
      quantityReceived: formatDecimal4(parseDecimal4(line.quantityReceived)),
      quantityRejected: formatDecimal4(parseDecimal4(line.quantityRejected)),
      batchCode: line.batchCode ?? null,
      expiresOn: line.expiresOn ?? null,
    })),
  };
}

/**
 * Deduplicated photo ids in the order sent (the first is the cover photo);
 * ids are compared case-insensitively.
 */
function uniqueMediaIds(mediaIds: readonly string[] | undefined): string[] {
  return [...new Set((mediaIds ?? []).map((id) => id.toLowerCase()))];
}

async function lockOrder(
  tx: Tx,
  context: ScopedTenantContext,
  orderId: string,
) {
  const [row] = await tx
    .select()
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.tenantId, context.tenant.tenantId),
        eq(purchaseOrders.id, orderId),
      ),
    )
    .for("update");
  return row ?? null;
}

async function assertLocations(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  locationIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(locationIds)];
  const rows = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.tenantId, context.tenant.tenantId),
        eq(stockLocations.outletId, outletId),
        inArray(stockLocations.id, unique),
      ),
    );
  if (rows.length !== unique.length)
    throw invalid("A stock location does not belong to this outlet.");
}

async function assertPhotos(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  mediaIds: readonly string[],
  now: Date,
): Promise<void> {
  if (mediaIds.length === 0) return;
  const rows = await tx
    .select({
      id: coreStorageObjects.id,
      createdAt: coreStorageObjects.createdAt,
    })
    .from(coreStorageObjects)
    .where(
      and(
        eq(coreStorageObjects.tenantId, context.tenant.tenantId),
        eq(coreStorageObjects.outletId, outletId),
        eq(coreStorageObjects.purpose, PHOTO_PURPOSE),
        inArray(coreStorageObjects.id, [...mediaIds]),
      ),
    );
  if (rows.length !== mediaIds.length)
    throw invalid("A photo is not a receipt photo of this outlet.");
  // Photos are checked before any is linked: a stale one refuses the receipt.
  const oldest = now.getTime() - PHOTO_MAX_AGE_MS;
  if (rows.some((row) => row.createdAt.getTime() < oldest))
    throw invalid("A receipt photo must be uploaded within the last 24 hours.");
  // One upload documents one receipt: refuse a photo another receipt owns.
  const attached = await tx
    .select({ id: goodsReceiptMedia.storageObjectId })
    .from(goodsReceiptMedia)
    .where(
      and(
        eq(goodsReceiptMedia.tenantId, context.tenant.tenantId),
        eq(goodsReceiptMedia.outletId, outletId),
        inArray(goodsReceiptMedia.storageObjectId, [...mediaIds]),
      ),
    )
    .limit(1);
  if (attached.length > 0)
    throw invalid("A photo is already attached to another goods receipt.");
}

/** Purchase cost per base unit: PO unit price x accepted / accepted base. */
export function baseUnitCost(
  unitCostIdr: string,
  accepted: string,
  acceptedBase: string,
): Decimal4 {
  return formatDecimal4(
    divideRounded(
      parseDecimal4(unitCostIdr) * parseDecimal4(accepted),
      parseDecimal4(acceptedBase),
      ROUNDING_MODE,
    ),
  );
}

function acceptedOf(line: ReceiptLineRow): Decimal4 {
  return formatDecimal4(
    parseDecimal4(line.quantityReceived) - parseDecimal4(line.quantityRejected),
  );
}

/**
 * Posts the stock-in of a recorded receipt: every line with an accepted base
 * quantity above zero. Each line has its own deterministic idempotency key, so
 * a second call writes no new ledger rows.
 */
export async function postGoodsReceiptStockInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  goodsReceiptId: string,
  actorUserId: string,
): Promise<void> {
  const [receipt] = await tx
    .select()
    .from(goodsReceipts)
    .where(
      and(
        eq(goodsReceipts.tenantId, context.tenant.tenantId),
        eq(goodsReceipts.id, goodsReceiptId),
      ),
    );
  if (!receipt)
    throw new HttpError(404, "NOT_FOUND", "Goods receipt not found.");
  const lines = await tx
    .select()
    .from(goodsReceiptLines)
    .where(
      and(
        eq(goodsReceiptLines.tenantId, context.tenant.tenantId),
        eq(goodsReceiptLines.goodsReceiptId, goodsReceiptId),
        sql`${goodsReceiptLines.acceptedBaseQuantity} > 0`,
      ),
    )
    // Same lock order for every receipt (location, then item): no deadlocks.
    .orderBy(
      asc(goodsReceiptLines.locationId),
      asc(goodsReceiptLines.inventoryItemId),
      asc(goodsReceiptLines.lineNo),
    );
  for (const line of lines) {
    const unitCostIdr = guardMoneyMath(() =>
      baseUnitCost(
        line.unitCostIdr,
        acceptedOf(line),
        line.acceptedBaseQuantity,
      ),
    );
    await recordStockMovementInTransaction(tx, context, {
      outletId: receipt.outletId,
      locationId: line.locationId,
      inventoryItemId: line.inventoryItemId,
      movementType: "receipt",
      quantity: formatDecimal4(parseDecimal4(line.acceptedBaseQuantity)),
      unitCostIdr,
      batchId: line.batchId,
      sourceType: "goods_receipt",
      sourceId: receipt.id,
      occurredAt: receipt.receivedAt.toISOString(),
      idempotencyKey: `goods_receipt:${receipt.id}:${line.id}`,
      actor: { type: "user", id: actorUserId },
    });
  }
}

/**
 * The `goods_receipt.recorded` envelope of a stored receipt. Shared by the
 * outbox append at receipt time and the finance "journalize receipt" command
 * (legend-7e0q4), so both build the same fact.
 */
export function buildReceiptRecordedEvent(
  tenantId: ScopedTenantContext["tenant"]["tenantId"],
  receipt: GoodsReceipt,
  lineCount: number,
  receivedValueIdr: number,
) {
  const name = "goods_receipt.recorded";
  const occurredAt = new Date(receipt.receivedAt);
  return purchasingEvents[name].envelopeSchema.parse({
    id: createUlid(occurredAt.getTime()),
    tenantId,
    outletId: receipt.outletId,
    name,
    version: 1,
    aggregateType: "goods_receipt",
    aggregateId: receipt.id,
    sequence: 1,
    occurredAt: receipt.receivedAt,
    actor: { type: "user", id: receipt.receivedBy },
    deviceId: null,
    idempotencyKey: `${name}:${receipt.id}:1`,
    payloadSchemaRef: `${name}.v1`,
    payload: {
      goodsReceiptId: receipt.id,
      purchaseOrderId: receipt.purchaseOrderId,
      supplierId: receipt.supplierId,
      number: receipt.number,
      receivedValueIdr,
      lineCount,
      receivedBy: receipt.receivedBy,
      receivedAt: receipt.receivedAt,
    },
  });
}

async function appendReceiptRecordedEvent(
  tx: Tx,
  context: ScopedTenantContext,
  receipt: GoodsReceipt,
  lineCount: number,
  receivedValueIdr: number,
): Promise<void> {
  const event = buildReceiptRecordedEvent(
    context.tenant.tenantId,
    receipt,
    lineCount,
    receivedValueIdr,
  );
  await appendOutbox(tx, context, {
    id: createUlid(),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * POST goods receipt. Needs `inventory.stock.receive` at the outlet. Records
 * the receipt, posts the accepted stock and advances the PO in one
 * transaction; a retry with the same key replays the first receipt.
 */
export async function createGoodsReceipt(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateGoodsReceiptInput,
): Promise<GoodsReceiptDetail> {
  assertOutlet(context, input.outletId);
  const mediaIds = uniqueMediaIds(input.mediaIds);
  const claim = {
    operation: CREATE_OPERATION,
    key: input.idempotencyKey,
    outletId: input.outletId,
    fingerprint: requestFingerprint(
      CREATE_OPERATION,
      actorUserId,
      canonicalInput(input, [...mediaIds].sort()),
    ),
  };
  try {
    return await withTenant(db, context, async (tx) => {
      await requireOpsPermission(
        tx,
        context,
        actorUserId,
        RECEIVE_PERMISSION,
        input.outletId,
      );
      const replay = await claimPurchasingIdempotency(tx, context, claim);
      if (replay) return goodsReceiptDetailSchema.parse(replay.replay);

      const order = await lockOrder(tx, context, input.purchaseOrderId);
      if (
        !order ||
        order.outletId.toLowerCase() !== input.outletId.toLowerCase()
      )
        throw new HttpError(404, "NOT_FOUND", "Purchase order not found.");
      if (order.status !== "sent" && order.status !== "partially_received")
        throw new PurchasingError(
          "PURCHASE_ORDER_INVALID_TRANSITION",
          `Cannot receive goods for a purchase order in ${order.status}`,
        );

      const orderLines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(
          and(
            eq(purchaseOrderLines.tenantId, context.tenant.tenantId),
            eq(purchaseOrderLines.purchaseOrderId, order.id),
          ),
        );
      const orderLineById = new Map<string, OrderLineRow>(
        orderLines.map((line) => [line.id, line]),
      );
      const priorLines =
        orderLines.length === 0
          ? []
          : await tx
              .select()
              .from(goodsReceiptLines)
              .where(
                and(
                  eq(goodsReceiptLines.tenantId, context.tenant.tenantId),
                  inArray(
                    goodsReceiptLines.purchaseOrderLineId,
                    orderLines.map((line) => line.id),
                  ),
                ),
              );

      const lineIds = input.lines.map((line) => line.purchaseOrderLineId);
      if (new Set(lineIds).size !== lineIds.length)
        throw invalid("A purchase order line appears twice in this receipt.");
      await assertLocations(
        tx,
        context,
        input.outletId,
        input.lines.map((line) => line.locationId),
      );
      // The input schema does not compare the two; the DB CHECK would 500.
      if (
        input.lines.some(
          (line) =>
            parseDecimal4(line.quantityRejected) >
            parseDecimal4(line.quantityReceived),
        )
      )
        throw invalid("Rejected quantity cannot exceed the received quantity.");
      // DB rows carry plain string ids; the contract helpers take branded ids.
      const contractOrderLines = orderLines as unknown as readonly Pick<
        PurchaseOrderLine,
        "id" | "inventoryItemId" | "quantity"
      >[];
      const contractReceiptLines = (
        lines: readonly {
          purchaseOrderLineId: string;
          inventoryItemId: string;
          quantityReceived: string;
          quantityRejected: string;
        }[],
      ) =>
        lines as unknown as readonly Pick<
          GoodsReceiptLine,
          | "purchaseOrderLineId"
          | "inventoryItemId"
          | "quantityReceived"
          | "quantityRejected"
        >[];
      const newLines = input.lines.map((line) => ({
        purchaseOrderLineId: line.purchaseOrderLineId,
        inventoryItemId:
          orderLineById.get(line.purchaseOrderLineId)?.inventoryItemId ?? "",
        quantityReceived: line.quantityReceived,
        quantityRejected: line.quantityRejected,
      }));
      const rejectsAny = input.lines.some(
        (line) => parseDecimal4(line.quantityRejected) > 0n,
      );
      if (rejectsAny && !input.qcNotes)
        throw invalid("QC notes are required when a quantity is rejected.");
      assertGoodsReceiptMatchesOrder(
        contractOrderLines,
        contractReceiptLines(priorLines),
        contractReceiptLines(newLines),
      );
      const now = new Date();
      await assertPhotos(tx, context, input.outletId, mediaIds, now);

      const itemIds = [...new Set(orderLines.map((l) => l.inventoryItemId))];
      const items = await tx
        .select({ id: inventoryItems.id, baseUomId: inventoryItems.baseUomId })
        .from(inventoryItems)
        .where(inArray(inventoryItems.id, itemIds));
      const baseUomOf = new Map(items.map((item) => [item.id, item.baseUomId]));
      const conversionRows = await tx
        .select()
        .from(uomConversions)
        .where(inArray(uomConversions.inventoryItemId, itemIds));
      const conversions = conversionRows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        inventoryItemId: row.inventoryItemId,
        fromUomId: row.fromUomId,
        toUomId: row.toUomId,
        factor: row.factor,
      })) as UomConversion[];

      const businessDate = businessDateOf(
        now,
        await loadOutletClock(tx, input.outletId),
      );
      const receivedOn = input.receivedOn ?? businessDate;
      const number = await nextGrNumber(tx, context, businessDate);
      const receiptId = randomUUID();

      const [row] = await tx
        .insert(goodsReceipts)
        .values({
          id: receiptId,
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          purchaseOrderId: order.id,
          supplierId: order.supplierId,
          number,
          receivedBy: actorUserId,
          receivedAt: now,
          receivedOn,
          qcNotes: input.qcNotes ? input.qcNotes : null,
          note: input.note ? input.note : null,
        })
        .returning();

      const lineValues: (typeof goodsReceiptLines.$inferInsert)[] = [];
      for (const [index, line] of input.lines.entries()) {
        const orderLine = orderLineById.get(line.purchaseOrderLineId)!;
        const baseUomId = baseUomOf.get(orderLine.inventoryItemId);
        if (!baseUomId) throw invalid("The purchase order item is missing.");
        const accepted = formatDecimal4(
          parseDecimal4(line.quantityReceived) -
            parseDecimal4(line.quantityRejected),
        );
        const acceptedBase = guardMoneyMath(() =>
          convertQuantity(
            accepted,
            orderLine.uomId,
            baseUomId,
            conversions.filter(
              (conversion) =>
                conversion.inventoryItemId === orderLine.inventoryItemId,
            ),
            ROUNDING_MODE,
          ),
        );
        // A purchase unit smaller than the base unit can round to zero base
        // units: the PO would count it as received while no stock moves.
        if (parseDecimal4(accepted) > 0n && parseDecimal4(acceptedBase) === 0n)
          throw invalid(
            "The accepted quantity is too small to record in the base unit.",
          );
        let batchId: string | null = null;
        if (line.batchCode && parseDecimal4(acceptedBase) > 0n) {
          const [batch] = await tx
            .insert(stockBatches)
            .values({
              tenantId: context.tenant.tenantId,
              outletId: input.outletId,
              locationId: line.locationId,
              inventoryItemId: orderLine.inventoryItemId,
              batchCode: line.batchCode,
              expiresOn: line.expiresOn ?? null,
              receivedAt: now,
            })
            .returning({ id: stockBatches.id });
          batchId = batch!.id;
        }
        lineValues.push({
          id: randomUUID(),
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          goodsReceiptId: receiptId,
          purchaseOrderLineId: orderLine.id,
          inventoryItemId: orderLine.inventoryItemId,
          locationId: line.locationId,
          uomId: orderLine.uomId,
          quantityReceived: line.quantityReceived,
          quantityRejected: line.quantityRejected,
          acceptedBaseQuantity: acceptedBase,
          unitCostIdr: orderLine.unitPriceIdr,
          batchCode: line.batchCode ?? null,
          expiresOn: line.expiresOn ?? null,
          batchId,
          lineNo: index + 1,
        });
      }
      await tx.insert(goodsReceiptLines).values(lineValues);
      // Link each photo to this receipt: only the uploader's own unattached
      // receipt photo of this outlet links, and the link is what lets the
      // outlet's receiving readers open it.
      for (const objectId of mediaIds) {
        try {
          await linkStorageObjectSource(tx, {
            tenantId: context.tenant.tenantId,
            objectId,
            sourceKind: "goods_receipt",
            sourceId: receiptId,
            actorUserId,
            outletId: input.outletId,
          });
        } catch (error) {
          // The storage helper answers a core 400; this contract answers 422.
          if (error instanceof CoreError && error.code === "VALIDATION_ERROR")
            throw invalid(
              "A photo must be your own unattached receipt photo of this outlet.",
            );
          throw error;
        }
      }
      if (mediaIds.length > 0)
        await tx.insert(goodsReceiptMedia).values(
          mediaIds.map((storageObjectId, position) => ({
            tenantId: context.tenant.tenantId,
            outletId: input.outletId,
            goodsReceiptId: receiptId,
            storageObjectId,
            position,
          })),
        );

      await postGoodsReceiptStockInTransaction(
        tx,
        context,
        receiptId,
        actorUserId,
      );

      const nextStatus = purchaseOrderStatusAfterReceipt(
        contractOrderLines,
        contractReceiptLines([...priorLines, ...newLines]),
      );
      if (nextStatus !== null) {
        // Throws PURCHASE_ORDER_INVALID_TRANSITION for a move the PO state
        // machine does not allow; an unchanged status writes nothing.
        transitionPurchaseOrder(
          order.status,
          nextStatus === "received" ? "receive_full" : "receive_partial",
        );
      }
      if (nextStatus !== null && nextStatus !== order.status) {
        const newStatus = nextStatus;
        // `updated_at` is the PO optimistic-lock token: strictly increasing.
        const moved = await tx
          .update(purchaseOrders)
          .set({
            status: newStatus,
            updatedAt: sql`GREATEST(clock_timestamp(), ${purchaseOrders.updatedAt} + interval '1 millisecond')`,
          })
          .where(
            and(
              eq(purchaseOrders.tenantId, context.tenant.tenantId),
              eq(purchaseOrders.id, order.id),
              eq(purchaseOrders.status, order.status),
            ),
          )
          .returning({ id: purchaseOrders.id });
        if (moved.length === 0)
          throw new HttpError(
            409,
            "CONFLICT",
            "The purchase order changed; reload it.",
          );
        await recordOpsAudit(tx, context, {
          actorUserId,
          outletId: input.outletId,
          action: "purchasing.order_received",
          objectType: "purchase_order",
          objectId: order.id,
          before: { status: order.status },
          after: { status: newStatus, goodsReceiptId: receiptId },
          safeFields: ORDER_AUDIT_FIELDS,
        });
      }

      const detail = await detailOf(tx, row!);
      const receivedValueIdr = guardMoneyMath(() =>
        goodsReceiptValueIdr(detail.lines, ROUNDING_MODE),
      );
      await recordOpsAudit(tx, context, {
        actorUserId,
        outletId: input.outletId,
        action: "inventory.goods_receipt_recorded",
        objectType: "goods_receipt",
        objectId: receiptId,
        before: null,
        after: {
          number: detail.receipt.number,
          purchaseOrderId: detail.receipt.purchaseOrderId,
          supplierId: detail.receipt.supplierId,
          receivedOn: detail.receipt.receivedOn,
          lineCount: detail.lines.length,
          receivedValueIdr,
        },
        safeFields: RECEIPT_AUDIT_FIELDS,
      });
      await appendReceiptRecordedEvent(
        tx,
        context,
        detail.receipt,
        detail.lines.length,
        receivedValueIdr,
      );
      await completePurchasingIdempotency(tx, context, claim, detail);
      return detail;
    });
  } catch (error) {
    throw translatePurchasingError(translateInventoryError(error));
  }
}

function requireReceiptRead(
  snapshot: Awaited<ReturnType<typeof accessSnapshotInTransaction>>,
  outletId: string,
): void {
  const allowed = GOODS_RECEIPT_READ_PERMISSIONS.some((permission) =>
    snapshot.allows(permission, outletTarget(outletId)),
  );
  if (!allowed) throw new AccessError("PERMISSION_DENIED");
}

/** GET goods receipts of one outlet, newest first. */
export async function listGoodsReceipts(
  context: ScopedTenantContext,
  actorUserId: string,
  query: GoodsReceiptQuery,
): Promise<CursorPage<GoodsReceipt>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    requireReceiptRead(
      await accessSnapshotInTransaction(tx, context, actorUserId, new Date()),
      query.outletId,
    );
    const filters: SQL[] = [
      eq(goodsReceipts.tenantId, context.tenant.tenantId),
      eq(goodsReceipts.outletId, query.outletId),
    ];
    if (query.purchaseOrderId)
      filters.push(eq(goodsReceipts.purchaseOrderId, query.purchaseOrderId));
    if (query.supplierId)
      filters.push(eq(goodsReceipts.supplierId, query.supplierId));
    if (query.fromDate)
      filters.push(gte(goodsReceipts.receivedOn, query.fromDate));
    if (query.toDate) filters.push(lte(goodsReceipts.receivedOn, query.toDate));
    const [receivedAt, id] = cursorKeys(query.cursor, 2);
    if (receivedAt !== undefined && id !== undefined) {
      const at = cursorInstant(receivedAt);
      filters.push(
        or(
          lt(goodsReceipts.receivedAt, at),
          and(
            eq(goodsReceipts.receivedAt, at),
            sql`${goodsReceipts.id} < ${cursorUuid(id)}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(goodsReceipts)
      .where(and(...filters))
      .orderBy(desc(goodsReceipts.receivedAt), desc(goodsReceipts.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const media = await loadMediaIds(
      tx,
      context.tenant.tenantId,
      query.outletId,
      page.map((row) => row.id),
    );
    return {
      data: page.map((row) => toReceipt(row, media.get(row.id) ?? [])),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.receivedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** GET one goods receipt with lines; another outlet or tenant is a 404. */
export async function getGoodsReceipt(
  context: ScopedTenantContext,
  actorUserId: string,
  goodsReceiptId: string,
): Promise<GoodsReceiptDetail> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.tenantId, context.tenant.tenantId),
          eq(goodsReceipts.id, goodsReceiptId),
        ),
      );
    if (!row) throw new HttpError(404, "NOT_FOUND", "Goods receipt not found.");
    requireReceiptRead(
      await accessSnapshotInTransaction(tx, context, actorUserId, new Date()),
      row.outletId,
    );
    return detailOf(tx, row);
  });
}
