// Typed callers for the restore endpoints (legend-nb4iy). Reads are wired in
// restore-hooks.ts; components never import this file.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { platformEndpoints } from "@starter/shared/platform";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

export const restoreTenant = (
  params: Params<typeof platformEndpoints.restoreTenant>,
  body: Body<typeof platformEndpoints.restoreTenant>,
) => callEndpoint(platformEndpoints.restoreTenant, { params, body });

export const restoreOutlet = (
  params: Params<typeof platformEndpoints.restoreOutlet>,
  body: Body<typeof platformEndpoints.restoreOutlet>,
) => callEndpoint(platformEndpoints.restoreOutlet, { params, body });
