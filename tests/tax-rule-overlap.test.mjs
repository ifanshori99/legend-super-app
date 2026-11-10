// Unit tests for the tax rule overlap detector (bead legend-de3b). Publish
// refuses a rule that ties with an active one in resolveTaxRule; these pin what
// counts as a tie and what does not. Pure, no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as tax from "../packages/shared/src/tax/index.ts";

const uuid = (n) => `9e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const published = {
  status: "published",
  publishedAt: "2026-10-25T03:00:00.000Z",
  publishedBy: "5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  createdAt: "2026-10-24T09:00:00.000Z",
};
const tenantId = "3f8b7c1e-2d4a-4e6b-9c0d-1a2b3c4d5e6f";
const outletA = uuid(1);
const outletB = uuid(2);
const itemX = uuid(50);
const categoryC = uuid(60);

const rule = (n, overrides = {}) =>
  tax.taxRuleSchema.parse({
    id: uuid(100 + n),
    tenantId,
    outletId: null,
    code: `RULE-${n}`,
    name: `Rule ${n}`,
    taxType: "pbjt",
    rateBp: 1000,
    regionCode: null,
    channels: [],
    appliesTo: { itemClasses: ["food_beverage"], categoryIds: [], itemIds: [] },
    priceIncludesTax: false,
    includeServiceInBase: true,
    isActive: true,
    version: 1,
    effectiveFrom: "2026-01-01",
    ...published,
    ...overrides,
  });
const applies = (overrides) => ({
  itemClasses: [],
  categoryIds: [],
  itemIds: [],
  ...overrides,
});

test("two tenant-wide rules for one class tie", () => {
  const tie = tax.taxRuleTie(rule(1), rule(2), null);
  assert.ok(tie);
  assert.equal(tie.a.id, rule(1).id);
  assert.equal(tie.b.id, rule(2).id);
  assert.equal(tie.outletId, null);
  assert.equal(tie.level, "itemClass");
  assert.equal(tie.key, "food_beverage");
  assert.equal(tie.regionCode, null);
  assert.ok(tax.taxChannelSchema.options.includes(tie.channel));
});

test("rules for different classes do not tie", () => {
  const facility = rule(2, {
    appliesTo: applies({ itemClasses: ["facility"] }),
  });
  assert.equal(tax.taxRuleTie(rule(1), facility, null), null);
});

test("a tombstone never ties", () => {
  assert.equal(
    tax.taxRuleTie(rule(1), rule(2, { isActive: false }), null),
    null,
  );
  assert.equal(
    tax.taxRuleTie(rule(1, { isActive: false }), rule(2), null),
    null,
  );
});

test("two versions of one code never tie", () => {
  assert.equal(
    tax.taxRuleTie(rule(1), rule(2, { code: "RULE-1", version: 2 }), null),
    null,
  );
});

test("different specificity does not tie", () => {
  // outlet beats tenant-wide
  assert.equal(
    tax.taxRuleTie(rule(1, { outletId: outletA }), rule(2), outletA),
    null,
  );
  // explicit channel beats every channel
  assert.equal(
    tax.taxRuleTie(rule(1, { channels: ["dine_in"] }), rule(2), null),
    null,
  );
  // explicit region beats any region
  assert.equal(
    tax.taxRuleTie(rule(1, { regionCode: "ID-JB-3273" }), rule(2), null),
    null,
  );
  // item beats class
  assert.equal(
    tax.taxRuleTie(
      rule(1, { appliesTo: applies({ itemIds: [itemX] }) }),
      rule(2),
      null,
    ),
    null,
  );
  // category beats class
  assert.equal(
    tax.taxRuleTie(
      rule(1, { appliesTo: applies({ categoryIds: [categoryC] }) }),
      rule(2),
      null,
    ),
    null,
  );
});

test("same item in two rules ties at item level", () => {
  const itemRule = (n) => rule(n, { appliesTo: applies({ itemIds: [itemX] }) });
  const tie = tax.taxRuleTie(itemRule(1), itemRule(2), null);
  assert.equal(tie?.level, "item");
  assert.equal(tie?.key, itemX);
});

test("same category in two rules ties at category level", () => {
  const categoryRule = (n) =>
    rule(n, { appliesTo: applies({ categoryIds: [categoryC] }) });
  const tie = tax.taxRuleTie(categoryRule(1), categoryRule(2), null);
  assert.equal(tie?.level, "category");
  assert.equal(tie?.key, categoryC);
});

test("channels: same set ties, disjoint sets do not, overlap ties on the shared one", () => {
  const withChannels = (n, channels) => rule(n, { channels });
  assert.ok(
    tax.taxRuleTie(
      withChannels(1, ["dine_in"]),
      withChannels(2, ["dine_in"]),
      null,
    ),
  );
  assert.equal(
    tax.taxRuleTie(
      withChannels(1, ["dine_in"]),
      withChannels(2, ["takeaway"]),
      null,
    ),
    null,
  );
  const tie = tax.taxRuleTie(
    withChannels(1, ["dine_in", "takeaway"]),
    withChannels(2, ["takeaway"]),
    null,
  );
  assert.equal(tie?.channel, "takeaway");
});

test("regions: same ties, different do not", () => {
  const inRegion = (n, regionCode) => rule(n, { regionCode });
  const tie = tax.taxRuleTie(
    inRegion(1, "ID-JB-3273"),
    inRegion(2, "ID-JB-3273"),
    null,
  );
  assert.equal(tie?.regionCode, "ID-JB-3273");
  assert.equal(
    tax.taxRuleTie(inRegion(1, "ID-JB-3273"), inRegion(2, "ID-JB-3204"), null),
    null,
  );
});

test("partial overlap is found whichever rule is broader", () => {
  const narrow = rule(1);
  const broad = rule(2, {
    appliesTo: applies({ itemClasses: ["food_beverage", "facility"] }),
  });
  assert.equal(tax.taxRuleTie(narrow, broad, null)?.key, "food_beverage");
  assert.equal(tax.taxRuleTie(broad, narrow, null)?.key, "food_beverage");
});

test("outlet view: rules of one outlet tie there only", () => {
  const one = rule(1, { outletId: outletA });
  const two = rule(2, { outletId: outletA });
  assert.equal(tax.taxRuleTie(one, two, outletA)?.outletId, outletA);
  assert.equal(tax.taxRuleTie(one, two, null), null);
  assert.equal(tax.taxRuleTie(one, two, outletB), null);
});

test("findTaxRuleTies: publish check names the other rule and reports `a` as the checked rule", () => {
  const old = rule(1);
  const fresh = rule(0, { code: "CUSTOM" }); // lower id than `old`
  const ties = tax.findTaxRuleTies([old, fresh], {
    outletIds: [null],
    from: "2026-11-01",
    onlyRuleId: fresh.id,
  });
  assert.equal(ties.length, 1);
  assert.equal(ties[0].a.id, fresh.id);
  assert.equal(ties[0].b.id, old.id);
  assert.equal(ties[0].effectiveDate, "2026-11-01");
});

test("findTaxRuleTies: onlyRuleId ignores ties between other rules", () => {
  const rules = [
    rule(1),
    rule(2),
    rule(3, { appliesTo: applies({ itemClasses: ["facility"] }) }),
  ];
  assert.equal(
    tax.findTaxRuleTies(rules, {
      outletIds: [null],
      from: "2026-11-01",
      onlyRuleId: rules[2].id,
    }).length,
    0,
  );
  assert.equal(
    tax.findTaxRuleTies(rules, { outletIds: [null], from: "2026-11-01" })
      .length,
    1,
  );
});

test("findTaxRuleTies: a tombstone of the old code clears the tie", () => {
  const old = rule(1);
  const tombstone = rule(3, {
    code: old.code,
    version: 2,
    isActive: false,
    effectiveFrom: "2026-11-01",
  });
  const fresh = rule(2, { effectiveFrom: "2026-11-01" });
  assert.deepEqual(
    tax.findTaxRuleTies([old, tombstone, fresh], {
      outletIds: [null],
      from: "2026-11-01",
      onlyRuleId: fresh.id,
    }),
    [],
  );
});

test("findTaxRuleTies: a tie that starts on a later effectiveFrom is found", () => {
  const old = rule(1);
  const later = rule(2, { effectiveFrom: "2026-12-01" });
  const ties = tax.findTaxRuleTies([old, later], {
    outletIds: [null],
    from: "2026-11-01",
  });
  assert.equal(ties.length, 1);
  assert.equal(ties[0].effectiveDate, "2026-12-01");
});

test("findTaxRuleTies: a later version that ends the old rule removes the tie", () => {
  const old = rule(1);
  const fresh = rule(2, { effectiveFrom: "2026-12-01" });
  const ends = rule(3, {
    code: old.code,
    version: 2,
    isActive: false,
    effectiveFrom: "2026-12-01",
  });
  assert.deepEqual(
    tax.findTaxRuleTies([old, fresh, ends], {
      outletIds: [null],
      from: "2026-11-01",
    }),
    [],
  );
});

test("findTaxRuleTies: draft and superseded versions are ignored", () => {
  const draft = rule(2, {
    status: "draft",
    publishedAt: null,
    publishedBy: null,
  });
  assert.deepEqual(
    tax.findTaxRuleTies([rule(1), draft], {
      outletIds: [null],
      from: "2026-11-01",
    }),
    [],
  );
});

test("findTaxRuleTies: one entry per pair, tenant-wide view first", () => {
  const rules = [rule(1), rule(2)];
  const ties = tax.findTaxRuleTies(rules, {
    outletIds: [outletA, null, outletB],
    from: "2026-11-01",
  });
  assert.equal(ties.length, 1);
  assert.equal(ties[0].outletId, null);
});

test("findTaxRuleTies: outlet-scoped tie shows only in that outlet's view", () => {
  const rules = [
    rule(1, { outletId: outletA }),
    rule(2, { outletId: outletA }),
  ];
  const ties = tax.findTaxRuleTies(rules, {
    outletIds: [null, outletA, outletB],
    from: "2026-11-01",
  });
  assert.equal(ties.length, 1);
  assert.equal(ties[0].outletId, outletA);
});

test("findTaxRuleTies: an outlet version of a code replaces the tenant-wide one", () => {
  const tenantWide = rule(1, { code: "SAME" });
  const outletVersion = rule(2, {
    code: "SAME",
    outletId: outletA,
    appliesTo: applies({ itemClasses: ["facility"] }),
  });
  const other = rule(3, { appliesTo: applies({ itemClasses: ["facility"] }) });
  assert.equal(
    tax.findTaxRuleTies([tenantWide, outletVersion, other], {
      outletIds: [outletA],
      from: "2026-11-01",
    }).length,
    0, // outlet rule outranks the tenant-wide `other`
  );
});

test("findTaxRuleTies: the seeded cafe rules have no ties", () => {
  const seeded = tax.cafeLegendTaxFixtures.taxRules;
  assert.deepEqual(
    tax.findTaxRuleTies(seeded, { outletIds: [null], from: "2026-11-02" }),
    [],
  );
});
