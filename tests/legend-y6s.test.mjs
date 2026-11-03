// Platform ops screens (bead legend-y6s; PRD v1.7 §3 F4 "Feature Flag & Paket",
// "Kuota & Plafon"; TEN-05). Pure logic of
// apps/web/src/features/ws01-platform-ops/logic.ts checked against the platform
// contract and its fixtures. Acceptance ID in every test name: TEN-05.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  auditEventSchema,
  cafeLegendAuditFixtures,
} from "../packages/shared/src/audit/index.ts";
import {
  INTEGRATION_PROVIDERS,
  MODULE_KEYS,
  cafeLegendPlatformFixtures as fixtures,
  COST_CAPS,
  COUNT_QUOTAS,
  checkCountQuota,
  evaluateCostCap,
} from "../packages/shared/src/platform/index.ts";
import {
  attentionItems,
  auditMatches,
  blockedModules,
  changeRows,
  diffList,
  draftFromLimits,
  jakartaDayRange,
  limitWarnings,
  limitsChanged,
  nextModules,
  nextProviders,
  parseLimitsDraft,
  providersByCategory,
  quotaState,
  tenantCounts,
  usagePercent,
} from "../apps/web/src/features/ws01-platform-ops/logic.ts";

const [full, basic] = fixtures.packages;

describe("TEN-05 modules and packages", () => {
  test("TEN-05 · toggling a module keeps contract order and never duplicates", () => {
    const on = nextModules(["pos", "kds"], "inventory", true);
    assert.deepEqual(on, ["pos", "kds", "inventory"]);
    assert.deepEqual(nextModules(on, "inventory", true), on);
    assert.deepEqual(nextModules(on, "kds", false), ["pos", "inventory"]);
    assert.ok(
      nextModules([], "mcp", true).every((key) => MODULE_KEYS.includes(key)),
    );
  });

  test("TEN-05 · modules outside the package block the save (MODULE_NOT_IN_PACKAGE)", () => {
    assert.deepEqual(blockedModules(["pos", "mcp"], full), []);
    const blocked = blockedModules([...full.modules], basic);
    assert.ok(blocked.includes("accounting"));
    assert.ok(!blocked.includes("pos"));
    assert.deepEqual(blockedModules(["pos"], undefined), []);
  });

  test("TEN-05 · diffList reports added and removed entries", () => {
    assert.deepEqual(diffList(["pos", "kds"], ["kds", "crm"]), {
      added: ["crm"],
      removed: ["pos"],
    });
  });

  test("TEN-05 · every gateway belongs to exactly one category group", () => {
    const listed = providersByCategory().flatMap((group) => group.providers);
    assert.deepEqual([...listed].sort(), [...INTEGRATION_PROVIDERS].sort());
    assert.equal(providersByCategory()[0].category, "payment_gateway");
    assert.deepEqual(nextProviders(["doit"], "email", true), ["doit", "email"]);
  });
});

