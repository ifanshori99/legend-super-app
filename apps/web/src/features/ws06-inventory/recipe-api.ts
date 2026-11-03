// One typed caller per recipe and production endpoint this back office uses
// (docs/frontend.md "Typed endpoints and mock mode"). Components never call
// these directly: the hooks in ./recipe-hooks.ts own cache keys and
// invalidation. Reads keep the cursor page; writes unwrap the `{ data }`
// envelope and forward the attempt's Idempotency-Key header.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createProductionOrder as createProductionOrderEndpoint,
  createRecipe as createRecipeEndpoint,
  createRecipeVersion as createRecipeVersionEndpoint,
  getRecipe,
  listProductionOrders,
  listRecipes,
  postProductionOrderTransition as postProductionOrderTransitionEndpoint,
} from "@starter/shared/inventory";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

// ---- Reads ---------------------------------------------------------------

export const listRecipeRows = (query: Query<typeof listRecipes>) =>
  callEndpoint(listRecipes, { query });

export async function getRecipeDetail(
  params: Params<typeof getRecipe>,
  signal?: AbortSignal,
) {
  const { data } = await callEndpoint(getRecipe, { params }, { signal });
  return data;
}

export const listProductionRows = (query: Query<typeof listProductionOrders>) =>
  callEndpoint(listProductionOrders, { query });

// ---- Writes --------------------------------------------------------------

/** One Idempotency-Key per create attempt (contracts.md typed client). */
export async function createRecipe(
  body: Body<typeof createRecipeEndpoint>,
  idempotencyKey: string,
) {
  const { data } = await callEndpoint(
    createRecipeEndpoint,
    { body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
  return data;
}

export async function createRecipeVersion(
  params: Params<typeof createRecipeVersionEndpoint>,
  body: Body<typeof createRecipeVersionEndpoint>,
  idempotencyKey: string,
) {
  const { data } = await callEndpoint(
    createRecipeVersionEndpoint,
    { params, body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
  return data;
}

export async function createProductionOrder(
  body: Body<typeof createProductionOrderEndpoint>,
  idempotencyKey: string,
) {
  const { data } = await callEndpoint(
    createProductionOrderEndpoint,
    { body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
  return data;
}

export async function transitionProductionOrder(
  params: Params<typeof postProductionOrderTransitionEndpoint>,
  body: Body<typeof postProductionOrderTransitionEndpoint>,
  idempotencyKey: string,
) {
  const { data } = await callEndpoint(
    postProductionOrderTransitionEndpoint,
    { params, body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
  return data;
}
