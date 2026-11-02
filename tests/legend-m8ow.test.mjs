// Loyalty back office (bead legend-m8ow; PRD v1.7 §3.20 "Loyalty &
// Membership"). Runs with the root node:test suite, no database: it loads the
// shared CRM contract, the web app's mock runtime and the feature's own
// helpers with Node type stripping. The screens are exercised end-to-end in
// e2e/legend-m8ow.mock.spec.ts; this file proves the data layer, the form
// rules and the mock handlers the screens depend on.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as crm from "../packages/shared/src/crm/index.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import { registeredMockIds } from "../apps/web/src/lib/mock/registry.ts";
import * as lib from "../apps/web/src/features/ws08-loyalty/lib.ts";
import "../apps/web/src/features/ws08-loyalty/mock.ts";

const fixtures = crm.cafeLegendCrmFixtures;

async function get(path, query) {
  return dispatchMock({ method: "GET", path, query });
}

async function send(method, path, body) {
  return dispatchMock({ method, path, body });
}

afterEach(() => {
  setScenario("normal");
  resetMocks();
});

test("legend-m8ow: every loyalty admin endpoint the screens call has a mock", () => {
  const ids = [
    crm.getLoyaltyProgram,
    crm.updateLoyaltyProgram,
    crm.listLoyaltyTiers,
    crm.createLoyaltyTier,
    crm.updateLoyaltyTier,
    crm.listRewards,
    crm.createReward,
    crm.updateReward,
    crm.listMissions,
    crm.createMission,
    crm.updateMission,
  ].map((endpoint) => endpoint.id);
  const registered = registeredMockIds();
  for (const id of ids)
    assert.ok(registered.includes(id), `missing mock ${id}`);
});

// ---- Program (PRD §3.20 "Poin", "Kedaluwarsa Poin") ----------------------

test("PRD §3.20: the program PUT saves the earn ratio, point value and expiry policy", async () => {
  const form = lib.programFormFrom(fixtures.program);
  const body = lib.programBody({
    ...form,
    earnSpend: "15000",
    earnPoints: "2",
    expiry: "18",
    rolling: "6",
    pointValue: "150",
  });
  const saved = await send("PUT", "/api/loyalty/program", body);
  assert.equal(saved.data.earnRate.spendIdr, 15_000);
  assert.equal(saved.data.earnRate.points, 2);
  assert.equal(saved.data.expiryMonths, 18);
  assert.equal(saved.data.rollingMonths, 6);
  assert.equal(saved.data.pointValueIdr, 150);

  const read = await get("/api/loyalty/program");
  assert.equal(read.data.program.expiryMonths, 18);
  assert.equal(read.data.tiers.length, fixtures.tiers.length);
});

test("PRD §3.20: the program form rejects an unusable ratio before it is sent", () => {
  const form = lib.programFormFrom(fixtures.program);
  assert.deepEqual(lib.validateProgramForm(form), {});
  const errors = lib.validateProgramForm({
    ...form,
    earnSpend: "0",
    earnPoints: "",
    expiry: "61",
    rolling: "0",
    pointValue: "-5",
  });
  assert.equal(errors.earnSpend, "loyalty.program.errors.earnSpend");
  assert.equal(errors.earnPoints, "loyalty.program.errors.earnPoints");
  assert.equal(errors.expiry, "loyalty.program.errors.expiry");
  assert.equal(errors.rolling, "loyalty.program.errors.rolling");
  assert.equal(errors.pointValue, "loyalty.program.errors.pointValue");
});

// ---- Tiers (PRD §3.20 "Tier") -------------------------------------------

test("PRD §3.20: a tier saves its ladder position and benefits", async () => {
  const form = {
    ...lib.emptyTierForm(),
    name: "Obsidian",
    rank: "4",
    spend: "15000000",
    visits: "45",
    multiplier: "2,5",
    birthdayPoints: "500",
    reservationPriority: true,
    exclusivePromotions: true,
    facilityQuota: "6",
  };
  assert.deepEqual(lib.validateTierForm(form), {});
  const body = lib.tierBody(form);
  assert.equal(body.benefits.pointsMultiplierBp, 25_000);

  const created = await send("POST", "/api/loyalty/tiers", body);
  assert.equal(created.data.name, "Obsidian");
  assert.equal(created.data.benefits.birthdayRewardPoints, 500);

  const patched = await send("PATCH", `/api/loyalty/tiers/${created.data.id}`, {
    isActive: false,
  });
  assert.equal(patched.data.isActive, false);
  assert.equal(patched.data.rank, 4);

  const list = await get("/api/loyalty/tiers");
  assert.equal(
    list.data.filter((tier) => tier.id === created.data.id).length,
    1,
  );
});

