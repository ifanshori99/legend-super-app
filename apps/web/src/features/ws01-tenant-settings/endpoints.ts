// Endpoints this feature needs that the shared contract does not declare yet.
// They follow the contract's conventions (`/api/org/...` = tenant admin, tenant
// from the session, bodies are the contract's own input schemas) so the API
// bead can lift them into `@starter/shared/platform` / `@starter/shared/text`
// without a client change. Reported to the lead as contract gaps (legend-5k0):
//
//  - text override CRUD: `textOverrideSchema` / `textOverrideInputSchema` exist
//    in `@starter/shared/text`, but no endpoint reads or writes them.
//  - org config import: `exportConfig` exists for a tenant admin, while
//    `platformEndpoints.importConfig` takes a target tenant id from the path,
//    which a tenant screen must never send (TEN-02).
import { defineEndpoint } from "@starter/shared/api";
import { dataResponseSchema, uuidSchema, z } from "@starter/shared/core";
import {
  configImportSchema,
  importConfigInputSchema,
} from "@starter/shared/platform";
import {
  textOverrideInputSchema,
  textOverrideSchema,
} from "@starter/shared/text";

export const listTextOverrides = defineEndpoint({
  method: "GET",
  path: "/api/org/text-overrides",
  response: z.object({ data: z.array(textOverrideSchema) }),
});

/** Upsert by (locale, key); the API returns the stored row. */
export const upsertTextOverride = defineEndpoint({
  method: "PUT",
  path: "/api/org/text-overrides",
  body: textOverrideInputSchema,
  response: dataResponseSchema(textOverrideSchema),
});

/** Clearing a term deletes its row (never an empty string). */
export const deleteTextOverride = defineEndpoint({
  method: "DELETE",
  path: "/api/org/text-overrides/:overrideId",
  params: z.strictObject({ overrideId: uuidSchema }),
});

export const importOrgConfig = defineEndpoint({
  method: "POST",
  path: "/api/org/config/import",
  body: importConfigInputSchema,
  response: dataResponseSchema(configImportSchema),
});
