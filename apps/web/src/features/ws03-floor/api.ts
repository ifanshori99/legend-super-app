// One typed caller per floor endpoint (docs/frontend.md "Typed endpoints and
// mock mode"). Components never call these: they use ./hooks.ts, which owns
// cache keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createFloorZone as createFloorZoneEndpoint,
  createTable as createTableEndpoint,
  deleteFloorZone as deleteFloorZoneEndpoint,
  deleteTable as deleteTableEndpoint,
  issueTableQr as issueTableQrEndpoint,
  saveFloorLayout as saveFloorLayoutEndpoint,
  updateFloorZone as updateFloorZoneEndpoint,
  updateTable as updateTableEndpoint,
} from "@starter/shared/qr-order";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

// ---- Zones ---------------------------------------------------------------

export const createZone = (body: Body<typeof createFloorZoneEndpoint>) =>
  callEndpoint(createFloorZoneEndpoint, { body });

export const updateZone = (
  params: Params<typeof updateFloorZoneEndpoint>,
  body: Body<typeof updateFloorZoneEndpoint>,
) => callEndpoint(updateFloorZoneEndpoint, { params, body });

export const deleteZone = (params: Params<typeof deleteFloorZoneEndpoint>) =>
  callEndpoint(deleteFloorZoneEndpoint, { params });

// ---- Tables --------------------------------------------------------------

export const createTable = (body: Body<typeof createTableEndpoint>) =>
  callEndpoint(createTableEndpoint, { body });

export const updateTable = (
  params: Params<typeof updateTableEndpoint>,
  body: Body<typeof updateTableEndpoint>,
) => callEndpoint(updateTableEndpoint, { params, body });

export const deleteTable = (params: Params<typeof deleteTableEndpoint>) =>
  callEndpoint(deleteTableEndpoint, { params });

/** Saves every moved table in one request (PUT /api/floor/layout). */
export const saveLayout = (body: Body<typeof saveFloorLayoutEndpoint>) =>
  callEndpoint(saveFloorLayoutEndpoint, { body });

// ---- Signed table QR -----------------------------------------------------

export const issueTableQr = (params: Params<typeof issueTableQrEndpoint>) =>
  callEndpoint(issueTableQrEndpoint, { params });
