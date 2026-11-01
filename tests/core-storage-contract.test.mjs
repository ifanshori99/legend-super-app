import { test } from "node:test";
import assert from "node:assert/strict";
import * as storage from "../packages/shared/src/storage/index.ts";

const outletId = "11111111-1111-4111-8111-111111111111";
test("legend-ruf: storage upload contract rejects extra fields and tenant IDs", () => {
  assert.equal(
    storage.uploadStorageMetadataSchema.safeParse({
      purpose: "menu_photo",
      outletId,
    }).success,
    true,
  );
  assert.equal(
    storage.uploadStorageMetadataSchema.safeParse({
      purpose: "menu_photo",
      outletId,
      tenantId: outletId,
    }).success,
    false,
  );
  assert.equal(
    storage.uploadStorageMetadataSchema.safeParse({
      purpose: "other",
      outletId,
    }).success,
    false,
  );
  assert.equal(
    storage.uploadStorageMetadataSchema.safeParse({
      purpose: "selfie",
      outletId: null,
    }).success,
    false,
  );
});
test("legend-ruf: purpose policy keeps personal documents private and limits upload bytes", () => {
  assert.equal(storage.storagePurposePolicy.menu_photo.visibility, "public");
  for (const purpose of ["selfie", "document", "receipt"])
    assert.equal(storage.storagePurposePolicy[purpose].visibility, "private");
  assert.equal(
    Math.max(
      ...Object.values(storage.storagePurposePolicy).map((p) => p.maxBytes),
    ),
    10 * 1024 * 1024,
  );
});
test("legend-ruf: storage endpoints declare authenticated object operations", () => {
  assert.equal(storage.uploadStorageObject.path, "/api/storage/uploads");
  assert.equal(
    storage.createStorageSignedUrl.path,
    "/api/storage/objects/:objectId/signed-url",
  );
  assert.equal(
    storage.createStorageSignedUrl.body.safeParse({ extra: true }).success,
    false,
  );
});
