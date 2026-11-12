import { describe, expect, it } from "vitest";
import {
  storagePurposePolicy,
  storageSourceKindSchema,
  storageSourceKindPurpose,
  uploadStorageMetadataSchema,
} from "@starter/shared/storage";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { storageSourcePermissionMap } from "../services/core-storage-access.ts";

describe("legend-d78a private waste evidence transport", () => {
  it("classifies waste evidence as its own receipt source kind", () => {
    expect(storageSourceKindSchema.safeParse("waste_log").success).toBe(true);
    expect(Reflect.get(storageSourceKindPurpose, "waste_log")).toBe("receipt");
    expect(
      uploadStorageMetadataSchema.safeParse({
        purpose: "receipt",
        sourceKind: "waste_log",
        outletId: cafeLegendPlatformFixtures.outlets[0]!.id,
      }).success,
    ).toBe(true);
  });
  it("requires waste recording for upload and stock viewing for read", () => {
    expect(Reflect.get(storageSourcePermissionMap, "waste_log")).toEqual({
      upload: ["inventory.waste.record"],
      read: ["inventory.stock.view"],
    });
  });
  it("keeps receipt evidence private and capped at ten MiB", () => {
    expect(storagePurposePolicy.receipt).toMatchObject({
      visibility: "private",
      maxBytes: 10 * 1024 * 1024,
    });
  });
});
