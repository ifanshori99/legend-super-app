// WS-08 CRM contract tests (bead legend-zk25).
// PRD v1.7 §3 F17/F18, §3.20 Loyalty & Membership, §3.21 CRM/Promo/Campaigns,
// §6.G tables, and acceptance criteria LOY-01..04. Conventions: §6 (money
// BIGINT rupiah as *_idr, UUID ids, ULID for operational ledger rows) and
// docs/plan/contracts.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as crm from "../packages/shared/src/crm/index.ts";
import { eventCatalog } from "../packages/shared/src/events/index.ts";
import { pathParamNames } from "../packages/shared/src/api/index.ts";
import { cafeLegendFixtures } from "../packages/shared/src/core/index.ts";

const f = crm.cafeLegendCrmFixtures;
const [sari, , rina, agus, maya, dimas] = f.profiles;
const AT = "2026-11-01T00:00:00.000Z";

const ledgerFor = (profileId) =>
  f.ledgerEntries.filter((entry) => entry.customerProfileId === profileId);

// ---- Fixtures -------------------------------------------------------------

test("WS-08 CRM fixtures parse against every schema (PRD §6.G)", () => {
  for (const [schema, fixture] of crm.crmSchemaFixtures)
    assert.ok(schema.parse(fixture));
  assert.equal(f.profiles.length, 6);
  assert.ok(f.ledgerEntries.length >= 15);
  assert.ok(f.promotions.length >= 10);
  assert.ok(f.vouchers.length >= 5);
  assert.ok(f.campaignSends.length >= 5);
  for (const collection of [
    f.profiles,
    f.consents,
    f.ledgerEntries,
    f.rewards,
    f.redemptions,
    f.missions,
    f.referrals,
    f.promotions,
    f.vouchers,
    f.segments,
    f.campaigns,
    f.feedback,
  ]) {
    const ids = collection.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test("Cafe Legend fixtures keep tenant and outlet scope (TEN-01)", () => {
  for (const profile of f.profiles)
    assert.equal(profile.tenantId, cafeLegendFixtures.tenant.id);
  for (const promotion of f.promotions)
    assert.equal(promotion.tenantId, cafeLegendFixtures.tenant.id);
  for (const entry of f.feedback)
    assert.equal(entry.outletId, cafeLegendFixtures.outlets[0].id);
  for (const row of f.promotionOutlets)
    assert.equal(row.outletId, cafeLegendFixtures.outlets[0].id);
});

test("member profile DTO never exposes the WhatsApp hash (PRD F3, §6.G.18)", () => {
  for (const dto of f.profileDtos) {
    assert.equal(Object.hasOwn(dto, "whatsappHash"), false);
    assert.equal(crm.customerProfileDtoSchema.safeParse(dto).success, true);
  }
  assert.equal(f.profiles[0].whatsappHash.length, 64);
});

test("member overview carries tier progress and versioned consents (PRD §3.20)", () => {
  const overview = f.memberOverview;
  assert.equal(Object.hasOwn(overview.profile, "whatsappHash"), false);
  assert.equal(overview.currentTier.id, f.profiles[0].tierId);
  assert.equal(overview.nextTier, null); // Platinum is the highest tier
  assert.equal(overview.tierProgressBp, 10_000);
  assert.equal(overview.rollingSpendIdr, overview.profile.lifetimeSpendIdr);
  assert.ok(overview.consents.length > 0);
  assert.equal(
    crm.memberOverviewSchema.safeParse({ ...overview, tierProgressBp: 10_001 })
      .success,
    false,
  );
});

test("member visits and favorites are read-only, newest first (PRD §3.20)", () => {
  const visits = f.memberVisits;
  const favorites = f.memberFavorites;
  for (let index = 1; index < visits.length; index += 1)
    assert.ok(
      Date.parse(visits[index - 1].visitedAt) >=
        Date.parse(visits[index].visitedAt),
      "visits are newest first",
    );
  for (let index = 1; index < favorites.length; index += 1)
    assert.ok(favorites[index - 1].quantity >= favorites[index].quantity);
  assert.equal(
    crm.customerVisitSchema.safeParse({ ...visits[0], spendIdr: -1 }).success,
    false,
  );
  assert.equal(crm.listMemberVisits.body, undefined);
  assert.equal(crm.listMemberFavorites.body, undefined);
});

// ---- LOY-01 ---------------------------------------------------------------

test("LOY-01 ledger is append-only and the balance always equals its sum", () => {
  for (const profile of f.profiles) {
    const entries = ledgerFor(profile.id);
    assert.equal(
      crm.ledgerMatchesBalance(profile, entries),
      true,
      `${profile.name}: ${profile.pointsBalance}`,
    );
    assert.equal(crm.pointBalanceFromLedger(entries), profile.pointsBalance);
    assert.ok(profile.pointsBalance >= 0);
  }
  assert.equal(crm.pointBalanceFromLedger([]), 0);
  assert.equal(f.profiles[3].pointsBalance, 0); // pending verification, no rows
});

test("LOY-01 ledger signs and sources are enforced per row type", () => {
  const earn = f.ledgerEntries[0];
  const cases = [
    { ...earn, type: "redeem" },
    { ...earn, points: -100 },
    { ...earn, sourceType: "refund" },
    { ...earn, expiresAt: null },
    { ...earn, liabilityIdr: -1 },
    { ...f.ledgerEntries[7], type: "reverse", sourceType: "order" },
    { ...f.ledgerEntries[14], reason: null },
    { ...f.ledgerEntries[14], points: 0 },
  ];
  for (const candidate of cases)
    assert.equal(
      crm.pointLedgerEntrySchema.safeParse(candidate).success,
      false,
      JSON.stringify(candidate),
    );
});

test("LOY-01 LOY-02 earn, redeem and reverse rows name their source once", () => {
  const earn = f.ledgerEntries[0];
  assert.equal(
    crm.pointLedgerEntrySchema.safeParse({ ...earn, sourceId: null }).success,
    false,
  );
  const key = crm.pointLedgerDedupeKey(earn);
  assert.equal(key, `${earn.tenantId}:earn:order:${earn.sourceId}`);
  // A replayed payment produces the same key, so the unique index rejects it.
  assert.equal(crm.pointLedgerDedupeKey({ ...earn }), key);
  assert.notEqual(
    crm.pointLedgerDedupeKey({
      ...earn,
      type: "reverse",
      sourceType: "refund",
    }),
    key,
  );
  const expiry = f.ledgerEntries.find((entry) => entry.type === "expire");
  assert.equal(crm.pointLedgerDedupeKey(expiry), null);
});

// ---- LOY-02 ---------------------------------------------------------------

test("LOY-02 points book only after payment and reverse on refund", () => {
  assert.equal(
    crm.transitionPointEarn("pending_payment", "payment_paid"),
    "booked",
  );
  assert.equal(crm.transitionPointEarn("booked", "order_refunded"), "reversed");
  assert.throws(() =>
    crm.transitionPointEarn("pending_payment", "order_refunded"),
  );
  assert.throws(() => crm.transitionPointEarn("reversed", "order_refunded"));
  assert.throws(() => crm.transitionPointEarn("reversed", "payment_paid"));
});

test("LOY-02 earn basis is after discount, before tax and service (PRD §3.20)", () => {
  // Rp10.000 = 1 point; multipliers are Gold 1.5x and Platinum 2x.
  assert.equal(crm.pointsForSpend(f.program, 240_000), 24);
  assert.equal(crm.pointsForSpend(f.program, 240_000, 15_000), 36);
  assert.equal(crm.pointsForSpend(f.program, 240_000, 20_000), 48);
  assert.equal(crm.pointsForSpend(f.program, 9_999), 0);
  assert.throws(() => crm.pointsForSpend(f.program, -1));
  assert.equal(crm.liabilityIdrForPoints(f.program, 240), 24_000);
  assert.equal(crm.liabilityIdrForPoints(f.program, -240), -24_000);
});

// ---- LOY-03 ---------------------------------------------------------------

test("LOY-03 reward redemption is atomic and single-use", () => {
  const reward = f.rewards[0];
  const input = {
    isActive: reward.isActive,
    stock: reward.stock,
    validFrom: reward.validFrom,
    validUntil: reward.validUntil,
    pointsCost: reward.pointsCost,
    pointsBalance: sari.pointsBalance,
    existingRedemptions: 0,
    perCustomerLimit: 1,
    at: AT,
  };
  assert.deepEqual(crm.rewardRedemptionCheck(input), { ok: true });
  assert.deepEqual(crm.rewardRedemptionCheck({ ...input, stock: 0 }), {
    ok: false,
    reason: "out_of_stock",
  });
  assert.deepEqual(crm.rewardRedemptionCheck({ ...input, pointsBalance: 10 }), {
    ok: false,
    reason: "insufficient_points",
  });
  assert.deepEqual(
    crm.rewardRedemptionCheck({ ...input, at: "2027-01-01T00:00:00.000Z" }),
    { ok: false, reason: "expired" },
  );
  assert.deepEqual(
    crm.rewardRedemptionCheck({ ...input, existingRedemptions: 1 }),
    { ok: false, reason: "limit_reached" },
  );
  assert.deepEqual(crm.rewardRedemptionCheck({ ...input, isActive: false }), {
    ok: false,
    reason: "reward_inactive",
  });
  assert.equal(crm.canTransitionRedemption("pending", "fulfilled"), true);
  assert.equal(crm.canTransitionRedemption("fulfilled", "cancelled"), false);
  assert.equal(
    crm.rewardRedemptionSchema.safeParse({
      ...f.redemptions[1],
      status: "fulfilled",
    }).success,
    false,
  );
  // Redemption codes and idempotency keys are unique; the service adds the
  // database constraints that make the concurrent double-redeem impossible.
  const codes = f.redemptions.map((row) => row.redemptionCode);
  assert.equal(new Set(codes).size, codes.length);
  const keys = f.redemptions.map((row) => row.idempotencyKey);
  assert.equal(new Set(keys).size, keys.length);
});

test("LOY-03 reward types carry only their own fields", () => {
  assert.equal(
    crm.rewardSchema.safeParse({ ...f.rewards[0], voucherValueIdr: 10_000 })
      .success,
    false,
  );
  assert.equal(
    crm.rewardSchema.safeParse({
      ...f.rewards[2],
      menuItemId: f.menuItems.kopiSusuAren,
    }).success,
    false,
  );
  assert.equal(
    crm.rewardSchema.safeParse({
      ...f.rewards[0],
      validUntil: "2026-09-01T00:00:00.000Z",
    }).success,
    false,
  );
});

// ---- LOY-04 ---------------------------------------------------------------

test("LOY-04 marketing consent gates every campaign send", () => {
  assert.equal(
    crm.isMarketingEligible(sari, crm.consentsFor(sari.id), AT),
    true,
  );
  assert.equal(
    crm.isMarketingEligible(rina, crm.consentsFor(rina.id), AT),
    false,
  );
  assert.equal(
    crm.isMarketingEligible(dimas, crm.consentsFor(dimas.id), AT),
    false,
  );
  assert.deepEqual(
    crm.campaignSendDecision(sari, crm.consentsFor(sari.id), AT),
    {
      eligible: true,
    },
  );
  assert.deepEqual(
    crm.campaignSendDecision(rina, crm.consentsFor(rina.id), AT),
    {
      eligible: false,
      reason: "no_marketing_consent",
    },
  );
  assert.deepEqual(
    crm.campaignSendDecision(dimas, crm.consentsFor(dimas.id), AT),
    {
      eligible: false,
      reason: "membership_inactive",
    },
  );
  // Sari withdrew the AI consent but never the marketing one.
  assert.equal(
    crm.hasActiveConsent(
      crm.consentsFor(sari.id),
      "ai",
      "2026-06-01T00:00:00.000Z",
    ),
    false,
  );
  assert.equal(
    crm.hasActiveConsent(crm.consentsFor(sari.id), "marketing", AT),
    true,
  );
});

test("LOY-04 skipped sends are recorded without a sent time", () => {
  const skipped = f.campaignSends.find(
    (send) => send.status === "skipped_no_consent",
  );
  assert.ok(skipped);
  assert.equal(skipped.sentAt, null);
  assert.equal(
    crm.campaignSendSchema.safeParse({
      ...skipped,
      sentAt: "2026-10-24T02:01:00.000Z",
    }).success,
    false,
  );
  assert.equal(
    crm.campaignSendSchema.safeParse({
      ...f.campaignSends[0],
      status: "failed",
    }).success,
    false,
  );
});

// ---- Membership and tiers -------------------------------------------------

test("membership needs a verified WhatsApp number and loyalty consent (PRD §3.20)", () => {
  assert.deepEqual(
    crm.membershipBlockers(sari, crm.consentsFor(sari.id), AT),
    [],
  );
  assert.deepEqual(crm.membershipBlockers(agus, [], AT), [
    "whatsapp_unverified",
    "loyalty_consent_missing",
    "not_active",
  ]);
  assert.deepEqual(
    crm.membershipBlockers(dimas, crm.consentsFor(dimas.id), AT),
    ["not_active"],
  );
  assert.equal(crm.isMemberActive(sari, crm.consentsFor(sari.id), AT), true);
  assert.equal(crm.isMemberActive(agus, [], AT), false);
  assert.equal(
    crm.customerProfileSchema.safeParse({
      ...f.profiles[0],
      whatsappVerifiedAt: null,
    }).success,
    false,
  );
});

test("tiers qualify on rolling spend OR visits, highest rank wins (PRD §3.20)", () => {
  assert.equal(
    crm.evaluateTier(f.tiers, { rollingSpendIdr: 0, rollingVisits: 0 }).name,
    "Silver",
  );
  assert.equal(
    crm.evaluateTier(f.tiers, { rollingSpendIdr: 3_000_000, rollingVisits: 3 })
      .name,
    "Gold",
  );
  assert.equal(
    crm.evaluateTier(f.tiers, { rollingSpendIdr: 1_000_000, rollingVisits: 13 })
      .name,
    "Gold",
  );
  assert.equal(
    crm.evaluateTier(f.tiers, { rollingSpendIdr: 9_000_000, rollingVisits: 31 })
      .name,
    "Platinum",
  );
  assert.equal(
    crm.evaluateTier([{ ...f.tiers[0], isActive: false }], {
      rollingSpendIdr: 0,
      rollingVisits: 0,
    }),
    null,
  );
  assert.equal(
    crm.tierProgressBp(
      { rollingSpendIdr: 1_250_000, rollingVisits: 6 },
      f.tiers[1],
    ),
    5_000,
  );
  assert.equal(
    crm.tierProgressBp({ rollingSpendIdr: 9_450_000, rollingVisits: 34 }, null),
    10_000,
  );
});

// ---- Promo engine ---------------------------------------------------------

const line = (menuItemId, quantity, unitPriceIdr) => ({
  menuItemId,
  quantity,
  unitPriceIdr,
  lineTotalIdr: quantity * unitPriceIdr,
});
const promoContext = (overrides = {}) => ({
  at: "2026-11-02T10:00:00.000Z", // Monday
  channel: "dine_in",
  localDayOfWeek: 1,
  localTime: "16:00",
  subtotalIdr: 230_000,
  lines: [
    line(f.menuItems.kopiSusuAren, 2, 28_000),
    line(f.menuItems.croissantMentega, 1, 24_000),
    line(f.menuItems.americano, 5, 30_000),
  ],
  customer: {
    customerProfileId: sari.id,
    tierId: f.tiers[1].id,
    isMember: true,
  },
  voucherPromotionId: null,
  ...overrides,
});
const promotion = (name) => {
  const found = f.promotions.find((row) => row.name === name);
  assert.ok(found, name);
  return found;
};
const evaluate = (name, overrides = {}, usage) =>
  crm.evaluatePromotion(promotion(name), promoContext(overrides), usage);

test("promo DSL covers percent, nominal, BXGY, bundle, happy hour, member, channel, min spend and facility reward (PRD §3.21)", () => {
  const percent = evaluate("Diskon 10% Semua Menu");
  assert.equal(percent.applied, true);
  assert.equal(percent.discountIdr, 23_000);

  const capped = evaluate("Diskon 10% Semua Menu", { subtotalIdr: 400_000 });
  assert.equal(capped.discountIdr, 25_000);

  const nominal = evaluate("Potongan Rp15.000 Dine-in");
  assert.equal(nominal.discountIdr, 15_000);
  assert.deepEqual(
    evaluate("Potongan Rp15.000 Dine-in", { channel: "takeaway" }),
    {
      applied: false,
      promotionId: promotion("Potongan Rp15.000 Dine-in").id,
      reason: "channel_mismatch",
    },
  );
  assert.equal(
    evaluate("Potongan Rp15.000 Dine-in", { subtotalIdr: 100_000 }).reason,
    "min_spend_not_met",
  );

  const bxgy = evaluate("Beli 2 Kopi Gratis Croissant");
  assert.equal(bxgy.applied, true);
  assert.deepEqual(bxgy.freeItems, [
    { menuItemId: f.menuItems.croissantMentega, quantity: 1 },
  ]);
  assert.equal(bxgy.discountIdr, 24_000);

  // One complete bundle (2 kopi, 1 croissant): 28.000 + 24.000 - 45.000; the
  // second kopi stays at full price.
  const bundle = evaluate("Paket Kopi + Croissant Rp45.000");
  assert.equal(bundle.discountIdr, 7_000);

  const happyHour = evaluate("Happy Hour 20%");
  assert.equal(happyHour.discountIdr, 20_000); // 46.000 capped at 20.000
  assert.equal(
    evaluate("Happy Hour 20%", { localTime: "19:00" }).reason,
    "time_window_mismatch",
  );
  assert.equal(
    evaluate("Happy Hour 20%", { localDayOfWeek: 0 }).reason,
    "time_window_mismatch",
  );
  assert.equal(
    evaluate("Happy Hour 20%", { localTime: "23:00", localDayOfWeek: 1 })
      .reason,
    "time_window_mismatch",
  );

  const member = evaluate("Diskon Gold 15%");
  assert.equal(member.discountIdr, 34_500);
  assert.equal(
    evaluate("Diskon Gold 15%", { customer: null }).reason,
    "member_only",
  );
  assert.equal(
    evaluate("Diskon Gold 15%", {
      customer: {
        customerProfileId: rina.id,
        tierId: f.tiers[0].id,
        isMember: true,
      },
    }).reason,
    "tier_mismatch",
  );

  const channel = evaluate("Promo GoFood 5%", { channel: "gofood" });
  assert.equal(channel.discountIdr, 11_500);
  assert.equal(evaluate("Promo GoFood 5%").reason, "channel_mismatch");

  const facility = evaluate("Belanja Rp200.000 Gratis 1 Jam Shower");
  assert.equal(facility.applied, true);
  assert.equal(facility.discountIdr, 0);
  assert.deepEqual(facility.facilityEntitlement, {
    facilityProductId: f.facilityProductId,
    quantity: 1,
  });
  assert.equal(
    evaluate("Belanja Rp200.000 Gratis 1 Jam Shower", { subtotalIdr: 150_000 })
      .reason,
    "min_spend_not_met",
  );
});

test("voucher promotions apply only with their validated voucher (PRD §3.21)", () => {
  const voucherPromo = promotion("Voucher 25% Akhir Pekan");
  assert.equal(evaluate("Voucher 25% Akhir Pekan").reason, "voucher_required");
  const applied = evaluate("Voucher 25% Akhir Pekan", {
    voucherPromotionId: voucherPromo.id,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.discountIdr, 50_000); // 25% of 230.000 capped at 50.000
  assert.equal(evaluate("Promo Ramadan (draft)").reason, "draft");
});

test("promo quota and budget stop over-spending (PRD §3.21)", () => {
  const promo = promotion("Diskon 10% Semua Menu");
  assert.equal(
    crm.evaluatePromotion(promo, promoContext(), {
      promotionId: promo.id,
      totalUses: 500,
      customerUses: 0,
    }).reason,
    "quota_exhausted",
  );
  assert.equal(
    crm.evaluatePromotion(promo, promoContext(), {
      promotionId: promo.id,
      totalUses: 10,
      customerUses: 2,
    }).reason,
    "quota_exhausted",
  );
  assert.equal(
    crm.evaluatePromotion(
      { ...promo, spentIdr: 4_990_000 },
      promoContext({ subtotalIdr: 400_000 }),
    ).reason,
    "budget_exhausted",
  );
  assert.equal(
    crm.promotionSchema.safeParse({ ...promo, spentIdr: 6_000_000 }).success,
    false,
  );
});

test("promo stacking is deterministic and never exceeds the bill (PRD §3.21)", () => {
  const context = promoContext();
  const exclusive = crm.applyPromotions(f.promotions, context, [], {
    mode: "exclusive",
    maxStacked: 1,
    allowSameGroup: false,
  });
  assert.equal(exclusive.totalDiscountIdr, 34_500); // Gold 15% beats 10%
  const applied = exclusive.evaluations.filter((row) => row.applied);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].promotionId, promotion("Diskon Gold 15%").id);

  const stackable = crm.applyPromotions(f.promotions, context, [], {
    mode: "stackable",
    maxStacked: 3,
    allowSameGroup: false,
  });
  assert.equal(stackable.totalDiscountIdr, 54_050); // facility + Gold 15% + 10% of the rest
  assert.ok(stackable.totalDiscountIdr <= context.subtotalIdr);

  const groups = crm.applyPromotions(f.promotions, context, [], {
    mode: "stackable",
    maxStacked: 10,
    allowSameGroup: false,
  });
  assert.ok(
    groups.evaluations.some(
      (row) => !row.applied && row.reason === "not_stackable",
    ),
  );
  assert.ok(groups.totalDiscountIdr <= context.subtotalIdr);

  const all = crm.applyPromotions(f.promotions, context, [], {
    mode: "stackable",
    maxStacked: 10,
    allowSameGroup: true,
  });
  assert.ok(all.totalDiscountIdr <= context.subtotalIdr);
});

test("stacked percentage promos apply sequentially on the remaining bill (owner Q20)", () => {
  const make = (id, name, percentBp, priority, stackGroup) =>
    crm.promotionSchema.parse({
      ...promotion("Diskon 10% Semua Menu"),
      id,
      name,
      stackGroup,
      priority,
      quotaTotal: null,
      quotaPerCustomer: null,
      budgetIdr: null,
      benefit: { kind: "percent_off", percentBp, maxDiscountIdr: null },
    });
  const ten = make(
    "00000000-0000-4000-8000-000000000101",
    "Sepuluh persen",
    1_000,
    20,
    "order_discount",
  );
  const twenty = make(
    "00000000-0000-4000-8000-000000000102",
    "Dua puluh persen",
    2_000,
    10,
    "member",
  );
  const context = promoContext({ subtotalIdr: 100_000 });
  const policy = { mode: "stackable", maxStacked: 2, allowSameGroup: false };
  const discountOf = (result, promotionId) =>
    result.evaluations.find((row) => row.promotionId === promotionId)
      .discountIdr;

  // 10% first (priority 20): 10.000, then 20% of the remaining 90.000: 18.000.
  // The input order must not change the outcome.
  for (const list of [
    [ten, twenty],
    [twenty, ten],
  ]) {
    const result = crm.applyPromotions(list, context, [], policy);
    assert.equal(result.totalDiscountIdr, 28_000);
    assert.equal(discountOf(result, ten.id), 10_000);
    assert.equal(discountOf(result, twenty.id), 18_000);
  }

  // Equal priority breaks the tie by id (…101 before …102).
  const tied = [{ ...ten, priority: 10 }, twenty];
  const result = crm.applyPromotions(tied, context, [], policy);
  assert.equal(result.totalDiscountIdr, 28_000);
  assert.equal(discountOf(result, ten.id), 10_000);
  assert.equal(discountOf(result, twenty.id), 18_000);

  // A percentage still uses the full bill for its minimum-spend condition.
  const gated = crm.promotionSchema.parse({
    ...ten,
    conditions: [{ kind: "min_spend", amountIdr: 150_000 }],
  });
  const smallBill = crm.applyPromotions(
    [gated, twenty],
    promoContext({ subtotalIdr: 100_000 }),
    [],
    policy,
  );
  assert.equal(discountOf(smallBill, gated.id), undefined);
  assert.equal(discountOf(smallBill, twenty.id), 20_000);
});

test("a non-stackable promotion chosen first stays alone (PRD §3.21 aturan tumpang tindih)", () => {
  // Happy hour (priority 30, non-stackable) outranks Gold 15% and 10% once
  // the facility reward is out of reach.
  const context = promoContext({ subtotalIdr: 150_000 });
  const result = crm.applyPromotions(f.promotions, context, [], {
    mode: "stackable",
    maxStacked: 10,
    allowSameGroup: true,
  });
  const applied = result.evaluations.filter((row) => row.applied);
  assert.deepEqual(
    applied.map((row) => row.promotionId),
    [promotion("Happy Hour 20%").id],
  );
  assert.equal(result.totalDiscountIdr, 20_000);
  for (const name of ["Diskon Gold 15%", "Diskon 10% Semua Menu"])
    assert.equal(
      result.evaluations.find((row) => row.promotionId === promotion(name).id)
        .reason,
      "not_stackable",
    );
});

test("default stacking policy applies one promotion when the PRD is silent (PRD §3.21)", () => {
  assert.equal(crm.defaultPromoStackingPolicy.mode, "exclusive");
  assert.ok(
    crm.promoStackingPolicySchema.parse(crm.defaultPromoStackingPolicy),
  );
  const result = crm.applyPromotions(
    f.promotions,
    promoContext(),
    [],
    crm.defaultPromoStackingPolicy,
  );
  assert.equal(result.evaluations.filter((row) => row.applied).length, 1);
});

test("buy X get Y shares one free allowance across lines (PRD §3.21)", () => {
  const croissant = f.menuItems.croissantMentega;
  const result = evaluate("Beli 2 Kopi Gratis Croissant", {
    lines: [
      line(f.menuItems.kopiSusuAren, 2, 28_000),
      line(croissant, 1, 24_000),
      line(croissant, 1, 26_000),
    ],
  });
  assert.equal(result.applied, true);
  assert.deepEqual(result.freeItems, [{ menuItemId: croissant, quantity: 1 }]);
  assert.equal(result.discountIdr, 24_000);
});

// ---- Vouchers -------------------------------------------------------------

test("voucher lifecycle blocks expired, redeemed and mismatched codes (LOY-03)", () => {
  const issued = f.vouchers[0];
  assert.equal(
    crm.voucherUsability(issued, { customerProfileId: sari.id, at: AT }),
    null,
  );
  assert.equal(
    crm.voucherUsability(issued, { customerProfileId: rina.id, at: AT }),
    "customer_mismatch",
  );
  assert.equal(
    crm.voucherUsability(issued, {
      customerProfileId: sari.id,
      at: "2026-10-01T00:00:00.000Z",
    }),
    "not_started",
  );
  assert.equal(
    crm.voucherUsability(issued, {
      customerProfileId: sari.id,
      at: "2026-12-01T00:00:00.000Z",
    }),
    "expired",
  );
  const redeemed = f.vouchers.find((voucher) => voucher.status === "redeemed");
  assert.equal(
    crm.voucherUsability(redeemed, { customerProfileId: null, at: AT }),
    "already_redeemed",
  );
  const cancelled = f.vouchers.find(
    (voucher) => voucher.status === "cancelled",
  );
  assert.equal(
    crm.voucherUsability(cancelled, { customerProfileId: null, at: AT }),
    "cancelled",
  );
  assert.equal(
    crm.voucherSchema.safeParse({ ...issued, status: "redeemed" }).success,
    false,
  );
});

test("voucher codes normalize before hashing and validation", () => {
  assert.equal(crm.voucherCodeInputSchema.parse("  legend25  "), "LEGEND25");
  assert.equal(crm.voucherCodeInputSchema.safeParse("abc").success, false);
  // legend-4qu: the grouped display form of an apology voucher redeems too.
  assert.equal(crm.voucherCodeInputSchema.parse("legend-25"), "LEGEND25");
  assert.equal(
    crm.voucherCodeInputSchema.parse(" leg-ab12-cd34 "),
    "LEGAB12CD34",
  );
  assert.equal(crm.voucherCodeInputSchema.safeParse("a-b-c").success, false);
  assert.equal(crm.voucherCodeInputSchema.safeParse("------").success, false);
  assert.equal(
    crm.voucherCodeInputSchema.safeParse("LEGEND_25").success,
    false,
  );
  assert.equal(
    crm.voucherValidationInputSchema.safeParse({
      code: "legend25",
      subtotalIdr: 100_000,
      channel: "dine_in",
    }).success,
    true,
  );
  assert.equal(
    crm.voucherValidationResultSchema.safeParse({
      valid: false,
      reason: "min_spend_not_met",
    }).success,
    true,
  );
});

// ---- Segments, campaigns and feedback ------------------------------------

test("dynamic segments match RFM, tier, favorites, outlet and behavior (PRD §3.21)", () => {
  const contextFor = (profile, overrides = {}) => ({
    profile,
    daysSinceLastVisit: 104,
    favoriteMenuItemIds: [f.menuItems.kopiSusuAren],
    visitedOutletIds: [cafeLegendFixtures.outlets[0].id],
    birthMonth: 11,
    ...overrides,
  });
  const inactive = f.segments[0];
  assert.equal(crm.matchesSegment(contextFor(maya), inactive.definition), true);
  assert.equal(
    crm.matchesSegment(
      contextFor(rina, { daysSinceLastVisit: 47 }),
      inactive.definition,
    ),
    false, // no marketing opt-in
  );
  assert.equal(
    crm.matchesSegment(
      contextFor(sari, { daysSinceLastVisit: 2 }),
      inactive.definition,
    ),
    false,
  );
  assert.equal(
    crm.matchesSegment(contextFor(maya), f.segments[1].definition),
    true, // Gold
  );
  assert.equal(
    crm.matchesSegment(contextFor(rina), f.segments[1].definition),
    false, // Silver
  );
  assert.equal(
    crm.matchesSegment(contextFor(sari), f.segments[2].definition),
    true,
  );
  assert.equal(
    crm.matchesSegment(contextFor(maya), f.segments[3].definition),
    true,
  );
  assert.equal(
    crm.matchesSegment(contextFor(maya, { favoriteMenuItemIds: [] }), {
      match: "any",
      rules: [
        { kind: "favorite_item", menuItemIds: [f.menuItems.kopiSusuAren] },
        { kind: "rfm_monetary", minSpendIdr: 1_000_000 },
      ],
    }),
    true,
  );
  assert.equal(
    crm.matchesSegment(contextFor(maya), {
      match: "all",
      rules: [
        { kind: "rfm_frequency", minVisits: 30 },
        { kind: "rfm_monetary", minSpendIdr: 1_000_000 },
      ],
    }),
    false,
  );
});

test("campaign and feedback state machines reject invalid transitions (PRD §3.21)", () => {
  assert.equal(crm.transitionCampaign("draft", "schedule"), "scheduled");
  assert.equal(crm.transitionCampaign("scheduled", "start"), "running");
  assert.equal(crm.transitionCampaign("running", "complete"), "completed");
  assert.equal(crm.transitionCampaign("running", "cancel"), "cancelled");
  assert.throws(() => crm.transitionCampaign("completed", "cancel"));
  assert.throws(() => crm.transitionCampaign("draft", "start"));
  assert.equal(
    crm.campaignSchema.safeParse({ ...f.campaigns[0], scheduledAt: null })
      .success,
    false,
  );
  assert.equal(
    crm.campaignSchema.safeParse({
      ...f.campaigns[0],
      status: "completed",
      completedAt: null,
    }).success,
    false,
  );

  assert.equal(crm.transitionFeedback("open", "start_review"), "in_review");
  assert.equal(crm.transitionFeedback("in_review", "resolve"), "resolved");
  assert.equal(crm.transitionFeedback("resolved", "close"), "closed");
  assert.equal(crm.transitionFeedback("open", "dismiss"), "closed");
  assert.throws(() => crm.transitionFeedback("closed", "start_review"));
  assert.throws(() => crm.transitionFeedback("open", "resolve"));
  assert.equal(
    crm.feedbackSchema.safeParse({
      ...f.feedback[0],
      status: "open",
      handledBy: f.staffUserId,
      resolvedAt: null,
    }).success,
    false,
  );
  assert.equal(
    crm.feedbackSchema.safeParse({
      ...f.feedback[2],
      kind: "complaint",
      comment: null,
    }).success,
    false,
  );
  assert.equal(
    crm.feedbackSchema.safeParse({
      ...f.feedback[3],
      status: "resolved",
      resolvedAt: null,
    }).success,
    false,
  );
});

test("Customer 360 includes consents, visits, favorites, feedback and vouchers (PRD §3.21)", () => {
  assert.equal(f.customer360.profile.id, sari.id);
  assert.ok(f.customer360.consents.length >= 3);
  assert.equal(f.customer360.recentVisits.length, 3);
  assert.equal(
    f.customer360.favoriteItems[0].menuItemId,
    f.menuItems.kopiSusuAren,
  );
  assert.ok(f.customer360.recentFeedback.length >= 1);
  assert.ok(f.customer360.activeVouchers.length >= 1);
  assert.equal(Object.hasOwn(f.customer360.profile, "whatsappHash"), false);
});

// ---- Events ---------------------------------------------------------------

test("CRM events are registered in the WS-00 catalog with typed payloads (PRD §6.G)", () => {
  const names = eventCatalog.map((entry) => entry.name);
  for (const event of crm.crmEventCatalogEntries) {
    assert.ok(names.includes(event.name), event.name);
    assert.equal(event.workstream, "WS-08");
    assert.equal(event.version, 1);
    assert.equal(event.payloadSchemaRef, `${event.name}.v1`);
  }
  assert.deepEqual(
    crm.crmEventCatalogEntries.map((entry) => entry.name),
    crm.crmEventNames,
  );
  assert.ok(crm.crmEventSchema.parse(f.pointsEarnedEvent));
  assert.equal(
    crm.crmEventSchema.safeParse({
      ...f.pointsEarnedEvent,
      name: "points.expired",
    }).success,
    false,
  );
  assert.equal(
    crm.crmEventSchema.safeParse({
      ...f.pointsEarnedEvent,
      payload: { ...f.pointsEarnedEvent.payload, points: -240 },
    }).success,
    false,
  );
  assert.equal(
    crm.crmEventSchema.safeParse({
      ...f.pointsEarnedEvent,
      payload: { ...f.pointsEarnedEvent.payload, balanceAfter: undefined },
    }).success,
    false,
  );
  assert.equal(crm.crmEventPayloadSchema("order.paid"), null);
  assert.equal(crm.crmEventPayloadSchema("constructor"), null);
  // Defined via defineDomainEvent: each envelope is bound to its catalog entry.
  assert.ok(
    crm.crmEvents["points.earned"].envelopeSchema.parse(f.pointsEarnedEvent),
  );
  assert.equal(
    crm.crmEventSchema.safeParse({
      ...f.pointsEarnedEvent,
      payload: { ...f.pointsEarnedEvent.payload, sourceId: null },
    }).success,
    false,
  );
  // Stale WS-08 placeholders were replaced by these events.
  for (const stale of [
    "loyalty_points.earned",
    "loyalty_points.expired",
    "loyalty_tier.evaluated",
  ])
    assert.equal(names.includes(stale), false, stale);
});

// ---- Endpoints ------------------------------------------------------------

test("CRM endpoints are unique, typed and tenant-free client input (docs/frontend.md)", () => {
  assert.equal(crm.crmEndpoints.length, 52);
  const ids = crm.crmEndpoints.map((endpoint) => endpoint.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const endpoint of crm.crmEndpoints) {
    assert.equal(endpoint.id, `${endpoint.method} ${endpoint.path}`);
    assert.ok(endpoint.path.startsWith("/api/"));
    if (endpoint.method === "GET") assert.equal(endpoint.body, undefined);
    const params = endpoint.params ? Object.keys(endpoint.params.shape) : [];
    assert.deepEqual(pathParamNames(endpoint.path), params);
    if (endpoint.body) {
      assert.equal(Object.hasOwn(endpoint.body.shape, "tenantId"), false);
      assert.equal(Object.hasOwn(endpoint.body.shape, "tenant_id"), false);
    }
  }
});

test("CRM endpoint contracts accept fixtures and reject tenant input (TEN-02)", () => {
  assert.ok(crm.getMemberProfile.response.parse({ data: f.profileDtos[0] }));
  assert.ok(
    crm.listMemberRewards.response.parse({
      data: f.rewards,
      meta: { limit: 25, nextCursor: null },
    }),
  );
  assert.ok(crm.getCustomer360.response.parse({ data: f.customer360 }));
  assert.ok(crm.getMemberOverview.response.parse({ data: f.memberOverview }));
  assert.ok(
    crm.listMemberVisits.response.parse({
      data: f.memberVisits,
      meta: { limit: 25, nextCursor: null },
    }),
  );
  assert.ok(
    crm.listMemberFavorites.response.parse({ data: f.memberFavorites }),
  );
  assert.ok(
    crm.listFeedback.response.parse({
      data: f.feedback,
      meta: { limit: 25, nextCursor: null },
    }),
  );
  assert.ok(
    crm.redeemReward.body.parse({ idempotencyKey: "redeem-sari-0001" }),
  );
  assert.equal(
    crm.redeemReward.body.safeParse({
      idempotencyKey: "redeem-sari-0001",
      tenantId: cafeLegendFixtures.tenant.id,
    }).success,
    false,
  );
  assert.ok(
    crm.evaluatePromotions.body.parse({
      channel: "dine_in",
      lines: promoContext().lines.map(({ menuItemId, quantity }) => ({
        menuItemId,
        quantity,
      })),
      voucherCode: "legend25",
    }),
  );
  // Prices are server-derived: a client-sent price or subtotal is rejected.
  assert.equal(
    crm.evaluatePromotions.body.safeParse({
      channel: "dine_in",
      lines: promoContext().lines,
      voucherCode: null,
    }).success,
    false,
  );
  assert.equal(
    crm.evaluatePromotions.body.safeParse({
      channel: "dine_in",
      subtotalIdr: 1,
      lines: [{ menuItemId: f.menuItems.americano, quantity: 1 }],
      voucherCode: null,
    }).success,
    false,
  );
  const omitKeys = (object, keys) =>
    Object.fromEntries(
      Object.entries(object).filter(([key]) => !keys.includes(key)),
    );
  const promotionBody = omitKeys(f.promotions[0], [
    "id",
    "tenantId",
    "spentIdr",
    "createdAt",
    "updatedAt",
  ]);
  assert.equal(crm.createPromotion.body.safeParse(promotionBody).success, true);
  assert.equal(
    crm.createPromotion.body.safeParse({
      ...promotionBody,
      tenantId: cafeLegendFixtures.tenant.id,
    }).success,
    false,
  );
  const tierBody = omitKeys(f.tiers[0], ["id", "tenantId"]);
  assert.equal(crm.createLoyaltyTier.body.safeParse(tierBody).success, true);
  assert.equal(
    crm.createLoyaltyTier.body.safeParse({
      ...tierBody,
      tenantId: cafeLegendFixtures.tenant.id,
    }).success,
    false,
  );
});

// ---- Errors ---------------------------------------------------------------

test("CRM error codes map to HTTP statuses and Indonesian fallbacks (D-CORE-4)", () => {
  assert.equal(crm.crmErrorHttpStatus.POINTS_INSUFFICIENT, 409);
  assert.equal(crm.crmErrorHttpStatus.MARKETING_CONSENT_REQUIRED, 403);
  assert.equal(crm.crmErrorHttpStatus.CUSTOMER_NOT_FOUND, 404);
  assert.equal(
    crm.CRM_ERROR_CODES.length,
    Object.keys(crm.crmErrorMessages).length,
  );
  for (const code of crm.CRM_ERROR_CODES) {
    assert.equal(crm.crmErrorCodeSchema.safeParse(code).success, true);
    assert.ok(crm.crmErrorMessages[code].length > 10);
  }
  assert.equal(crm.crmErrorCodeSchema.safeParse("lowercase").success, false);
});
