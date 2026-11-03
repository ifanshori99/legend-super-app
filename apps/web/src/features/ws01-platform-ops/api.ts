// Typed callers for the platform ops screens (docs/frontend.md "Typed
// endpoints and mock mode"). Components use ./hooks.ts, never these directly.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { platformEndpoints } from "@starter/shared/platform";
import { callEndpoint } from "@/lib/api/endpoint";
import {
  listPlatformAuditEvents,
  type ListAuditEventsQuery,
} from "./contract-gap";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

export type SetTenantPackageBody = Body<
  typeof platformEndpoints.setTenantPackage
>;

export const setTenantPackage = (
  tenantId: string,
  body: SetTenantPackageBody,
) =>
  callEndpoint(platformEndpoints.setTenantPackage, {
    params: { tenantId },
    body,
  });

export const fetchAuditPage = (
  query: ListAuditEventsQuery,
  signal?: AbortSignal,
) => callEndpoint(listPlatformAuditEvents, { query }, { signal });
