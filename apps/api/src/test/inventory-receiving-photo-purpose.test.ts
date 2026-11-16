// Goods receipt photo purpose + 24 hour age rule (bead legend-5v7oq). Needs the
// disposable PostgreSQL database; fixtures are seeded as the migration owner and
// requests go through the real routes (receipt create and storage upload, with a
// fake object store).
//
// Acceptance ids used in test names:
// - 5v7oq-PURPOSE-1 a fresh own photo with purpose goods_receipt_photo is accepted and becomes a goods_receipt source
// - 5v7oq-PURPOSE-2 the old purpose "receipt" (unattached) is refused (422)
// - 5v7oq-PURPOSE-3 any other purpose (selfie, document) is refused
// - 5v7oq-AGE-1 a photo older than 24 hours is refused (422, message names 24 hours); one just inside the window is accepted
// - 5v7oq-AGE-2 a refused photo is never linked (source stays null, no goods_receipt_media row)
// - 5v7oq-UPLOAD-1 the upload route takes purpose goods_receipt_photo with sourceKind goods_receipt and refuses other kinds for it
// - 5v7oq-SHARED-1 shared contract: purpose enum, private 10 MiB policy, goods_receipt maps to the new purpose, other kinds keep "receipt"
//
// Assumptions where the contract is silent:
// - A refused photo answers 422 VALIDATION_ERROR; the too-old message contains "24 hours".
// - Age is measured from core_storage_objects.created_at (seeded here with an explicit timestamp).
// - "Just inside" the window is 24 hours minus 2 minutes (margin for request latency);
//   "too old" is 24 hours plus 1 minute. Exactly 24h00m00s is not tested (clock race).
// - The legacy access maps (storageLegacyUploadMap/ReadMap) follow the "receipt" shape:
//   no legacy upload (a kind is required), legacy read for accounting.reconcile.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  storagePurposePolicy,
  storagePurposeSchema,
  storageSourceKindPurpose,
  storageSourceKindSchema,
} from "@starter/shared/storage";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import {
  storageLegacyReadMap,
  storageLegacyUploadMap,
} from "../services/core-storage-access.ts";
import { liftDocumentCounters } from "./purchasing-document-counters.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
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

