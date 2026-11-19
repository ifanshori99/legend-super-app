// Light Cafe Legend sample: tenant, brand, outlets and the legal entity, with
// no order lines or menu names. Lives behind its own subpath,
// `@starter/shared/core/sample`, so production code that only needs outlet
// ids and names does not pull the order-line fixtures (bead legend-n64n).
// `cafeLegendFixtures` in ./fixtures.ts builds on this same data.
import { brandRefSchema, outletRefSchema, tenantRefSchema } from "./refs.ts";
import { DEFAULT_TIME_ZONE } from "./time.ts";

const tenant = tenantRefSchema.parse({
  id: "0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70",
  slug: "cafe-legend",
  name: "Cafe Legend",
});
const brand = brandRefSchema.parse({
  id: "3c9e5a71-2b84-4f6d-8e10-5a7b9c2d4e61",
  tenantId: tenant.id,
  slug: "cafe-legend",
  name: "Cafe Legend",
});
const outlets = [
  outletRefSchema.parse({
    id: "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
    tenantId: tenant.id,
    brandId: brand.id,
    code: "BDG-01",
    name: "Cafe Legend Bandung",
    timeZone: DEFAULT_TIME_ZONE,
    status: "active",
  }),
  outletRefSchema.parse({
    id: "9e4b7c21-5d6f-4a8b-b3c0-1f2e3d4c5b6a",
    tenantId: tenant.id,
    brandId: brand.id,
    code: "BDG-02",
    name: "Cafe Legend Bandung 2 (contoh)",
    timeZone: DEFAULT_TIME_ZONE,
    status: "preopening",
  }),
] as const;

export const cafeLegendCoreSample = {
  tenant,
  brand,
  legalEntityName: "PT Sultan Solusi Nusantara",
  outlets,
};
