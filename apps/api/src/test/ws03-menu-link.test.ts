// WS-03 menu contract W1: item <-> modifier group link (legend-un0j), reorder
// semantics, and the media outlet scope (legend-dcz0). Real Express app and
// PostgreSQL with RLS, same harness as menu-api.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { FakeObjectStorage } from "@starter/shared/adapters";
import {
  cafeLegendMenuFixtures,
  itemModifierGroupLinkSchema,
  menuFixtureSchema,
  uploadMenuImage,
} from "@starter/shared/menu";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";
import { uploadMenuPhoto } from "../services/menu-media.service";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers";

const app = createApp();
const { tenant, brand, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const brandId = brand.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUserIds: string[] = [];
const tag = randomBytes(3).toString("hex");
let foreignTenant: IsolatedTenant | null = null;

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (foreignTenant) await dropIsolatedTenant(foreignTenant);
  if (createdUserIds.length > 0)
    await ownerPool.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
  await ownerPool.end();
});

async function ownerClient() {
  const client = agent(app);
  await signUp(client, "Menu Link User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', NULL, now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId, userId],
  );
  createdUserIds.push(userId);
  return { client, userId };
}

type Client = ReturnType<typeof agent>;

async function post(client: Client, path: string, send: object) {
  const response = await client.post(path).set(originHeader).send(send);
  expect(response.status).toBe(201);
  return (response.body as { data: { id: string } }).data.id;
}

