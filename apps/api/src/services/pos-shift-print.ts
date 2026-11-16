// legend-2lp.4: frozen closing cash and committed attributed sale facts become
// one edge print job. Before the first successful enqueue, an authorized close
// replay may include later committed noncash facts. Once queued, its original
// bytes remain immutable under the deterministic shift key.
// Queue insertion shares the close transaction. The agent consumes it only
// after commit; a print-side failure rolls back its savepoint, never the close.
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { messagesId } from "@starter/shared/i18n";
import { edgePrinters } from "../db/schema/edge-print.ts";
import { outlets } from "../db/schema/platform-org.ts";
import {
  posOrderRefunds,
  posOrders,
  posOrderTenders,
  posOrderVoids,
} from "../db/schema/pos-order.ts";
import { user } from "../db/schema/user.ts";
import { getEdgePrintAgent } from "../edge/print/runtime.ts";
import { renderShiftReport } from "../edge/print/templates.ts";
import type { ShiftReportData } from "../edge/print/types.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { logger } from "../lib/logger.ts";
import type { Tx } from "./permission-resolver.ts";
import type { ShiftRow } from "./pos-shift-support.ts";

const methodLabels = new Map<string, string>(
  Object.entries(messagesId.posReceiptPublic.tender),
);

export async function enqueueClosedShiftReport(
  tx: Tx,
  context: ScopedTenantContext,
  shift: ShiftRow,
  createdBy: string,
): Promise<void> {
  const runtime = getEdgeRuntimeState();
  const agent = getEdgePrintAgent();
  if (
    !runtime.edgeMode ||
    !runtime.identity ||
    !agent ||
    runtime.identity.scope.tenantId !== context.tenant.tenantId ||
    runtime.identity.scope.outletId !== shift.outletId ||
    shift.closedAt === null
  )
    return;

  try {
    await tx.transaction(async (savepoint) => {
      const [printer] = await savepoint
        .select()
        .from(edgePrinters)
        .where(
          and(
            eq(edgePrinters.tenantId, shift.tenantId),
            eq(edgePrinters.outletId, shift.outletId),
            eq(edgePrinters.role, "receipt"),
            isNull(edgePrinters.retiredAt),
          ),
        )
        .orderBy(asc(edgePrinters.id))
        .limit(1);
      if (!printer) return;

      const [outlet] = await savepoint
        .select({ name: outlets.name })
        .from(outlets)
        .where(
          and(
            eq(outlets.tenantId, shift.tenantId),
            eq(outlets.id, shift.outletId),
          ),
        )
        .limit(1);
      const [cashier] = await savepoint
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, shift.cashierId))
        .limit(1);
      if (!outlet || !cashier || !shift.closedAt) return;

      // Cash tenders name the drawer they entered; noncash tenders have no
      // drawer id and belong to the order's originating shift instead.
      const captured = await savepoint
        .select({
          method: posOrderTenders.method,
          count: sql<string>`count(distinct ${posOrderTenders.orderId})::text`,
          amount: sql<string>`coalesce(sum(${posOrderTenders.amountIdr}), 0)::text`,
        })
        .from(posOrderTenders)
        .innerJoin(
          posOrders,
          and(
            eq(posOrders.tenantId, posOrderTenders.tenantId),
            eq(posOrders.outletId, posOrderTenders.outletId),
            eq(posOrders.orderId, posOrderTenders.orderId),
          ),
        )
        .where(
          and(
            eq(posOrderTenders.tenantId, shift.tenantId),
            eq(posOrderTenders.outletId, shift.outletId),
            eq(posOrderTenders.status, "captured"),
            eq(posOrders.isTraining, false),
            or(
              eq(posOrderTenders.shiftId, shift.id),
              and(
                isNull(posOrderTenders.shiftId),
                eq(posOrders.shiftId, shift.id),
              ),
            ),
          ),
        )
        .groupBy(posOrderTenders.method)
        .orderBy(asc(posOrderTenders.method));

      const [refunds] = await savepoint
        .select({
          amount: sql<string>`coalesce(sum(${posOrderRefunds.amountIdr}), 0)::text`,
        })
        .from(posOrderRefunds)
        .innerJoin(
          posOrders,
          and(
            eq(posOrders.tenantId, posOrderRefunds.tenantId),
            eq(posOrders.outletId, posOrderRefunds.outletId),
            eq(posOrders.orderId, posOrderRefunds.orderId),
          ),
        )
        .where(
          and(
            eq(posOrderRefunds.tenantId, shift.tenantId),
            eq(posOrderRefunds.outletId, shift.outletId),
            eq(posOrders.isTraining, false),
            eq(posOrderRefunds.needsApproval, false),
            or(
              eq(posOrderRefunds.shiftId, shift.id),
              and(
                isNull(posOrderRefunds.shiftId),
                eq(posOrders.shiftId, shift.id),
              ),
            ),
          ),
        );
      const [voids] = await savepoint
        .select({
          amount: sql<string>`coalesce(sum(${posOrderVoids.amountIdr}), 0)::text`,
        })
        .from(posOrderVoids)
        .innerJoin(
          posOrders,
          and(
            eq(posOrders.tenantId, posOrderVoids.tenantId),
            eq(posOrders.outletId, posOrderVoids.outletId),
            eq(posOrders.orderId, posOrderVoids.orderId),
          ),
        )
        .where(
          and(
            eq(posOrderVoids.tenantId, shift.tenantId),
            eq(posOrderVoids.outletId, shift.outletId),
            eq(posOrders.isTraining, false),
            eq(posOrderVoids.needsApproval, false),
            or(
              eq(posOrderVoids.shiftId, shift.id),
              and(
                isNull(posOrderVoids.shiftId),
                eq(posOrders.shiftId, shift.id),
              ),
            ),
          ),
        );

      const sales = captured.map((row) => ({
        method: methodLabels.get(row.method) ?? row.method,
        count: Number(row.count),
        amount: Number(row.amount),
      }));
      const report: ShiftReportData = {
        outletName: outlet.name,
        cashierName: cashier.name,
        shiftOpenedAt: shift.openedAt,
        shiftClosedAt: shift.closedAt,
        openingCash: Number(shift.openingFloatIdr),
        expectedCash: Number(shift.expectedIdr),
        countedCash: Number(shift.countedIdr),
        variance: Number(shift.varianceIdr),
        sales,
        totalSales: sales.reduce((total, sale) => total + sale.amount, 0),
        refunds: Number(refunds?.amount ?? 0),
        voids: Number(voids?.amount ?? 0),
        denominations: (shift.counts ?? []).map((line) => ({
          label: new Intl.NumberFormat("id-ID").format(line.denominationIdr),
          count: line.quantity,
          amount: line.denominationIdr * line.quantity,
        })),
      };
      await agent.enqueue(
        {
          printerId: printer.id,
          kind: "shift_report",
          sourceRef: shift.id,
          createdBy,
          idempotencyKey: `shift-report:${shift.id}`,
          content: renderShiftReport(report, printer.paperWidth),
        },
        savepoint,
      );
    });
  } catch {
    // Do not log content or query errors (names and tender references).
    // A failed enqueue needs operator follow-up; no silent duplicate original.
    logger.warn(
      { shiftId: shift.id, outletId: shift.outletId },
      "Shift report enqueue failed; closed shift remains committed",
    );
  }
}
