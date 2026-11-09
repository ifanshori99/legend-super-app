// One typed caller per open-bill endpoint (docs/frontend.md "Typed endpoints
// and mock mode"). Each caller unwraps the `{ data }` envelope. Components use
// the hooks in ./hooks.ts, which own cache keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  convertSessionToOpenBill as convertSessionToOpenBillEndpoint,
  getOpenBillPolicy as getOpenBillPolicyEndpoint,
  listOpenBillApprovers as listOpenBillApproversEndpoint,
  updateOpenBillPolicy as updateOpenBillPolicyEndpoint,
} from "@starter/shared/qr-order";
import { callEndpoint } from "@/lib/api/endpoint";
import type { CallOptions } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

export const getOpenBillPolicy = async (
  params: Params<typeof getOpenBillPolicyEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(getOpenBillPolicyEndpoint, { params }, options)).data;

export const listOpenBillApprovers = async (
  params: Params<typeof listOpenBillApproversEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(listOpenBillApproversEndpoint, { params }, options)).data;

export const updateOpenBillPolicy = async (
  params: Params<typeof updateOpenBillPolicyEndpoint>,
  body: Body<typeof updateOpenBillPolicyEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(updateOpenBillPolicyEndpoint, { params, body }, options))
    .data;

export const convertSessionToOpenBill = async (
  params: Params<typeof convertSessionToOpenBillEndpoint>,
  body: Body<typeof convertSessionToOpenBillEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      convertSessionToOpenBillEndpoint,
      { params, body },
      options,
    )
  ).data;
