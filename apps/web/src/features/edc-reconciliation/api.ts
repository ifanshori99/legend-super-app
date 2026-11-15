// One typed caller per EDC reconciliation endpoint (docs/frontend.md). The
// resolve route has no Idempotency-Key: the API itself rejects a second resolve
// of an already cleared row (CONFLICT). The mock in ./mock.ts serves the same
// contracts when VITE_API_MOCK=true.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  listEdcReconciliationQueue as listEdcReconciliationQueueEndpoint,
  resolveEdcReconciliation as resolveEdcReconciliationEndpoint,
} from "@starter/shared/payment/admin";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

export const fetchEdcReconciliationQueue = (
  query: Query<typeof listEdcReconciliationQueueEndpoint>,
  options?: { signal?: AbortSignal },
) => callEndpoint(listEdcReconciliationQueueEndpoint, { query }, options);

export const submitEdcReconciliation = (
  params: Params<typeof resolveEdcReconciliationEndpoint>,
  body: Body<typeof resolveEdcReconciliationEndpoint>,
) => callEndpoint(resolveEdcReconciliationEndpoint, { params, body });
