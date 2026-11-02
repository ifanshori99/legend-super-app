// One typed caller per tax endpoint (docs/frontend.md "Typed endpoints and
// mock mode"). Components never call these directly: they use the hooks in
// ./hooks.ts, which own cache keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { getFloorBoard } from "@starter/shared/qr-order";
import {
  createServiceChargeRule as createServiceChargeRuleEndpoint,
  createTaxRule as createTaxRuleEndpoint,
  createTaxSettings as createTaxSettingsEndpoint,
  getPbjtMonthlyRecap as getPbjtMonthlyRecapEndpoint,
  listServiceChargeRules as listServiceChargeRulesEndpoint,
  listTaxRules as listTaxRulesEndpoint,
  listTaxSettings as listTaxSettingsEndpoint,
  publishServiceChargeRule as publishServiceChargeRuleEndpoint,
  publishTaxRule as publishTaxRuleEndpoint,
  publishTaxSettings as publishTaxSettingsEndpoint,
  updateServiceChargeRule as updateServiceChargeRuleEndpoint,
  updateTaxRule as updateTaxRuleEndpoint,
} from "@starter/shared/tax";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

// ---- Rules -----------------------------------------------------------------

export type TaxRuleInput = Body<typeof createTaxRuleEndpoint>;
export type TaxRulePatch = Body<typeof updateTaxRuleEndpoint>;
export type ServiceChargeRuleInput = Body<
  typeof createServiceChargeRuleEndpoint
>;
export type ServiceChargeRulePatch = Body<
  typeof updateServiceChargeRuleEndpoint
>;
export type TaxSettingsInput = Body<typeof createTaxSettingsEndpoint>;
export type TaxListQuery = Query<typeof listTaxRulesEndpoint>;
export type PbjtRecapQuery = Query<typeof getPbjtMonthlyRecapEndpoint>;

export const fetchTaxRules = (query: TaxListQuery) =>
  callEndpoint(listTaxRulesEndpoint, { query });

export const createTaxRule = (body: TaxRuleInput) =>
  callEndpoint(createTaxRuleEndpoint, { body });

export const updateTaxRule = (
  params: Params<typeof updateTaxRuleEndpoint>,
  body: TaxRulePatch,
) => callEndpoint(updateTaxRuleEndpoint, { params, body });

export const publishTaxRule = (
  params: Params<typeof publishTaxRuleEndpoint>,
  body: Body<typeof publishTaxRuleEndpoint>,
) => callEndpoint(publishTaxRuleEndpoint, { params, body });

export const fetchServiceChargeRules = (query: TaxListQuery) =>
  callEndpoint(listServiceChargeRulesEndpoint, { query });

export const createServiceChargeRule = (body: ServiceChargeRuleInput) =>
  callEndpoint(createServiceChargeRuleEndpoint, { body });

export const updateServiceChargeRule = (
  params: Params<typeof updateServiceChargeRuleEndpoint>,
  body: ServiceChargeRulePatch,
) => callEndpoint(updateServiceChargeRuleEndpoint, { params, body });

export const publishServiceChargeRule = (
  params: Params<typeof publishServiceChargeRuleEndpoint>,
  body: Body<typeof publishServiceChargeRuleEndpoint>,
) => callEndpoint(publishServiceChargeRuleEndpoint, { params, body });

// ---- Calculation options ---------------------------------------------------

export const fetchTaxSettings = (
  query: Query<typeof listTaxSettingsEndpoint>,
) => callEndpoint(listTaxSettingsEndpoint, { query });

export const createTaxSettings = (body: TaxSettingsInput) =>
  callEndpoint(createTaxSettingsEndpoint, { body });

export const publishTaxSettings = (
  params: Params<typeof publishTaxSettingsEndpoint>,
  body: Body<typeof publishTaxSettingsEndpoint>,
) => callEndpoint(publishTaxSettingsEndpoint, { params, body });

// ---- PBJT recap ------------------------------------------------------------

export const fetchPbjtRecap = (query: PbjtRecapQuery) =>
  callEndpoint(getPbjtMonthlyRecapEndpoint, { query });

// ---- Floor zones (service-charge scope) ------------------------------------
//
// Service-charge rules apply per zone (PRD §3.14). The zone list is the floor
// contract's; the tax contract only stores the id. Read-only, best effort: if
// the floor read fails the editor offers "all zones" and the rule rows fall
// back to the zone id instead of blocking the tax screens.

export const fetchFloorZones = (outletId: string) =>
  callEndpoint(getFloorBoard, { params: { outletId } });
