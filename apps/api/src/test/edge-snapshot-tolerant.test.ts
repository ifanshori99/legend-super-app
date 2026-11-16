import { describe, expect, it } from "vitest";
import { edgePeopleSnapshotSchema } from "@starter/shared/edge/people-snapshot";
import {
  catalogSyncPageSchema,
  catalogSyncCloudPageSchema,
  deviceSyncCloudPageSchema,
  edgeBootstrapBundleCloudSchema,
  edgeMasterSnapshotCloudSchema,
  catalogSyncQuerySchema,
  CATALOG_SYNC_STREAMS,
  deviceReceiptSequenceSyncSchema,
} from "@starter/shared/edge";

const id = "11111111-1111-4111-8111-111111111111";

const snapshot = {
  users: [],
  roles: [],
  roleAssignments: [],
  employees: [],
  shiftAssignments: [],
  attendancePolicies: [],
  qrKeys: [{ dayIndex: 1, key: Buffer.alloc(32).toString("base64") }],
  selfieSealKey: null,
};

describe("cloud-to-edge snapshot compatibility", () => {
  it("rejects hidden credentials before stripping any catalog stream", () => {
    for (const stream of CATALOG_SYNC_STREAMS) {
      const page = { stream, records: [], nextCursor: null, hasMore: false };
      expect(catalogSyncPageSchema.safeParse(page).success, stream).toBe(true);
      expect(
        catalogSyncPageSchema.safeParse({
          ...page,
          future: { apiToken: "secret" },
        }).success,
        stream,
      ).toBe(false);
    }
  });

  it("strips unknown fields at the snapshot and nested record levels", () => {
    const parsed = edgePeopleSnapshotSchema.parse({
      ...snapshot,
      futureField: "ignored",
      qrKeys: [{ ...snapshot.qrKeys[0], futureField: "ignored" }],
    });
    expect(parsed).toEqual(snapshot);
  });

  it("still rejects an invalid known field", () => {
    expect(
      edgePeopleSnapshotSchema.safeParse({
        ...snapshot,
        qrKeys: [{ ...snapshot.qrKeys[0], dayIndex: "1" }],
      }).success,
    ).toBe(false);
  });

  it("strips extra catalog page and record fields but keeps the API query strict", () => {
    const row = {
      id,
      tenantId: id,
      outletId: id,
      name: "Bar",
      type: "coffee_bar",
      printerDeviceId: null,
      targetSeconds: null,
      displayOrder: 0,
      isActive: true,
      autoPrintFallback: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      syncTxid: "1",
    };
    const page = {
      stream: "stations",
      records: [row],
      nextCursor: null,
      hasMore: false,
    };
    expect(
      catalogSyncPageSchema.parse({
        ...page,
        future: 1,
        records: [{ ...row, future: 2 }],
      }),
    ).toEqual(page);
    expect(
      catalogSyncPageSchema.safeParse({
        ...page,
        records: [{ ...row, name: 1 }],
      }).success,
    ).toBe(false);
    expect(
      catalogSyncQuerySchema.safeParse({ stream: "stations", future: 1 })
        .success,
    ).toBe(false);
  });

  it("strips extra receipt-sequence fields and rejects invalid known values", () => {
    const row = {
      id,
      outletId: id,
      deviceId: id,
      prefix: "ABC",
      lastNumber: 0,
      edgeNodeId: id,
      edgeInstanceId: id,
    };
    expect(
      deviceReceiptSequenceSyncSchema.parse({ ...row, future: 1 }),
    ).toEqual(row);
    expect(
      deviceReceiptSequenceSyncSchema.safeParse({ ...row, lastNumber: "0" })
        .success,
    ).toBe(false);
  });

  it("rejects extra fields on money and recipe records and their children", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const base = { id, tenantId: id };
    const stamps = {
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      syncTxid: "1",
    };
    const item = {
      ...base,
      priceListId: id,
      itemId: id,
      variantId: null,
      priceIdr: 1000,
      createdAt: at,
      updatedAt: at,
    };
    const line = {
      ...base,
      recipeId: id,
      sortOrder: 0,
      componentType: "item",
      componentId: id,
      quantity: "1.0000",
      uomId: id,
      wastePctBp: 0,
    };
    const rows = [
      {
        stream: "menu_items",
        record: {
          ...base,
          brandId: id,
          categoryId: id,
          name: "Food",
          description: "",
          type: "single",
          stationId: null,
          stationType: null,
          course: null,
          recipeId: null,
          taxRuleId: null,
          labels: [],
          allergens: [],
          mediaId: null,
          isActive: true,
          sortOrder: 0,
          ...stamps,
        },
      },
      {
        stream: "modifiers",
        record: {
          ...base,
          groupId: id,
          name: "Extra",
          priceIdr: 1000,
          recipeId: null,
          stationId: null,
          ...stamps,
        },
      },
      {
        stream: "price_lists",
        record: {
          ...base,
          outletId: id,
          channel: "dine_in",
          effectiveFrom: "2026-01-01",
          items: [item],
          ...stamps,
        },
      },
      {
        stream: "recipes",
        record: {
          ...base,
          brandId: id,
          name: "Recipe",
          outputItemId: null,
          yieldQuantity: "1.0000",
          yieldUomId: id,
          version: 1,
          isActive: true,
          theoreticalCostIdr: "0.0000",
          updatedBy: "user",
          lines: [line],
          createdAt: at,
          updatedAt: at,
          syncTxid: "1",
        },
      },
    ];
    for (const { stream, record } of rows) {
      const page = {
        stream,
        records: [record],
        nextCursor: null,
        hasMore: false,
      };
      expect(catalogSyncPageSchema.safeParse(page).success, stream).toBe(true);
      expect(
        catalogSyncPageSchema.safeParse({
          ...page,
          records: [{ ...record, future: true }],
        }).success,
        stream,
      ).toBe(false);
    }
    const priceList = rows[2]!.record;
    const recipe = rows[3]!.record;
    expect(
      catalogSyncPageSchema.safeParse({
        stream: "price_lists",
        records: [{ ...priceList, items: [{ ...item, future: true }] }],
        nextCursor: null,
        hasMore: false,
      }).success,
    ).toBe(false);
    expect(
      catalogSyncPageSchema.safeParse({
        stream: "recipes",
        records: [{ ...recipe, lines: [{ ...line, future: true }] }],
        nextCursor: null,
        hasMore: false,
      }).success,
    ).toBe(false);
  });
});

