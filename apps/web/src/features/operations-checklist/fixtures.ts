// Read-only label and option sources the contract does not expose yet.
//
// The checklist contract carries ids only: `schedule.shiftTemplateId`,
// `schedule.stationId`, `schedule.zoneId`, `roleId` and `assignedTo`. There is
// no list endpoint for shift templates, stations or tenant user accounts yet
// (the HRIS employee directory has a different id set and its `userId` may be
// null), so the screens resolve their names and picker options from the shared
// Cafe Legend fixtures — the same gap the roster screens state in the UI
// (features/ws10-roster/fixtures.ts). Zones are the exception: the floor board
// endpoint serves them, so `useFloorZones` reads the contract instead.
//
// When those endpoints land this module is the only place that changes; data
// reads and writes always go through the contract endpoints in `api.ts`.
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import type { Role } from "@starter/shared/access";
import { cafeLegendHrisFixtures } from "@starter/shared/hris";
import type { ShiftTemplate } from "@starter/shared/hris";

const shiftTemplates: readonly ShiftTemplate[] =
  cafeLegendHrisFixtures.shiftTemplates;

const shiftNameById: ReadonlyMap<string, string> = new Map(
  shiftTemplates.map((template) => [template.id, template.name]),
);

const stations = cafeLegendAccessFixtures.stations;
const stationNameById: ReadonlyMap<string, string> = new Map(
  stations.map((station) => [station.id, station.name]),
);

const roles: readonly Role[] = cafeLegendAccessFixtures.roles;
const roleNameById: ReadonlyMap<string, string> = new Map(
  roles.map((role) => [role.id, role.name]),
);

const people = Object.values(cafeLegendAccessFixtures.users);
const userNameById: ReadonlyMap<string, string> = new Map(
  people.map((person) => [person.id, person.displayName]),
);

/** Shift templates of one outlet (all outlets when the id is unknown). */
export function shiftOptions(
  outletId: string | null | undefined,
): readonly { id: string; name: string }[] {
  return shiftTemplates
    .filter((template) => !outletId || template.outletId === outletId)
    .map((template) => ({ id: template.id, name: template.name }));
}

/** Stations of one outlet, in fixture order. */
export function stationOptions(
  outletId: string | null | undefined,
): readonly { id: string; name: string }[] {
  return stations
    .filter((station) => !outletId || station.outletId === outletId)
    .map((station) => ({ id: station.id, name: station.name }));
}

/** Tenant roles a template can be assigned to (templates included: the API
 *  clones them per tenant, so a template role id is assignable here). */
export function roleOptions(): readonly { id: string; name: string }[] {
  return roles.map((role) => ({ id: role.id, name: role.name }));
}

/** Staff accounts a checklist run can be assigned to (`assignedTo` is a
 *  userId, not an employeeId). */
export function assigneeOptions(): readonly { id: string; name: string }[] {
  return people.map((person) => ({
    id: person.id,
    name: person.displayName,
  }));
}

export function shiftName(shiftTemplateId: string | null): string | null {
  return shiftTemplateId === null
    ? null
    : (shiftNameById.get(shiftTemplateId) ?? null);
}

export function stationName(stationId: string | null): string | null {
  return stationId === null ? null : (stationNameById.get(stationId) ?? null);
}

export function roleName(roleId: string | null): string | null {
  return roleId === null ? null : (roleNameById.get(roleId) ?? null);
}

export function userName(userId: string | null): string | null {
  return userId === null ? null : (userNameById.get(userId) ?? null);
}
