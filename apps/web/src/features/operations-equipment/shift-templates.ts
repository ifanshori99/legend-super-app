// One read model the handover form needs but the HRIS contract does not expose
// yet: a list of shift templates (name + start/end times). `createShiftHandover`
// requires `fromShiftTemplateId` / `toShiftTemplateId`, but `@starter/shared/hris`
// only lists shift *assignments*, which carry ids and segments, not names.
//
// In mock mode the demo catalog answers the read so the handover form is
// reviewable (the same rows the handover fixtures reference, legend-cz9g).
// Against the real API it returns null and the form says the shift list is not
// available yet instead of inventing names. Follow-up bead: list shift
// templates (WS-10). Vite inlines API_MOCK, so a production build drops the
// fixture import with the dead branch.
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  cafeLegendHrisFixtures,
  type ShiftTemplate,
} from "@starter/shared/hris";

export function shiftTemplateOptions(
  outletId: string | undefined,
): readonly ShiftTemplate[] | null {
  if (!API_MOCK || !outletId) return null;
  return cafeLegendHrisFixtures.shiftTemplates.filter(
    (template) => template.outletId === outletId && template.isActive,
  );
}
