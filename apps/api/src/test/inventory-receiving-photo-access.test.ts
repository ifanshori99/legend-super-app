// Goods receipt photos: source lock + read access (bead legend-iy5l0). Needs the
// disposable PostgreSQL database; fixtures are seeded as the migration owner and
// requests go through the real routes (receipt create/read and the storage
// signed-url route, with a fake object store).
//
// Acceptance ids used in test names:
// - iy5l0-PHOTO-1 another user's unattached receipt photo is refused (422)
// - iy5l0-PHOTO-2 another outlet's or tenant's photo is refused (422)
// - iy5l0-PHOTO-3 own photo is accepted and becomes a goods_receipt source of that receipt
// - iy5l0-PHOTO-4 receipt readers (inventory.stock.receive at the outlet) can fetch the photo; others cannot
// - iy5l0-PHOTO-5 a photo already linked (to another receipt or any other source) is refused
// - iy5l0-PHOTO-6 receipt mediaIds never include media rows of another outlet
//
// Assumptions where the contract is silent:
// - A refused photo answers 422 with VALIDATION_ERROR (same as the petty purchase photo rule).
// - A refused signed-url read answers 403 or 404.
// - A refused create leaves the photo unlinked (source_kind/source_id stay null).
// - Photo seeds carry owner_user_id = the uploading user, like a real upload.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { liftDocumentCounters } from "./purchasing-document-counters.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;
const tenantB = randomUUID();

const app = createApp({
  storageRuntime: {
    storage: new FakeObjectStorage(),
    scanner: new NoopMalwareScanner(),
    fileSigner: async () => null,
    hrisDocumentSigner: async () => null,
  },
});
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

type Session = { client: ReturnType<typeof agent>; userId: string };

const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdStorageIds: string[] = [];
const createdOrderIds: string[] = [];
const createdLocationIds: string[] = [];
let uomKg: string;
let itemId: string;
let supplierId: string;
let creatorId: string;
let receiver: Session;
let otherReceiver: Session; // warehouse role: same outlet, same permission, different user
let receiveOnlyReader: Session; // inventory.stock.receive only, outlet A
let matchOnlyReader: Session; // purchasing.invoice.match only, outlet A
let outletBReader: Session; // inventory.stock.receive only, outlet B
let nobody: Session;

const key = () => `k-${randomUUID()}`;

async function signedIn(
  name: string,
  grant: { templateKey: string } | { codes: string[]; outletId: string },
): Promise<Session> {
  const client = agent(app);
  await signUp(client, name);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  createdUserIds.push(userId);
  let roleId: string | null = null;
  const scopeType = "outlet";
  let scopeId: string | null = null;
  if ("templateKey" in grant) {
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [tenantA, grant.templateKey],
    );
    roleId = rows[0]!.id;
    scopeId = outletA;
  } else {
    roleId = randomUUID();
    createdRoleIds.push(roleId);
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, $4, '["outlet"]')`,
      [roleId, tenantA, `Photo ${name}`, JSON.stringify(grant.codes)],
    );
    scopeId = grant.outletId;
  }
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [tenantA, userId, roleId, scopeType, scopeId],
  );
  return { client, userId };
}

async function plainUser(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, `Photo ${label}`, `${id}@example.com`],
  );
  createdUserIds.push(id);
  return id;
}

/** A stored object seeded as the migration owner; FKs skipped so tenant B needs no outlet. */
async function insertPhoto(spec: {
  ownerUserId: string | null;
  tenantId?: string;
  outletId?: string;
  purpose?: string;
  sourceKind?: string | null;
  sourceId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          owner_user_id, source_kind, source_id)
       VALUES ($1, $2, $3, $4, $5, 'image/webp', 1024, $6, $7, $8)`,
      [
        spec.tenantId ?? tenantA,
        spec.outletId ?? outletA,
        id,
        spec.purpose ?? "goods_receipt_photo",
        `legend-iy5l0/${id}.webp`,
        spec.ownerUserId,
        spec.sourceKind ?? null,
        spec.sourceId ?? null,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  createdStorageIds.push(id);
  return id;
}

