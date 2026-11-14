import { describe, expect, it } from "vitest";
import { edgePeopleSnapshotSchema } from "@starter/shared/edge/people-snapshot";
import {
  catalogSyncPageSchema,
  catalogSyncQuerySchema,
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
});
