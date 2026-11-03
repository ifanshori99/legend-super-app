// HTTP contracts for tenant text overrides and versioned consents
// (PRD v1.7 §3 F4 "Teks & Kamus Istilah", §6 A `text_overrides`, §6 B
// `consents`, §2 privacy "persetujuan terpisah dan berversi", LOY-04).
//
// Text overrides reuse the `text` contract (catalog key + locale + value).
// Consents are an append-only event log: a grant or a withdrawal is a new row,
// the "current" consent is the latest row per (subject, purpose), and nothing
// is ever updated or deleted.

import {
  cursorPageQuerySchema,
  cursorPageSchema,
  clientInputSchema,
  dataResponseSchema,
  isoDateTimeSchema,
  tenantIdSchema,
  userIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import { consentPurposeSchema, consentSourceSchema } from "../crm/loyalty.ts";
import {
  textLocaleSchema,
  textOverrideInputSchema,
  textOverrideSchema,
} from "../text/schemas.ts";

// ------------------------------------------------------------ text overrides

/** A stored override: the contract row plus its per-key version counter. */
export const textOverrideRecordSchema = textOverrideSchema.extend({
  /** 1 on first write, +1 on every change of the same (locale, key). */
  version: z.number().int().positive(),
});
export type TextOverrideRecord = z.infer<typeof textOverrideRecordSchema>;

export const listTextOverridesQuerySchema = z.strictObject({
  locale: textLocaleSchema.optional(),
});

export const textOverrideEndpoints = {
  listTextOverrides: defineEndpoint({
    method: "GET",
    path: "/api/org/text-overrides",
    query: listTextOverridesQuerySchema,
    response: z.object({ data: z.array(textOverrideRecordSchema) }),
  }),
  putTextOverride: defineEndpoint({
    method: "PUT",
    path: "/api/org/text-overrides",
    body: textOverrideInputSchema,
    response: dataResponseSchema(textOverrideRecordSchema),
  }),
} as const;

// ------------------------------------------------------------------ consents

export const consentDecisionSchema = z.enum(["granted", "withdrawn"]);
export type ConsentDecision = z.infer<typeof consentDecisionSchema>;

/** One append-only consent event. */
export const consentRecordSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  /** Customer profile (or other data subject) the consent belongs to. */
  subjectId: uuidSchema,
  purpose: consentPurposeSchema,
  policyVersion: z.string().min(1).max(20),
  decision: consentDecisionSchema,
  source: consentSourceSchema,
  recordedBy: userIdSchema.nullable(),
  recordedAt: isoDateTimeSchema,
});
export type ConsentRecord = z.infer<typeof consentRecordSchema>;

/** Body: tenant, id, actor and timestamp are server-derived. */
export const recordConsentInputSchema = clientInputSchema({
  subjectId: uuidSchema,
  purpose: consentPurposeSchema,
  policyVersion: z.string().trim().min(1).max(20),
  decision: consentDecisionSchema,
  source: consentSourceSchema,
});
export type RecordConsentInput = z.infer<typeof recordConsentInputSchema>;

export const listConsentsQuerySchema = cursorPageQuerySchema.extend({
  subjectId: uuidSchema,
  /** `latest` = current consent per purpose; `history` = every event. */
  view: z.enum(["latest", "history"]).default("latest"),
});
export type ListConsentsQuery = z.infer<typeof listConsentsQuerySchema>;

export const consentEndpoints = {
  listConsents: defineEndpoint({
    method: "GET",
    path: "/api/consents",
    query: listConsentsQuerySchema,
    response: cursorPageSchema(consentRecordSchema),
  }),
  recordConsent: defineEndpoint({
    method: "POST",
    path: "/api/consents",
    body: recordConsentInputSchema,
    response: dataResponseSchema(consentRecordSchema),
  }),
} as const;
