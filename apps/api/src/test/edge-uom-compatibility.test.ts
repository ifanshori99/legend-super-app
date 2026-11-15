import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  edgeMasterSnapshotSchema,
  edgeMasterUomSchema,
} from "@starter/shared/edge/master-sync";

const legacyUom = {
  id: randomUUID(),
  tenantId: randomUUID(),
  code: "pcs",
  name: "Piece",
  createdAt: "2026-11-14T00:00:00.000Z",
};

describe("legend-tkc19 edge UOM snapshot compatibility", () => {
  it("defaults a missing isSystem to false", () => {
    expect(edgeMasterUomSchema.parse(legacyUom)).toMatchObject({
      isSystem: false,
    });
  });

  it("preserves explicit isSystem values", () => {
    expect(
      edgeMasterUomSchema.parse({ ...legacyUom, isSystem: true }),
    ).toMatchObject({
      isSystem: true,
    });
    expect(
      edgeMasterUomSchema.parse({ ...legacyUom, isSystem: false }),
    ).toMatchObject({
      isSystem: false,
    });
  });

  it("documents that the legacy strict schema rejects the added field", () => {
    const legacySchema = edgeMasterUomSchema.pick({
      id: true,
      tenantId: true,
      code: true,
      name: true,
      createdAt: true,
    });
    expect(legacySchema.safeParse(legacyUom).success).toBe(true);
    expect(
      legacySchema.safeParse({ ...legacyUom, isSystem: true }).success,
    ).toBe(false);
  });

  it("rejects unknown and sensitive fields in inbound UOM rows", () => {
    const snapshot = {
      version: 1,
      issuedAt: legacyUom.createdAt,
      tenantId: legacyUom.tenantId,
      outletId: randomUUID(),
      legalEntityId: randomUUID(),
      uoms: [legacyUom],
      stockLocations: [],
      chartOfAccounts: [],
      accountMappings: [],
    };
    expect(edgeMasterSnapshotSchema.safeParse(snapshot).success).toBe(true);
    for (const extra of [{ token: "secret" }, { unexpected: true }]) {
      expect(
        edgeMasterSnapshotSchema.safeParse({
          ...snapshot,
          uoms: [{ ...legacyUom, ...extra }],
        }).success,
      ).toBe(false);
    }
  });
});
