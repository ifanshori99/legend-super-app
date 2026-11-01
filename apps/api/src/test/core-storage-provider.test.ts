import { describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendFixtures, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";

const tenantId = cafeLegendFixtures.tenant.id;
const outletId = cafeLegendFixtures.outlets[0]!.id;
const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);
const lookup = {
  tenantId,
  outletId,
  reference: "photo",
  key: "images/a.webp",
  visibility: "private" as const,
};

describe("legend-ruf object storage", () => {
  it("preserves binary content, isolates buckets and deletes objects", async () => {
    const storage = new FakeObjectStorage();
    const bytes = new Uint8Array([0, 255, 10]);
    await storage.put(context, {
      ...lookup,
      contentType: "image/webp",
      content: bytes,
    });
    bytes[0] = 42;
    expect((await storage.get(context, lookup)).content).toEqual(
      new Uint8Array([0, 255, 10]),
    );
    await expect(
      storage.get(context, { ...lookup, visibility: "public" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await storage.signedGetUrl(context, { ...lookup, expiresInSeconds: 60 }),
    ).toMatch(/^https:\/\//);
    await storage.delete(context, lookup);
    await expect(storage.get(context, lookup)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("denies tenant and outlet widening and invalid signing TTL", async () => {
    const storage = new FakeObjectStorage();
    const limited = establishScopedTenantContext(context.tenant, {
      kind: "outlets",
      outletIds: [outletId],
    });
    await expect(
      storage.delete(limited, { ...lookup, outletId: null }),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      storage.signedGetUrl(context, { ...lookup, expiresInSeconds: 3601 }),
    ).rejects.toThrow();
    await expect(
      storage.delete(context, {
        ...lookup,
        tenantId: tenantIdSchema.parse("99999999-9999-4999-8999-999999999999"),
      }),
    ).rejects.toThrow();
  });
});

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { vi } from "vitest";
import { S3ObjectStorage } from "../services/core-storage-provider.ts";

describe("legend-ruf S3 provider", () => {
  it("uses scoped paths and the correct bucket for binary put, read, sign and delete", async () => {
    const send = vi.fn(async (command: unknown) =>
      command instanceof GetObjectCommand
        ? {
            Body: { transformToByteArray: async () => new Uint8Array([7]) },
            ContentType: "image/webp",
            Metadata: { reference: "photo" },
          }
        : {},
    );
    const sign = vi.fn(async () => "https://storage.example/signed");
    const storage = new S3ObjectStorage({
      client: { send } as unknown as S3Client,
      privateBucket: "private",
      publicBucket: "public",
      publicBaseUrl: "https://cdn.example/images",
      sign,
    });
    await storage.put(context, {
      ...lookup,
      visibility: "public",
      contentType: "image/webp",
      content: new Uint8Array([7]),
    });
    expect(send.mock.calls[0]![0]).toBeInstanceOf(PutObjectCommand);
    expect((send.mock.calls[0]![0] as PutObjectCommand).input).toMatchObject({
      Bucket: "public",
      Key: `${tenantId}/${outletId}/images/a.webp`,
    });
    expect((await storage.get(context, lookup)).content).toEqual(
      new Uint8Array([7]),
    );
    expect(
      await storage.signedGetUrl(context, { ...lookup, expiresInSeconds: 60 }),
    ).toBe("https://storage.example/signed");
    expect(sign).toHaveBeenCalledOnce();
    expect(
      await storage.publicUrl(context, { ...lookup, visibility: "public" }),
    ).toBe(`https://cdn.example/images/${tenantId}/${outletId}/images/a.webp`);
    await storage.delete(context, lookup);
    expect(send.mock.calls.at(-1)![0]).toBeInstanceOf(DeleteObjectCommand);
  });
  it("refuses forged context, path traversal, invalid TTL and public signing", async () => {
    const send = vi.fn();
    const storage = new S3ObjectStorage({
      client: { send } as unknown as S3Client,
      privateBucket: "private",
      publicBucket: "public",
      publicBaseUrl: "https://cdn.example",
    });
    await expect(
      storage.delete(context, { ...lookup, key: "../escape" }),
    ).rejects.toThrow();
    await expect(
      storage.delete({} as typeof context, lookup),
    ).rejects.toThrow();
    await expect(
      storage.signedGetUrl(context, {
        ...lookup,
        visibility: "public",
        expiresInSeconds: 10,
      }),
    ).rejects.toThrow();
    await expect(
      storage.signedGetUrl(context, { ...lookup, expiresInSeconds: 3601 }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
