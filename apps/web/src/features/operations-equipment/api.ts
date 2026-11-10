// One typed caller per operations endpoint this feature uses (docs/frontend.md
// "Typed endpoints and mock mode"). Each caller unwraps the `{ data }` envelope,
// so hooks and components see the payload the contract describes. Components
// never call these directly: they use the hooks in ./hooks.ts, which own cache
// keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { listSuppliers } from "@starter/shared/inventory";
import { listItems as listMenuItemsEndpoint } from "@starter/shared/menu";
import {
  createEquipment as createEquipmentEndpoint,
  createMaintenanceSchedule as createMaintenanceScheduleEndpoint,
  createMaintenanceTicket as createMaintenanceTicketEndpoint,
  createShiftHandover as createShiftHandoverEndpoint,
  getEquipment as getEquipmentEndpoint,
  getMaintenanceTicket as getMaintenanceTicketEndpoint,
  getShiftHandover as getShiftHandoverEndpoint,
  listEquipment as listEquipmentEndpoint,
  listMaintenanceSchedules as listMaintenanceSchedulesEndpoint,
  listMaintenanceTickets as listMaintenanceTicketsEndpoint,
  listShiftHandovers as listShiftHandoversEndpoint,
  postEquipmentTransition as postEquipmentTransitionEndpoint,
  postMaintenanceTicketTransition as postMaintenanceTicketTransitionEndpoint,
  postShiftHandoverAcknowledgement as postShiftHandoverAcknowledgementEndpoint,
  updateEquipment as updateEquipmentEndpoint,
} from "@starter/shared/operations";
import { callEndpoint } from "@/lib/api/endpoint";
import type { CallOptions } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

/** Contract endpoints whose query we pass straight through. */
export const operationsEndpoints = {
  listEquipment: listEquipmentEndpoint,
  getEquipment: getEquipmentEndpoint,
  createEquipment: createEquipmentEndpoint,
  updateEquipment: updateEquipmentEndpoint,
  postEquipmentTransition: postEquipmentTransitionEndpoint,
  listMaintenanceSchedules: listMaintenanceSchedulesEndpoint,
  createMaintenanceSchedule: createMaintenanceScheduleEndpoint,
  listMaintenanceTickets: listMaintenanceTicketsEndpoint,
  getMaintenanceTicket: getMaintenanceTicketEndpoint,
  createMaintenanceTicket: createMaintenanceTicketEndpoint,
  postMaintenanceTicketTransition: postMaintenanceTicketTransitionEndpoint,
  listShiftHandovers: listShiftHandoversEndpoint,
  getShiftHandover: getShiftHandoverEndpoint,
  createShiftHandover: createShiftHandoverEndpoint,
  postShiftHandoverAcknowledgement: postShiftHandoverAcknowledgementEndpoint,
} as const;

export const listEquipment = async (
  query: Query<typeof listEquipmentEndpoint>,
  options?: CallOptions,
) => callEndpoint(listEquipmentEndpoint, { query }, options);

export const getEquipment = async (
  params: Params<typeof getEquipmentEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(getEquipmentEndpoint, { params }, options)).data;

export const createEquipment = async (
  body: Body<typeof createEquipmentEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(createEquipmentEndpoint, { body }, options)).data;

export const updateEquipment = async (
  params: Params<typeof updateEquipmentEndpoint>,
  body: Body<typeof updateEquipmentEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(updateEquipmentEndpoint, { params, body }, options)).data;

export const postEquipmentTransition = async (
  params: Params<typeof postEquipmentTransitionEndpoint>,
  body: Body<typeof postEquipmentTransitionEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      postEquipmentTransitionEndpoint,
      { params, body },
      options,
    )
  ).data;

export const listMaintenanceSchedules = async (
  query: Query<typeof listMaintenanceSchedulesEndpoint>,
  options?: CallOptions,
) => callEndpoint(listMaintenanceSchedulesEndpoint, { query }, options);

export const createMaintenanceSchedule = async (
  body: Body<typeof createMaintenanceScheduleEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(createMaintenanceScheduleEndpoint, { body }, options))
    .data;

export const listMaintenanceTickets = async (
  query: Query<typeof listMaintenanceTicketsEndpoint>,
  options?: CallOptions,
) => callEndpoint(listMaintenanceTicketsEndpoint, { query }, options);

export const getMaintenanceTicket = async (
  params: Params<typeof getMaintenanceTicketEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(getMaintenanceTicketEndpoint, { params }, options)).data;

export const createMaintenanceTicket = async (
  body: Body<typeof createMaintenanceTicketEndpoint>,
  options?: CallOptions,
) =>
  (await callEndpoint(createMaintenanceTicketEndpoint, { body }, options)).data;

export const postMaintenanceTicketTransition = async (
  params: Params<typeof postMaintenanceTicketTransitionEndpoint>,
  body: Body<typeof postMaintenanceTicketTransitionEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      postMaintenanceTicketTransitionEndpoint,
      { params, body },
      options,
    )
  ).data;

export const listShiftHandovers = async (
  query: Query<typeof listShiftHandoversEndpoint>,
  options?: CallOptions,
) => callEndpoint(listShiftHandoversEndpoint, { query }, options);

export const getShiftHandover = async (
  params: Params<typeof getShiftHandoverEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(getShiftHandoverEndpoint, { params }, options)).data;

export const createShiftHandover = async (
  body: Body<typeof createShiftHandoverEndpoint>,
  options?: CallOptions,
) => (await callEndpoint(createShiftHandoverEndpoint, { body }, options)).data;

export const acknowledgeShiftHandover = async (
  params: Params<typeof postShiftHandoverAcknowledgementEndpoint>,
  body: Body<typeof postShiftHandoverAcknowledgementEndpoint>,
  options?: CallOptions,
) =>
  (
    await callEndpoint(
      postShiftHandoverAcknowledgementEndpoint,
      { params, body },
      options,
    )
  ).data;

/** Menu names for the OPS-04 linked-menu view (WS-03 contract, read only). */
export const listMenuItems = async (
  query: Query<typeof listMenuItemsEndpoint>,
  options?: CallOptions,
) => callEndpoint(listMenuItemsEndpoint, { query }, options);

/** Service vendors are purchasing suppliers (owner decision legend-uy1e). */
export const listServiceVendors = async (
  query: Query<typeof listSuppliers>,
  options?: CallOptions,
) => callEndpoint(listSuppliers, { query }, options);
