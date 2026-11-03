// One typed caller per checklist endpoint (docs/frontend.md "Typed endpoints
// and mock mode"). Components never call these directly: hooks own cache keys
// and invalidation. Each detail/write caller unwraps the `{ data }` envelope.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createChecklistRun as createChecklistRunEndpoint,
  createChecklistTemplate as createChecklistTemplateEndpoint,
  getChecklistRun as getChecklistRunEndpoint,
  getChecklistTemplate as getChecklistTemplateEndpoint,
  listChecklistRuns as listChecklistRunsEndpoint,
  listChecklistTemplates as listChecklistTemplatesEndpoint,
  postChecklistRunTransition as postChecklistRunTransitionEndpoint,
  recordChecklistItemResult as recordChecklistItemResultEndpoint,
  updateChecklistTemplate as updateChecklistTemplateEndpoint,
} from "@starter/shared/operations";
import { callEndpoint } from "@/lib/api/endpoint";
import type { CallOptions } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

// ---- Runs ----------------------------------------------------------------

export const listChecklistRuns = (
  query: Query<typeof listChecklistRunsEndpoint>,
  options?: CallOptions,
) => callEndpoint(listChecklistRunsEndpoint, { query }, options);

export const getChecklistRun = async (
  params: Params<typeof getChecklistRunEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(getChecklistRunEndpoint, { params }, options)).data;

export const createChecklistRun = async (
  body: Body<typeof createChecklistRunEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(createChecklistRunEndpoint, { body }, options)).data;

export const recordChecklistItemResult = async (
  params: Params<typeof recordChecklistItemResultEndpoint>,
  body: Body<typeof recordChecklistItemResultEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      recordChecklistItemResultEndpoint,
      { params, body },
      options,
    )
  ).data;

export const postChecklistRunTransition = async (
  params: Params<typeof postChecklistRunTransitionEndpoint>,
  body: Body<typeof postChecklistRunTransitionEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      postChecklistRunTransitionEndpoint,
      { params, body },
      options,
    )
  ).data;

// ---- Templates -----------------------------------------------------------

export const listChecklistTemplates = (
  query: Query<typeof listChecklistTemplatesEndpoint>,
  options?: CallOptions,
) => callEndpoint(listChecklistTemplatesEndpoint, { query }, options);

export const getChecklistTemplate = async (
  params: Params<typeof getChecklistTemplateEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(getChecklistTemplateEndpoint, { params }, options)).data;

export const createChecklistTemplate = async (
  body: Body<typeof createChecklistTemplateEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(createChecklistTemplateEndpoint, { body }, options)).data;

export const updateChecklistTemplate = async (
  params: Params<typeof updateChecklistTemplateEndpoint>,
  body: Body<typeof updateChecklistTemplateEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      updateChecklistTemplateEndpoint,
      { params, body },
      options,
    )
  ).data;
