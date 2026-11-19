import assert from "node:assert/strict";
import { test } from "node:test";

import { cafeLegendFacilityFixtures as facilityFixture } from "../packages/shared/src/facility/fixtures.ts";
import * as platform from "../packages/shared/src/platform/index.ts";
import { cafeLegendTaxFixtures as taxFixture } from "../packages/shared/src/tax/fixtures.ts";

// legend-srfud: platform/config-codecs.ts `configBundleReferenceIssues` (the
// template/structural check run by the bundle schema) assumes every tax rule
// referenced by facilities is tenant-wide and the loyalty point value is
// unlocked. No API caller of `decodeConfigBundle` exists yet, so the import
// path must refuse to lean on those template assumptions: the tax-rule owner
// and the point-value lock must come from the target explicitly.
//
// Assumption (spec is silent on the exact API): a decode that carries an
// outlet-scoped tax rule but gets no `existingOutletKeys` cannot verify the
// rule owner and must refuse it (fail closed), while a tenant-wide rule needs
// no outlet list. Saving a template (parseConfigBundle) keeps its behaviour.

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

const decode = (sections, options) =>
  platform.decodeConfigBundle(bundle(sections), options);

function refused(result, section, reference) {
  assert.equal(result.ok, false, JSON.stringify(result));
  const issues = result.issues.filter((issue) => issue.section === section);
  assert.ok(issues.length > 0, JSON.stringify(result.issues));
  assert.match(JSON.stringify(issues), reference);
  assert.equal(Object.hasOwn(result, "drafts"), false);
}

const taxItems = platform.CONFIG_SECTION_CODECS.tax_rules.toTemplate(
  [taxFixture.taxRules[1]],
  { asOf: "2026-11-12", settings: [] },
);
const taxKey = taxItems[0].key;
// Facilities of outlet "cafe" whose product points at the tax rule by key only.
const facilities = platform.CONFIG_SECTION_CODECS.facilities
  .toTemplate(
    {
      facilities: [facilityFixture.facilities[0]],
      products: [{ ...facilityFixture.products[0], taxRuleId: null }],
    },
    { outletKeys: new Map([[facilityFixture.outlet.id, "cafe"]]) },
  )
  .map((item) =>
    item.kind === "product" ? { ...item, taxRuleKey: taxKey } : item,
  );
const outletRule = (outletKey) =>
  taxItems.map((item) => ({ ...item, outletKey }));

test("legend-srfud: import with the target outlet list refuses an unknown tax-rule outlet", () => {
  // Without a target outlet list the outlet check defers (538-G1 legacy test in
  // platform-config-codecs-cross-sections.test.mjs); with the list supplied the
  // unknown outlet is refused and a known outlet is accepted.
  const outletKeys = new Set(["cafe"]);
  refused(
    decode(
      { tax_rules: outletRule("other") },
      { lockedPointValueIdr: null, existingOutletKeys: outletKeys },
    ),
    "tax_rules",
    /outlet/i,
  );
  const known = decode(
    { tax_rules: outletRule("cafe") },
    { lockedPointValueIdr: null, existingOutletKeys: outletKeys },
  );
  assert.equal(known.ok, true, JSON.stringify(known.issues));
});

test("legend-srfud: tenant-wide tax rules still import without an outlet list", () => {
  const result = decode(
    { tax_rules: outletRule(null) },
    { lockedPointValueIdr: null },
  );
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("legend-srfud: facilities referencing a tax rule need the explicit target owner, never the tenant-wide assumption", () => {
  const base = { lockedPointValueIdr: null };
  for (const options of [
    undefined,
    base,
    { ...base, existingTaxRuleOutletKeyByKey: new Map() },
    // A tax rule owned by another outlet than the facility is refused.
    {
      ...base,
      existingTaxRuleOutletKeyByKey: new Map([[taxKey, "other"]]),
    },
  ])
    refused(decode({ facilities }, options), "facilities", /tax/i);
  for (const owner of [null, "cafe"]) {
    const accepted = decode(
      { facilities },
      {
        ...base,
        existingTaxRuleOutletKeyByKey: new Map([[taxKey, owner]]),
      },
    );
    assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  }
});

test("legend-srfud: loyalty import needs the explicit target lock decision and honors a locked value", () => {
  const sections = { loyalty_policy: [program] };
  for (const options of [
    undefined,
    {},
    { lockedPointValueIdr: undefined },
    { lockedPointValueIdr: 0 },
    { lockedPointValueIdr: 1.5 },
  ])
    refused(decode(sections, options), "loyalty_policy", /lock/i);
  // The target's frozen value differs from the bundle: refused.
  refused(
    decode(sections, { lockedPointValueIdr: 200 }),
    "loyalty_policy",
    /locked/i,
  );
  for (const lockedPointValueIdr of [null, 100]) {
    const accepted = decode(sections, { lockedPointValueIdr });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.issues));
  }
});

test("legend-srfud: saving a template keeps its structural assumptions", () => {
  // Template validation has no target: a facilities-only bundle may reference
  // a tax rule of the target tenant, and loyalty is not lock-checked.
  for (const sections of [{ facilities }, { loyalty_policy: [program] }]) {
    const parsed = platform.parseConfigBundle(bundle(sections));
    assert.equal(parsed.ok, true, JSON.stringify(parsed.schemaIssues));
  }
  // An outlet-scoped tax rule inside a template stays storable.
  const parsed = platform.parseConfigBundle(
    bundle({ tax_rules: outletRule("cafe") }),
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed.schemaIssues));
});
