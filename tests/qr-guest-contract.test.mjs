// Guest-facing QR order contracts (beads legend-2m4, legend-8sh, legend-woz,
// legend-tz1). Acceptance IDs: ORD-01, ORD-03, ORD-05, ORD-08. PRD v1.7 §3
// "QR Order Pelanggan".
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEndpointPath,
  pathParamNames,
} from "../packages/shared/src/api/endpoint.ts";
import * as qr from "../packages/shared/src/qr-order/index.ts";
import * as sample from "../packages/shared/src/qr-order/sample.ts";

const f = qr.qrOrderFixtures;
const uuid = "00000000-0000-4000-8000-000000000401";

test("ORD-01 the sample QR tokens are well formed and map to distinct tables", () => {
  const tokens = Object.values(sample.qrTokenFixtures);
  assert.equal(new Set(tokens).size, tokens.length);
  for (const token of tokens) {
    assert.ok(qr.signedQrTokenSchema.safeParse(token).success, token);
    assert.ok(sample.qrTokenTableCodes[token], token);
  }
  assert.equal(sample.qrTokenFixtures.indoor, f.tableQr.token);
});

test("ORD-03 the QR menu states that prices exclude tax and service charge", () => {
  const menu = sample.qrMenuFixtures.indoor;
  assert.equal(menu.pricing.pricesIncludeTaxAndService, false);
  assert.equal(menu.pricing.serviceChargeBp, f.zones[0].serviceChargeBp);
  assert.ok(menu.pricing.taxes.length >= 1);
  assert.ok(menu.items.every((item) => item.priceIdr > 0));
  // An outlet that opted into inclusive prices says so; the flag stays a boolean.
  assert.ok(
    qr.qrMenuSchema.safeParse({
      ...menu,
      pricing: {
        ...menu.pricing,
        pricesIncludeTaxAndService: true,
        taxPriceMode: "inclusive",
      },
    }).success,
  );
  assert.equal(
    qr.qrMenuSchema.safeParse({
      ...menu,
      pricing: { ...menu.pricing, pricesIncludeTaxAndService: "yes" },
    }).success,
    false,
  );
});

test("ORD-05 the QR menu carries sold-out items and sold-out modifiers", () => {
  const menu = sample.qrMenuFixtures.indoor;
  const soldOut = menu.items.filter((item) => item.status === "sold_out");
  assert.ok(soldOut.length >= 2);
  assert.ok(
    menu.items.some((item) =>
      item.modifierGroups.some((group) =>
        group.modifiers.some((modifier) => modifier.soldOut),
      ),
    ),
  );
  assert.ok(menu.items.some((item) => item.status === "available"));
});

test("ORD-01 modifier groups keep min/max coherent and items stay orderable", () => {
  const menu = sample.qrMenuFixtures.indoor;
  const required = menu.items.filter((item) =>
    item.modifierGroups.some((group) => group.minSelect > 0),
  );
  assert.ok(required.length > 0);
  for (const item of menu.items)
    for (const group of item.modifierGroups) {
      assert.ok(group.minSelect <= group.maxSelect, item.name);
      assert.ok(group.maxSelect <= group.modifiers.length, item.name);
    }
  const bad = structuredClone(menu.items[0].modifierGroups[0] ?? null);
  if (bad) {
    bad.minSelect = bad.maxSelect + 1;
    assert.equal(qr.qrMenuModifierGroupSchema.safeParse(bad).success, false);
  }
});

test("ORD-01 variant prices drive the item base price and ids stay unique", () => {
  const menu = sample.qrMenuFixtures.indoor;
  const withVariants = menu.items.filter((item) => item.variants.length > 0);
  assert.ok(withVariants.length > 0);
  for (const item of withVariants)
    assert.equal(
      item.priceIdr,
      Math.min(...item.variants.map((v) => v.priceIdr)),
    );
  const ids = menu.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const broken = { ...withVariants[0], priceIdr: withVariants[0].priceIdr + 1 };
  assert.equal(qr.qrMenuItemSchema.safeParse(broken).success, false);
});

test("ORD-01 the menu of a table in an open-bill zone says so", () => {
  const zone = f.zones[2];
  const table = f.tables.find((entry) => entry.code === "P1");
  const menu = sample.buildQrMenu({ table, zone });
  assert.equal(menu.zone.paymentMode, "open_bill");
  assert.equal(menu.zone.minimumSpendIdr, zone.minimumSpendIdr);
  assert.equal(menu.table.code, "P1");
});

