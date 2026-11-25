// 1269 F0: while the paid shower room is deferred (SHOWER_FACILITIES_RELEASED),
// every shower screen answers "not found". Presentation only; the API refuses
// the same actions on its own (FACILITY_TICKETS_DISABLED).
import { notFound } from "@tanstack/react-router";
import { SHOWER_FACILITIES_RELEASED } from "@starter/shared/facility";

export function showerGate(): void {
  if (!SHOWER_FACILITIES_RELEASED) throw notFound();
}
