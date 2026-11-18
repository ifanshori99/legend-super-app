// legend-1095 edge fixtures (no tests here): an edge node of a tenant, the real link
// store used to deliver `order.paid` / `order.voided` events, and observers of the
// ledger (edge_order_ingests), the parked events (edge_deferred_events) and the void
// rows. Modelled on single-refund-lane-1042.test.ts and edge-order-ingest.test.ts.

import { randomBytes, randomUUID } from "node:crypto";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import { establishScopedTenantContext, establishTenantContext } from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { registerOrderEdgeApplier } from "../edge/order-edge-applier.ts";
import { registerStockMovedEdgeApplier } from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { owner } from "./floor-test-helpers.ts";

export const EDGE_PAID = 50_000;
export const EDGE_BUSINESS_DATE = "2034-01-02";

type Where = { tenantId: string; outletId: string };

/** Registers the edge appliers like runtime.ts does (call in beforeEach). */
export function registerEdgeAppliers() {
  resetEdgeApplierRegistryForTests();
  registerStockMovedEdgeApplier();
  registerPosDeferredEdgeApplier();
  registerOrderEdgeApplier(); // after the POS registration, as runtime.ts does
  registerEdgeDeferredFallback();
}

export function resetEdge() {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
}

export async function registerNode(where: Where): Promise<AuthenticatedEdgeNode> {
  setAuditWriter(coreAuditWriter);
  const context = establishTenantContext({
    tenantId: tenantIdSchema.parse(where.tenantId),
    brandId: null,
    source: "session",
  });
  const registered = await registerEdgeNode(
    establishScopedTenantContext(context, {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(where.outletId)],
    }),
    randomUUID(),
    {
      outletId: where.outletId,
      role: "primary",
      label: `Utama 1095 ${randomBytes(2).toString("hex")}`,
    },
  );
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  return authenticated;
}

export function edgeKit(
  where: Where,
  node: AuthenticatedEdgeNode,
  people: { requestedBy: string; approvedBy: string; menuItemId?: string },
) {
  let clock = Date.parse("2026-11-18T09:00:00.000Z");
  let numberSeq = 0;
  const short = () => randomUUID().slice(0, 6);

  function envelope(
    name: string,
    orderUlid: string,
    sequence: number,
    payload: Record<string, unknown>,
  ): EventEnvelope {
    clock += 1_000;
    return {
      id: createUlid(clock),
      tenantId: where.tenantId as EventEnvelope["tenantId"],
      outletId: where.outletId as EventEnvelope["outletId"],
      name,
      version: 1,
      aggregateType: "order",
      aggregateId: orderUlid,
      sequence,
      occurredAt: new Date(clock).toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `${name}:${orderUlid}:${sequence}`,
      payloadSchemaRef: `${name}.v1`,
      payload: payload as EventEnvelope["payload"],
    };
  }

  /** `order.paid` of a one-line Rp50.000 cash sale. */
  function paidEvent(orderUlid: string): EventEnvelope {
    numberSeq += 1;
    return envelope("order.paid", orderUlid, 1, {
      orderId: orderUlid,
      outletId: where.outletId,
      businessDate: EDGE_BUSINESS_DATE,
      channel: "pos",
      serviceType: "takeaway",
      orderNumber: `E1095-${String(numberSeq).padStart(5, "0")}-${short()}`,
      subtotalIdr: EDGE_PAID,
      pricesIncludeTax: false,
      paymentMode: "pay_first",
      isTraining: false,
      grossSalesIdr: EDGE_PAID,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      taxes: [],
      roundingIdr: 0,
      totalIdr: EDGE_PAID,
      paidCashIdr: EDGE_PAID,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      paidDepositIdr: 0,
      tenders: [{ method: "cash", amountIdr: EDGE_PAID, receivedIdr: EDGE_PAID }],
      shiftId: null,
      cashierId: people.requestedBy,
      deviceId: randomUUID(),
      paidAt: "2034-01-02T03:04:05.000Z",
      lines: [
        {
          menuItemId: people.menuItemId,
          name: "Latte",
          quantity: 1,
          unitPriceIdr: EDGE_PAID,
          modifiersTotalIdr: 0,
          lineTotalIdr: EDGE_PAID,
          fireStatus: "fired",
          reservedBusinessDate: EDGE_BUSINESS_DATE,
          status: "served",
        },
      ],
    });
  }

  /** `order.voided` of the whole sale. `amountIdr` is the sale total. */
  function voidEvent(
    orderUlid: string,
    sequence = 2,
    amountIdr = EDGE_PAID,
  ): EventEnvelope {
    numberSeq += 1;
    return envelope("order.voided", orderUlid, sequence, {
      orderId: orderUlid,
      outletId: where.outletId,
      businessDate: EDGE_BUSINESS_DATE,
      amountIdr,
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      requestedBy: people.requestedBy,
      approvedBy: people.approvedBy,
      overrideId: createUlid(++clock),
      approvalRequestId: null,
      voidedFinalOrder: true,
      voidId: randomUUID(),
      receiptNumber: `POS1-${String(numberSeq).padStart(6, "0")}`,
      voidedAt: "2034-01-02T04:00:00.000Z",
    });
  }

  /** One receive batch through the real link (the apply transaction). */
  async function deliver(events: EventEnvelope[]) {
    const link = createDbLinkStore({
      database: db,
      context: node.context,
      node: node.scope,
      outboundDirection: "cloud_to_edge",
    });
    const from = await link.lastReceivedInbound();
    await link.applyInbound({
      fromSeq: from,
      toSeq: from + events.length,
      events: events.map((event, index) => ({
        linkSeq: from + index + 1,
        event,
      })),
    });
  }

  async function ingestOf(orderUlid: string) {
    const { rows } = await owner.query<{ state: string; reason: string | null }>(
      "SELECT state, reason FROM edge_order_ingests WHERE tenant_id = $1 AND order_id = $2::uuid",
      [where.tenantId, ulidToUuid(orderUlid as never)],
    );
    return rows[0];
  }

  /** Void rows of the order (cloud and edge voids share the table). */
  async function voidRows(orderUlid: string) {
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2::uuid",
      [where.tenantId, ulidToUuid(orderUlid as never)],
    );
    return rows[0]!.n;
  }

  /** Parked rows of the order's `order.voided` events. */
  async function parkedVoids(orderUlid: string) {
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM edge_deferred_events
        WHERE tenant_id = $1 AND event_name = 'order.voided' AND aggregate_id = $2`,
      [where.tenantId, orderUlid],
    );
    return rows[0]!.n;
  }

  return { paidEvent, voidEvent, deliver, ingestOf, voidRows, parkedVoids };
}
