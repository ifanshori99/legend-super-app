// 1269 F0 (founder 25 Nov 2026): the paid shower room is deferred past release
// 1. The API refuses facilities of type shower with FACILITY_SHOWER_DISABLED
// (env FACILITY_SHOWER_ENABLED, default off); this constant is the web side,
// applied per facility type: the booth board, cleaning, incidents and the guest
// booking page leave showers out, and the settings of a shower show only its
// guest Wi-Fi policy. Coworking, lockers and meeting rooms are untouched, and
// the emergency screen and panic alerts always cover every facility. It is a
// build-time constant on purpose (the browser reads no server env). Flip it
// with the API flag when the shower is released.
export const SHOWER_FACILITIES_RELEASED = false;

/** True when a facility of this type may appear in the web app. */
export function isFacilityTypeReleased(type: string): boolean {
  return SHOWER_FACILITIES_RELEASED || type !== "shower";
}
