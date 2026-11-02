// Kitchen config & analytics logic (bead legend-uq2). PRD v1.7 §3 F12
// "Analitik Serving Time", "Order Pacing", "Remake & Comp"; acceptance IDs
// KDS-05 (capacity drives the pacing/estimate refresh) and KDS-07 (remake and
// comp record reason, user, ingredient cost).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as kitchen from "../packages/shared/src/kitchen/index.ts";
import {
  CAPACITY_CHANNELS,
  draftProblem,
  draftToRuleInput,
  draftsToRuleInputs,
  durationParts,
  moveChannel,
  periodIncludesDate,
  recentBusinessPeriod,
  rulesToDrafts,
  shortRef,
} from "../apps/web/src/features/ws04-kitchen-config/lib.ts";

const fixtures = kitchen.cafeLegendKitchenFixtures.capacityRules;

test("KDS-05: reading a station's rules and saving them back keeps every window", () => {
  const kitchenRules = fixtures.filter(
    (rule) => rule.stationId === fixtures[0].stationId,
  );
  const drafts = rulesToDrafts(kitchenRules);
  assert.equal(drafts.length, kitchenRules.length);

  const inputs = draftsToRuleInputs(drafts);
  assert.ok(inputs);
  assert.deepEqual(
    inputs.map((rule) => ({
      windowMinutes: rule.windowMinutes,
      capacityPoints: rule.capacityPoints,
      nearCapacityBp: rule.nearCapacityBp,
    })),
    kitchenRules.map((rule) => ({
      windowMinutes: rule.windowMinutes,
      capacityPoints: rule.capacityPoints,
      nearCapacityBp: rule.nearCapacityBp,
    })),
    "an untouched editor sends the stored values",
  );
  assert.deepEqual(inputs[0].schedule, kitchenRules[0].schedule);
  assert.deepEqual(inputs[0].channelPriority, kitchenRules[0].channelPriority);
});

test("KDS-05: capacity rules reject empty, inverted and out-of-range windows", () => {
  const [draft] = rulesToDrafts([fixtures[0]]);
  assert.equal(draftProblem(draft), null);
  assert.equal(draftProblem({ ...draft, capacityPoints: "0" }), "capacity");
  assert.equal(draftProblem({ ...draft, capacityPoints: "12.5" }), "capacity");
  assert.equal(draftProblem({ ...draft, nearPercent: "101" }), "near");
  assert.equal(
    draftProblem({
      ...draft,
      schedules: [{ daysOfWeek: [], start: "08:00", end: "22:00" }],
    }),
    "days",
  );
  assert.equal(
    draftProblem({
      ...draft,
      schedules: [{ daysOfWeek: [1], start: "22:00", end: "08:00" }],
    }),
    "time",
  );
  assert.equal(draftProblem({ ...draft, channelPriority: [] }), "channels");
  assert.equal(
    draftProblem({
      ...draft,
      channelPriority: ["dine_in", "dine_in"],
    }),
    "channels",
  );
  assert.equal(draftToRuleInput({ ...draft, capacityPoints: "abc" }), null);
  assert.equal(draftsToRuleInputs([]), null);
});

test("KDS-05: capacity channel priority can be reordered without losing a channel", () => {
  const channels = [...CAPACITY_CHANNELS];
  const moved = moveChannel(channels, "gofood", -1);
  assert.deepEqual(moved, [
    "dine_in",
    "gofood",
    "takeaway",
    "grabfood",
    "shopeefood",
    "reservation",
  ]);
  assert.deepEqual(moveChannel(channels, "dine_in", -1), channels);
  assert.deepEqual(moveChannel(channels, "reservation", 1), channels);
  assert.equal(new Set(moved).size, channels.length);
});

test("F12: serving-time period and duration helpers keep the report readable", () => {
  assert.equal(
    periodIncludesDate("2026-10-26", "2026-11-02", "2026-11-01"),
    true,
  );
  assert.equal(
    periodIncludesDate("2026-11-02", "2026-11-08", "2026-11-01"),
    false,
  );
  assert.deepEqual(durationParts(660), { minutes: 11, seconds: 0 });
  assert.deepEqual(durationParts(725), { minutes: 12, seconds: 5 });
});

test("KDS-07: id references for the remake/comp log stay short and stable", () => {
  assert.equal(shortRef("01JBQ7Z8K3M4N5P6Q7R8S9T0VY", 6), "S9T0VY");
  assert.equal(shortRef("00000000-0000-4000-8000-000000000500"), "0500");
});

test("KDS-05: the config screen can read capacity rules before replacing them", () => {
  assert.equal(
    kitchen.listCapacityRules.path,
    "/api/outlets/:outletId/kitchen/capacity-rules",
  );
  assert.equal(kitchen.listCapacityRules.method, "GET");
  const parsed = kitchen.listCapacityRules.response.parse({
    data: kitchen.cafeLegendKitchenFixtures.capacityRules,
  });
  assert.equal(
    parsed.data.length,
    kitchen.cafeLegendKitchenFixtures.capacityRules.length,
  );
});

test("F12 review: the serving-time default period uses the outlet business day", () => {
  // 2026-11-01T18:30Z is 01:30 WIB on 2 Nov: the report ends on 2 Nov.
  assert.deepEqual(
    recentBusinessPeriod(new Date("2026-11-01T18:30:00Z"), "Asia/Jakarta"),
    { startDate: "2026-10-27", endDate: "2026-11-02" },
  );
  // Month boundary: seven days ending 3 Mar 2026 starts 25 Feb.
  assert.deepEqual(
    recentBusinessPeriod(new Date("2026-03-03T05:00:00Z"), "Asia/Jakarta"),
    { startDate: "2026-02-25", endDate: "2026-03-03" },
  );
});