describe("strict cloud output", () => {
  it("rejects accidental columns at root and nested rows for all four contracts", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const bundle = {
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
    expect(edgeBootstrapBundleCloudSchema.safeParse(bundle).success).toBe(true);
    expect(
      edgeBootstrapBundleCloudSchema.safeParse({ ...bundle, leaked: 1 })
        .success,
    ).toBe(false);
    expect(
      edgeBootstrapBundleCloudSchema.safeParse({
        ...bundle,
        tenant: { ...bundle.tenant, leaked: 1 },
      }).success,
    ).toBe(false);
    const master = {
      version: 1,
      issuedAt: at,
      tenantId: id,
      outletId: id,
      legalEntityId: id,
      uoms: [
        {
          id,
          tenantId: id,
          code: "EA",
          name: "Each",
          isSystem: false,
          createdAt: at,
        },
      ],
      stockLocations: [],
      chartOfAccounts: [],
      accountMappings: [],
    };
    expect(edgeMasterSnapshotCloudSchema.safeParse(master).success).toBe(true);
    expect(
      edgeMasterSnapshotCloudSchema.safeParse({ ...master, leaked: 1 }).success,
    ).toBe(false);
    expect(
      edgeMasterSnapshotCloudSchema.safeParse({
        ...master,
        uoms: [{ ...master.uoms[0], leaked: 1 }],
      }).success,
    ).toBe(false);
    const device = {
      data: [],
      meta: { limit: 1, nextCursor: null, watermark: null },
    };
    expect(deviceSyncCloudPageSchema.safeParse(device).success).toBe(true);
    expect(
      deviceSyncCloudPageSchema.safeParse({ ...device, leaked: 1 }).success,
    ).toBe(false);
    expect(
      deviceSyncCloudPageSchema.safeParse({
        ...device,
        meta: { ...device.meta, leaked: 1 },
      }).success,
    ).toBe(false);
    const catalog = {
      stream: "stations",
      records: [
        {
          id,
          tenantId: id,
          outletId: id,
          name: "Bar",
          type: "coffee_bar",
          printerDeviceId: null,
          targetSeconds: null,
          displayOrder: 0,
          isActive: true,
          autoPrintFallback: false,
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
          syncTxid: "1",
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
    expect(catalogSyncCloudPageSchema.safeParse(catalog).success).toBe(true);
    expect(
      catalogSyncCloudPageSchema.safeParse({ ...catalog, leaked: 1 }).success,
    ).toBe(false);
    expect(
      catalogSyncCloudPageSchema.safeParse({
        ...catalog,
        records: [{ ...catalog.records[0], leaked: 1 }],
      }).success,
    ).toBe(false);
  });
});
