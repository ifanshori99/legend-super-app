// The roster screens read two things the HRIS contract does not expose yet:
// the shift-template catalog (`shift_templates`) and the tenant's compliance
// policy (`shift_compliance_policy`). There is no list/read endpoint for
// either, so the screens use the shared Cafe Legend fixtures and say so in the
// UI. When those endpoints land (follow-up bead) this module is the only place
// that changes. The assignment read and the publish write go through the
// contract endpoints in `api.ts`, never through these fixtures.
import { cafeLegendHrisFixtures } from "@starter/shared/hris";
import { cafeLegendMenuFixtures } from "@starter/shared/menu";

export const ROSTER_TENANT_ID = cafeLegendHrisFixtures.tenant.id;

/** Templates of one outlet, active and inactive, in fixture order. */
export function rosterTemplatesFor(outletId: string | undefined) {
  return cafeLegendHrisFixtures.shiftTemplates.filter(
    (template) => template.outletId === outletId,
  );
}

/** Tenant-wide working-time limits (PRD F26 "Kepatuhan", HR-05). */
export const ROSTER_COMPLIANCE_POLICY =
  cafeLegendHrisFixtures.shiftCompliancePolicy;

const STATION_NAMES = new Map(
  cafeLegendMenuFixtures.stations.map((station) => [station.id, station.name]),
);

/** Station label for an assignment/template; the menu owns station names. */
export function stationName(stationId: string | null): string | null {
  return stationId === null ? null : (STATION_NAMES.get(stationId) ?? null);
}
