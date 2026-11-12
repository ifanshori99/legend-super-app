import assert from "node:assert/strict";
import { test } from "node:test";

import * as platform from "../packages/shared/src/platform/index.ts";
import { cafeLegendFacilityFixtures as facilityFixture } from "../packages/shared/src/facility/fixtures.ts";
import { cafeLegendTaxFixtures as taxFixture } from "../packages/shared/src/tax/fixtures.ts";

const zone = {
  key: "cafe.terrace",
  outletKey: "cafe",
  name: "Terrace",
  paymentMode: "open_bill",
  serviceChargeBp: 500,
  minimumSpendIdr: 50_000,
  hours: [{ daysOfWeek: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" }],
  status: "active",
  sortOrder: 0,
};
const service = {
  key: "cafe.sc-terrace",
  outletKey: "cafe",
  zoneKey: zone.key,
  code: "SC-TERRACE",
  name: "Terrace service",
  rateBp: 500,
  orderTypes: ["dine_in"],
  itemClasses: ["food_beverage"],
  isActive: true,
};
const role = {
  key: "custom.bar",
  kind: "custom",
  templateKey: null,
  name: "Bar",
  permissions: ["floor.table.view"],
  allowedScopeTypes: ["outlet"],
  mfaRequired: false,
};
const checklist = {
  key: "cafe.chk.opening",
  outletKey: "cafe",
  name: "Opening",
  type: "opening",
  items: [{ label: "Clean bar", instruction: "Clean", requiredEvidence: [] }],
  schedule: { zoneKey: zone.key, dueTime: "08:30" },
  roleKey: role.key,
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
  sortOrder: 0,
  perCustomerLimit: 1,
  redemptionValidDays: 7,
};

function bundle(sections) {
  return {
    formatVersion: 1,
    exportedAt: "2026-11-12T00:00:00.000Z",
    sections: Object.fromEntries(
      Object.entries(sections).map(([name, items]) => [
        name,
        { version: 1, items },
      ]),
    ),
  };
}

function decode(sections, options) {
  return platform.decodeConfigBundle(bundle(sections), options);
}

function refused(result, section, reference) {
  assert.equal(result.ok, false, JSON.stringify(result));
  const issues = result.issues.filter((issue) => issue.section === section);
  assert.ok(issues.length > 0, JSON.stringify(result.issues));
  assert.match(JSON.stringify(issues), reference);
  assert.equal(Object.hasOwn(result, "drafts"), false);
}

const outletContext = { existingOutletKeys: new Set(["cafe", "other"]) };
const targetContext = {
  ...outletContext,
  existingRoleKeys: new Set([role.key]),
  existingZoneOutletKeyByKey: new Map([[zone.key, "cafe"]]),
};

test("538-G1: service and checklist references resolve from bundled zones and roles regardless of section order", () => {
  const sections = {
    checklists: [checklist],
    service_charge_rules: [service],
    zones: [zone],
    roles: [role],
  };
  for (const entries of [
    Object.entries(sections),
    Object.entries(sections).reverse(),
  ]) {
    const result = decode(Object.fromEntries(entries), outletContext);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.deepEqual(result.drafts.checklists, [checklist]);
    assert.deepEqual(result.drafts.service_charge_rules, [service]);
    assert.equal(result.withoutCodec.includes("checklists"), false);
    assert.equal(result.withoutCodec.includes("service_charge_rules"), false);
  }
});

test("538-G1: service charge rejects missing and foreign-outlet bundled zones", () => {
  for (const candidate of [
    { ...service, zoneKey: "zone.missing" },
    { ...service, outletKey: "other" },
  ]) {
    refused(
      decode(
        { service_charge_rules: [candidate], zones: [zone] },
        outletContext,
      ),
      "service_charge_rules",
      /zone|outlet/i,
    );
  }
});

test("538-G1: checklist rejects missing bundled role, missing zone and zone belonging to another outlet", () => {
  for (const candidate of [
    { ...checklist, roleKey: "role.missing" },
    {
      ...checklist,
      schedule: { ...checklist.schedule, zoneKey: "zone.missing" },
    },
    { ...checklist, outletKey: "other" },
  ]) {
    refused(
      decode(
        { checklists: [candidate], roles: [role], zones: [zone] },
        outletContext,
      ),
      "checklists",
      /role|zone|outlet/i,
    );
  }
});

test("538-G1: partial service and checklist imports use target references and reject unresolved explicit keys", () => {
  const sections = { checklists: [checklist], service_charge_rules: [service] };
  const accepted = decode(sections, targetContext);
  assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  assert.deepEqual(accepted.drafts.checklists, [checklist]);
  assert.deepEqual(accepted.drafts.service_charge_rules, [service]);
  for (const context of [
    outletContext,
    { ...targetContext, existingZoneOutletKeyByKey: new Map() },
    {
      ...targetContext,
      existingZoneOutletKeyByKey: new Map([[zone.key, "other"]]),
    },
  ]) {
    const result = decode(sections, context);
    refused(result, "service_charge_rules", /zone|outlet/i);
    refused(result, "checklists", /zone|outlet/i);
  }
  refused(
    decode(
      { checklists: [checklist] },
      { ...targetContext, existingRoleKeys: new Set() },
    ),
    "checklists",
    /role/i,
  );
});

test("538-G1: parsing partial service and checklist bundles defers target references while decode fails closed", () => {
  for (const [section, item] of [
    ["service_charge_rules", service],
    ["checklists", checklist],
  ]) {
    const parsed = platform.parseConfigBundle(bundle({ [section]: [item] }));
    assert.equal(parsed.ok, true, JSON.stringify(parsed.schemaIssues));
    refused(platform.decodeConfigBundle(parsed.bundle), section, /role|zone/i);
    const accepted = platform.decodeConfigBundle(parsed.bundle, targetContext);
    assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  }
});

test("538-G1: selecting dependent sections alone requires target context rather than unselected bundle rows", () => {
  const sections = { checklists: [checklist], roles: [role], zones: [zone] };
  refused(
    decode(sections, { sections: ["checklists"] }),
    "checklists",
    /role|zone/i,
  );
  const accepted = decode(sections, {
    ...targetContext,
    sections: ["checklists"],
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  assert.deepEqual(Object.keys(accepted.drafts), ["checklists"]);
});

test("538-G1b P2: facilities accept tenant-wide or same-outlet taxes and reject unknown or foreign-outlet tax references", () => {
  const taxCodec = platform.CONFIG_SECTION_CODECS.tax_rules;
  const facilityCodec = platform.CONFIG_SECTION_CODECS.facilities;
  assert.ok(taxCodec);
  assert.ok(facilityCodec);
  const taxItems = taxCodec.toTemplate([taxFixture.taxRules[1]], {
    asOf: "2026-11-12",
    settings: [],
  });
  const facilities = facilityCodec
    .toTemplate(
      {
        facilities: [facilityFixture.facilities[0]],
        products: [{ ...facilityFixture.products[0], taxRuleId: null }],
      },
      { outletKeys: new Map([[facilityFixture.outlet.id, "cafe"]]) },
    )
    .map((item) =>
      item.kind === "product" ? { ...item, taxRuleKey: taxItems[0].key } : item,
    );
  const bundled = decode({ facilities, tax_rules: taxItems }, outletContext);
  assert.equal(bundled.ok, true, JSON.stringify(bundled.issues));
  assert.equal(
    bundled.drafts.facilities.find((item) => item.kind === "product")
      .taxRuleKey,
    taxItems[0].key,
  );
  const target = decode(
    { facilities },
    {
      ...outletContext,
      existingTaxRuleOutletKeyByKey: new Map([[taxItems[0].key, null]]),
    },
  );
  assert.equal(target.ok, true, JSON.stringify(target.issues));
  for (const options of [
    outletContext,
    { ...outletContext, existingTaxRuleOutletKeyByKey: new Map() },
  ])
    refused(decode({ facilities }, options), "facilities", /taxRuleKey|tax/i);
  const parsed = platform.parseConfigBundle(bundle({ facilities }));
  assert.equal(parsed.ok, true, JSON.stringify(parsed.schemaIssues));
  refused(
    platform.decodeConfigBundle(parsed.bundle),
    "facilities",
    /taxRuleKey|tax/i,
  );
  for (const taxOutletKey of [null, "cafe", "other"]) {
    const bundledScope = decode(
      {
        facilities,
        tax_rules: taxItems.map((item) => ({
          ...item,
          outletKey: taxOutletKey,
        })),
      },
      outletContext,
    );
    const targetScope = decode(
      { facilities },
      {
        ...outletContext,
        existingTaxRuleOutletKeyByKey: new Map([
          [taxItems[0].key, taxOutletKey],
        ]),
      },
    );
    for (const result of [bundledScope, targetScope]) {
      if (taxOutletKey === "other") {
        refused(result, "facilities", /taxRuleKey|tax|outlet/i);
      } else {
        assert.equal(result.ok, true, JSON.stringify(result.issues));
        const importedProduct = result.drafts.facilities.find(
          (item) => item.kind === "product",
        );
        assert.equal(importedProduct.taxRuleKey, taxItems[0].key);
        assert.equal(
          importedProduct.priceIdr,
          facilityFixture.products[0].priceIdr,
        );
      }
    }
  }
});

test("538-G1: legacy outlet-scoped tax rules and settings validate supplied target outlets and otherwise defer", () => {
  const codec = platform.CONFIG_SECTION_CODECS.tax_rules;
  assert.ok(codec);
  const [rule] = codec.toTemplate([taxFixture.taxRules[0]], {
    asOf: "2026-11-12",
    settings: [],
  });
  rule.outletKey = "cafe";
  delete rule.effectiveFrom;
  const settings = {
    key: "settings.cafe",
    kind: "settings",
    outletKey: "cafe",
    calculationOrder: "discount_service_tax",
    pricesIncludeTax: false,
    serviceRoundingMode: "half_up",
    taxRoundingMode: "half_up",
    inclusiveBaseRoundingMode: "half_up",
    billRounding: null,
    packageAllocation: "fixed_bp",
  };
  for (const item of [rule, settings]) {
    const sections = { tax_rules: [item] };
    refused(
      decode(sections, { existingOutletKeys: new Set() }),
      "tax_rules",
      /outlet/i,
    );
    for (const options of [
      undefined,
      { existingOutletKeys: new Set(["cafe"]) },
    ]) {
      const accepted = decode(sections, options);
      assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
      assert.equal(accepted.drafts.tax_rules[0].outletKey, "cafe");
    }
  }
});

test("538-G1: bundle loyalty import preserves locked value and refuses any increase or decrease", () => {
  const accepted = decode(
    { loyalty_policy: [program] },
    { lockedPointValueIdr: 100 },
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  assert.equal(accepted.drafts.loyalty_policy[0].pointValueIdr, 100);
  for (const pointValueIdr of [99, 101])
    refused(
      decode(
        { loyalty_policy: [{ ...program, pointValueIdr }] },
        { lockedPointValueIdr: 100 },
      ),
      "loyalty_policy",
      /pointValueIdr.*lock/i,
    );
});

test("538-G1b P3: selected loyalty imports require an explicit lock state and null permits an unlocked value", () => {
  const sections = { loyalty_policy: [program], roles: [role] };
  for (const options of [
    undefined,
    {},
    { lockedPointValueIdr: undefined },
    { lockedPointValueIdr: Number.NaN },
    { sections: ["loyalty_policy"] },
  ]) {
    refused(decode(sections, options), "loyalty_policy", /lock/i);
  }
  for (const pointValueIdr of [100, 101]) {
    const accepted = decode(
      { loyalty_policy: [{ ...program, pointValueIdr }] },
      { lockedPointValueIdr: null },
    );
    assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
    assert.equal(
      accepted.drafts.loyalty_policy[0].pointValueIdr,
      pointValueIdr,
    );
  }
  const unselected = decode(sections, { sections: ["roles"] });
  assert.equal(unselected.ok, true, JSON.stringify(unselected.issues));
  assert.deepEqual(Object.keys(unselected.drafts), ["roles"]);
  const empty = decode({ loyalty_policy: [] });
  assert.equal(empty.ok, true, JSON.stringify(empty.issues));
  refused(
    decode(
      { loyalty_policy: [reward] },
      { existingMenuItemKeys: new Set([reward.menuItemKey]) },
    ),
    "loyalty_policy",
    /lock/i,
  );
});

test("538-G1: bundle loyalty forwards existing menu keys and rejects unknown explicit references", () => {
  const accepted = decode(
    { loyalty_policy: [reward] },
    {
      lockedPointValueIdr: null,
      existingMenuItemKeys: new Set([reward.menuItemKey]),
    },
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  assert.deepEqual(accepted.drafts.loyalty_policy, [reward]);
  for (const options of [
    { lockedPointValueIdr: null },
    { lockedPointValueIdr: null, existingMenuItemKeys: new Set() },
  ])
    refused(
      decode({ loyalty_policy: [reward] }, options),
      "loyalty_policy",
      /menu/i,
    );
});
