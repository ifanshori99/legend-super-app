import assert from "node:assert/strict";
import { test } from "node:test";
import * as admin from "../packages/shared/src/payment/admin.ts";
import * as payment from "../packages/shared/src/payment/index.ts";

test("WS-05 admin fixtures satisfy every back-office contract", () => {
  for (const [schema, fixture] of admin.paymentAdminFixtures)
    assert.ok(schema.parse(fixture));
});

test("PAY-04 unallocated funds carry the excess amount and a resolution with approval", () => {
  const [open, resolved] =
    admin.cafeLegendPaymentAdminFixtures.unallocatedFunds;
  // A double payment is the whole paid amount on top of a settled bill.
  assert.equal(open.paidAmountIdr - open.billTotalIdr, open.amountIdr);
  assert.equal(open.status, "open");
  assert.equal(open.resolution, null);
  // Resolved funds name who approved the refund/credit (PAY-04).
  assert.equal(resolved.status, "resolved");
  assert.ok(resolved.resolution);
  assert.ok(resolved.resolvedBy && resolved.resolvedByName);
  assert.equal(
    admin.resolveUnallocatedFundInputSchema.safeParse({
      resolution: "credit",
      note: "",
    }).success,
    false,
  );
  assert.equal(
    admin.resolveUnallocatedFundInputSchema.safeParse({
      resolution: "forgive",
      note: "Tidak ada dasar penyelesaian.",
    }).success,
    false,
  );
});

test("EDC-06 every settlement difference is a reconciliation case with a variance", () => {
  const cases = admin.cafeLegendPaymentAdminFixtures.reconciliationCases;
  assert.ok(cases.length > 0);
  for (const entry of cases) {
    // A case exists only for a difference between booked and received money.
    assert.equal(entry.varianceIdr, entry.receivedIdr - entry.expectedIdr);
    assert.notEqual(entry.varianceIdr, 0);
    if (entry.status === "resolved") {
      assert.ok(entry.resolvedByName);
      assert.ok(entry.note);
    } else {
      assert.equal(entry.resolvedByName, null);
    }
  }
  // Both sources (gateway settlement and EDC batch) reach the case list.
  assert.deepEqual([...new Set(cases.map((entry) => entry.source))].sort(), [
    "edc",
    "gateway",
  ]);
  const summary = admin.reconciliationSummaryFixture;
  assert.equal(
    summary.varianceIdr,
    cases.reduce((sum, entry) => sum + entry.varianceIdr, 0),
  );
});

test("EDC-07 terminals keep two banks active side by side with a cashier default", () => {
  const view = admin.edcCashierDefaultsFixture;
  const activeBanks = view.terminals
    .filter((terminal) => terminal.status === "active")
    .map((terminal) => terminal.bankCode);
  assert.ok(activeBanks.includes("bca"));
  assert.ok(activeBanks.includes("mandiri"));
  for (const cashier of view.cashiers) {
    assert.ok(
      ["edc_card", "edc_qris", "qris_doit"].includes(cashier.defaultMethod),
    );
    // A tender that needs an EDC terminal always names one in the same outlet.
    if (cashier.defaultMethod !== "qris_doit") {
      assert.ok(cashier.terminalId);
      assert.ok(
        view.terminals.some(
          (terminal) =>
            terminal.id === cashier.terminalId && terminal.status === "active",
        ),
      );
    }
  }
});

test("routing is per tenant or outlet and only online methods route", () => {
  const tenantView = admin.paymentRoutingFixture;
  const outletView = admin.paymentRoutingOutletFixture;
  assert.equal(tenantView.scope, "tenant");
  assert.equal(tenantView.outletId, null);
  assert.equal(outletView.scope, "outlet");
  assert.ok(outletView.outletId);
  // The outlet override wins for the same method.
  const tenantPaylater = tenantView.routes.find(
    (route) => route.method === "paylater",
  );
  const outletPaylater = outletView.routes.find(
    (route) => route.method === "paylater",
  );
  assert.equal(tenantPaylater?.enabled, false);
  assert.equal(outletPaylater?.enabled, true);
  // No fallback is invented before a second gateway is active (PRD Failover).
  assert.ok(
    [...tenantView.routes, ...outletView.routes].every(
      (route) => route.fallbackProvider === null,
    ),
  );
  // Cash, EDC, points and vouchers are tenders, never gateway routes.
  for (const method of ["cash", "edc_card", "points", "voucher"]) {
    assert.equal(
      admin.routedPaymentMethodSchema.safeParse(method).success,
      false,
    );
  }
});

test("payment admin inputs never accept a client tenant id (TEN-02)", () => {
  const body = {
    outletId: null,
    provider: "doit",
    fallbackProvider: null,
    enabled: true,
  };
  assert.ok(admin.updatePaymentRouteInputSchema.safeParse(body).success);
  assert.equal(
    admin.updatePaymentRouteInputSchema.safeParse({
      ...body,
      tenantId: payment.intentFixture.tenantId,
    }).success,
    false,
  );
});
