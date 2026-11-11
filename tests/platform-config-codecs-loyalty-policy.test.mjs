import assert from "node:assert/strict";
import { test } from "node:test";

import * as platform from "../packages/shared/src/platform/index.ts";

const codec = () => {
  const value = platform.CONFIG_SECTION_CODECS.loyalty_policy;
  assert.ok(value, "loyalty_policy codec must be registered");
  return value;
};

const program = {
  key: "program.main",
  kind: "program",
  name: "Poin Member",
  earnRate: { spendIdr: 10_000, points: 1 },
  expiryMonths: 12,
  rollingMonths: 12,
  pointValueIdr: 100,
  referral: {
    enabled: false,
    referrerPoints: 100,
    refereePoints: 50,
    qualifyingEvent: "first_paid_order",
    minFirstOrderIdr: 0,
    maxReferralsPerCustomerPerMonth: 10,
  },
  antiFraud: { dailyPointCapPerCustomer: 500, employeeSelfServeBan: true },
  isActive: false,
};
const tier = {
  key: "tier.silver",
  kind: "tier",
  name: "Silver",
  rank: 1,
  thresholdSpendIdr: 100_000,
  thresholdVisits: 10,
  benefits: {
    pointsMultiplierBp: 10_000,
    birthdayRewardPoints: 10,
    reservationPriority: false,
    exclusivePromotions: false,
    facilityFreeAccessQuota: 0,
  },
  isActive: true,
};
const reward = {
  key: "reward.kopi",
  kind: "reward",
  name: "Kopi",
  description: "Kopi gratis",
  type: "free_item",
  pointsCost: 100,
  stock: 20,
  validFrom: "2026-11-01T00:00:00.000Z",
  validUntil: null,
  menuItemKey: "menu.kopi",
  voucherValueIdr: null,
  isActive: true,
  sortOrder: 1,
  perCustomerLimit: 1,
  redemptionValidDays: 7,
};
const mission = {
  key: "mission.try-kopi",
  kind: "mission",
  name: "Coba kopi",
  description: "Coba menu baru",
  type: "try_new_item",
  rule: { kind: "try_new_item", targetItems: 1, menuItemKeys: ["menu.kopi"] },
  reward: { kind: "points", points: 10 },
  period: { kind: "monthly" },
  isActive: true,
  startsAt: null,
  endsAt: null,
};
const items = [program, tier, reward, mission];
const menuContext = { menuItemKeys: new Set(["menu.kopi"]) };

test("legend-1tzvg: loyalty policy decodes config only, preserving exact reward liability", () => {
  const value = codec();
  assert.equal(value.section, "loyalty_policy");
  const decoded = value.fromTemplate(items, menuContext);
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
  assert.deepEqual(decoded.drafts, items);
  assert.equal(decoded.drafts[0].pointValueIdr, 100);
  assert.equal(decoded.drafts[2].pointsCost, 100);
  assert.equal(decoded.drafts[3].reward.points, 10);
  assert.deepEqual(platform.findBundleIdentifiers(decoded.drafts), []);
  for (const item of items) {
    for (const field of [
      "id",
      "tenantId",
      "customerProfileId",
      "ledger",
      "updatedAt",
    ])
      assert.equal(
        value.itemSchema.safeParse({ ...item, [field]: "private" }).success,
        false,
        field,
      );
  }
});

test("legend-1tzvg: locked point value cannot increase or decrease imported liabilities", () => {
  const value = codec();
  for (const pointValueIdr of [1, 99, 101, 10_000]) {
    const result = value.fromTemplate([{ ...program, pointValueIdr }], {
      lockedPointValueIdr: 100,
    });
    assert.equal(result.ok, false, String(pointValueIdr));
    assert.match(result.issues.join("\n"), /pointValueIdr.*lock/i);
  }
  assert.equal(
    value.fromTemplate([program], { lockedPointValueIdr: 100 }).ok,
    true,
  );
  assert.equal(
    value.fromTemplate([{ ...program, pointValueIdr: 101 }]).ok,
    true,
  );
});

test("legend-1tzvg: loyalty policy refuses duplicate configuration and unresolved menu keys", () => {
  const value = codec();
  for (const invalid of [
    [program, { ...program, key: "program.other" }],
    [tier, { ...tier, key: "tier.other" }],
    [tier, { ...tier, kind: "tier" }],
    [reward],
    [mission],
  ])
    assert.equal(
      value.fromTemplate(invalid).ok,
      false,
      JSON.stringify(invalid),
    );
  assert.throws(
    () =>
      value.toTemplate({
        rewards: [{ ...reward, menuItemId: "private-menu-id" }],
      }),
    /menu/i,
  );
});

test("legend-1tzvg: loyalty policy keeps domain reward and mission constraints", () => {
  const value = codec();
  for (const item of [
    { ...program, pointValueIdr: 0 },
    { ...program, earnRate: { spendIdr: 0, points: 1 } },
    { ...reward, pointsCost: 0 },
    { ...reward, type: "voucher", voucherValueIdr: 20_000 },
    { ...reward, validUntil: "2026-10-01T00:00:00.000Z" },
    { ...mission, type: "visit_count" },
    {
      ...mission,
      startsAt: "2026-11-02T00:00:00.000Z",
      endsAt: "2026-11-01T00:00:00.000Z",
    },
  ])
    assert.equal(
      value.fromTemplate([item], menuContext).ok,
      false,
      JSON.stringify(item),
    );
});

test("legend-1tzvg: export strips source ids and uses stable keys for menu references", () => {
  const value = codec();
  const sourceId = "bba1b2c3-0000-4000-8000-000000000001";
  const tenantId = "bba1b2c3-0000-4000-8000-000000000002";
  const menuId = "bba1b2c3-0000-4000-8000-000000000003";
  const sourceFields = (item) =>
    Object.fromEntries(
      Object.entries(item).filter(
        ([key]) => !["key", "kind", "menuItemKey"].includes(key),
      ),
    );
  const rows = {
    programs: [
      {
        ...sourceFields(program),
        id: sourceId,
        tenantId,
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
    ],
    tiers: [{ ...sourceFields(tier), id: sourceId, tenantId }],
    rewards: [
      { ...sourceFields(reward), id: sourceId, tenantId, menuItemId: menuId },
    ],
    missions: [
      {
        ...sourceFields(mission),
        id: sourceId,
        tenantId,
        rule: { kind: "try_new_item", targetItems: 1, menuItemIds: [menuId] },
      },
    ],
  };
  const exported = value.toTemplate(rows, {
    menuItemKeyById: new Map([[menuId, "menu.kopi"]]),
  });
  assert.equal(exported.length, 4);
  assert.deepEqual(
    platform.findBundleIdentifiers(exported, [sourceId, tenantId, menuId]),
    [],
  );
  assert.deepEqual(
    value.toTemplate(rows, {
      menuItemKeyById: new Map([[menuId, "menu.kopi"]]),
    }),
    exported,
  );
  assert.equal(
    exported.find((item) => item.kind === "reward").menuItemKey,
    "menu.kopi",
  );
  assert.deepEqual(
    exported.find((item) => item.kind === "mission").rule.menuItemKeys,
    ["menu.kopi"],
  );
  assert.equal(value.fromTemplate(exported, menuContext).ok, true);
});
