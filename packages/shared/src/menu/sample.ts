// Light menu sample: only the station ids and their outlets, no item names.
// Lives behind its own subpath, `@starter/shared/menu/sample`, so production
// code that only needs station reach does not pull the sample menu catalog
// (bead legend-n64n). `cafeLegendMenuFixtures` in ./fixtures.ts builds its
// stations from these refs, so ids and outlets stay in one place.
import { cafeLegendCoreSample } from "../core/sample.ts";

const { tenant, outlets } = cafeLegendCoreSample;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ref = (n: number, outletId: (typeof outlets)[number]["id"]) => ({
  id: id(n),
  tenantId: tenant.id,
  outletId,
});

/** Stations 200-203 belong to the first outlet; 205 to the second. */
export const cafeLegendStationRefs = [
  ref(200, outlets[0].id),
  ref(201, outlets[0].id),
  ref(202, outlets[0].id),
  ref(203, outlets[0].id),
  ref(205, outlets[1].id),
] as const;
