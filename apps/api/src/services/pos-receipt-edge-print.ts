// legend-2lp.2: deliver the frozen POS receipt document to the local edge
// Print Agent. The queue insert shares the receipt delivery transaction, so
// rollback cannot leave a printable original or a misleading sent delivery.
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  CoreError,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { messagesId } from "@starter/shared/i18n";
import type {
  PrintPaperWidth,
  PrintPayload,
  ReceiptDocument,
  ReceiptPrintResult,
} from "@starter/shared/pos";
import { edgePrinters } from "../db/schema/edge-print.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { markReprint } from "../edge/print/escpos.ts";
import { getEdgePrintAgent } from "../edge/print/runtime.ts";
import { renderReceipt } from "../edge/print/templates.ts";
import type { ReceiptData } from "../edge/print/types.ts";
import type { Tx } from "./permission-resolver.ts";

/** Read the document's amounts unchanged; printing never recalculates a sale. */
export function receiptData(document: ReceiptDocument): ReceiptData {
  return {
    outletName: document.outletName,
    outletAddress: document.outletAddress,
    receiptNumber: document.receiptNumber,
    cashierName: document.cashierName ?? "-",
    issuedAt: new Date(document.issuedAt),
    lines: document.items.map((line) => ({
      name: line.name,
      qty: line.quantity,
      unitPrice: line.unitPriceIdr,
      total: line.lineTotalIdr,
      note: line.note,
    })),
    subtotal: document.subtotalIdr,
    discount: document.discountIdr,
    serviceCharge: document.serviceChargeIdr,
    tax: document.taxIdr,
    pricesIncludeTax: document.pricesIncludeTax,
    total: document.totalIdr,
    rounding: document.roundingIdr,
    status: document.status,
    depositAppliedIdr: Number(document.depositAppliedIdr),
    payments: document.tenders.map((tender) => ({
      method: tender.method,
      amount: tender.amountIdr,
    })),
  };
}

/**
 * The edge queues the job on its printer. The cloud has no printer: without a
 * `paperWidth` it prints nothing; with one (P1) it hands the bytes to the
 * tablet, which sends them to its own printer ("sent", never "printed").
 */
export function receiptPrintResult(
  paperWidth?: PrintPaperWidth,
): ReceiptPrintResult {
  return getEdgeRuntimeState().edgeMode || paperWidth !== undefined
    ? "queued_to_printer"
    : "not_printed";
}

/** Marks a print delivery whose bytes went to the tablet (not a legacy row). */
export const TABLET_PRINT_DESTINATION = "printer tablet";

/** Same bytes as the edge print job, as the payload a tablet prints (P1). */
export function receiptPrintPayload(
  document: ReceiptDocument,
  paperWidth: PrintPaperWidth,
  /** A replay of an earlier print key is never the original. */
  forceReprint = false,
): PrintPayload {
  const reprint = document.reprint || forceReprint;
  const bytes = renderReceipt(receiptData(document), paperWidth);
  return toPrintPayload(
    reprint ? markReprint(bytes) : bytes,
    paperWidth,
    reprint,
  );
}

export function toPrintPayload(
  bytes: Uint8Array,
  paperWidth: PrintPaperWidth,
  reprint: boolean,
): PrintPayload {
  return {
    paperWidth,
    escposBase64: Buffer.from(bytes).toString("base64"),
    reprint,
  };
}

export async function enqueueReceiptOnEdge(
  tx: Tx,
  context: ScopedTenantContext,
  document: ReceiptDocument,
  requestedBy: UserId,
  idempotencyKey: string,
): Promise<void> {
  const runtime = getEdgeRuntimeState();
  // Cloud keeps its existing document-delivery flow. Only the provisioned
  // edge node owns the physical outlet printers.
  if (!runtime.edgeMode) return;
  const identity = runtime.identity;
  if (
    !identity ||
    identity.scope.tenantId !== context.tenant.tenantId ||
    identity.scope.tenantId !== document.tenantId ||
    identity.scope.outletId !== document.outletId
  )
    throw new CoreError(
      "CONFLICT",
      messagesId.deviceRegistry.receiptPrintErrors.wrongOutlet,
    );
  const agent = getEdgePrintAgent();
  if (!agent)
    throw new CoreError(
      "CONFLICT",
      messagesId.deviceRegistry.receiptPrintErrors.agentUnavailable,
    );

  const [printer] = await tx
    .select({ id: edgePrinters.id, paperWidth: edgePrinters.paperWidth })
    .from(edgePrinters)
    .where(
      and(
        eq(edgePrinters.tenantId, context.tenant.tenantId),
        eq(edgePrinters.outletId, document.outletId),
        eq(edgePrinters.role, "receipt"),
        isNull(edgePrinters.retiredAt),
      ),
    )
    .orderBy(asc(edgePrinters.id))
    .limit(1);
  if (!printer) throw new CoreError("NOT_FOUND", "Printer tidak ditemukan.");

  const bytes = renderReceipt(receiptData(document), printer.paperWidth);
  await agent.enqueue(
    {
      printerId: printer.id,
      kind: "receipt",
      content: document.reprint ? markReprint(bytes) : bytes,
      idempotencyKey: `pos_receipt:${document.id}:${idempotencyKey}`,
      sourceRef: document.receiptNumber,
      createdBy: requestedBy,
    },
    tx,
  );
}
