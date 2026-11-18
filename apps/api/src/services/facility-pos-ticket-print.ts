// Prints a paid facility ticket on the outlet's receipt printer through the
// edge Print Agent (936 part D; same route as pos-receipt-edge-print.ts). The
// cloud has no printer: there the call returns null and the cashier shows the
// door credential on screen instead. The queue insert shares the caller's
// transaction, so a rollback cannot leave a printable ticket for a credential
// that was never minted.
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  CoreError,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { messagesId } from "@starter/shared/i18n";
import { edgePrinters } from "../db/schema/edge-print.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import {
  EscPosBuilder,
  formatDateTime,
  markReprint,
  toPrintableAscii,
} from "../edge/print/escpos.ts";
import { getEdgePrintAgent } from "../edge/print/runtime.ts";
import type { PaperWidth } from "../edge/print/types.ts";
import type { Tx } from "./permission-resolver.ts";

export type TicketPrintData = {
  ticketId: string;
  outletId: OutletId;
  facilityName: string;
  areaName: string;
  unitCode: string | null;
  customerName: string;
  startsAt: Date;
  endsAt: Date;
  validFrom: Date;
  validUntil: Date;
  qrToken: string;
  pin: string;
};

function renderTicket(data: TicketPrintData, width: PaperWidth): Uint8Array {
  const b = new EscPosBuilder().init();
  b.align("center").bold(true).line(toPrintableAscii(data.facilityName));
  b.bold(false).line(toPrintableAscii(data.areaName));
  if (data.unitCode) b.line(`Bilik ${toPrintableAscii(data.unitCode)}`);
  b.align("left").divider("-", width);
  b.line(toPrintableAscii(data.customerName));
  b.columns("Mulai", formatDateTime(data.startsAt), width);
  b.columns("Selesai", formatDateTime(data.endsAt), width);
  b.columns("Berlaku dari", formatDateTime(data.validFrom), width);
  b.divider("-", width);
  b.align("center").line("PIN pintu").bold(true).size("double");
  b.line(data.pin);
  b.size("normal").bold(false).divider("-", width);
  b.line(toPrintableAscii(data.qrToken));
  return b.feed(3).cut().bytes();
}

export type TicketPrintOutcome = {
  printedAt: Date | null;
  printerName: string | null;
};

export async function enqueueTicketOnEdge(
  tx: Tx,
  context: ScopedTenantContext,
  data: TicketPrintData,
  input: {
    requestedBy: UserId;
    idempotencyKey: string;
    reprint: boolean;
    at: Date;
  },
): Promise<TicketPrintOutcome> {
  const runtime = getEdgeRuntimeState();
  if (!runtime.edgeMode) return { printedAt: null, printerName: null };
  const identity = runtime.identity;
  if (
    !identity ||
    identity.scope.tenantId !== context.tenant.tenantId ||
    identity.scope.outletId !== data.outletId
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
        eq(edgePrinters.outletId, data.outletId),
        eq(edgePrinters.role, "receipt"),
        isNull(edgePrinters.retiredAt),
      ),
    )
    .orderBy(asc(edgePrinters.id))
    .limit(1);
  if (!printer) throw new CoreError("NOT_FOUND", "Printer tidak ditemukan.");
  const bytes = renderTicket(data, printer.paperWidth);
  await agent.enqueue(
    {
      printerId: printer.id,
      kind: "receipt",
      content: input.reprint ? markReprint(bytes) : bytes,
      idempotencyKey: `facility_ticket:${data.ticketId}:${input.idempotencyKey}`,
      sourceRef: `ticket:${data.ticketId}`.slice(0, 64),
      createdBy: input.requestedBy,
    },
    tx,
  );
  return { printedAt: input.at, printerName: "Printer kasir" };
}
