// Mock handlers for VITE_API_MOCK=true: station config, capacity rules,
// pacing, serving-time analytics and the remake/comp log come from the kitchen
// fixtures (@starter/shared/kitchen), so all three screens work without an API
// (docs/frontend.md, "Typed endpoints and mock mode"). The handlers behave like
// the service they stand for: replacing rules changes what the pacing screen
// reports, and only the requested period and group come back.
import {
  capacityLevelFor,
  cafeLegendKitchenFixtures,
  getPacing,
  getServingTimeSummary,
  listCapacityRules,
  listKitchenStations,
  listOrderIssues,
  orderIssueViews,
  updateCapacityRules,
  updateKitchenStations,
} from "@starter/shared/kitchen";
import type {
  CapacityRule,
  StationConfig,
  PacingSnapshot,
  ServingTimeSummary,
} from "@starter/shared/kitchen";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { FIXTURE_BUSINESS_DATE } from "./outlet.ts";
import { periodIncludesDate } from "./lib.ts";

const { stationConfigs, capacityRules, pacing, servingTimeSummaries } =
  cafeLegendKitchenFixtures;

/** Fixtures stay immutable: the stores own the copies the screens mutate. */
function seedRules(): CapacityRule[] {
  return capacityRules.map((rule) => ({
    ...rule,
    schedule: rule.schedule.map((entry) => ({
      ...entry,
      daysOfWeek: [...entry.daysOfWeek],
    })),
    channelPriority: [...rule.channelPriority],
  })) as CapacityRule[];
}

function seedPacing(): PacingSnapshot {
  return {
    ...pacing,
    stations: pacing.stations.map((station) => ({ ...station })),
  } as PacingSnapshot;
}

function seedSummaries(): ServingTimeSummary[] {
  return servingTimeSummaries.map((row) => ({
    ...row,
  })) as ServingTimeSummary[];
}

function seedStationConfigs(): StationConfig[] {
  return stationConfigs.map((config) => ({ ...config })) as StationConfig[];
}

const stations = createMockStore<StationConfig[]>(seedStationConfigs);
const rules = createMockStore<CapacityRule[]>(seedRules);
const pacingStore = createMockStore<PacingSnapshot>(seedPacing);
const summaries = createMockStore<ServingTimeSummary[]>(seedSummaries);

/** Deterministic ids keep a screenshot's DOM stable between renders. */
let createdRule = 0;
const nextRuleId = () =>
  `00000000-0000-4000-8000-${String(2100 + createdRule++).padStart(12, "0")}`;

// Like the API, every read is scoped to the outlet in the path.
registerMock(listKitchenStations, ({ params, scenario }) => {
  if (scenario === "empty") return { data: [] };
  return {
    data: stations
      .get()
      .filter((config) => config.outletId === params.outletId),
  };
});

// Replaces order and flags of every station of the outlet at once, like the
// endpoint (@starter/shared/kitchen). Unknown or missing stations refuse the
// whole save, so a reorder is never half applied.
registerMock(updateKitchenStations, ({ params, body }) => {
  const own = stations
    .get()
    .filter((config) => config.outletId === params.outletId);
  const sent = new Set(body.stations.map((row) => row.stationId));
  if (
    sent.size !== body.stations.length ||
    sent.size !== own.length ||
    own.some((config) => !sent.has(config.stationId))
  )
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Daftar stasiun tidak sesuai dengan stasiun outlet.",
    );
  const next = own.map((config) => {
    const row = body.stations.find(
      (entry) => entry.stationId === config.stationId,
    )!;
    return {
      ...config,
      displayOrder: row.displayOrder,
      isActive: row.isActive,
      autoPrintFallback: row.autoPrintFallback,
    };
  });
  stations.set([
    ...stations.get().filter((config) => config.outletId !== params.outletId),
    ...next,
  ]);
  return { data: next };
});

registerMock(listCapacityRules, ({ params, scenario }) => {
  if (scenario === "empty") return { data: [] };
  return {
    data: rules.get().filter((rule) => rule.outletId === params.outletId),
  };
});

registerMock(getPacing, ({ params, scenario }) => {
  const snapshot = pacingStore.get();
  if (scenario === "empty") return { data: { ...snapshot, stations: [] } };
  return {
    data: {
      ...snapshot,
      outletId: params.outletId,
      stations: snapshot.stations.filter(
        (row) => row.outletId === params.outletId,
      ),
    },
  };
});

registerMock(getServingTimeSummary, ({ query, scenario }) => {
  if (scenario === "empty") return { data: [] };
  // The fixtures describe one service day (Cafe Legend, 1 November 2026). A
  // period that does not include it has no samples, like a real query.
  if (
    !periodIncludesDate(query.startDate, query.endDate, FIXTURE_BUSINESS_DATE)
  )
    return { data: [] };
  return {
    data: summaries.get().filter((row) => row.group === query.group),
  };
});

registerMock(listOrderIssues, ({ query, scenario }) => {
  const rows = [...orderIssueViews]
    .filter((row) => (query.type ? row.type === query.type : true))
    .filter((row) =>
      query.stationId ? row.stationId === query.stationId : true,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(updateCapacityRules, ({ params, body }) => {
  const config = stationConfigs.find(
    (station) => station.stationId === params.stationId,
  );
  if (!config || config.outletId !== params.outletId)
    throw new ApiError(404, "NOT_FOUND", "Stasiun tidak ditemukan.");
  const scope = { tenantId: config.tenantId, outletId: config.outletId };
  const rows: CapacityRule[] = body.rules.map((rule) => ({
    ...scope,
    id: nextRuleId(),
    stationId: params.stationId,
    windowMinutes: rule.windowMinutes,
    capacityPoints: rule.capacityPoints,
    nearCapacityBp: rule.nearCapacityBp,
    schedule: rule.schedule.map((entry) => ({
      ...entry,
      daysOfWeek: [...entry.daysOfWeek],
    })),
    channelPriority: [...rule.channelPriority],
  })) as CapacityRule[];
  rules.set([
    ...rules.get().filter((rule) => rule.stationId !== params.stationId),
    ...rows,
  ]);

  // Pacing follows the first rule of the replacement list, like the service
  // reads the rule for the current window (KDS-05). `usedPoints` is unchanged:
  // the queue did not move when the supervisor edited the rule.
  const active = rows[0];
  const snapshot = pacingStore.get();
  pacingStore.set({
    ...snapshot,
    generatedAt: snapshot.generatedAt,
    stations: snapshot.stations.map((station) =>
      station.stationId === params.stationId
        ? {
            ...station,
            windowMinutes: active.windowMinutes,
            capacityPoints: active.capacityPoints,
            nearCapacityBp: active.nearCapacityBp,
            status: capacityLevelFor(
              station.usedPoints,
              active.capacityPoints,
              active.nearCapacityBp,
            ),
          }
        : station,
    ),
  });
  return { data: rows };
});