describe("legend-un0j shared link contract", () => {
  it("fixture links match the table shape and point at fixture rows", () => {
    const { itemModifierGroups, items, modifierGroups } = cafeLegendMenuFixtures;
    expect(itemModifierGroups.length).toBeGreaterThan(0);
    const keys = new Set<string>();
    for (const link of itemModifierGroups) {
      expect(itemModifierGroupLinkSchema.parse(link)).toEqual(link);
      expect(items.some((item) => item.id === link.itemId)).toBe(true);
      expect(modifierGroups.some((group) => group.id === link.groupId)).toBe(
        true,
      );
      keys.add(`${link.itemId}:${link.groupId}`);
    }
    // (item, group) is unique, like menu_item_modifier_groups_tenant_item_group_key.
    expect(keys.size).toBe(itemModifierGroups.length);
    expect(menuFixtureSchema.parse(cafeLegendMenuFixtures)).toBeTruthy();
  });

  it("link schema is strict and refuses a negative sortOrder", () => {
    const link = { itemId: randomUUID(), groupId: randomUUID(), sortOrder: 0 };
    expect(itemModifierGroupLinkSchema.safeParse(link).success).toBe(true);
    expect(
      itemModifierGroupLinkSchema.safeParse({ ...link, sortOrder: -1 }).success,
    ).toBe(false);
    expect(
      itemModifierGroupLinkSchema.safeParse({ ...link, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("legend-un0j link storage and reorder semantics", () => {
  it("keeps link order, soft-deletes removed groups and revives them", async () => {
    const { client } = await ownerClient();
    const categoryId = await post(client, "/api/menu/categories", {
      brandId,
      name: `Link ${tag}`,
    });
    const itemId = await post(client, "/api/menu/items", {
      brandId,
      categoryId,
      name: `Link Item ${tag}`,
    });
    const g1 = await post(client, "/api/menu/modifier-groups", {
      name: `G1 ${tag}`,
    });
    const g2 = await post(client, "/api/menu/modifier-groups", {
      name: `G2 ${tag}`,
    });
    const path = `/api/menu/items/${itemId}/modifier-groups`;
    const set = (groupIds: string[]) =>
      client.put(path).set(originHeader).send({ groupIds });
    const stored = async () =>
      (
        await ownerPool.query(
          `SELECT group_id, sort_order, deleted_at FROM menu_item_modifier_groups
           WHERE tenant_id = $1 AND menu_item_id = $2 ORDER BY sort_order`,
          [tenantId, itemId],
        )
      ).rows as {
        group_id: string;
        sort_order: number;
        deleted_at: Date | null;
      }[];

    expect((await set([g2, g1])).body.data.groupIds).toEqual([g2, g1]);
    expect((await client.get(path)).body.data.groupIds).toEqual([g2, g1]);
    expect(
      (await stored()).map((row) => [row.group_id, row.sort_order]),
    ).toEqual([
      [g2, 0],
      [g1, 1],
    ]);

    // Dropping g2 soft-deletes its row; g1 is re-indexed to 0.
    expect((await set([g1])).body.data.groupIds).toEqual([g1]);
    const afterDrop = await stored();
    expect(afterDrop.find((row) => row.group_id === g2)?.deleted_at).not.toBe(
      null,
    );
    expect(afterDrop.find((row) => row.group_id === g1)?.sort_order).toBe(0);

    // Re-adding g2 revives the same row (unique key) at its new position.
    expect((await set([g1, g2])).body.data.groupIds).toEqual([g1, g2]);
    const revived = await stored();
    expect(revived).toHaveLength(2);
    expect(revived.every((row) => row.deleted_at === null)).toBe(true);

    // A duplicate or unknown group is refused and nothing changes.
    expect((await set([g1, g1])).status).toBe(422);
    expect((await set([randomUUID()])).status).toBe(404);
    expect((await client.get(path)).body.data.groupIds).toEqual([g1, g2]);
  });

  it("reorderItems / reorderCategories: index becomes sortOrder, others keep theirs", async () => {
    const { client } = await ownerClient();
    const categoryA = await post(client, "/api/menu/categories", {
      brandId,
      name: `Order A ${tag}`,
    });
    const categoryB = await post(client, "/api/menu/categories", {
      brandId,
      name: `Order B ${tag}`,
    });
    const itemIn = (categoryId: string, name: string, sortOrder: number) =>
      post(client, "/api/menu/items", {
        brandId,
        categoryId,
        name: `${name} ${tag}`,
        sortOrder,
      });
    const a = await itemIn(categoryA, "A", 5);
    const b = await itemIn(categoryA, "B", 6);
    const c = await itemIn(categoryA, "C", 7);
    const other = await itemIn(categoryB, "Other", 0);
    const sortOf = async (categoryId: string) =>
      Object.fromEntries(
        (
          (
            await client.get(
              `/api/menu/items?limit=100&brandId=${brandId}&categoryId=${categoryId}`,
            )
          ).body.data as { id: string; sortOrder: number }[]
        ).map((row) => [row.id, row.sortOrder]),
      );
    const put = (path: string, orderedIds: string[]) =>
      client.put(path).set(originHeader).send({ orderedIds });

    // Full list: dense 0..n-1.
    expect((await put("/api/menu/items/order", [c, b, a])).status).toBe(204);
    expect(await sortOf(categoryA)).toEqual({ [c]: 0, [b]: 1, [a]: 2 });

    // Partial list: listed ids take their index, unlisted keep theirs.
    expect((await put("/api/menu/items/order", [a, c])).status).toBe(204);
    expect(await sortOf(categoryA)).toEqual({ [a]: 0, [c]: 1, [b]: 1 });

    // Ids from two categories (two parents) are refused, nothing changes.
    expect((await put("/api/menu/items/order", [a, other])).status).toBe(422);
    expect((await sortOf(categoryB))[other]).toBe(0);
    // An unknown id is a 404.
    expect((await put("/api/menu/items/order", [a, randomUUID()])).status).toBe(
      404,
    );

    // Categories follow the same rule.
    expect(
      (await put("/api/menu/categories/order", [categoryB, categoryA])).status,
    ).toBe(204);
    const order = (
      (await client.get(`/api/menu/categories?limit=100&brandId=${brandId}`))
        .body.data as { id: string }[]
    ).map((row) => row.id);
    expect(order.indexOf(categoryB)).toBeLessThan(order.indexOf(categoryA));
    expect(
      (await put("/api/menu/categories/order", [categoryA, randomUUID()]))
        .status,
    ).toBe(404);
  });
});

describe("legend-dcz0 media outlet scope", () => {
  const png = sharp({
    create: { width: 8, height: 8, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();

  const scoped = (
    assignment:
      | { kind: "tenant" }
      | { kind: "outlets"; outletIds: (typeof outletA)[] },
  ) =>
    establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      assignment,
    );

  async function upload(
    context: ReturnType<typeof scoped>,
    userId: string,
    outletId?: string,
  ) {
    const bytes = await png;
    return uploadMenuPhoto(
      context,
      userId,
      {
        fileName: "foto.png",
        contentType: "image/png",
        dataBase64: bytes.toString("base64"),
        width: 8,
        height: 8,
        ...(outletId ? { outletId } : {}),
      },
      { storage: new FakeObjectStorage() },
    );
  }

  async function hostOutlet(mediaId: string): Promise<string> {
    const { rows } = await ownerPool.query(
      "SELECT outlet_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
      [tenantId, mediaId],
    );
    return rows[0].outlet_id as string;
  }

  it("contract: outletId is optional and must be a uuid", () => {
    const base = {
      fileName: "a.png",
      contentType: "image/png",
      dataBase64: "AAAA",
      width: 8,
      height: 8,
    };
    expect(uploadMenuImage.body.safeParse(base).success).toBe(true);
    expect(
      uploadMenuImage.body.safeParse({ ...base, outletId: outletB }).success,
    ).toBe(true);
    expect(
      uploadMenuImage.body.safeParse({ ...base, outletId: "not-a-uuid" })
        .success,
    ).toBe(false);
  });

  it("missing outletId falls back to the caller's first reachable outlet", async () => {
    const { userId } = await ownerClient();
    const own = await upload(
      scoped({ kind: "outlets", outletIds: [outletB] }),
      userId,
    );
    expect(await hostOutlet(own.mediaId)).toBe(outletB);
    const wide = await upload(scoped({ kind: "tenant" }), userId);
    const first = await ownerPool.query(
      "SELECT id FROM outlets WHERE tenant_id = $1 ORDER BY created_at, id LIMIT 1",
      [tenantId],
    );
    expect(await hostOutlet(wide.mediaId)).toBe(first.rows[0].id);
  });

  it("an explicit reachable outlet hosts the object", async () => {
    const { userId } = await ownerClient();
    const scopedHit = await upload(
      scoped({ kind: "outlets", outletIds: [outletA, outletB] }),
      userId,
      outletB,
    );
    expect(await hostOutlet(scopedHit.mediaId)).toBe(outletB);
    const wideHit = await upload(scoped({ kind: "tenant" }), userId, outletB);
    expect(await hostOutlet(wideHit.mediaId)).toBe(outletB);
  });

  it("an explicit outlet the caller does not reach is 403", async () => {
    const { userId } = await ownerClient();
    await expect(
      upload(scoped({ kind: "outlets", outletIds: [outletA] }), userId, outletB),
    ).rejects.toMatchObject({ status: 403 });
    // Tenant-wide reach still refuses an outlet that is not in the tenant.
    await expect(
      upload(scoped({ kind: "tenant" }), userId, randomUUID()),
    ).rejects.toMatchObject({ status: 403 });
    // A real outlet of another tenant answers the same 403.
    foreignTenant = await createIsolatedTenant(`mlk${tag}`);
    await expect(
      upload(scoped({ kind: "tenant" }), userId, foreignTenant.outletId),
    ).rejects.toMatchObject({ status: 403 });
  });
});
