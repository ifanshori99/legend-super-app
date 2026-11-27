// One typed caller for the EDC settlement CSV upload (docs/frontend.md). The
// mock in ./mock.ts serves the same contract when VITE_API_MOCK=true.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { importEdcSettlementCsv as importEdcSettlementCsvEndpoint } from "@starter/shared/payment/admin";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

export const submitEdcSettlementCsv = (
  body: Body<typeof importEdcSettlementCsvEndpoint>,
) => callEndpoint(importEdcSettlementCsvEndpoint, { body });
