// Mock mode for the tax & service-charge back office: serves and mutates the
// shared Cafe Legend tax fixtures, so every screen works with
// VITE_API_MOCK=true and the Playwright spec covers the happy path
// (docs/frontend.md "Mock mode").
//
// Handlers behave like the API will: the runtime parses input with the
// contract's schemas, rule versions move through the contract's own lifecycle
// (`publishRuleVersion`, R21) and errors keep the domain codes the UI maps to
// catalog text. Idempotency keys are honored like a real endpoint: replaying
// one returns the recorded result, reusing it for another version is refused.
import { userIdSchema } from "@starter/shared/core";
import {
  TaxError,
  cafeLegendTaxFixtures,
  createServiceChargeRule,
  createTaxRule,
  createTaxSettings,
  getPbjtMonthlyRecap,
  listServiceChargeRules,
  listTaxRules,
  listTaxSettings,
  pbjtMonthlyRecapSchema,
  publishRuleVersion,
  publishServiceChargeRule,
  publishTaxRule,
  publishTaxSettings,
  serviceChargeRuleSchema,
  taxRuleSchema,
  taxSettingsSchema,
  updateServiceChargeRule,
  updateTaxRule,
  type ServiceChargeRule,
  type TaxRule,
  type TaxSettings,
} from "@starter/shared/tax";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import {
  businessDateToday,
  effectiveSettings,
  nextVersionNumber,
  sortRuleVersions,
} from "./lib.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

const fixtures = cafeLegendTaxFixtures;
/** The finance user the fixture rules were published by (publishedBy). */
const ACTOR_ID = userIdSchema.parse(fixtures.financeUserId);

type TaxState = {
  taxRules: TaxRule[];
  serviceChargeRules: ServiceChargeRule[];
  settings: TaxSettings[];
};

const seed = (): TaxState => {
  const source = structuredClone(fixtures);
  return {
    taxRules: source.taxRules,
    serviceChargeRules: source.serviceChargeRules,
    settings: source.settings,
  };
};

const store = createMockStore<TaxState>(seed);

// ---- Publish idempotency ---------------------------------------------------

type PublishRecord = { targetId: string; response: unknown };

const publishes = createMockStore(() => new Map<string, PublishRecord>());

/** Replays a publish for the same key/target, like the API's idempotency. */
function replayPublish<T>(
  endpointId: string,
  key: string,
  targetId: string,
  compute: () => T,
): T {
  const records = publishes.get();
  const id = `${endpointId}:${key}`;
  const seen = records.get(id);
  if (seen) {
    if (seen.targetId !== targetId)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai untuk versi lain.",
      );
    return seen.response as T;
  }
  const response = compute();
  records.set(id, { targetId, response });
  return response;
}

function publishOptions() {
  return {
    today: businessDateToday(),
    actorId: ACTOR_ID,
    at: new Date().toISOString(),
  };
}

/** Contract domain errors reach the UI as ApiError, like the API's handler. */
function toApiError(error: unknown): never {
  if (error instanceof TaxError)
    throw new ApiError(error.status, error.code, error.message);
  throw error;
}

function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

// ---- Tax rules -------------------------------------------------------------

registerMock(listTaxRules, ({ query, scenario }) => {
  const rows = store.get().taxRules.filter((rule) => {
    if (query.outletId !== undefined && rule.outletId !== query.outletId)
      return false;
    if (query.status !== undefined && rule.status !== query.status)
      return false;
    if (query.code !== undefined && rule.code !== query.code) return false;
    return true;
  });
  return paginateFixture(
    sortRuleVersions(rows),
    query,
    (rule) => rule.id,
    scenario,
  );
});

