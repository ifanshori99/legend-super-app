import { describe, expect, it, vi } from "vitest";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { S3ObjectStorage } from "../services/core-storage-provider";

const row = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../db/tenant", () => ({
  withTenant: async (
    _db: unknown,
    _ctx: unknown,
    fn: (tx: unknown) => unknown,
  ) =>
    fn({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [row.value] }) }),
      }),
    }),
}));
import { signedStorageUrl } from "../services/core-storage";

const tenantId = cafeLegendFixtures.tenant.id;
const outletId = cafeLegendFixtures.outlets[0]!.id;
const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);
const lookup = {
  tenantId,
  outletId,
  reference: "report",
  key: "tax/coretax.xml",
  visibility: "private" as const,
  expiresInSeconds: 60,
};
const objectId = "11111111-1111-4111-8111-111111111111";

function s3() {
  const sign = vi.fn(async (...args: [S3Client, GetObjectCommand]) =>
    args.length > 0 ? "https://storage.example/s" : "",
  );
  const storage = new S3ObjectStorage({
    client: { send: vi.fn() } as unknown as S3Client,
    privateBucket: "private",
    publicBucket: "public",
    publicBaseUrl: "https://cdn.example",
    sign,
  });
  return { storage, sign };
}

describe("legend-z6a5 Content-Disposition on signed download", () => {
  it("sets attachment filename and filename* on the signed GET", async () => {
    const { storage, sign } = s3();
    await storage.signedGetUrl(context, {
      ...lookup,
      downloadFileName: "coretax-pbjt-2026-03.xml",
    });
    const command = sign.mock.calls[0]![1];
    expect(command.input.ResponseContentDisposition).toBe(
      `attachment; filename="coretax-pbjt-2026-03.xml"; filename*=UTF-8''coretax-pbjt-2026-03.xml`,
    );
  });

  it("leaves the response header unset when no download name is given", async () => {
    const { storage, sign } = s3();
    await storage.signedGetUrl(context, lookup);
    expect(
      sign.mock.calls[0]![1].input.ResponseContentDisposition,
    ).toBeUndefined();
  });

  it.each([
    'a.xml"; filename="evil.exe',
    "a.xml\r\nSet-Cookie: x=1",
    "a\nb.xml",
    "../etc/passwd",
    "dir/a.xml",
    "a;b.xml",
    "a b.xml",
    "nama-é.xml",
    ".hidden.xml",
    "",
    "a".repeat(151),
  ])("rejects unsafe download name %j without signing", async (name) => {
    const { storage, sign } = s3();
    await expect(
      storage.signedGetUrl(context, { ...lookup, downloadFileName: name }),
    ).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
  });

  it("fake storage rejects unsafe names too", async () => {
    const storage = new FakeObjectStorage();
    await expect(
      storage.signedGetUrl(context, {
        ...lookup,
        downloadFileName: "a\r\nx.xml",
      }),
    ).rejects.toThrow();
  });

  it("signedStorageUrl passes downloadFileName to the provider", async () => {
    row.value = {
      outletId,
      purpose: "document",
      objectKey: "tax/coretax.xml",
      thumbnailKey: null,
    };
    const signedGetUrl = vi.fn(async () => "https://storage.example/s");
    const result = await signedStorageUrl(
      {} as never,
      context,
      objectId,
      "original",
      {
        storage: { signedGetUrl } as never,
        authorize: async () => true,
      },
      { downloadFileName: "coretax-ppn-2026-01.xml" },
    );
    expect(signedGetUrl).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ downloadFileName: "coretax-ppn-2026-01.xml" }),
    );
    expect(result.url).toBe("https://storage.example/s");
  });

  it("signedStorageUrl omits downloadFileName by default", async () => {
    const signedGetUrl = vi.fn(async () => "https://storage.example/s");
    await signedStorageUrl({} as never, context, objectId, "original", {
      storage: { signedGetUrl } as never,
      authorize: async () => true,
    });
    expect(signedGetUrl.mock.calls[0]![1]).not.toHaveProperty(
      "downloadFileName",
    );
  });
});
