// QR order contract tests (bead legend-6li). Acceptance IDs: ORD-02, ORD-03,
// ORD-04, ORD-06, ORD-08, ORD-09, ORD-10; PRD v1.7 §3 "QR Order Pelanggan",
// §6.C, §6.D.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEndpointPath,
  matchEndpointPath,
  pathParamNames,
} from "../packages/shared/src/api/endpoint.ts";
import { eventCatalog } from "../packages/shared/src/events/index.ts";
import * as qr from "../packages/shared/src/qr-order/index.ts";

const f = qr.qrOrderFixtures;
const uuid = "00000000-0000-4000-8000-000000000401";
const taxRuleId = "00000000-0000-4000-8000-000000007000";

test("ORD-03 Cafe Legend QR order fixtures parse and stay coherent", () => {
  qr.qrOrderFixtureSchema.parse(f);
  assert.equal(f.zones.length, 4);
  assert.equal(f.tables.length, 12);
  assert.equal(f.cart.lines.length, 4);
  assert.equal(f.quotes[0].cartVersion, f.cart.version);
  assert.equal(f.orders[0].items.length, 4);
  assert.equal(f.sessionBills[0].splits.length, 2);
  assert.equal(f.scanResult.session.id, f.sessions[0].id);
  assert.equal(f.floorBoard.tables.length, f.tables.length);
  assert.equal(
    f.floorBoard.tables.find((row) => row.table.code === "A03").session.status,
    "open",
  );
  assert.equal(
    f.floorBoard.tables.find((row) => row.table.code === "A05").session,
    null,
  );
  // The quote and the order are computed from the same cart by the server.
  assert.ok(f.quotes[0].subtotalIdr > 0);
  assert.equal(f.orders[0].totalIdr, f.quotes[1].totalIdr);
});

