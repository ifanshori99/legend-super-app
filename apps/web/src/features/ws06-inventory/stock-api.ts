// One typed caller per inventory write the stock-control screens use (docs/
// frontend.md "Typed endpoints and mock mode"). Reads go through the endpoint
// query options in ./queries.ts; components never call either directly.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { createPurchaseRequest as createPurchaseRequestEndpoint } from "@starter/shared/inventory";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

/**
 * Draft purchase request from purchase suggestions (PRD §16 "Saran Pembelian",
 * §4 Alur I step 1: PR → approval → PO). The server sets requester and status
 * draft; approval is a separate screen (legend-1j7).
 */
export const createPurchaseRequest = (
  body: Body<typeof createPurchaseRequestEndpoint>,
) => callEndpoint(createPurchaseRequestEndpoint, { body });
