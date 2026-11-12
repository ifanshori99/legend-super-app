// Typed callers for the tenant Owner endpoints (legend-be0lx). Own file so the
// restore screen (legend-nb4iy) and this one never edit the same lines of
// api.ts. Components go through owner-hooks.ts.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { platformEndpoints } from "@starter/shared/platform";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

export const assignTenantOwner = (
  params: Params<typeof platformEndpoints.assignTenantOwner>,
  body: Body<typeof platformEndpoints.assignTenantOwner>,
) => callEndpoint(platformEndpoints.assignTenantOwner, { params, body });

export const replaceTenantOwner = (
  params: Params<typeof platformEndpoints.replaceTenantOwner>,
  body: Body<typeof platformEndpoints.replaceTenantOwner>,
) => callEndpoint(platformEndpoints.replaceTenantOwner, { params, body });