test("ORD-01 a menu outside the zone's hours is readable but not orderable", () => {
  const zone = f.zones[0];
  const table = f.tables.find((entry) => entry.code === "A03");
  const night = sample.buildQrMenu({
    table,
    zone,
    at: new Date("2026-11-01T20:00:00.000Z"),
  });
  assert.equal(night.orderingOpen, false);
  assert.ok(night.items.length > 0);
  assert.equal(sample.qrMenuFixtures.indoor.orderingOpen, true);
});

test("ORD-08 the guest failed-item view offers swap and voucher only, no cost", () => {
  const issue = sample.guestOrderIssueFixtures[0];
  assert.deepEqual(Object.keys(issue.options).sort(), ["swap", "voucher"]);
  assert.equal("costIdr" in issue, false);
  assert.equal("reportedBy" in issue, false);
  assert.equal("approvedBy" in issue, false);
  assert.equal(issue.options.voucher.valueIdr, issue.lineTotalIdr);
  const option = issue.options.swap.items[0];
  assert.equal(option.differenceIdr, option.priceIdr - issue.lineTotalIdr);
  assert.equal(
    qr.guestOrderIssueSchema.safeParse({ ...issue, costIdr: 1 }).success,
    false,
  );
  assert.equal(
    qr.guestOrderIssueSchema.safeParse({
      ...issue,
      options: { ...issue.options, manual_refund: { allowed: true } },
    }).success,
    false,
  );
});

test("ORD-02 a guest payment is paid only with paidAt and never carries a client amount", () => {
  const base = {
    id: uuid,
    target: { kind: "bill" },
    method: "qris",
    amountIdr: 52_800,
    guestFeeIdr: 0,
    chargedIdr: 52_800,
    status: "pending",
    qrisPayload: "00020101021226690014ID.CO.QRIS",
    redirectUrl: null,
    vaNumber: null,
    bankCode: null,
    bankName: null,
    expiresAt: "2026-11-01T05:25:00.000Z",
    paidAt: null,
  };
  assert.ok(qr.guestPaymentSchema.safeParse(base).success);
  assert.equal(
    qr.guestPaymentSchema.safeParse({ ...base, status: "paid" }).success,
    false,
  );
  assert.ok(
    qr.guestPaymentSchema.safeParse({
      ...base,
      status: "paid",
      paidAt: "2026-11-01T05:12:00.000Z",
    }).success,
  );
  assert.equal(
    qr.createGuestPaymentInputSchema.safeParse({
      target: { kind: "bill" },
      method: "qris",
      idempotencyKey: "pay-bill-0001-abcdef",
      amountIdr: 1,
    }).success,
    false,
  );
  assert.equal(
    qr.createGuestPaymentInputSchema.safeParse({
      target: { kind: "bill" },
      method: "cash",
      idempotencyKey: "pay-bill-0001-abcdef",
    }).success,
    false,
  );
});

test("ORD-06 the point claim has a deadline while available and fixtures parse", () => {
  assert.ok(qr.pointClaimSchema.safeParse(sample.pointClaimFixture).success);
  assert.equal(
    qr.pointClaimSchema.safeParse({
      ...sample.pointClaimFixture,
      claimableUntil: null,
    }).success,
    false,
  );
});

test("ORD-01 guest endpoints use absolute paths with schemas for every param", () => {
  for (const endpoint of [
    qr.getQrMenu,
    qr.getMenuSuggestions,
    qr.listSessionOrderIssues,
    qr.createGuestPayment,
    qr.getGuestPayment,
    qr.getPointClaim,
    qr.claimSessionPoints,
  ]) {
    assert.ok(endpoint.path.startsWith("/api/"), endpoint.path);
    const names = pathParamNames(endpoint.path);
    assert.deepEqual(
      Object.keys(endpoint.params.shape).sort(),
      [...names].sort(),
      endpoint.id,
    );
  }
  assert.equal(
    buildEndpointPath(qr.getQrMenu.path, {
      qrToken: sample.qrTokenFixtures.indoor,
    }),
    `/api/qr/menu/${encodeURIComponent(sample.qrTokenFixtures.indoor)}`,
  );
});
