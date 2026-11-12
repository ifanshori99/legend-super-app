// Typed callers of the account-role mapping endpoints (legend-fzvh). Own file
// so the shared accounting api.ts stays untouched; responses are unwrapped
// from their `{ data }` envelope like the rest of the accounting layer.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  listAccountMappings as listAccountMappingsEndpoint,
  replaceAccountMappings as replaceAccountMappingsEndpoint,
} from "@starter/shared/accounting";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

export type ReplaceMappingsBody = Body<typeof replaceAccountMappingsEndpoint>;

export async function fetchAccountMappings(
  legalEntityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listAccountMappingsEndpoint,
    {
      params: { legalEntityId } as Params<typeof listAccountMappingsEndpoint>,
    },
    { signal },
  );
  return response.data;
}

export async function replaceAccountMappings(
  legalEntityId: string,
  body: ReplaceMappingsBody,
) {
  const response = await callEndpoint(replaceAccountMappingsEndpoint, {
    params: { legalEntityId } as Params<typeof replaceAccountMappingsEndpoint>,
    body,
  });
  return response.data;
}
