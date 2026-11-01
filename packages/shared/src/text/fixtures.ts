// Cafe Legend mock term overrides (FE mock mode + contract tests). Realistic
// but illustrative: the tenant shortens the production-station labels its
// staff see, names its shower facility after the brand, and pre-fills a few
// English labels for the menu translation that ships in P1. Facts from PRD
// v1.7: stations "bar kopi, bar nonkopi, dapur panas, dapur dingin, pastry"
// (§3 WS-03), "Shower Room Legend" (§3 WS-09) and tier examples Silver, Gold,
// Platinum (§3 WS-08).

import { cafeLegendFixtures } from "../core/index.ts";
import { textFixtureSchema, textOverrideSchema } from "./schemas.ts";

const { tenant } = cafeLegendFixtures;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const updatedAt = "2026-11-01T09:00:00.000Z";
const rows = [
  // Café staff say "Kopi"/"Nonkopi", not the platform's "Bar Kopi".
  { n: 9001, locale: "id", key: "terms.stationBarKopi", value: "Kopi" },
  { n: 9002, locale: "id", key: "terms.stationBarNonkopi", value: "Nonkopi" },
  { n: 9003, locale: "id", key: "terms.stationPastry", value: "Pastry" },
  // The facility is branded for this tenant.
  {
    n: 9004,
    locale: "id",
    key: "terms.showerRoom",
    value: "Shower Room Legend",
  },
  // English labels pre-filled before the English catalog (PRD F47, P1).
  { n: 9005, locale: "en", key: "terms.table", value: "Table" },
  { n: 9006, locale: "en", key: "terms.stationBarKopi", value: "Coffee Bar" },
] as const;

const overrides = rows.map((row) =>
  textOverrideSchema.parse({
    id: id(row.n),
    tenantId: tenant.id,
    locale: row.locale,
    key: row.key,
    value: row.value,
    updatedAt,
  }),
);

export const cafeLegendTextFixtures = textFixtureSchema.parse({ overrides });