test("PRD §3.20: the tier form only accepts a 1x-10x multiplier", () => {
  assert.equal(lib.parseMultiplier("1,5"), 15_000);
  assert.equal(lib.parseMultiplier("1.5"), 15_000);
  assert.equal(lib.parseMultiplier("1"), 10_000);
  assert.equal(lib.parseMultiplier("10"), 100_000);
  assert.equal(lib.parseMultiplier("0,9"), null);
  assert.equal(lib.parseMultiplier("10,1"), null);
  assert.equal(lib.parseMultiplier(""), null);
  assert.equal(lib.formatMultiplier(15_000), "1,5×");
  assert.equal(lib.formatMultiplier(10_000), "1×");
});

// ---- Rewards (PRD §3.20 "Reward Katalog") --------------------------------

test("PRD §3.20 Reward: the reward list serves stock and validity from the contract fixtures", async () => {
  const page = await get("/api/loyalty/rewards", { limit: "100" });
  assert.equal(page.data.length, fixtures.rewards.length);
  const first = page.data.find(
    (reward) => reward.id === fixtures.rewards[0].id,
  );
  assert.ok(first);
  assert.equal(first.stock, 40);
  assert.ok(first.validUntil);
  assert.equal(first.menuItemId, fixtures.menuItems.kopiSusuAren);

  const inactive = await get("/api/loyalty/rewards", {
    limit: "100",
    active: "false",
  });
  assert.ok(inactive.data.length > 0);
  assert.ok(inactive.data.every((reward) => !reward.isActive));
});

test("PRD §3.20 Reward: the reward form needs a valid stock and validity window before save", () => {
  const base = {
    ...lib.emptyRewardForm(),
    name: "Voucher Uji",
    type: "voucher",
    voucherValue: "10000",
  };
  assert.deepEqual(lib.validateRewardForm(base), {});
  const errors = lib.validateRewardForm({
    ...base,
    validUntil: "2026-09-30",
    validFrom: "2026-10-01",
    stock: "-1",
  });
  assert.equal(errors.validUntil, "loyalty.rewards.errors.validUntil");
  assert.equal(errors.stock, "loyalty.rewards.errors.stock");
  assert.equal(
    lib.validateRewardForm({ ...base, voucherValue: "" }).voucherValue,
    "loyalty.rewards.errors.voucherValue",
  );
  assert.equal(
    lib.validateRewardForm({
      ...base,
      type: "free_item",
      voucherValue: "",
      menuItemId: "",
    }).menuItemId,
    "loyalty.rewards.errors.menuItem",
  );
});

test("PRD §3.20 Reward: creating a voucher reward keeps points, stock and validity", async () => {
  const body = lib.rewardBody({
    ...lib.emptyRewardForm(),
    name: "Voucher Uji",
    type: "voucher",
    pointsCost: "120",
    stock: "5",
    validFrom: "2026-11-01",
    validUntil: "2026-12-31",
    voucherValue: "10000",
  });
  const created = await send("POST", "/api/loyalty/rewards", body);
  assert.equal(created.data.stock, 5);
  assert.equal(created.data.voucherValueIdr, 10_000);
  assert.equal(created.data.validFrom, "2026-10-31T17:00:00.000Z");
  assert.equal(created.data.validUntil, "2026-12-31T16:59:59.000Z");

  const page = await get("/api/loyalty/rewards", { limit: "100" });
  assert.ok(page.data.some((reward) => reward.id === created.data.id));
});

