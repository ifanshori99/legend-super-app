import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import {
  panicAlertResolvedEdgePayloadSchema,
  panicAlertResolvedEvent,
  wifiQuotaUpdatedEdgePayloadSchema,
  wifiQuotaUpdatedEvent,
} from "@starter/shared/facility";
import {
  qrOrderPlacedEdgePayloadSchema,
  qrOrderPlacedEdgeReceivePayloadSchema,
} from "@starter/shared/qr-order";
import { catalogSyncPageSchema } from "@starter/shared/edge";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { registerQrOrderEdgeApplier } from "../edge/qr-order-applier.ts";
import { registerWifiQuotaEdgeApplier } from "../edge/wifi-quota-applier.ts";
import { registerPanicAlertEdgeApplier } from "../edge/panic-alert-applier.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";

const id = "11111111-1111-4111-8111-111111111111";
const tenantId = tenantIdSchema.parse(id);
const outletId = outletIdSchema.parse("22222222-2222-4222-8222-222222222222");
const at = "2026-11-14T00:00:00.000Z";
const orderId = createUlid();
const qrPayload = {
  order: {
    id: orderId,
    number: "QR-1",
    channel: "qr",
    serviceType: "dine_in",
    tableSessionId: null,
    paymentMode: "pay_first",
    subtotalIdr: 10000,
    discountIdr: 0,
    serviceChargeIdr: 0,
    taxIdr: 0,
    roundingIdr: 0,
    totalIdr: 10000,
    depositAppliedIdr: 0,
    status: "sent",
    businessDate: "2026-11-14",
    taxResult: null,
    note: null,
    placedAt: at,
    firedAt: null,
    createdAt: at,
    updatedAt: at,
  },
  items: [
    {
      id: createUlid(),
      menuItemId: id,
      variantId: null,
      name: "Coffee",
      quantity: 1,
      unitPriceIdr: 10000,
      modifiersTotalIdr: 0,
      lineTotalIdr: 10000,
      modifiers: [],
      note: null,
      course: null,
      fireStatus: "fired",
      status: "queued",
      reservedBusinessDate: "2026-11-14",
      createdAt: at,
      updatedAt: at,
    },
  ],
};
const wifiPayload = {
  customerProfileId: id,
  sessionId: id,
  zoneId: id,
  quotaMinutes: 60,
  usedMinutes: 10,
  speedTier: "full",
  fullSpeedKbps: 10000,
  baseSpeedKbps: 1000,
  sessionEndsAt: at,
  reason: "spend",
};
const panicPayload = {
  alertId: id,
  resolvedBy: id,
  resolvedAt: at,
  resolutionNote: null,
};
const meta: EdgeApplyMeta = {
  edgeNodeId: id,
  direction: "cloud_to_edge",
  kind: "transaction_event",
  context: establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletId] },
  ),
};
function event(
  name: string,
  aggregateId: string,
  payload: unknown,
): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId,
    outletId,
    name,
    version: 1,
    aggregateType: name.split(".")[0],
    aggregateId,
    sequence: 1,
    occurredAt: at,
    actor: { type: "system" },
    idempotencyKey: createUlid(),
    payloadSchemaRef: `${name}.v1`,
    payload,
  });
}
function transaction() {
  const values = vi.fn();
  return {
    values,
    tx: {
      insert: () => ({
        values: (value: unknown) => {
          values(value);
          return {
            onConflictDoNothing: () => ({ returning: async () => [{ id }] }),
          };
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      select: () => ({ from: () => ({ where: async () => [] }) }),
    },
  };
}
afterEach(resetEdgeApplierRegistryForTests);

describe("cloud-to-edge domain compatibility", () => {
  it("strips unknown fields from each edge receive schema", () => {
    expect(
      qrOrderPlacedEdgeReceivePayloadSchema.parse({
        ...qrPayload,
        future: 1,
        order: { ...qrPayload.order, future: 2 },
        items: qrPayload.items.map((item) => ({ ...item, future: 3 })),
      }),
    ).toEqual(qrPayload);
    expect(
      wifiQuotaUpdatedEdgePayloadSchema.parse({ ...wifiPayload, future: 1 }),
    ).toEqual(wifiPayload);
    expect(
      panicAlertResolvedEdgePayloadSchema.parse({ ...panicPayload, future: 1 }),
    ).toEqual(panicPayload);
  });

  it("accepts new QR root, order and item fields without copying them or changing money", async () => {
    registerQrOrderEdgeApplier();
    const { tx, values } = transaction();
    const payload = {
      ...qrPayload,
      future: 1,
      order: { ...qrPayload.order, future: 2 },
      items: qrPayload.items.map((item) => ({ ...item, future: 3 })),
    };
    await expect(
      edgeEventApplier("cloud_to_edge").apply(
        tx,
        event("qr_order.placed", orderId, payload),
        meta,
      ),
    ).resolves.toBeUndefined();
    expect(values.mock.calls[0]?.[0]).toMatchObject({
      totalIdr: 10000,
      discountIdr: 0,
    });
    expect(values.mock.calls[0]?.[0]).not.toHaveProperty("future");
    expect(values.mock.calls[1]?.[0][0]).toMatchObject({
      unitPriceIdr: 10000,
      lineTotalIdr: 10000,
    });
    expect(values.mock.calls[1]?.[0][0]).not.toHaveProperty("future");
  });

  it("accepts new Wi-Fi fields and persists only the known payload for the queue worker", async () => {
    registerWifiQuotaEdgeApplier();
    const { tx, values } = transaction();
    await expect(
      edgeEventApplier("cloud_to_edge").apply(
        tx,
        event("wifi_quota.updated", id, { ...wifiPayload, future: 1 }),
        meta,
      ),
    ).resolves.toBeUndefined();
    expect(values.mock.calls[0]?.[0]).toMatchObject({
      event: { payload: wifiPayload },
    });
    expect(values.mock.calls[0]?.[0].event.payload).not.toHaveProperty(
      "future",
    );
  });

  it("accepts a cloud panic resolution with an added field", async () => {
    registerPanicAlertEdgeApplier();
    const { tx } = transaction();
    await expect(
      edgeEventApplier("cloud_to_edge").apply(
        tx,
        event("panic_alert.resolved", panicPayload.alertId, {
          ...panicPayload,
          future: 1,
        }),
        meta,
      ),
    ).resolves.toBeUndefined();
  });

  it("continues rejecting malformed known fields before any writes", async () => {
    registerQrOrderEdgeApplier();
    registerWifiQuotaEdgeApplier();
    registerPanicAlertEdgeApplier();
    const { tx, values } = transaction();
    for (const [name, aggregateId, payload] of [
      [
        "qr_order.placed",
        orderId,
        { ...qrPayload, order: { ...qrPayload.order, totalIdr: "10000" } },
      ],
      ["wifi_quota.updated", id, { ...wifiPayload, quotaMinutes: "60" }],
      [
        "panic_alert.resolved",
        panicPayload.alertId,
        { ...panicPayload, resolvedAt: "bad" },
      ],
    ] as const) {
      await expect(
        edgeEventApplier("cloud_to_edge").apply(
          tx,
          event(name, aggregateId, payload),
          meta,
        ),
      ).rejects.toThrow();
    }
    expect(values).not.toHaveBeenCalled();
  });

  it("keeps cloud domain schemas strict", () => {
    for (const [schema, payload] of [
      [qrOrderPlacedEdgePayloadSchema, qrPayload],
      [wifiQuotaUpdatedEvent.payloadSchema, wifiPayload],
      [panicAlertResolvedEvent.payloadSchema, panicPayload],
    ] as const) {
      expect(schema.safeParse(payload).success).toBe(true);
      expect(schema.safeParse({ ...payload, future: 1 }).success).toBe(false);
    }
    expect(
      qrOrderPlacedEdgePayloadSchema.safeParse({
        ...qrPayload,
        order: { ...qrPayload.order, future: 1 },
      }).success,
    ).toBe(false);
  });

  it("keeps promotion and voucher edge records strict, including discount restrictions", () => {
    const promotion = {
      id,
      tenantId,
      name: "Promo",
      description: "",
      status: "active",
      voucherRequired: false,
      startsAt: at,
      endsAt: null,
      conditions: [{ kind: "min_spend", amountIdr: 10000 }],
      benefit: { kind: "nominal_off", amountIdr: 1000 },
      stackGroup: "default",
      stackable: false,
      priority: 1,
      quotaTotal: null,
      quotaPerCustomer: null,
      budgetIdr: null,
      spentIdr: 0,
      createdAt: at,
      updatedAt: at,
      codeRef: null,
      outletId,
      outletScope: "all_except",
      usesTotal: 0,
      createdBy: null,
      updatedBy: null,
      syncTxid: "1",
      outletOverrides: [],
      stackingSettings: null,
    };
    const voucher = {
      id,
      tenantId,
      promotionId: id,
      customerProfileId: null,
      source: "promo_code",
      status: "issued",
      valueIdr: 1000,
      validFrom: at,
      validUntil: null,
      issuedAt: at,
      issuedBy: null,
      redeemedAt: null,
      redeemedOrderId: null,
      cancelledReason: null,
      syncTxid: "1",
    };
    const page = (stream: string, record: unknown) => ({
      stream,
      records: [record],
      nextCursor: null,
      hasMore: false,
    });
    for (const [stream, record] of [
      ["promotions", promotion],
      ["vouchers", voucher],
    ] as const) {
      expect(catalogSyncPageSchema.parse(page(stream, record))).toEqual(
        page(stream, record),
      );
      expect(
        catalogSyncPageSchema.safeParse(
          page(stream, { ...record, futureRestriction: 1 }),
        ).success,
      ).toBe(false);
    }
    expect(
      catalogSyncPageSchema.safeParse(
        page("promotions", {
          ...promotion,
          benefit: { ...promotion.benefit, futureRestriction: 1 },
        }),
      ).success,
    ).toBe(false);
    expect(
      catalogSyncPageSchema.safeParse(
        page("promotions", {
          ...promotion,
          conditions: [{ ...promotion.conditions[0], futureRestriction: 1 }],
        }),
      ).success,
    ).toBe(false);
  });
});
