// One typed caller per floor-board endpoint (docs/frontend.md "Typed endpoints
// and mock mode"). Each caller unwraps the `{ data }` envelope, so hooks and
// components see the payload the contract describes. Components never call
// these directly: they use the hooks in ./hooks.ts, which own cache keys and
// invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { listExampleOutlets } from "@starter/shared/api";
import {
  closeTableSession as closeTableSessionEndpoint,
  confirmOpenBillSession as confirmOpenBillSessionEndpoint,
  createSessionSplits as createSessionSplitsEndpoint,
  getFloorBoard as getFloorBoardEndpoint,
  getSessionBill as getSessionBillEndpoint,
  issueTableQr as issueTableQrEndpoint,
  mergeTableSessions as mergeTableSessionsEndpoint,
  moveSessionItems as moveSessionItemsEndpoint,
  moveTableSession as moveTableSessionEndpoint,
  updateTableStatus as updateTableStatusEndpoint,
} from "@starter/shared/qr-order";
import { callEndpoint } from "@/lib/api/endpoint";
import type { CallOptions } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

/**
 * Outlet context is not part of the web app yet (the API will expose the
 * staff's assigned outlets); until that bead lands the board lists the
 * accessible outlets and opens the first one.
 */
export const listOutlets = (
  query: Query<typeof listExampleOutlets>,
  options?: CallOptions,
) => callEndpoint(listExampleOutlets, { query }, options);

export const getFloorBoard = async (
  params: Params<typeof getFloorBoardEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(getFloorBoardEndpoint, { params }, options)).data;

export const getSessionBill = async (
  params: Params<typeof getSessionBillEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(getSessionBillEndpoint, { params }, options)).data;

export const confirmOpenBillSession = async (
  params: Params<typeof confirmOpenBillSessionEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(confirmOpenBillSessionEndpoint, { params }, options))
    .data;

export const closeTableSession = async (
  params: Params<typeof closeTableSessionEndpoint>,
  body: Body<typeof closeTableSessionEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(closeTableSessionEndpoint, { params, body }, options))
    .data;

export const issueTableQr = async (
  params: Params<typeof issueTableQrEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(issueTableQrEndpoint, { params }, options)).data;

export const updateTableStatus = async (
  params: Params<typeof updateTableStatusEndpoint>,
  body: Body<typeof updateTableStatusEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(updateTableStatusEndpoint, { params, body }, options))
    .data;

export const moveTableSession = async (
  params: Params<typeof moveTableSessionEndpoint>,
  body: Body<typeof moveTableSessionEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(moveTableSessionEndpoint, { params, body }, options))
    .data;

export const mergeTableSessions = async (
  params: Params<typeof mergeTableSessionsEndpoint>,
  body: Body<typeof mergeTableSessionsEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(mergeTableSessionsEndpoint, { params, body }, options))
    .data;

export const moveSessionItems = async (
  params: Params<typeof moveSessionItemsEndpoint>,
  body: Body<typeof moveSessionItemsEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(moveSessionItemsEndpoint, { params, body }, options))
    .data;

export const createSessionSplits = async (
  params: Params<typeof createSessionSplitsEndpoint>,
  body: Body<typeof createSessionSplitsEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(createSessionSplitsEndpoint, { params, body }, options))
    .data;
