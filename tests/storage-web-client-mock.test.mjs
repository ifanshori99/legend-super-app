import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/api/mock-flag")
      return {
        url: "data:text/javascript,export const API_MOCK=true",
        shortCircuit: true,
      };
    if (specifier === "@/lib/env")
      return {
        url: "data:text/javascript,export const API_URL='https://api.example.test'",
        shortCircuit: true,
      };
    if (specifier.startsWith("@/"))
      return nextResolve(
        new URL(`../apps/web/src/${specifier.slice(2)}.ts`, import.meta.url)
          .href,
        context,
      );
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier))
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const outletId = "00000000-0000-4000-8000-000000000002";

test("[legend-avf8m M1-05] mock upload returns a schema-valid object and a working local blob URL without network", async () => {
  const { uploadStorageFile, fetchStorageObjectUrl } =
    await import("../apps/web/src/features/storage/api.ts");
  const { storageObjectSchema } =
    await import("../packages/shared/src/storage/index.ts");
  const photo = new Blob(["local-photo"], { type: "image/jpeg" });
  globalThis.fetch = async () => {
    throw new Error("Mock storage must not call the network");
  };
  const object = await uploadStorageFile({
    purpose: "goods_receipt_photo",
    sourceKind: "goods_receipt",
    outletId,
    file: photo,
  });
  assert.equal(storageObjectSchema.safeParse(object).success, true);
  assert.equal(object.purpose, "goods_receipt_photo");
  const signed = await fetchStorageObjectUrl(object.id, "thumbnail");
  assert.match(signed.url, /^blob:/);
  assert.ok(Date.parse(signed.expiresAt) > Date.now());
  assert.ok(Date.parse(signed.expiresAt) <= Date.now() + 300_000);
  const local = await originalFetch(signed.url);
  assert.equal(await local.text(), "local-photo");
});

test("[legend-avf8m M1-05] mock upload applies the same strict client image limit", async () => {
  const { uploadStorageFile } =
    await import("../apps/web/src/features/storage/api.ts");
  await assert.rejects(
    uploadStorageFile({
      purpose: "goods_receipt_photo",
      sourceKind: "goods_receipt",
      outletId,
      file: new Blob([new Uint8Array(5 * 1024 * 1024)], { type: "image/jpeg" }),
    }),
  );
});
