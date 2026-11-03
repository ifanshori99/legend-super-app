// One typed caller per endpoint the Panel Platform tenant screens use
// (docs/frontend.md "Typed endpoints and mock mode"). Components go through
// hooks.ts; read endpoints are wired in queries.ts.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { orgEndpoints, platformEndpoints } from "@starter/shared/platform";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

export const createTenant = (
  body: Body<typeof platformEndpoints.createTenant>,
) => callEndpoint(platformEndpoints.createTenant, { body });

export const setTenantStatus = (
  params: Params<typeof platformEndpoints.setTenantStatus>,
  body: Body<typeof platformEndpoints.setTenantStatus>,
) => callEndpoint(platformEndpoints.setTenantStatus, { params, body });

// Org endpoints take the tenant from the session (TEN-02). The wizard calls
// them right after createTenant; see the report for the contract gap.
export const createLegalEntity = (
  body: Body<typeof orgEndpoints.createLegalEntity>,
) => callEndpoint(orgEndpoints.createLegalEntity, { body });

export const createBrand = (body: Body<typeof orgEndpoints.createBrand>) =>
  callEndpoint(orgEndpoints.createBrand, { body });

export const createOutlet = (body: Body<typeof orgEndpoints.createOutlet>) =>
  callEndpoint(orgEndpoints.createOutlet, { body });
