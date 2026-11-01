// Tax-domain events (WS-05 line in events/catalog.ts). Published rule versions
// are immutable, so each event fully describes the version now scheduled.

import {
  z,
  basisPointsSchema,
  businessDateSchema,
  outletIdSchema,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/define.ts";
import {
  ruleCodeSchema,
  serviceChargeRuleIdSchema,
  taxRuleIdSchema,
  taxSettingsIdSchema,
} from "./schemas.ts";

const versionPayload = {
  outletId: outletIdSchema.nullable(),
  version: z.number().int().positive(),
  effectiveFrom: businessDateSchema,
};

export const taxRulePublished = defineDomainEvent({
  name: "tax_rule.published",
  payload: z.strictObject({
    taxRuleId: taxRuleIdSchema,
    code: ruleCodeSchema,
    rateBp: basisPointsSchema,
    isActive: z.boolean(),
    ...versionPayload,
  }),
});

export const serviceChargeRulePublished = defineDomainEvent({
  name: "service_charge_rule.published",
  payload: z.strictObject({
    serviceChargeRuleId: serviceChargeRuleIdSchema,
    code: ruleCodeSchema,
    rateBp: basisPointsSchema,
    isActive: z.boolean(),
    ...versionPayload,
  }),
});

export const taxSettingsPublished = defineDomainEvent({
  name: "tax_settings.published",
  payload: z.strictObject({
    taxSettingsId: taxSettingsIdSchema,
    ...versionPayload,
  }),
});

export const TAX_EVENTS = [
  taxRulePublished,
  serviceChargeRulePublished,
  taxSettingsPublished,
] as const;