const PHOTO_PURPOSE = "goods_receipt_photo";
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

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
  createdAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          owner_user_id, source_kind, source_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'image/webp', 1024, $6, $7, $8, $9)`,
      [
        spec.tenantId ?? tenantA,
        spec.outletId ?? outletA,
        id,
        spec.purpose ?? PHOTO_PURPOSE,
        `legend-5v7oq/${id}.webp`,
        spec.ownerUserId,
        spec.sourceKind ?? null,
        spec.sourceId ?? null,
        spec.createdAt ?? new Date(),
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

async function sourceOf(objectId: string) {
  const { rows } = await owner.query<{
    source_kind: string | null;
    source_id: string | null;
  }>("SELECT source_kind, source_id FROM core_storage_objects WHERE id = $1", [
    objectId,
  ]);
  return rows[0]!;
}

async function mediaRowCount(storageObjectId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM goods_receipt_media WHERE storage_object_id = $1",
    [storageObjectId],
  );
  return rows[0]!.n;
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

const unlinked = { source_kind: null, source_id: null };

describe("5v7oq-PURPOSE goods receipt photo purpose", () => {
  it("[5v7oq-PURPOSE-1] a fresh own goods_receipt_photo is accepted and becomes a goods_receipt source of the receipt", async () => {
    const fx = await seedFixture();
    const photo = await insertPhoto({
      ownerUserId: receiver.userId,
      purpose: "goods_receipt_photo",
      createdAt: ago(5 * MINUTE_MS),
    });
    const created = await receive(receiver, fx, [photo]);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const receiptId = created.body.data.receipt.id as string;
    expect(created.body.data.receipt.mediaIds).toEqual([photo]);
    expect(await sourceOf(photo)).toEqual({
      source_kind: "goods_receipt",
      source_id: receiptId,
    });
  });

  it("[5v7oq-PURPOSE-2] the old purpose receipt, still unattached, is refused for a new receipt", async () => {
    const fx = await seedFixture();
    const oldPurpose = await insertPhoto({
      ownerUserId: receiver.userId,
      purpose: "receipt",
    });
    expectRefusedPhoto(await receive(receiver, fx, [oldPurpose]));
    expect(await sourceOf(oldPurpose)).toEqual(unlinked);
    expect(await receiptCount(fx.poId)).toBe(0);
    // Positive control: the same user and PO accept a goods_receipt_photo.
    const good = await insertPhoto({
      ownerUserId: receiver.userId,
      purpose: "goods_receipt_photo",
    });
    const ok = await receive(receiver, fx, [good]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("[5v7oq-PURPOSE-3] selfie and document photos are refused", async () => {
    const fx = await seedFixture();
    for (const purpose of ["selfie", "document"]) {
      const wrong = await insertPhoto({
        ownerUserId: receiver.userId,
        purpose,
      });
      expectRefusedPhoto(await receive(receiver, fx, [wrong]));
      expect(await sourceOf(wrong)).toEqual(unlinked);
    }
    expect(await receiptCount(fx.poId)).toBe(0);
  });
});

describe("5v7oq-AGE goods receipt photo must be at most 24 hours old", () => {
  it("[5v7oq-AGE-1] a photo 24 hours and 1 minute old is refused with the 24 hours message; one just inside the window is accepted", async () => {
    const fx = await seedFixture();
    const tooOld = await insertPhoto({
      ownerUserId: receiver.userId,
      createdAt: ago(24 * HOUR_MS + MINUTE_MS),
    });
    const refused = await receive(receiver, fx, [tooOld]);
    expectRefusedPhoto(refused);
    expect(JSON.stringify(refused.body)).toContain("24 hours");
    expect(await receiptCount(fx.poId)).toBe(0);

    const inside = await insertPhoto({
      ownerUserId: receiver.userId,
      createdAt: ago(24 * HOUR_MS - 2 * MINUTE_MS),
    });
    const accepted = await receive(receiver, fx, [inside]);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.data.receipt.mediaIds).toEqual([inside]);
  });

  it("[5v7oq-AGE-1b] a day-old photo is refused even when it is the only stale one among fresh photos", async () => {
    const fx = await seedFixture();
    const fresh = await insertPhoto({ ownerUserId: receiver.userId });
    const stale = await insertPhoto({
      ownerUserId: receiver.userId,
      createdAt: ago(3 * 24 * HOUR_MS),
    });
    const refused = await receive(receiver, fx, [fresh, stale]);
    expectRefusedPhoto(refused);
    expect(JSON.stringify(refused.body)).toContain("24 hours");
    expect(await receiptCount(fx.poId)).toBe(0);
    expect(await sourceOf(fresh)).toEqual(unlinked);
  });

  it("[5v7oq-AGE-2] a refused too-old photo is never linked: source stays null and no goods_receipt_media row exists", async () => {
    const fx = await seedFixture();
    const tooOld = await insertPhoto({
      ownerUserId: receiver.userId,
      createdAt: ago(25 * HOUR_MS),
    });
    const refused = await receive(receiver, fx, [tooOld]);
    expectRefusedPhoto(refused);
    expect(JSON.stringify(refused.body)).toContain("24 hours");
    expect(await sourceOf(tooOld)).toEqual(unlinked);
    expect(await mediaRowCount(tooOld)).toBe(0);
    expect(await receiptCount(fx.poId)).toBe(0);
  });
});

describe("5v7oq-UPLOAD storage upload route", () => {
  const upload = async (sourceKind: string, purpose = "goods_receipt_photo") =>
    receiver.client
      .post("/api/storage/uploads")
      .set(originHeader)
      .field("purpose", purpose)
      .field("outletId", outletA)
      .field("sourceKind", sourceKind)
      .attach(
        "file",
        await sharp({
          create: { width: 8, height: 8, channels: 3, background: "blue" },
        })
          .png()
          .toBuffer(),
        "terima.png",
      );

  it("[5v7oq-UPLOAD-1] accepts purpose goods_receipt_photo with sourceKind goods_receipt and refuses any other kind for that purpose", async () => {
    const ok = await upload("goods_receipt");
    expect([200, 201], JSON.stringify(ok.body)).toContain(ok.status);
    expect(ok.body.data.purpose).toBe("goods_receipt_photo");
    createdStorageIds.push(ok.body.data.id as string);
    // The uploaded photo is usable for a receipt right away.
    const fx = await seedFixture();
    const created = await receive(receiver, fx, [ok.body.data.id as string]);
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    for (const kind of ["expense", "purchase_invoice", "waste_log"]) {
      const res = await upload(kind);
      expect(res.status, `${kind}: ${JSON.stringify(res.body)}`).toBe(422);
    }
    // And the goods_receipt kind no longer belongs to the generic receipt purpose.
    const generic = await upload("goods_receipt", "receipt");
    expect(generic.status, JSON.stringify(generic.body)).toBe(422);
  });
});

describe("5v7oq-SHARED goods_receipt_photo contract", () => {
  it("[5v7oq-SHARED-1] purpose enum, policy, kind mapping and legacy access maps", () => {
    expect(storagePurposeSchema.options).toContain("goods_receipt_photo");
    expect(storagePurposeSchema.safeParse("goods_receipt_photo").success).toBe(
      true,
    );
    expect(Reflect.get(storagePurposePolicy, "goods_receipt_photo")).toEqual({
      visibility: "private",
      maxBytes: 10 * 1024 * 1024,
    });
    expect(storageSourceKindPurpose.goods_receipt).toBe("goods_receipt_photo");
    // Regression guard: every other kind keeps its previous purpose.
    for (const kind of storageSourceKindSchema.options) {
      if (kind === "goods_receipt") continue;
      expect(storageSourceKindPurpose[kind], `kind ${kind}`).not.toBe(
        "goods_receipt_photo",
      );
    }
    expect(storageSourceKindPurpose.expense).toBe("receipt");
    expect(storageSourceKindPurpose.purchase_invoice).toBe("receipt");
    expect(storageSourceKindPurpose.waste_log).toBe("receipt");
    expect(storageSourceKindPurpose.attendance).toBe("selfie");
    // Like receipt: no legacy (kind-less) upload; strict legacy read.
    expect(Reflect.get(storageLegacyUploadMap, "goods_receipt_photo")).toEqual(
      [],
    );
    expect(Reflect.get(storageLegacyReadMap, "goods_receipt_photo")).toEqual([
      "accounting.reconcile",
    ]);
  });
});