registerMock(createTaxRule, ({ body }) => {
  const state = store.get();
  const outletId = body.outletId ?? null;
  const today = businessDateToday();
  const rule = taxRuleSchema.parse({
    id: newIdempotencyKey(),
    tenantId: fixtures.taxRules[0].tenantId,
    outletId,
    code: body.code,
    name: body.name,
    taxType: body.taxType,
    rateBp: body.rateBp,
    regionCode: body.regionCode,
    channels: body.channels,
    appliesTo: body.appliesTo,
    // An omitted flag inherits the tenant/outlet setting (contract).
    priceIncludesTax:
      body.priceIncludesTax ??
      effectiveSettings(state.settings, today)?.pricesIncludeTax ??
      false,
    includeServiceInBase: body.includeServiceInBase,
    isActive: body.isActive,
    version: nextVersionNumber(state.taxRules, body.code, outletId),
    effectiveFrom: body.effectiveFrom,
    status: "draft",
    publishedAt: null,
    publishedBy: null,
    createdAt: new Date().toISOString(),
  });
  store.set({ ...state, taxRules: [...state.taxRules, rule] });
  return { data: rule };
});

registerMock(updateTaxRule, ({ params, body }) => {
  const state = store.get();
  const found = state.taxRules.find((rule) => rule.id === params.taxRuleId);
  if (!found) notFound("Aturan pajak");
  if (found.status !== "draft")
    throw new ApiError(
      409,
      "TAX_RULE_IMMUTABLE",
      "Aturan pajak yang sudah terbit tidak dapat diubah; buat versi baru.",
    );
  const updated = taxRuleSchema.parse({ ...found, ...body });
  store.set({
    ...state,
    taxRules: state.taxRules.map((rule) =>
      rule.id === updated.id ? updated : rule,
    ),
  });
  return { data: updated };
});

registerMock(publishTaxRule, ({ params, body }) =>
  replayPublish(
    publishTaxRule.id,
    body.idempotencyKey,
    params.taxRuleId,
    () => {
      const state = store.get();
      const found = state.taxRules.find((rule) => rule.id === params.taxRuleId);
      if (!found) notFound("Aturan pajak");
      let published: TaxRule;
      try {
        published = publishRuleVersion(found, publishOptions());
      } catch (error) {
        return toApiError(error);
      }
      store.set({
        ...state,
        taxRules: state.taxRules.map((rule) =>
          rule.id === published.id ? published : rule,
        ),
      });
      return { data: published };
    },
  ),
);

// ---- Service-charge rules --------------------------------------------------

registerMock(listServiceChargeRules, ({ query, scenario }) => {
  const rows = store.get().serviceChargeRules.filter((rule) => {
    if (query.outletId !== undefined && rule.outletId !== query.outletId)
      return false;
    if (query.status !== undefined && rule.status !== query.status)
      return false;
    if (query.code !== undefined && rule.code !== query.code) return false;
    return true;
  });
  return paginateFixture(
    sortRuleVersions(rows),
    query,
    (rule) => rule.id,
    scenario,
  );
});

registerMock(createServiceChargeRule, ({ body }) => {
  const state = store.get();
  const outletId = body.outletId ?? null;
  const rule = serviceChargeRuleSchema.parse({
    id: newIdempotencyKey(),
    tenantId: fixtures.serviceChargeRules[0].tenantId,
    outletId,
    code: body.code,
    name: body.name,
    rateBp: body.rateBp,
    zoneId: body.zoneId,
    orderTypes: body.orderTypes,
    itemClasses: body.itemClasses,
    isActive: body.isActive,
    version: nextVersionNumber(state.serviceChargeRules, body.code, outletId),
    effectiveFrom: body.effectiveFrom,
    status: "draft",
    publishedAt: null,
    publishedBy: null,
    createdAt: new Date().toISOString(),
  });
  store.set({
    ...state,
    serviceChargeRules: [...state.serviceChargeRules, rule],
  });
  return { data: rule };
});

registerMock(updateServiceChargeRule, ({ params, body }) => {
  const state = store.get();
  const found = state.serviceChargeRules.find(
    (rule) => rule.id === params.serviceChargeRuleId,
  );
  if (!found) notFound("Aturan service charge");
  if (found.status !== "draft")
    throw new ApiError(
      409,
      "TAX_RULE_IMMUTABLE",
      "Aturan yang sudah terbit tidak dapat diubah; buat versi baru.",
    );
  const updated = serviceChargeRuleSchema.parse({ ...found, ...body });
  store.set({
    ...state,
    serviceChargeRules: state.serviceChargeRules.map((rule) =>
      rule.id === updated.id ? updated : rule,
    ),
  });
  return { data: updated };
});

