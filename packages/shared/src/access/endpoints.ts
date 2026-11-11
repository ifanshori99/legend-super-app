// HTTP contracts for the access domain's self-service view (bead legend-t4y7).
// RBAC administration endpoints live in `@starter/shared/identity/endpoints`
// next to the rest of WS-01 (roles, assignments, approval matrix) because the
// identity contract owns the HTTP surface for WS-01; this file only adds the
// one endpoint the web area guards call before rendering a shell.
//
// Authorization is server-side: the endpoint answers for the signed-in user in
// the tenant the domain or token resolved (TEN-02). The permission list is
// presentation data (which areas to show); every API call is authorized again.

import { dataResponseSchema } from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import {
  activeOutletSchema,
  myAccessViewSchema,
  setActiveOutletInputSchema,
} from "./schemas.ts";

/** What `loadAreaAccess` reads instead of failing every area closed. */
export const getMyAccess = defineEndpoint({
  method: "GET",
  path: "/api/me/access",
  response: dataResponseSchema(myAccessViewSchema),
});

/**
 * Pin the outlet the outlet-less staff routes work on (legend-6vgv). An outlet
 * outside the caller's reach, in another tenant or unknown answers the same
 * 404 OUTLET_NOT_FOUND.
 */
export const setActiveOutlet = defineEndpoint({
  method: "PUT",
  path: "/api/me/active-outlet",
  body: setActiveOutletInputSchema,
  response: dataResponseSchema(activeOutletSchema),
});
