// One typed caller per HRIS endpoint the roster back office uses
// (docs/frontend.md "Typed endpoints and mock mode"). Components never call
// these directly: the hooks in ./hooks.ts own cache keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  listEmployees,
  listHolidays,
  listPositions,
  listShiftAssignments,
  publishRoster as publishRosterEndpoint,
} from "@starter/shared/hris";
import { callEndpoint } from "@/lib/api/endpoint";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

export const listRosterEmployees = (query: Query<typeof listEmployees>) =>
  callEndpoint(listEmployees, { query });

export const listRosterPositions = (query: Query<typeof listPositions>) =>
  callEndpoint(listPositions, { query });

export const listRosterShifts = (query: Query<typeof listShiftAssignments>) =>
  callEndpoint(listShiftAssignments, { query });

export const listRosterHolidays = (query: Query<typeof listHolidays>) =>
  callEndpoint(listHolidays, { query });

export const publishRoster = (body: Body<typeof publishRosterEndpoint>) =>
  callEndpoint(publishRosterEndpoint, { body });