test("legend-m8ow review: reward validity uses outlet (WIB) business days and round-trips", () => {
  // Business dates live in the outlet time zone (AGENT_PLAYBOOK §2), not UTC.
  assert.equal(
    lib.isoFromDateInput("2026-11-01", "start"),
    "2026-10-31T17:00:00.000Z",
  );
  assert.equal(
    lib.isoFromDateInput("2026-11-01", "end"),
    "2026-11-01T16:59:59.000Z",
  );
  assert.equal(lib.dateInputValue("2026-10-31T17:00:00.000Z"), "2026-11-01");
  assert.equal(lib.dateInputValue("2026-11-01T16:59:59.000Z"), "2026-11-01");
  assert.equal(lib.formatDateShort("2026-10-31T17:00:00.000Z"), "01/11/2026");
  // A one-day reward (from = until) is valid: the end is that day's close.
  const oneDay = {
    ...lib.emptyRewardForm(),
    name: "Hari Ini",
    type: "voucher",
    voucherValue: "10000",
    validFrom: "2026-11-01",
    validUntil: "2026-11-01",
  };
  assert.equal(lib.validateRewardForm(oneDay).validUntil, undefined);
});

// ---- Missions (PRD §3.20 "Mission") -------------------------------------

test("PRD §3.20: a stamp card mission is created with its stamp target", async () => {
  const form = {
    ...lib.emptyMissionForm(),
    name: "Stamp Card 5 Kopi",
    type: "stamp_card",
    stamps: "5",
  };
  assert.deepEqual(lib.validateMissionForm(form), {});
  const body = lib.missionBody(form);
  assert.equal(body.rule.kind, "stamp_card");
  assert.equal(body.rule.stampsRequired, 5);

  const created = await send("POST", "/api/loyalty/missions", body);
  assert.equal(created.data.type, "stamp_card");
  assert.equal(created.data.rule.stampsRequired, 5);

  const page = await get("/api/loyalty/missions", { limit: "100" });
  assert.ok(page.data.some((mission) => mission.id === created.data.id));
});

test("PRD §3.20: weekday missions need at least one day and a target", () => {
  const form = {
    ...lib.emptyMissionForm(),
    name: "Ngopi Hari Kerja",
    type: "weekday_visit",
    weekdays: [],
    targetVisits: "0",
  };
  const errors = lib.validateMissionForm(form);
  assert.equal(errors.weekdays, "loyalty.missions.errors.weekdays");
  assert.equal(errors.targetVisits, "loyalty.missions.errors.target");

  const body = lib.missionBody({
    ...form,
    weekdays: [3, 1],
    targetVisits: "2",
  });
  assert.deepEqual(body.rule.weekdays, [1, 3]);
  assert.equal(body.rule.targetVisits, 2);
});

test("PRD §3.20: mission summaries describe rule, reward and period", () => {
  const [visitMission] = fixtures.missions;
  assert.deepEqual(
    lib.missionRuleSummary(visitMission.rule, (day) => String(day)),
    { key: "loyalty.missions.summary.visits", vars: { count: 3 } },
  );
  const weekday = lib.missionRuleSummary(
    { kind: "weekday_visit", weekdays: [5, 1], targetVisits: 2 },
    (day) => lib.WEEKDAY_KEYS[day] && `d${day}`,
  );
  assert.equal(weekday.vars.days, "d1, d5");
  assert.deepEqual(
    lib.missionRewardSummary(
      { kind: "voucher", valueIdr: 20_000, validDays: 30 },
      (value) => `Rp ${value}`,
    ),
    {
      key: "loyalty.missions.summary.voucher",
      vars: { value: "Rp 20000" },
    },
  );
  assert.equal(
    lib.missionPeriodSummary({ kind: "monthly" }, String).key,
    "loyalty.missions.periods.monthly",
  );
  assert.deepEqual(
    lib.missionPeriodSummary(
      { kind: "date_range", start: "2026-11-01", end: "2026-11-30" },
      lib.formatDateLabel,
    ),
    {
      key: "loyalty.missions.summary.dateRange",
      vars: { start: "1 Nov 2026", end: "30 Nov 2026" },
    },
  );
});

// ---- Mock scenarios ------------------------------------------------------

test("legend-m8ow: ?mock=empty shows the empty lists while the program still exists", async () => {
  setScenario("empty");
  const program = await get("/api/loyalty/program");
  assert.equal(program.data.program.name, fixtures.program.name);
  assert.deepEqual(program.data.tiers, []);
  assert.deepEqual((await get("/api/loyalty/tiers")).data, []);
  assert.deepEqual(
    (await get("/api/loyalty/rewards", { limit: "10" })).data,
    [],
  );
  assert.deepEqual(
    (await get("/api/loyalty/missions", { limit: "10" })).data,
    [],
  );
});
