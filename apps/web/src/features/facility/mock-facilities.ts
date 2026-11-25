// Mock-mode facilities (VITE_API_MOCK=true). localStorage
// ["legend.mock.boothType"] = "coworking" serves the booth fixture as an open
// facility type, so the board, cleaning and booking specs keep running while
// showers are deferred (1269 F0). Anything else keeps the shower fixture.
import { cafeLegendFacilityFixtures as fx } from "@starter/shared/facility";
import type { Facility } from "@starter/shared/facility";

const BOOTH_TYPE_KEY = "legend.mock.boothType";

export function mockFacilities(): Facility[] {
  const open =
    typeof window !== "undefined" &&
    window.localStorage.getItem(BOOTH_TYPE_KEY) === "coworking";
  return fx.facilities.map((facility) =>
    open && facility.type === "shower"
      ? { ...facility, type: "coworking" as const }
      : facility,
  );
}
