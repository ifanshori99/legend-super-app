import assert from "node:assert/strict";
import { test } from "node:test";
import * as admin from "../packages/shared/src/payment/admin.ts";
import * as payment from "../packages/shared/src/payment/index.ts";
import { filterUnallocated } from "../apps/web/src/features/ws05-payment-admin/format.ts";

test("WS-05 admin fixtures satisfy every back-office contract", () => {
  for (const [schema, fixture] of admin.paymentAdminFixtures)
    assert.ok(schema.parse(fixture));
});

test("legend-s3ex8 evidence mismatch is an explicit boolean and preserves the resolved status", () => {
  const [, resolved] = admin.cafeLegendPaymentAdminFixtures.unallocatedFunds;
  const changed = {
    ...resolved,
    evidenceMismatch: true,
    paidAmountIdr: 10_000,
  };
  const parsed = admin.unallocatedFundViewSchema.parse(changed);
  assert.equal(parsed.status, "resolved");
  assert.equal(parsed.evidenceMismatch, true);
  assert.equal(parsed.amountIdr, resolved.amountIdr);
  assert.equal(parsed.paidAmountIdr, 10_000);
  assert.equal(
    admin.unallocatedFundViewSchema.safeParse({
      ...resolved,
      evidenceMismatch: false,
    }).success,
    true,
  );
  for (const evidenceMismatch of [undefined, "true", 1, null]) {
    assert.equal(
      admin.unallocatedFundViewSchema.safeParse({
        ...resolved,
        evidenceMismatch,
      }).success,
      false,
    );
  }
});

test("legend-s3ex8 the review filter retains resolved mismatches without making healthy funds actionable", () => {
  const [open, resolved] =
    admin.cafeLegendPaymentAdminFixtures.unallocatedFunds;
  const changed = { ...resolved, evidenceMismatch: true };
  const pendingReview = {
    ...open,
    status: "needs_review",
    evidenceMismatch: true,
  };
  const rows = [open, resolved, changed, pendingReview];
  assert.deepEqual(filterUnallocated(rows, "needs_review"), [
    changed,
    pendingReview,
  ]);
  assert.deepEqual(filterUnallocated(rows, "resolved"), [resolved, changed]);
  assert.deepEqual(filterUnallocated(rows, "open"), [open]);
  assert.deepEqual(filterUnallocated(rows, "all"), rows);
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

test("refund and unallocated money writes require an idempotency key (contracts: idempotent mutations)", () => {
  const paymentIntentId = "8a32e00d-7e43-45b6-9d01-7a92e605c104";
  const refund = { paymentIntentId, amountIdr: 50_000, reason: "Batal." };
  assert.equal(admin.createRefundInputSchema.safeParse(refund).success, false);
  assert.equal(
    admin.createRefundInputSchema.safeParse({
      ...refund,
      idempotencyKey: "refund-7f3a2c19",
    }).success,
    true,
  );
  assert.equal(admin.approveRefundInputSchema.safeParse({}).success, false);
  assert.equal(
    admin.resolveUnallocatedFundInputSchema.safeParse({
      resolution: "credit",
      note: "Kredit tamu.",
    }).success,
    false,
  );
});

test("PAY-04 refunds never exceed the paid amount and the approver is not the requester", () => {
  const { refunds, refundablePayments } = admin.cafeLegendPaymentAdminFixtures;
  for (const payment of refundablePayments) {
    assert.equal(
      payment.refundedAmountIdr + payment.refundableAmountIdr,
      payment.paidAmountIdr,
    );
    const reserved = refunds
      .filter(
        (refund) =>
          refund.paymentIntentId === payment.paymentIntentId &&
          refund.status !== "failed",
      )
      .reduce((sum, refund) => sum + refund.amountIdr, 0);
    assert.equal(reserved, payment.refundedAmountIdr);
  }
  // A fully refunded payment is no longer offered.
  const fullyRefunded = refunds.find(
    (refund) =>
      refund.status === "completed" &&
      refund.amountIdr === refund.paidAmountIdr,
  );
  assert.ok(fullyRefunded);
  assert.ok(
    !refundablePayments.some(
      (payment) => payment.paymentIntentId === fullyRefunded.paymentIntentId,
    ),
  );
  for (const refund of refunds) {
    if (refund.approvedBy !== null)
      assert.notEqual(refund.approvedBy, refund.requestedBy);
    if (refund.status !== "pending")
      assert.equal(refund.viewerCanApprove, false);
  }
  const [first] = refundablePayments;
  assert.equal(
    admin.refundablePaymentSchema.safeParse({
      ...first,
      refundableAmountIdr: first.paidAmountIdr,
    }).success,
    false,
  );
});

test("EDC-06 / PAY-04 derived amounts are checked by the schema", () => {
  const [kase] = admin.cafeLegendPaymentAdminFixtures.reconciliationCases;
  assert.equal(
    admin.reconciliationCaseViewSchema.safeParse({
      ...kase,
      varianceIdr: kase.varianceIdr + 1,
    }).success,
    false,
  );
  // legend-knev: a bill may carry several funds, so one fund is only bounded
  // by what arrived; the per-bill sum is enforced server side.
  const [fund] = admin.cafeLegendPaymentAdminFixtures.unallocatedFunds;
  assert.equal(
    admin.unallocatedFundViewSchema.safeParse({
      ...fund,
      amountIdr: fund.paidAmountIdr + 1,
    }).success,
    false,
  );
});
