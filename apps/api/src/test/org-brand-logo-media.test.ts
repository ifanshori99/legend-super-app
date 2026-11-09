// legend-ja7i7 (TEN-10, same gap as legend-iiqx in theme drafts): a brand's
// logoMediaId must be an object of the caller's own tenant media library. A bare
// uuid would let one tenant point its brand at another tenant's file.
// Assumption: refusal is 422 VALIDATION_ERROR, identical for "other tenant" and
// "does not exist" (no existence oracle); null clears the logo.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CreateBrandInput,
  UpdateBrandInput,
} from "@starter/shared/platform";
import { createBrand, updateBrand } from "../services/org.service";
import {
  createTestTenant,
  owner,
  removeTestTenant,
  storedMedia,
  type TestTenant,
} from "./platform-theme-helpers";

let a: TestTenant;
let b: TestTenant;

const slug = () => `logo-${randomUUID().slice(0, 8)}`;
const create = (t: TestTenant, logoMediaId: string | null) =>
  createBrand(t.context, {
    slug: slug(),
    name: "Brand Logo",
    logoMediaId,
  } as unknown as CreateBrandInput);
const update = (t: TestTenant, logoMediaId: string | null) =>
  updateBrand(t.context, t.brandId, {
    logoMediaId,
  } as unknown as UpdateBrandInput);

beforeAll(async () => {
  a = await createTestTenant("brand-logo-a");
  b = await createTestTenant("brand-logo-b");
});

afterAll(async () => {
  for (const t of [a, b])
    await owner
      .query("DELETE FROM brands WHERE tenant_id = $1 AND id <> $2", [
        t.tenantId,
        t.brandId,
      ])
      .catch(() => undefined);
  await removeTestTenant(a);
  await removeTestTenant(b);
  await owner.end();
});

const refused = { status: 422, code: "VALIDATION_ERROR" };

describe("legend-ja7i7 brand logoMediaId belongs to the tenant", () => {
  it("createBrand accepts the tenant's own media and null", async () => {
    const mediaId = await storedMedia(a);
    expect((await create(a, mediaId)).logoMediaId).toBe(mediaId);
    expect((await create(a, null)).logoMediaId).toBeNull();
  });

  it("createBrand refuses another tenant's media and an unknown id (nothing stored)", async () => {
    const foreign = await storedMedia(b);
    const name = slug();
    await expect(
      createBrand(a.context, {
        slug: name,
        name: "Foreign",
        logoMediaId: foreign,
      } as unknown as CreateBrandInput),
    ).rejects.toMatchObject(refused);
    await expect(create(a, randomUUID())).rejects.toMatchObject(refused);
    const { rows } = await owner.query(
      "SELECT 1 FROM brands WHERE tenant_id = $1 AND slug = $2",
      [a.tenantId, name],
    );
    expect(rows).toHaveLength(0);
  });

  it("updateBrand accepts the tenant's own media, then null clears it", async () => {
    const mediaId = await storedMedia(a);
    expect((await update(a, mediaId)).logoMediaId).toBe(mediaId);
    expect((await update(a, null)).logoMediaId).toBeNull();
  });

  it("updateBrand refuses another tenant's media and an unknown id (logo unchanged)", async () => {
    const own = await storedMedia(a);
    await update(a, own);
    const foreign = await storedMedia(b);
    await expect(update(a, foreign)).rejects.toMatchObject(refused);
    await expect(update(a, randomUUID())).rejects.toMatchObject(refused);
    const { rows } = await owner.query<{ logo_media_id: string }>(
      "SELECT logo_media_id FROM brands WHERE id = $1",
      [a.brandId],
    );
    expect(rows[0]!.logo_media_id).toBe(own);
  });

  it("updateBrand without logoMediaId (name only) is unaffected", async () => {
    const renamed = await updateBrand(a.context, a.brandId, {
      name: "Nama Baru",
    } as unknown as UpdateBrandInput);
    expect(renamed.name).toBe("Nama Baru");
  });
});