type Fixture = { poId: string; line: string; location: string };

async function seedFixture(): Promise<Fixture> {
  const { rows: loc } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantA, outletA, `Gudang Photo ${randomUUID().slice(0, 6)}`],
  );
  const location = loc[0]!.id;
  createdLocationIds.push(location);
  const poId = randomUUID();
  await owner.query(
    `INSERT INTO purchase_orders
       (id, tenant_id, outlet_id, supplier_id, number, status, expected_date,
        subtotal_idr, tax_idr, total_idr, source, created_by, approved_by,
        approved_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, 'sent', '2099-12-20', 1000000, 0, 1000000, 'user',
        $6, $6, now(), now())`,
    [
      poId,
      tenantA,
      outletA,
      supplierId,
      `PO/209912/${randomBytes(4).toString("hex")}`,
      creatorId,
    ],
  );
  createdOrderIds.push(poId);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO purchase_order_lines
       (tenant_id, outlet_id, purchase_order_id, inventory_item_id, quantity,
        uom_id, unit_price_idr, line_total_idr, line_no)
     VALUES ($1, $2, $3, $4, 100.0000, $5, 10000.0000, 1000000, 1) RETURNING id`,
    [tenantA, outletA, poId, itemId, uomKg],
  );
  return { poId, line: rows[0]!.id, location };
}

const receive = (
  who: Session,
  fx: Fixture,
  mediaIds: string[],
  quantity = "1.0000",
) =>
  who.client
    .post("/api/inventory/goods-receipts")
    .set(originHeader)
    .send({
      outletId: outletA,
      purchaseOrderId: fx.poId,
      lines: [
        {
          purchaseOrderLineId: fx.line,
          locationId: fx.location,
          quantityReceived: quantity,
          quantityRejected: "0.0000",
        },
      ],
      mediaIds,
      idempotencyKey: key(),
    });

const signedUrl = (who: Session, objectId: string) =>
  who.client
    .post(`/api/storage/objects/${objectId}/signed-url`)
    .set(originHeader)
    .send({ variant: "original" });

async function sourceOf(objectId: string) {
  const { rows } = await owner.query<{
    source_kind: string | null;
    source_id: string | null;
  }>("SELECT source_kind, source_id FROM core_storage_objects WHERE id = $1", [
    objectId,
  ]);
  return rows[0]!;
}

async function receiptCount(poId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = $2",
    [tenantA, poId],
  );
  return rows[0]!.n;
}

function expectRefusedPhoto(res: { status: number; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(
    (res.body as { error: { code: string } }).error.code,
    JSON.stringify(res.body),
  ).toBe("VALIDATION_ERROR");
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await liftDocumentCounters(owner, tenantA);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Receipt Photo Tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `gr-photo-b-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  creatorId = await plainUser("creator");
  receiver = await signedIn("Photo receiver", { templateKey: "warehouse" });
  otherReceiver = await signedIn("Photo other receiver", {
    templateKey: "warehouse",
  });
  receiveOnlyReader = await signedIn("Photo receive reader", {
    codes: ["inventory.stock.receive"],
    outletId: outletA,
  });
  matchOnlyReader = await signedIn("Photo match reader", {
    codes: ["purchasing.invoice.match"],
    outletId: outletA,
  });
  outletBReader = await signedIn("Photo outlet B reader", {
    codes: ["inventory.stock.receive"],
    outletId: outletB,
  });
  nobody = await signedIn("Photo nobody", { codes: [], outletId: outletA });
  const uom = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `kg${randomUUID().slice(0, 6)}`],
  );
  uomKg = uom.rows[0]!.id;
  const item = await owner.query<{ id: string }>(
    "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
    [tenantA, `Tepung Photo ${randomUUID().slice(0, 6)}`, uomKg],
  );
  itemId = item.rows[0]!.id;
  const supplier = await owner.query<{ id: string }>(
    `INSERT INTO suppliers (tenant_id, name, payment_terms_days, is_active, created_by)
     VALUES ($1, $2, 30, true, $3) RETURNING id`,
    [tenantA, `Supplier Photo ${randomUUID().slice(0, 6)}`, creatorId],
  );
  supplierId = supplier.rows[0]!.id;
});