describe("TEN-05 quotas and caps", () => {
  test("TEN-05 · limits draft round-trips and accepts dotted rupiah", () => {
    const draft = draftFromLimits(fixtures.tenant.limits);
    const parsed = parseLimitsDraft(draft);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.limits, fixtures.tenant.limits);
    const dotted = parseLimitsDraft({ ...draft, aiCostCapIdr: "1.500.000" });
    assert.equal(dotted.limits.aiCostCapIdr, 1_500_000);
    assert.deepEqual(limitsChanged(fixtures.tenant.limits, dotted.limits), [
      "aiCostCapIdr",
    ]);
  });

  test("TEN-05 · limits draft rejects empty, non-numeric and out-of-range values", () => {
    const draft = draftFromLimits(fixtures.tenant.limits);
    assert.equal(
      parseLimitsDraft({ ...draft, maxOutlets: "" }).errors.maxOutlets,
      "required",
    );
    assert.equal(
      parseLimitsDraft({ ...draft, maxDevices: "-3" }).errors.maxDevices,
      "invalid",
    );
    assert.equal(
      parseLimitsDraft({ ...draft, maxOutlets: "2,5" }).errors.maxOutlets,
      "invalid",
    );
    const range = parseLimitsDraft({ ...draft, maxOutlets: "2000000" });
    assert.equal(range.ok, false);
    assert.equal(range.errors.maxOutlets, "range");
    assert.equal(range.limits, null);
  });

  test("TEN-05 · below 30 active employees warns (D27); below usage warns without blocking", () => {
    const low = { ...fixtures.tenant.limits, maxActiveEmployees: 20 };
    const warnings = limitWarnings(low, fixtures.usage);
    assert.equal(warnings.maxActiveEmployees, "belowUsage");
    const lowUnused = limitWarnings(
      { ...low, maxActiveEmployees: 29 },
      { ...fixtures.usage, activeEmployees: 3 },
    );
    assert.equal(lowUnused.maxActiveEmployees, "belowDefault");
    assert.deepEqual(limitWarnings(fixtures.tenant.limits, fixtures.usage), {});
  });

  test("TEN-05 · quota bars warn at 80% and stop at 100% like cost caps (R18)", () => {
    assert.equal(quotaState(79, 100), "ok");
    assert.equal(quotaState(80, 100), "warning");
    assert.equal(quotaState(100, 100), "stopped");
    assert.equal(quotaState(0, 0), "ok");
    assert.equal(quotaState(1, 0), "stopped");
    assert.equal(usagePercent(34, 40), 85);
    assert.equal(usagePercent(500, 40), 100);
    assert.equal(usagePercent(0, 0), 0);
  });

  test("TEN-05 · attention list flags the WhatsApp cap at 83% and ignores caps set to 0", () => {
    const { tenant, usage } = fixtures;
    const view = {
      quotas: COUNT_QUOTAS.map((quota) => {
        const { limit, used } = checkCountQuota(tenant.limits, usage, quota);
        return { quota, limit, used };
      }),
      costCaps: COST_CAPS.map((cap) => ({
        cap,
        ...evaluateCostCap(tenant.limits, usage, cap),
      })),
    };
    const items = attentionItems(tenant.id, view);
    const whatsapp = items.find((item) => item.key === "whatsapp");
    assert.equal(whatsapp.state, "warning");
    assert.equal(whatsapp.percent, 83);
    const off = attentionItems(tenant.id, {
      quotas: [],
      costCaps: [{ cap: "whatsapp", state: "stopped", capIdr: 0, spentIdr: 0 }],
    });
    assert.deepEqual(off, []);
  });

  test("TEN-05 · tenant counts group the registry by status", () => {
    const counts = tenantCounts([fixtures.tenant, fixtures.suspendedTenant]);
    assert.deepEqual(counts, {
      active: 1,
      suspended: 1,
      archived: 0,
      total: 2,
    });
  });
});

describe("TEN-05 cross-tenant audit", () => {
  const events = cafeLegendAuditFixtures;

  test("TEN-05 · day pickers become Asia/Jakarta whole-day instants", () => {
    assert.deepEqual(jakartaDayRange("2026-11-03", "2026-11-03"), {
      from: "2026-11-02T17:00:00.000Z",
      to: "2026-11-03T16:59:59.999Z",
    });
    assert.deepEqual(jakartaDayRange("", "nonsense"), {});
  });

  test("TEN-05 · filters match tenant, actor kind, action prefix and date range", () => {
    const [user] = events;
    assert.ok(auditMatches(user, { tenantId: user.tenantId }));
    assert.ok(!auditMatches(user, { tenantId: fixtures.suspendedTenant.id }));
    assert.ok(auditMatches(user, { action: "Settings." }));
    assert.ok(!auditMatches(user, { action: "role." }));
    assert.ok(auditMatches(user, { actorType: "user" }));
    assert.ok(!auditMatches(user, { actorType: "system" }));
    assert.ok(auditMatches(user, jakartaDayRange("2026-11-01", "2026-11-01")));
    assert.ok(!auditMatches(user, jakartaDayRange("2026-11-02", "2026-11-03")));
  });

  test("TEN-05 · detail rows show masked before/after field by field", () => {
    assert.deepEqual(changeRows(events[0].maskedChanges), [
      { field: "status", before: "preopening", after: "active" },
    ]);
    assert.deepEqual(changeRows({ before: null, after: null }), []);
    assert.deepEqual(changeRows({ before: "a", after: 2 }), [
      { field: "", before: "a", after: "2" },
    ]);
    const parsed = auditEventSchema.parse({
      ...events[0],
      maskedChanges: { before: { a: 1 }, after: { b: 2 } },
    });
    assert.deepEqual(
      changeRows(parsed.maskedChanges).map((row) => row.field),
      ["a", "b"],
    );
  });
});
