// 1269 F0 (founder 25 Nov 2026): the paid shower room is deferred past release
// 1. The API refuses facilities of type shower with FACILITY_SHOWER_DISABLED
// (env FACILITY_SHOWER_ENABLED, default off); this constant is the web side:
// one switch that hides the shower staff screens (booth board, cleaning,
// incidents), drops shower facilities from the facility settings, and keeps
// the guest booking entry /f/$facility closed until the paid WFC booking (W8)
// is wired. It is a build-time constant on purpose (the browser reads no server
// env). Flip it with the API flag when the shower is released. Guest Wi-Fi,
// the WFC policy and the facility reports are not behind it.
export const SHOWER_FACILITIES_RELEASED = false;

/** True when a facility of this type may appear in the web app. */
export function isFacilityTypeReleased(type: string): boolean {
  return SHOWER_FACILITIES_RELEASED || type !== "shower";
}