afterAll(async () => {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const receipts = `(SELECT id FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[]))`;
    const params = [tenantA, createdOrderIds];
    await client.query(
      `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id IN ${receipts}`,
      params,
    );
    await client.query(
      `DELETE FROM stock_ledger WHERE tenant_id = $1 AND source_id IN ${receipts}`,
      params,
    );
    await client.query(
      `DELETE FROM goods_receipt_media WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts}`,
      params,
    );
    await client.query(
      `DELETE FROM goods_receipt_lines WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts}`,
      params,
    );
    await client.query(
      "DELETE FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[])",
      params,
    );
    for (const table of ["stock_balances", "stock_batches"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND location_id = ANY($2::uuid[])`,
        [tenantA, createdLocationIds],
      );
    await client.query(
      "DELETE FROM purchase_order_lines WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[])",
      params,
    );
    await client.query(
      "DELETE FROM purchase_orders WHERE id = ANY($1::uuid[])",
      [createdOrderIds],
    );
    await client.query(
      "DELETE FROM purchasing_idempotency WHERE tenant_id = $1",
      [tenantA],
    );
    await client.query(
      "DELETE FROM purchasing_document_sequences WHERE tenant_id = $1 AND kind = 'GR'",
      [tenantA],
    );
    await client.query(
      "DELETE FROM stock_locations WHERE id = ANY($1::uuid[])",
      [createdLocationIds],
    );
    await client.query("DELETE FROM inventory_items WHERE id = $1", [itemId]);
    await client.query("DELETE FROM uoms WHERE id = $1", [uomKg]);
    await client.query("DELETE FROM suppliers WHERE id = $1", [supplierId]);
    await client.query(
      "DELETE FROM core_storage_objects WHERE id = ANY($1::uuid[])",
      [createdStorageIds],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantA, createdUserIds],
    );
    await client.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoleIds,
    ]);
    await client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await owner.end();
});

describe("iy5l0-PHOTO goods receipt photo source lock", () => {
  it("[iy5l0-PHOTO-1] an unattached receipt photo owned by another user of the same outlet is refused and stays unlinked", async () => {
    const fx = await seedFixture();
    const othersPhoto = await insertPhoto({
      ownerUserId: otherReceiver.userId,
    });
    const nobodyOwned = await insertPhoto({ ownerUserId: null });

    for (const mediaId of [othersPhoto, nobodyOwned]) {
      expectRefusedPhoto(await receive(receiver, fx, [mediaId]));
      expect(await sourceOf(mediaId)).toEqual({
        source_kind: null,
        source_id: null,
      });
    }
    expect(await receiptCount(fx.poId)).toBe(0);
  });

  it("[iy5l0-PHOTO-2] a photo of another outlet or another tenant is refused even when the sender owns it", async () => {
    const fx = await seedFixture();
    const ownOk = await insertPhoto({ ownerUserId: receiver.userId });
    const otherOutlet = await insertPhoto({
      ownerUserId: receiver.userId,
      outletId: outletB,
    });
    const otherTenant = await insertPhoto({
      ownerUserId: receiver.userId,
      tenantId: tenantB,
    });
    const wrongPurpose = await insertPhoto({
      ownerUserId: receiver.userId,
      purpose: "document",
    });

    for (const mediaId of [otherOutlet, otherTenant, wrongPurpose]) {
      expectRefusedPhoto(await receive(receiver, fx, [ownOk, mediaId]));
    }
    expect(await receiptCount(fx.poId)).toBe(0);
    // A refused create links nothing, not even the valid photo in the same request.
    expect(await sourceOf(ownOk)).toEqual({
      source_kind: null,
      source_id: null,
    });
  });

  it("[iy5l0-PHOTO-3] own photo is accepted and becomes a goods_receipt source pointing at the receipt", async () => {
    const fx = await seedFixture();
    const first = await insertPhoto({ ownerUserId: receiver.userId });
    const second = await insertPhoto({ ownerUserId: receiver.userId });

    const created = await receive(receiver, fx, [first, second]);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const receiptId = created.body.data.receipt.id as string;
    expect(created.body.data.receipt.mediaIds).toEqual([first, second]);
    for (const mediaId of [first, second])
      expect(await sourceOf(mediaId)).toEqual({
        source_kind: "goods_receipt",
        source_id: receiptId,
      });
  });

  it("[iy5l0-PHOTO-4] receipt readers at the outlet get a signed url for the photo; users without permission or at another outlet do not", async () => {
    const fx = await seedFixture();
    const photo = await insertPhoto({ ownerUserId: receiver.userId });
    const created = await receive(receiver, fx, [photo]);
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    // The uploader keeps reading its own photo.
    expect((await signedUrl(receiver, photo)).status).toBe(200);
    // Colleagues holding the receive permission at the receipt's outlet.
    for (const reader of [otherReceiver, receiveOnlyReader, matchOnlyReader]) {
      const res = await signedUrl(reader, photo);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    // No permission, or the permission only at another outlet.
    for (const denied of [nobody, outletBReader]) {
      const res = await signedUrl(denied, photo);
      expect([403, 404], JSON.stringify(res.body)).toContain(res.status);
    }
  });

  it("[iy5l0-PHOTO-5] a photo already linked to another receipt or to another source is refused", async () => {
    const fx = await seedFixture();
    const used = await insertPhoto({ ownerUserId: receiver.userId });
    const first = await receive(receiver, fx, [used]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expectRefusedPhoto(await receive(receiver, fx, [used], "2.0000"));
    expect(await receiptCount(fx.poId)).toBe(1);

    // Linked to something else (a goods_receipt id that is not a receipt row here,
    // or another source kind) and never attached through goods_receipt_media.
    const foreignReceiptSource = await insertPhoto({
      ownerUserId: receiver.userId,
      sourceKind: "goods_receipt",
      sourceId: randomUUID(),
    });
    const pettySource = await insertPhoto({
      ownerUserId: receiver.userId,
      sourceKind: "petty_purchase",
      sourceId: randomUUID(),
    });
    for (const mediaId of [foreignReceiptSource, pettySource])
      expectRefusedPhoto(await receive(receiver, fx, [mediaId], "2.0000"));
    expect(await receiptCount(fx.poId)).toBe(1);
  });

  it("[iy5l0-PHOTO-6] mediaIds of a receipt never include media rows of another outlet", async () => {
    const fx = await seedFixture();
    const photo = await insertPhoto({ ownerUserId: receiver.userId });
    const created = await receive(receiver, fx, [photo]);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const receiptId = created.body.data.receipt.id as string;

    // A stray media row stored under outlet B but pointing at this receipt
    // (cloned from the real row, FKs skipped as the other seeds do).
    const strayObject = await insertPhoto({
      ownerUserId: receiver.userId,
      outletId: outletB,
    });
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const { rows } = await client.query(
        "SELECT * FROM goods_receipt_media WHERE tenant_id = $1 AND goods_receipt_id = $2",
        [tenantA, receiptId],
      );
      const stray: Record<string, unknown> = {
        ...rows[0],
        outlet_id: outletB,
        storage_object_id: strayObject,
        position: 1, // (tenant, receipt, position) is unique; the real photo is at 0
      };
      const columns = Object.keys(stray);
      await client.query(
        `INSERT INTO goods_receipt_media (${columns.join(", ")})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
        columns.map((column) => stray[column]),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const fetched = await receiver.client.get(
      `/api/inventory/goods-receipts/${receiptId}`,
    );
    expect(fetched.status, JSON.stringify(fetched.body)).toBe(200);
    expect(fetched.body.data.receipt.mediaIds).toEqual([photo]);
  });
});
