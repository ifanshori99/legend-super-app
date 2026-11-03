import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as logic from "../apps/web/src/features/ws01-platform-tenants/logic.ts";
import { platformTenantsMessages } from "../packages/shared/src/i18n/messages/ws01-platform-tenants.ts";
import { cafeLegendPlatformFixtures } from "../packages/shared/src/platform/index.ts";

// Panel Platform tenant screens (legend-tno, PRD v1.7 §3 F1/F4, §4 Alur R).
// TEN-06: tenants, brands, outlets and legal entities are data made from the
// panel, validated by the contract's schemas.

const packages = cafeLegendPlatformFixtures.packages;
const draft = () => ({
  tenant: {
    name: "Kopi Senja",
    slug: "kopi-senja",
    slugTouched: false,
    plan: packages[0].key,
    deploymentMode: "dedicated",
  },
  brand: { name: "Kopi Senja", slug: "kopi-senja", slugTouched: false },
  outlet: { code: "KS-01", name: "Kopi Senja Dago", address: "Jl. Dago 1" },
  legal: {
    name: "PT Senja",
    npwp: "01.234.567.8-901.000",
    isPkp: true,
    address: "",
  },
  admin: { name: "Sari", whatsapp: "0812-3456-7890", email: "" },
});

test("TEN-06 · every wizard step passes with valid input and builds contract payloads", () => {
  const d = draft();
  for (const step of logic.WIZARD_STEPS)
    assert.deepEqual(logic.validateStep(step, d, packages), {}, step);
  assert.equal(logic.firstInvalidStep(d, packages), null);
  const tenant = logic.buildTenantInput(d, packages[0]);
  assert.equal(tenant.firstAdmin.whatsapp, "6281234567890");
  assert.equal(tenant.firstAdmin.email, null);
  assert.deepEqual(tenant.featureFlags.modules, packages[0].modules);
  const legal = logic.buildLegalEntityInput(d);
  assert.equal(legal.npwp, "012345678901000");
  const outlet = logic.buildOutletInput(d, {
    brandId: cafeLegendPlatformFixtures.brand.id,
    legalEntityId: cafeLegendPlatformFixtures.legalEntity.id,
  });
  assert.equal(outlet.openingHours.mon.opens, "08:00");
});

test("TEN-06 · invalid fields are reported per step with the contract schemas", () => {
  const d = draft();
  d.tenant.slug = "Bad Slug";
  d.tenant.plan = "nope";
  assert.ok(logic.validateStep("tenant", d, packages).slug);
  assert.ok(logic.validateStep("tenant", d, packages).plan);
  d.outlet.code = "bad code";
  assert.ok(logic.validateStep("outlet", d).outletCode);
  d.legal.npwp = "123";
  assert.ok(logic.validateStep("legal", d).npwp);
  d.legal.npwp = "";
  assert.ok(logic.validateStep("legal", d).npwp, "PKP needs an NPWP");
  d.legal.isPkp = false;
  assert.deepEqual(logic.validateStep("legal", d), {});
  d.admin.whatsapp = "12345";
  assert.ok(logic.validateStep("admin", d).whatsapp);
  d.admin.whatsapp = "0812 3456 7890";
  d.admin.email = "not-an-email";
  assert.ok(logic.validateStep("admin", d).email);
});

test("TEN-06 · retired packages cannot be assigned", () => {
  const retired = [{ ...packages[0], status: "retired" }];
  assert.ok(logic.validateStep("tenant", draft(), retired).plan);
});

test("TEN-06 · status actions follow the contract transitions", () => {
  assert.deepEqual(logic.statusActions("active"), ["suspended"]);
  assert.deepEqual(logic.statusActions("suspended"), ["active"]);
  assert.deepEqual(logic.statusActions("archived"), []);
  assert.equal(logic.validateReason("short"), false);
  assert.equal(logic.validateReason("Tunggakan langganan"), true);
});

test("TEN-06 · helpers: slug, whatsapp, usage thresholds, list query, NPWP mask", () => {
  assert.equal(logic.slugify("Kopi Senja & Co!"), "kopi-senja-co");
  assert.equal(logic.normalizeWhatsapp("+62 812-3456-7890"), "6281234567890");
  assert.equal(logic.usageTone(79, 100), "success");
  assert.equal(logic.usageTone(80, 100), "warning");
  assert.equal(logic.usageTone(100, 100), "danger");
  assert.equal(logic.usageTone(0, 0), "danger");
  assert.deepEqual(logic.buildListQuery({ status: "all", search: "  " }), {
    limit: logic.TENANT_PAGE_SIZE,
  });
  assert.deepEqual(
    logic.buildListQuery({ status: "active", search: "kopi", cursor: "c" }),
    { limit: logic.TENANT_PAGE_SIZE, cursor: "c", status: "active", q: "kopi" },
  );
  assert.equal(logic.maskNpwp("1234"), "••••1234");
  assert.equal(logic.maskNpwp(null), null);
});

test("TEN-06 · every static platformTenants text key used by the feature exists", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  };
  walk("apps/web/src/features/ws01-platform-tenants");
  const has = (path) =>
    path
      .split(".")
      .reduce((node, part) => node?.[part], platformTenantsMessages) !==
    undefined;
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(
      /platformTenants\.([A-Za-z_.]+[A-Za-z_])(?![A-Za-z_.${])/g,
    ))
      assert.ok(has(m[1]), `${file}: platformTenants.${m[1]}`);
  }
  // Module labels cover every module key.
  for (const key of cafeLegendPlatformFixtures.tenant.featureFlags.modules)
    assert.ok(platformTenantsMessages.modules[key], key);
});