test("ORD-03 prices, discounts, service, tax and rounding are server-computed", () => {
  const config = {
    serviceChargeBp: 500,
    taxRules: [
      {
        id: taxRuleId,
        name: "PBJT Kota Bandung 10%",
        rateBp: 1000,
        appliesTo: "net_plus_service",
      },
    ],
    roundingIncrementIdr: 100,
    roundingMode: "half_up",
    minimumSpendIdr: 50_000,
  };
  const lines = [
    {
      cartLineId: "00000000-0000-4000-8000-000000000501",
      menuItemId: "00000000-0000-4000-8000-000000001004",
      name: "Kopi Susu Aren",
      quantity: 1,
      unitPriceIdr: 60_000,
      modifiersTotalIdr: 0,
      taxRuleId,
    },
    {
      cartLineId: "00000000-0000-4000-8000-000000000502",
      menuItemId: "00000000-0000-4000-8000-000000001030",
      name: "Nasi Goreng Kampung",
      quantity: 1,
      unitPriceIdr: 40_000,
      modifiersTotalIdr: 0,
      taxRuleId,
    },
  ];
  const quote = qr.computeQuote({
    sessionId: uuid,
    cartVersion: 1,
    lines,
    config,
    discounts: [
      { label: "Promo pembukaan", source: "promo", amountIdr: 10_000 },
    ],
    computedAt: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(quote.subtotalIdr, 100_000);
  assert.equal(quote.discountIdr, 10_000);
  assert.deepEqual(
    quote.lines.map((line) => line.discountIdr),
    [6_000, 4_000],
  );
  assert.equal(quote.serviceCharge.amountIdr, 4_500);
  assert.equal(quote.taxLines[0].baseIdr, 94_500);
  assert.equal(quote.taxIdr, 9_450);
  assert.equal(quote.rounding.adjustmentIdr, 50);
  assert.equal(quote.totalIdr, 104_000);
  assert.equal(quote.minimumSpend.shortfallIdr, 0);

  const short = qr.computeQuote({
    sessionId: uuid,
    cartVersion: 1,
    lines,
    config: { ...config, minimumSpendIdr: 120_000 },
    computedAt: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(short.minimumSpend.shortfallIdr, 20_000);

  const round = (unitPriceIdr) =>
    qr.computeQuote({
      sessionId: uuid,
      cartVersion: 1,
      lines: [
        {
          cartLineId: "00000000-0000-4000-8000-000000000501",
          menuItemId: "00000000-0000-4000-8000-000000001004",
          name: "Uji pembulatan",
          quantity: 1,
          unitPriceIdr,
          modifiersTotalIdr: 0,
          taxRuleId: null,
        },
      ],
      config: {
        serviceChargeBp: 0,
        taxRules: [],
        roundingIncrementIdr: 100,
        roundingMode: "half_up",
        minimumSpendIdr: 0,
      },
      computedAt: "2026-11-01T00:00:00.000Z",
    });
  assert.equal(round(1_050).totalIdr, 1_100);
  assert.equal(round(1_050).rounding.adjustmentIdr, 50);
  assert.equal(round(1_049).totalIdr, 1_000);
  assert.equal(round(1_049).rounding.adjustmentIdr, -49);
});

test("ORD-03 client input cannot carry prices, totals or a tenant", () => {
  assert.equal(qr.quoteInputSchema.safeParse({}).success, true);
  assert.equal(
    qr.quoteInputSchema.safeParse({ promoCode: "HEMAT10" }).success,
    true,
  );
  assert.equal(qr.quoteInputSchema.safeParse({ totalIdr: 1 }).success, false);
  assert.equal(
    qr.quoteInputSchema.safeParse({ lines: [{ unitPriceIdr: 1 }] }).success,
    false,
  );
  const cartInput = {
    menuItemId: uuid,
    quantity: 1,
    modifierIds: [],
    expectedCartVersion: 1,
    idempotencyKey: "cart-add-0001",
  };
  assert.equal(qr.addCartLineInputSchema.safeParse(cartInput).success, true);
  assert.equal(
    qr.addCartLineInputSchema.safeParse({ ...cartInput, unitPriceIdr: 1_000 })
      .success,
    false,
  );
  assert.equal(
    qr.addCartLineInputSchema.safeParse({ ...cartInput, tenantId: uuid })
      .success,
    false,
  );
  // Cart lines and quotes reject tampered arithmetic even when they arrive
  // through a mock or a compromised client.
  assert.equal(
    qr.cartLineSchema.safeParse({
      ...f.cart.lines[0],
      lineTotalIdr: f.cart.lines[0].lineTotalIdr + 1,
    }).success,
    false,
  );
  assert.equal(
    qr.orderQuoteSchema.safeParse({
      ...f.quotes[0],
      totalIdr: f.quotes[0].totalIdr + 1,
    }).success,
    false,
  );
});

test("ORD-06 split bill parts sum exactly to the bill total", () => {
  const total = 100_001;
  const equal = qr.splitBill({ method: "equal", totalIdr: total, parts: 3 });
  assert.equal(
    equal.reduce((sum, part) => sum + part.amountIdr, 0),
    total,
  );
  qr.assertSplitsSumToTotal(equal, total);
  assert.throws(
    () => qr.assertSplitsSumToTotal([{ amountIdr: 1 }], total),
    RangeError,
  );

  const byPerson = qr.splitBill({
    method: "by_person",
    totalIdr: total,
    participantIds: ["p1", "p2", "p3", "p4"],
  });
  assert.equal(
    byPerson.reduce((sum, part) => sum + part.amountIdr, 0),
    total,
  );

  const lines = [
    { orderItemId: "i1", lineTotalIdr: 60_000 },
    { orderItemId: "i2", lineTotalIdr: 40_000 },
  ];
  const byItem = qr.splitBill({
    method: "by_item",
    totalIdr: total,
    lines,
    assignments: [{ orderItemIds: ["i1"] }, { orderItemIds: ["i2"] }],
  });
  assert.equal(
    byItem.reduce((sum, part) => sum + part.amountIdr, 0),
    total,
  );
  assert.throws(
    () =>
      qr.splitBill({
        method: "by_item",
        totalIdr: total,
        lines,
        assignments: [{ orderItemIds: ["i1"] }],
      }),
    RangeError,
  );
  assert.throws(
    () =>
      qr.splitBill({
        method: "by_item",
        totalIdr: total,
        lines,
        assignments: [{ orderItemIds: ["i1", "i2"] }, { orderItemIds: ["i1"] }],
      }),
    RangeError,
  );

  const bill = f.sessionBills[0];
  assert.equal(
    bill.splits.reduce((sum, split) => sum + split.amountIdr, 0),
    bill.totals.totalIdr,
  );
  assert.equal(
    qr.sessionBillSchema.safeParse({
      ...bill,
      splits: bill.splits.map((split) => ({
        ...split,
        amountIdr: split.amountIdr + 1,
      })),
    }).success,
    false,
  );
});

test("ORD-04 closed sessions reject guest actions; the table QR opens a new one", () => {
  const closed = f.sessions.find((session) => session.status === "closed");
  const open = f.sessions.find((session) => session.status === "open");
  assert.throws(() => qr.assertSessionUsable(closed), RangeError);
  assert.doesNotThrow(() => qr.assertSessionUsable(open));
  assert.throws(
    () =>
      qr.planQrOrderPlacement({
        paymentMode: "pay_first",
        sessionStatus: "closed",
        cartLineCount: 1,
      }),
    RangeError,
  );
  assert.throws(
    () => qr.transitionTableSession("closed", "reopen"),
    RangeError,
  );
  assert.equal(qr.transitionTableSession("bill_requested", "reopen"), "open");
});

test("ORD-10 a table cannot close before the bill is settled or a waiter confirms", () => {
  assert.equal(
    qr.canCloseTableSession({
      billOutstandingIdr: 0,
      tableCleaned: true,
      waiterConfirmedEmpty: false,
    }),
    true,
  );
  assert.equal(
    qr.canCloseTableSession({
      billOutstandingIdr: 1,
      tableCleaned: true,
      waiterConfirmedEmpty: false,
    }),
    false,
  );
  assert.equal(
    qr.canCloseTableSession({
      billOutstandingIdr: 1,
      tableCleaned: false,
      waiterConfirmedEmpty: true,
    }),
    true,
  );
  assert.throws(
    () =>
      qr.assertCanCloseTableSession({
        billOutstandingIdr: 1,
        tableCleaned: true,
        waiterConfirmedEmpty: false,
      }),
    RangeError,
  );
  assert.equal(qr.transitionTableSession("open", "close"), "closed");
});

test("pay-first holds the kitchen, open bill fires after waiter confirmation", () => {
  assert.deepEqual(
    qr.planQrOrderPlacement({
      paymentMode: "pay_first",
      sessionStatus: "open",
      cartLineCount: 2,
    }),
    {
      orderStatus: "awaiting_payment",
      kitchenFire: "held_for_payment",
      sessionStatusAfter: "open",
    },
  );
  assert.deepEqual(
    qr.planQrOrderPlacement({
      paymentMode: "open_bill",
      sessionStatus: "open",
      cartLineCount: 2,
    }),
    { orderStatus: "sent", kitchenFire: "fired", sessionStatusAfter: "open" },
  );
  assert.throws(
    () =>
      qr.planQrOrderPlacement({
        paymentMode: "open_bill",
        sessionStatus: "pending_confirmation",
        cartLineCount: 2,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      qr.planQrOrderPlacement({
        paymentMode: "pay_first",
        sessionStatus: "open",
        cartLineCount: 0,
      }),
    RangeError,
  );
  assert.equal(
    qr.planQrOrderPlacement({
      paymentMode: "open_bill",
      sessionStatus: "bill_requested",
      cartLineCount: 1,
    }).sessionStatusAfter,
    "open",
  );
});

test("ORD-02 pay-first orders fire only after a verified payment", () => {
  assert.equal(
    qr.canFireQrOrder({
      paymentMode: "pay_first",
      orderStatus: "awaiting_payment",
      paymentStatus: "paid",
    }),
    true,
  );
  assert.equal(
    qr.canFireQrOrder({
      paymentMode: "pay_first",
      orderStatus: "awaiting_payment",
      paymentStatus: "pending",
    }),
    false,
  );
  assert.equal(
    qr.canFireQrOrder({
      paymentMode: "open_bill",
      orderStatus: "sent",
      paymentStatus: "pending",
    }),
    true,
  );
  assert.equal(
    qr.canFireQrOrder({
      paymentMode: "open_bill",
      orderStatus: "awaiting_payment",
      paymentStatus: "paid",
    }),
    false,
  );
});

test("service requests follow acknowledge/resolve and require the right reason", () => {
  assert.equal(
    qr.transitionServiceRequest("pending", "acknowledge"),
    "acknowledged",
  );
  assert.equal(
    qr.transitionServiceRequest("acknowledged", "resolve"),
    "resolved",
  );
  assert.equal(qr.transitionServiceRequest("pending", "cancel"), "cancelled");
  assert.throws(
    () => qr.transitionServiceRequest("resolved", "resolve"),
    RangeError,
  );
  const input = (patch) => ({ idempotencyKey: "sr-test-0001", ...patch });
  assert.equal(
    qr.createServiceRequestInputSchema.safeParse(
      input({ type: "call_waiter", reason: "utensils" }),
    ).success,
    true,
  );
  assert.equal(
    qr.createServiceRequestInputSchema.safeParse(input({ type: "call_waiter" }))
      .success,
    false,
  );
  assert.equal(
    qr.createServiceRequestInputSchema.safeParse(
      input({ type: "request_bill" }),
    ).success,
    true,
  );
  assert.equal(
    qr.createServiceRequestInputSchema.safeParse(
      input({ type: "request_bill", reason: "utensils" }),
    ).success,
    false,
  );
  assert.equal(
    qr.createServiceRequestInputSchema.safeParse(
      input({ type: "complaint", message: "AC bocor" }),
    ).success,
    true,
  );
  assert.equal(
    qr.createServiceRequestInputSchema.safeParse(input({ type: "complaint" }))
      .success,
    false,
  );
});

test("ORD-08/ORD-09 failed items offer swap or voucher; refunds need approval", () => {
  const issue = f.orderIssues.find((entry) => entry.status === "open");
  assert.equal(
    qr.customerOrderIssueChoiceInputSchema.safeParse({
      choice: "manual_refund",
    }).success,
    false,
  );
  assert.equal(
    qr.customerOrderIssueChoiceInputSchema.safeParse({ choice: "swap" })
      .success,
    false,
  );
  assert.equal(
    qr.customerOrderIssueChoiceInputSchema.safeParse({
      choice: "swap",
      replacementItemId: uuid,
    }).success,
    true,
  );
  assert.equal(
    qr.customerOrderIssueChoiceInputSchema.safeParse({ choice: "voucher" })
      .success,
    true,
  );
  assert.equal(
    qr.staffOrderIssueResolutionInputSchema.safeParse({
      resolution: "manual_refund",
      reason: "Tamu menolak ganti menu dan voucher",
    }).success,
    false,
  );
  assert.equal(
    qr.staffOrderIssueResolutionInputSchema.safeParse({
      resolution: "manual_refund",
      approvalRequestId: uuid,
      reason: "Tamu menolak ganti menu dan voucher",
    }).success,
    true,
  );
  assert.equal(
    qr.orderIssueSchema.safeParse({
      ...issue,
      status: "resolved",
      resolution: "manual_refund",
      resolvedAt: "2026-11-01T05:20:00.000Z",
    }).success,
    false,
  );
  assert.equal(f.orderIssueOptions.manualRefundOfferedToCustomer, false);
  assert.equal(f.orderIssueOptions.swap.allowed, true);
  assert.equal(
    f.orderIssueOptions.voucher.valueIdr,
    f.orders[0].items[1].lineTotalIdr,
  );
});

test("apology vouchers redeem only while issued and unexpired", () => {
  const voucher = f.apologyVouchers[0];
  assert.equal(qr.canRedeemVoucher(voucher, "2026-11-15T00:00:00.000Z"), true);
  assert.equal(qr.canRedeemVoucher(voucher, "2026-12-03T00:00:00.000Z"), false);
  assert.equal(
    qr.canRedeemVoucher(
      { status: "redeemed", expiresAt: voucher.expiresAt },
      "2026-11-15T00:00:00.000Z",
    ),
    false,
  );
  assert.equal(
    qr.apologyVoucherSchema.safeParse({ ...voucher, valueIdr: 0 }).success,
    false,
  );
  assert.equal(
    qr.apologyVoucherSchema.safeParse({ ...voucher, status: "redeemed" })
      .success,
    false,
  );
});

test("post-meal review drives the Google CTA from the rating", () => {
  assert.equal(qr.googleReviewPromptFor(5), true);
  assert.equal(qr.googleReviewPromptFor(4), true);
  assert.equal(qr.googleReviewPromptFor(3), false);
  assert.equal(
    qr.tableReviewSchema.safeParse({ ...f.reviews[0], rating: 3 }).success,
    false,
  );
  assert.equal(
    qr.tableReviewSchema.safeParse({ ...f.reviews[0], googleReviewUrl: null })
      .success,
    false,
  );
  assert.equal(
    qr.submitReviewInputSchema.safeParse({ rating: 6 }).success,
    false,
  );
  assert.equal(
    qr.submitReviewInputSchema.safeParse({ rating: 4, comment: "Enak" })
      .success,
    true,
  );
});

test("events are registered in the WS-00 catalog and payloads validate", () => {
  const names = eventCatalog.map((entry) => entry.name);
  for (const entry of qr.qrOrderEventCatalogEntries) {
    assert.ok(names.includes(entry.name), entry.name);
    assert.equal(entry.workstream, "WS-03");
  }
  assert.ok(names.includes("order.paid"));
  qr.tableSessionOpenedPayloadSchema.parse({
    sessionId: f.sessions[0].id,
    tableId: f.tables[2].id,
    zoneId: f.zones[0].id,
    pax: 4,
    paymentMode: "pay_first",
    openedBy: "guest",
    participantId: f.participants[0].id,
  });
  qr.tableSessionClosedPayloadSchema.parse({
    sessionId: f.sessions[3].id,
    tableId: f.tables[4].id,
    reason: "paid_and_cleaned",
    billTotalIdr: 150_000,
    paidIdr: 150_000,
    orderCount: 1,
    closedBy: "staff",
  });
  qr.orderPlacedPayloadSchema.parse({
    orderId: f.orders[0].id,
    sessionId: f.sessions[1].id,
    channel: "qr",
    itemCount: 4,
    totalIdr: f.orders[0].totalIdr,
    paymentMode: "open_bill",
    status: "sent",
  });
  // order.paid is WS-04's event; this contract must not redefine it.
  assert.equal(qr.orderPaidPayloadSchema, undefined);
  assert.equal(qr.qrOrderEventNames.includes("order.paid"), false);
  const failed = {
    orderId: f.orders[0].id,
    orderItemId: f.orders[0].items[1].id,
    orderIssueId: f.orderIssues[0].id,
    type: "unfulfillable",
    reason: "Bahan habis mendadak",
    offeredResolutions: ["swap", "voucher"],
  };
  qr.itemFailedPayloadSchema.parse(failed);
  assert.equal(
    qr.itemFailedPayloadSchema.safeParse({
      ...failed,
      offeredResolutions: ["swap", "manual_refund"],
    }).success,
    false,
  );
  qr.serviceRequestCreatedPayloadSchema.parse({
    serviceRequestId: f.serviceRequests[0].id,
    sessionId: f.sessions[0].id,
    tableId: f.tables[2].id,
    zoneId: f.zones[0].id,
    type: "call_waiter",
    reason: "utensils",
  });
});

test("endpoint contracts are unique, typed and path-param complete", () => {
  const endpoints = Object.values(qr).filter(
    (value) =>
      value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.method === "string" &&
      typeof value.path === "string" &&
      value.id === `${value.method} ${value.path}`,
  );
  assert.ok(endpoints.length >= 24, `found ${endpoints.length} endpoints`);
  const ids = endpoints.map((endpoint) => endpoint.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const endpoint of endpoints) {
    assert.ok(endpoint.path.startsWith("/"), endpoint.id);
    const names = pathParamNames(endpoint.path);
    if (names.length > 0) assert.ok(endpoint.params, endpoint.id);
    for (const name of names)
      assert.ok(
        Object.hasOwn(endpoint.params.shape, name),
        `${endpoint.id} declares no schema for :${name}`,
      );
    if (endpoint.method === "GET") assert.equal(endpoint.body, undefined);
  }
  const sessionPath = buildEndpointPath(qr.getSessionBill.path, {
    sessionId: uuid,
  });
  assert.equal(sessionPath, `/api/table-sessions/${uuid}/bill`);
  assert.deepEqual(matchEndpointPath(qr.getSessionBill.path, sessionPath), {
    sessionId: uuid,
  });
});

test("scan input and DTOs never expose QR or session token hashes", () => {
  assert.equal("qrTokenHash" in f.tables[0], false);
  assert.equal("sessionTokenHash" in f.sessions[0], false);
  assert.equal(
    qr.tableSchema.safeParse({
      ...f.tables[0],
      qrTokenHash: "a".repeat(64),
    }).success,
    false,
  );
  assert.equal(
    qr.tableSessionSchema.safeParse({
      ...f.sessions[0],
      sessionTokenHash: "a".repeat(64),
    }).success,
    false,
  );
  const scanInput = {
    qrToken: f.tableQr.token,
    pax: 2,
    deviceHash: "device-new-guest",
  };
  assert.equal(qr.qrScanInputSchema.safeParse(scanInput).success, true);
  assert.equal(
    qr.qrScanInputSchema.safeParse({ ...scanInput, tenantId: uuid }).success,
    false,
  );
});

test("ORD-03/ORD-04 composite views reject cross-session references", () => {
  const view = {
    session: f.sessions[0],
    cart: f.cart,
    quote: f.quotes[0],
    orders: [],
    openServiceRequests: [f.serviceRequests[0]],
  };
  assert.equal(qr.tableSessionViewSchema.safeParse(view).success, true);
  assert.equal(
    qr.tableSessionViewSchema.safeParse({
      ...view,
      quote: f.quotes[1],
    }).success,
    false,
  );

  const placement = {
    order: f.orders[0],
    quote: f.quotes[1],
    session: f.sessions[1],
    kitchenFire: "fired",
  };
  assert.equal(qr.placeOrderResultSchema.safeParse(placement).success, true);
  assert.equal(
    qr.placeOrderResultSchema.safeParse({
      ...placement,
      order: { ...f.orders[0], totalIdr: f.orders[0].totalIdr + 1 },
    }).success,
    false,
  );

  assert.equal(
    qr.qrScanResultSchema.safeParse({
      ...f.scanResult,
      table: f.tables[0],
    }).success,
    false,
  );

  assert.equal(
    qr.tableSessionSchema.safeParse({
      ...f.sessions[0],
      status: "pending_confirmation",
    }).success,
    false,
  );

  assert.equal(
    qr.tableLiveStatusSchema.safeParse({
      table: f.tables[0],
      session: null,
      openServiceRequestCount: 0,
      outstandingIdr: 1_000,
    }).success,
    false,
  );
});

test("WS-03 owns order.placed (QR) via defineDomainEvent; order.submitted stays WS-04", () => {
  const byName = new Map(eventCatalog.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("order.placed").workstream, "WS-03");
  assert.equal(byName.get("order.submitted").workstream, "WS-04");
  assert.equal(byName.get("order.paid").workstream, "WS-04");
  for (const name of qr.qrOrderEventNames) {
    const event = qr.qrOrderEvents[name];
    assert.equal(event.name, name);
    assert.equal(event.payloadSchemaRef, `${name}.v1`);
    assert.equal(event.entry.workstream, "WS-03");
  }
  assert.deepEqual(
    qr.qrOrderEventCatalogEntries.map((entry) => entry.name),
    [...qr.qrOrderEventNames],
  );
});

test("ORD-06 split sets sum per order or per session, never mixed", () => {
  const bill = f.sessionBills[0];
  // Fixture splits are per order (pay-first style checkout of one order).
  assert.ok(bill.splits.every((split) => split.orderId !== null));
  assert.equal(qr.sessionBillSchema.safeParse(bill).success, true);
  // A session-level set alongside per-order splits is rejected.
  const sessionLevel = bill.splits.map((split, index) => ({
    ...split,
    id: split.id.replace(/.$/, String(index + 5)),
    orderId: null,
  }));
  assert.equal(
    qr.sessionBillSchema.safeParse({
      ...bill,
      splits: [...bill.splits, ...sessionLevel],
    }).success,
    false,
  );
  // Session-level splits alone must sum to the bill total.
  assert.equal(
    qr.sessionBillSchema.safeParse({ ...bill, splits: sessionLevel }).success,
    true,
  );
  // Duplicate share index in one set is rejected.
  assert.equal(
    qr.sessionBillSchema.safeParse({
      ...bill,
      splits: bill.splits.map((split) => ({ ...split, shareIndex: 0 })),
    }).success,
    false,
  );
  // Splits pointing at an order outside the bill are rejected.
  assert.equal(
    qr.sessionBillSchema.safeParse({
      ...bill,
      splits: bill.splits.map((split) => ({
        ...split,
        orderId: "01JC0QRZZZZZZZZZZZZZZZZZZZ",
      })),
    }).success,
    false,
  );
  // Remainder: 100_001 over 3 parts places the extra rupiah on the first part.
  const parts = qr.splitBill({ method: "equal", totalIdr: 100_001, parts: 3 });
  assert.deepEqual(
    parts.map((part) => part.amountIdr),
    [33_334, 33_334, 33_333],
  );
});

test("ORD-04 QR token ids are cross-checked against the host tenant and table row (TEN-02)", () => {
  const payload = f.qrTokenPayload;
  const table = f.tables.find((row) => row.id === payload.tableId);
  assert.ok(table);
  qr.assertQrTokenMatchesTable(payload, payload.tenantId, table);
  const otherTenant = "0190b8c4-0000-7000-8000-00000000ffff";
  for (const [tenant, row] of [
    [otherTenant, table],
    [payload.tenantId, null],
    [payload.tenantId, { ...table, status: "inactive" }],
    [payload.tenantId, { ...table, outletId: otherTenant }],
    [payload.tenantId, { ...table, id: otherTenant }],
  ]) {
    assert.throws(
      () => qr.assertQrTokenMatchesTable(payload, tenant, row),
      (error) => error.code === "NOT_FOUND",
    );
  }
  // The guest session token is opaque, expires, and never names a closed session.
  const scan = f.scanResult;
  assert.ok(scan, "scan fixture");
  assert.equal(
    qr.qrScanResultSchema.safeParse({
      ...scan,
      sessionToken: "v1.e30.not-opaque!",
    }).success,
    false,
  );
  assert.equal(
    qr.qrScanResultSchema.safeParse({
      ...scan,
      sessionTokenExpiresAt: scan.serverTime,
    }).success,
    false,
  );
});
