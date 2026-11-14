import { describe, expect, it } from "vitest";
import {
  deviceReceiptSequenceSyncSchema,
  deviceReceiptWriteoffSyncSchema,
  deviceSyncPageSchema,
  edgeBootstrapBundleSchema,
} from "@starter/shared/edge";
import { edgeMasterSnapshotSchema } from "@starter/shared/edge/master-sync";
import { decodeFrame } from "../edge/protocol.ts";

const id = "11111111-1111-4111-8111-111111111111";
const at = "2026-01-01T00:00:00.000Z";
const bootstrap = {
  version: 1,
  issuedAt: at,
  tenant: {
    id,
    slug: "tenant",
    name: "Tenant",
    plan: "base",
    status: "active",
    deploymentMode: "shared",
    featureFlags: {},
    limits: {},
    createdBy: "user",
    createdAt: at,
  },
  legalEntity: {
    id,
    tenantId: id,
    name: "Legal",
    isPkp: false,
    address: null,
    createdAt: at,
  },
  brands: [
    {
      id,
      tenantId: id,
      slug: "brand",
      name: "Brand",
      logoMediaId: null,
      themeId: null,
      createdAt: at,
    },
  ],
  outlet: {
    id,
    tenantId: id,
    brandId: id,
    legalEntityId: id,
    code: "OUTLET",
    name: "Outlet",
    address: "Street",
    geofence: null,
    timezone: "Asia/Jakarta",
    businessDayCutoff: "04:00",
    openingHours: {},
    edgeNodeId: null,
    status: "active",
    createdAt: at,
  },
};
const master = {
  version: 1,
  issuedAt: at,
  tenantId: id,
  outletId: id,
  legalEntityId: id,
  uoms: [],
  stockLocations: [
    {
      id,
      tenantId: id,
      outletId: id,
      name: "Stock",
      type: "warehouse",
      isActive: true,
      createdAt: at,
    },
  ],
  chartOfAccounts: [],
  accountMappings: [],
};
const sequence = {
  id,
  outletId: id,
  deviceId: id,
  prefix: "ABC",
  lastNumber: 0,
  edgeNodeId: id,
  edgeInstanceId: id,
};
const writeoff = {
  id,
  outletId: id,
  sequenceId: id,
  prefix: "ABC",
  sequenceNumber: 1,
  reason: "duplicate number",
  writtenOffBy: id,
  createdAt: at,
};

describe("edge stream credential filtering", () => {
  it("rejects sensitive fields before bootstrap and master stripping", () => {
    expect(edgeBootstrapBundleSchema.safeParse(bootstrap).success).toBe(true);
    expect(
      edgeBootstrapBundleSchema.safeParse({
        ...bootstrap,
        tenant: { ...bootstrap.tenant, apiToken: "secret" },
      }).success,
    ).toBe(false);
    for (const key of ["featureFlags", "limits"] as const) {
      expect(
        edgeBootstrapBundleSchema.safeParse({
          ...bootstrap,
          tenant: { ...bootstrap.tenant, [key]: { apiToken: "secret" } },
        }).success,
        key,
      ).toBe(false);
    }
    for (const key of ["geofence", "openingHours"] as const) {
      expect(
        edgeBootstrapBundleSchema.safeParse({
          ...bootstrap,
          outlet: { ...bootstrap.outlet, [key]: { apiToken: "secret" } },
        }).success,
        key,
      ).toBe(false);
    }
    expect(edgeMasterSnapshotSchema.safeParse(master).success).toBe(true);
    expect(
      edgeMasterSnapshotSchema.safeParse({
        ...master,
        stockLocations: [{ ...master.stockLocations[0], apiToken: "secret" }],
      }).success,
    ).toBe(false);
  });
  it("rejects sensitive fields in receipt streams and the device envelope", () => {
    expect(deviceReceiptSequenceSyncSchema.safeParse(sequence).success).toBe(
      true,
    );
    expect(
      deviceReceiptSequenceSyncSchema.safeParse({
        ...sequence,
        apiToken: "secret",
      }).success,
    ).toBe(false);
    expect(deviceReceiptWriteoffSyncSchema.safeParse(writeoff).success).toBe(
      true,
    );
    expect(
      deviceReceiptWriteoffSyncSchema.safeParse({
        ...writeoff,
        apiToken: "secret",
      }).success,
    ).toBe(false);
    const page = {
      data: [],
      meta: { limit: 1, nextCursor: null, watermark: null },
    };
    expect(deviceSyncPageSchema.safeParse(page).success).toBe(true);
    expect(
      deviceSyncPageSchema.safeParse({ ...page, apiToken: "secret" }).success,
    ).toBe(false);
  });
  it("rejects sensitive unknown link fields while allowing ordinary extension fields", () => {
    const frame = { type: "hello", version: "1", inboundCursor: "0" };
    expect(decodeFrame(JSON.stringify({ ...frame, future: 1 }), true)).toEqual(
      frame,
    );
    expect(
      decodeFrame(JSON.stringify({ ...frame, apiToken: "secret" }), true),
    ).toBeNull();
  });
});