registerMock(publishServiceChargeRule, ({ params, body }) =>
  replayPublish(
    publishServiceChargeRule.id,
    body.idempotencyKey,
    params.serviceChargeRuleId,
    () => {
      const state = store.get();
      const found = state.serviceChargeRules.find(
        (rule) => rule.id === params.serviceChargeRuleId,
      );
      if (!found) notFound("Aturan service charge");
      let published: ServiceChargeRule;
      try {
        published = publishRuleVersion(found, publishOptions());
      } catch (error) {
        return toApiError(error);
      }
      store.set({
        ...state,
        serviceChargeRules: state.serviceChargeRules.map((rule) =>
          rule.id === published.id ? published : rule,
        ),
      });
      return { data: published };
    },
  ),
);

// ---- Calculation options ---------------------------------------------------

registerMock(listTaxSettings, ({ query, scenario }) => {
  const rows = store.get().settings.filter((row) => {
    if (query.outletId !== undefined && row.outletId !== query.outletId)
      return false;
    if (query.status !== undefined && row.status !== query.status) return false;
    return true;
  });
  return paginateFixture(
    [...rows].sort((a, b) => b.version - a.version),
    query,
    (row) => row.id,
    scenario,
  );
});

registerMock(createTaxSettings, ({ body }) => {
  const state = store.get();
  const outletId = body.outletId ?? null;
  const version =
    state.settings
      .filter((row) => row.outletId === outletId)
      .reduce((max, row) => Math.max(max, row.version), 0) + 1;
  const row = taxSettingsSchema.parse({
    id: newIdempotencyKey(),
    tenantId: fixtures.settings[0].tenantId,
    outletId,
    calculationOrder: body.calculationOrder,
    pricesIncludeTax: body.pricesIncludeTax,
    serviceRoundingMode: body.serviceRoundingMode,
    taxRoundingMode: body.taxRoundingMode,
    inclusiveBaseRoundingMode: body.inclusiveBaseRoundingMode,
    billRounding: body.billRounding,
    packageAllocation: body.packageAllocation,
    version,
    effectiveFrom: body.effectiveFrom,
    status: "draft",
    publishedAt: null,
    publishedBy: null,
    createdAt: new Date().toISOString(),
  });
  store.set({ ...state, settings: [...state.settings, row] });
  return { data: row };
});

registerMock(publishTaxSettings, ({ params, body }) =>
  replayPublish(
    publishTaxSettings.id,
    body.idempotencyKey,
    params.taxSettingsId,
    () => {
      const state = store.get();
      const found = state.settings.find(
        (row) => row.id === params.taxSettingsId,
      );
      if (!found) notFound("Opsi perhitungan");
      let published: TaxSettings;
      try {
        published = publishRuleVersion(found, publishOptions());
      } catch (error) {
        return toApiError(error);
      }
      store.set({
        ...state,
        settings: state.settings.map((row) =>
          row.id === published.id ? published : row,
        ),
      });
      return { data: published };
    },
  ),
);

// ---- PBJT monthly recap ----------------------------------------------------

registerMock(getPbjtMonthlyRecap, ({ query, scenario }) => {
  const source = fixtures.pbjtRecap;
  const generatedAt = new Date().toISOString();
  // Only the fixture month has transactions; another month is an honest empty
  // report, and "empty" is the scenario switch for screenshots/e2e.
  const rows =
    scenario === "empty" || query.period !== source.period ? [] : source.rows;
  return {
    data: pbjtMonthlyRecapSchema.parse({
      ...source,
      outletId: query.outletId,
      period: query.period,
      generatedAt,
      rows,
      totalTransactionCount:
        rows.length === 0 ? 0 : source.totalTransactionCount,
      totalTaxBaseIdr: rows.reduce((sum, row) => sum + row.taxBaseIdr, 0),
      totalTaxIdr: rows.reduce((sum, row) => sum + row.taxIdr, 0),
    }),
  };
});
