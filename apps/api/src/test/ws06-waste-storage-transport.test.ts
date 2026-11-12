import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { decimal4 } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp({
  storageRuntime: {
    storage: new FakeObjectStorage(),
    scanner: new NoopMalwareScanner(),
    fileSigner: async () => null,
    hrisDocumentSigner: async () => null,
  },
});
const client = agent(app);
const reader = agent(app);
let userId: string;
let readerId: string;
const roleId = randomUUID();
const readerRoleId = randomUUID();
const locationId = randomUUID();
const itemId = randomUUID();
const uomId = randomUUID();
let image: Buffer;
const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "domain" }),
  { kind: "tenant" },
);

beforeAll(async () => {
  await signUp(client, "WS06 Waste Recorder");
  await signUp(reader, "WS06 Waste Reader");
  userId = (await client.get("/api/auth/get-session")).body.user.id;
  readerId = (await reader.get("/api/auth/get-session")).body.user.id;
  for (const [id, name, codes, actor] of [
    [
      roleId,
      "WS06 Recorder",
      ["inventory.waste.record", "inventory.stock.view"],
      userId,
    ],
    [readerRoleId, "WS06 Reader", ["inventory.stock.view"], readerId],
  ] as const) {
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types) VALUES ($1, $2, $3, $4, '["outlet"]')`,
      [id, tenantId, name, JSON.stringify(codes)],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by) VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenantId, actor, id, outletA],
    );
  }
  await owner.query(
    `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Gram WS06')`,
    [uomId, tenantId, `w${uomId.slice(0, 7)}`],
  );
  await owner.query(
    `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, 'warehouse')`,
    [locationId, tenantId, outletA, `Waste WS06 ${locationId}`],
  );
  await owner.query(
    `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, $3, 'Bahan Baku', 'raw_material', $4)`,
    [itemId, tenantId, `Waste WS06 ${itemId}`, uomId],
  );
  await recordStockMovement(context, {
    outletId: outletA,
    locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4("20.0000"),
    unitCostIdr: decimal4("100.0000"),
    batchId: null,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    actor: { type: "system" },
  });
  image = await sharp({
    create: { width: 4, height: 4, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
});
afterAll(async () => {
  await owner.query(
    "DELETE FROM role_assignments WHERE role_id = ANY($1::uuid[])",
    [[roleId, readerRoleId]],
  );
  await owner.end();
});
const upload = (who = client, outletId = outletA) =>
  who
    .post("/api/storage/uploads")
    .set(originHeader)
    .field("purpose", "receipt")
    .field("sourceKind", "waste_log")
    .field("outletId", outletId)
    .attach("file", image, "waste.png");
const waste = (mediaId: string, idempotencyKey = `waste-${randomUUID()}`) =>
  client.post("/api/inventory/waste-logs").set(originHeader).send({
    outletId: outletA,
    locationId,
    targetType: "inventory_item",
    targetId: itemId,
    quantity: "1.0000",
    reason: "spoiled",
    mediaId,
    idempotencyKey,
  });
const signed = (who: ReturnType<typeof agent>, id: string) =>
  who
    .post(`/api/storage/objects/${id}/signed-url`)
    .set(originHeader)
    .send({ variant: "original" });

describe("legend-d78a waste image transport and attachment", () => {
  it("uploads a private image, records waste, signs it for an outlet reader and rejects a second attachment", async () => {
    const media = await upload();
    expect(media.status).toBe(201);
    expect(media.body.data.publicUrl).toBeNull();
    const created = await waste(media.body.data.id);
    expect(created.status).toBe(201);
    expect(created.body.data.mediaId).toBe(media.body.data.id);
    const link = await owner.query(
      "SELECT source_kind, source_id FROM core_storage_objects WHERE id = $1",
      [media.body.data.id],
    );
    expect(link.rows[0]).toMatchObject({
      source_kind: "waste_log",
      source_id: created.body.data.id,
    });
    const readable = await signed(reader, media.body.data.id);
    expect(readable.status).toBe(200);
    expect(readable.body.data.url).toBeTruthy();
    const second = await waste(media.body.data.id);
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it("denies upload without waste permission and outside the recorder outlet", async () => {
    expect((await upload(reader)).status).toBe(403);
    expect((await upload(client, outletB)).status).toBe(403);
  });

  it("rejects another outlet, owner, purpose, non-image and prelinked evidence without reducing stock", async () => {
    const before = await owner.query(
      "SELECT quantity::text AS quantity FROM stock_balances WHERE location_id = $1 AND inventory_item_id = $2",
      [locationId, itemId],
    );
    for (const invalid of [
      {
        outletId: outletB,
        owner: userId,
        purpose: "receipt",
        kind: "waste_log",
        contentType: "image/webp",
        sourceId: null,
      },
      {
        outletId: outletA,
        owner: readerId,
        purpose: "receipt",
        kind: "waste_log",
        contentType: "image/webp",
        sourceId: null,
      },
      {
        outletId: outletA,
        owner: userId,
        purpose: "document",
        kind: null,
        contentType: "image/webp",
        sourceId: null,
      },
      {
        outletId: outletA,
        owner: userId,
        purpose: "receipt",
        kind: "waste_log",
        contentType: "application/pdf",
        sourceId: null,
      },
      {
        outletId: outletA,
        owner: userId,
        purpose: "receipt",
        kind: "waste_log",
        contentType: "image/webp",
        sourceId: randomUUID(),
      },
    ]) {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO core_storage_objects (id, tenant_id, outlet_id, purpose, object_key, content_type, size_bytes, owner_user_id, source_kind, source_id) VALUES ($1,$2,$3,$4,$5,$6,1024,$7,$8,$9)`,
        [
          id,
          tenantId,
          invalid.outletId,
          invalid.purpose,
          `private/${tenantId}/${id}.webp`,
          invalid.contentType,
          invalid.owner,
          invalid.kind,
          invalid.sourceId,
        ],
      );
      const response = await waste(id);
      expect(response.status, JSON.stringify(invalid)).toBeGreaterThanOrEqual(
        400,
      );
      if (invalid.outletId === outletB)
        expect((await signed(reader, id)).status).toBeGreaterThanOrEqual(400);
    }
    const after = await owner.query(
      "SELECT quantity::text AS quantity FROM stock_balances WHERE location_id = $1 AND inventory_item_id = $2",
      [locationId, itemId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
  it("attaches one uploaded photo once under concurrent distinct waste requests", async () => {
    const media = await upload();
    expect(media.status).toBe(201);
    const before = await owner.query(
      "SELECT quantity::text AS quantity FROM stock_balances WHERE location_id = $1 AND inventory_item_id = $2",
      [locationId, itemId],
    );
    const results = await Promise.all([
      waste(media.body.data.id),
      waste(media.body.data.id),
    ]);
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status >= 400)).toHaveLength(1);
    const after = await owner.query(
      "SELECT quantity::text AS quantity FROM stock_balances WHERE location_id = $1 AND inventory_item_id = $2",
      [locationId, itemId],
    );
    expect(Number(after.rows[0].quantity)).toBe(
      Number(before.rows[0].quantity) - 1,
    );
    const attached = await owner.query(
      "SELECT count(*)::int AS count FROM waste_logs WHERE media_id = $1",
      [media.body.data.id],
    );
    expect(attached.rows[0].count).toBe(1);
  });
});
