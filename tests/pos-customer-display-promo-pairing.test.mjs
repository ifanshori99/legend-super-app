import assert from "node:assert/strict";
import { test } from "node:test";
import * as pos from "../packages/shared/src/pos/index.ts";

const promotion = {
  title: "Promo kopi",
  body: "Nikmati kopi pilihan hari ini.",
  validUntil: "2026-11-30T16:59:59.000Z",
};
const paired = {
  ...pos.cafeLegendPosFixtures.customerDisplayState,
  promotions: [promotion],
  pairingCode: null,
};
const unpaired = {
  ...paired,
  terminalDeviceId: null,
  state: "idle",
  pairingCode: "001234",
  orderId: null,
  orderNumber: null,
  lines: [],
  subtotalIdr: 0,
  discountIdr: 0,
  serviceChargeIdr: 0,
  taxIdr: 0,
  roundingIdr: 0,
  totalIdr: 0,
  depositAppliedIdr: 0,
  remainingIdr: 0,
  qris: null,
  tenders: [],
  changeIdr: null,
};
const accepts = (data) =>
  pos.getCustomerDisplayState.response.safeParse({ data }).success;

test("customer display response carries safe promotion fields", () => {
  assert.deepEqual(
    pos.getCustomerDisplayState.response.parse({ data: paired }).data
      .promotions,
    [promotion],
  );
  const { promotions: omitted, ...withoutPromotions } = paired;
  assert.equal(accepts(withoutPromotions), false);
  assert.deepEqual(omitted, [promotion]);
  for (const extra of [
    { voucherCode: "SECRET" },
    { quota: 10 },
    { internalPriceIdr: 100 },
  ]) {
    assert.equal(
      accepts({ ...paired, promotions: [{ ...promotion, ...extra }] }),
      false,
    );
  }
  assert.equal(
    accepts({
      ...paired,
      promotions: [{ ...promotion, validUntil: "invalid" }],
    }),
    false,
  );
});

test("unpaired display has a six-digit code and no terminal", () => {
  assert.equal(accepts(unpaired), true);
  for (const pairingCode of [null, "12345", "1234567", "12a456", 123456]) {
    assert.equal(accepts({ ...unpaired, pairingCode }), false);
  }
  assert.equal(
    accepts({ ...unpaired, terminalDeviceId: paired.terminalDeviceId }),
    false,
  );
  assert.equal(accepts({ ...paired, pairingCode: "123456" }), false);
  assert.equal(
    accepts({
      ...unpaired,
      terminalDeviceId: paired.terminalDeviceId,
      pairingCode: null,
    }),
    true,
  );
  assert.equal(accepts({ ...paired, terminalDeviceId: null }), false);
  assert.equal(accepts({ ...unpaired, orderNumber: "POS-0001" }), false);
  assert.equal(accepts({ ...unpaired, lines: paired.lines }), false);
  assert.equal(accepts({ ...unpaired, changeIdr: 1 }), false);
});
