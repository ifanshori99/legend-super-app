// Goods receipt photos must be LINKED to the receipt (bead legend-9h4qh, card
// M2; media-transport spec D-1 fallback + D-2). Needs the disposable
// PostgreSQL database; the migration owner seeds fixtures, requests go through
// the real route POST /api/inventory/goods-receipts.
//
// Acceptance ids used in test names:
// - 9h4qh-M2-1 a photo uploaded by another user is refused and stays free
// - 9h4qh-M2-2 a photo of another kind (cash_deposit) is refused and stays free
// - 9h4qh-M2-3 a photo already linked to a document is refused
// - 9h4qh-M2-4 a successful create links every photo (goods_receipt + receipt id)
// - 9h4qh-M2-5 a failed create leaves no photo linked (rollback)
// - 9h4qh-M2-6 an idempotent replay returns the stored receipt and does not fail
// - 9h4qh-M2-7 a photo stored at another outlet is refused
// - 9h4qh-M2-8 sweepOrphanReceiptPhotos removes only old, unlinked receipt
//   objects (row and blob) of the swept tenant
//
// Assumptions where the shared contract is silent:
// - Refusals answer 422 with `{ error: { code: "VALIDATION_ERROR" } }`, like the
//   other receipt-photo suites (o1o4s-GR-5, 65mgw-PP-6).
// - "Uploader" is core_storage_objects.owner_user_id (the same column the petty
//   cash suite seeds as the uploader); linkStorageObjectSource compares it with
//   the receiving user.
// - There is no storage purpose `cash_deposit`: a "cash_deposit photo" is a
//   purpose `receipt` object whose source_kind is already `cash_deposit`
//   (source_id still null), as the upload endpoint would store it.
// - A replayed create answers 200 or 201 (only the same receipt id is pinned).
// - Sweeper: worker/receipt-photo-orphan-sweep.job.ts
//     sweepOrphanReceiptPhotos(now, { storage, listTenantIds }) -> { deleted, failed }
//   Run with a FakeObjectStorage and `now` injected (like
//   edge-selfie-orphan-sweep.test.ts); `listTenantIds` limits it to tenant A.
//   It deletes the blob and then the core_storage_objects row of objects with
//   purpose = 'receipt', source_kind = 'goods_receipt', source_id IS NULL and
//   created_at older than 24 hours.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import {
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { sweepOrphanReceiptPhotos } from "../worker/receipt-photo-orphan-sweep.job.ts";
import { liftDocumentCounters } from "./purchasing-document-counters.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;
const tenantB = randomUUID();

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

function storageContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
}

/** The storage lookup of a photo seeded by insertPhoto (same key, outlet A). */
const blobLookup = (tenantId: string, objectId: string) => ({
  tenantId: tenantIdSchema.parse(tenantId),
  outletId: outletIdSchema.parse(outletA),
  reference: objectId,
  key: `legend-9h4qh/${objectId}.webp`,
  visibility: "private" as const,
});

async function putBlob(
  storage: FakeObjectStorage,
  tenantId: string,
  objectId: string,
): Promise<void> {
  await storage.put(storageContext(tenantId), {
    ...blobLookup(tenantId, objectId),
    contentType: "image/webp",
    content: new Uint8Array([1, 2, 3]),
  });
}

async function blobExists(
  storage: FakeObjectStorage,
  tenantId: string,
  objectId: string,
): Promise<boolean> {
  try {
    await storage.get(storageContext(tenantId), blobLookup(tenantId, objectId));
    return true;
  } catch {
    return false;
  }
}

const createdUserIds: string[] = [];
const createdUomIds: string[] = [];
const createdItemIds: string[] = [];
const createdLocationIds: string[] = [];
const createdOrderIds: string[] = [];
const createdStorageIds: string[] = [];
const createdSupplierIds: string[] = [];

let supplierId: string;
let uomKg: string;
let creatorId: string;
let approverId: string;
let otherUploaderId: string;
let receiver: { client: ReturnType<typeof agent>; userId: string };

const key = () => `k-${randomUUID()}`;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

async function plainUser(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, `Receiving link ${label}`, `${id}@example.com`],
  );
  createdUserIds.push(id);
  return id;
}

/** A real session user holding the warehouse role (inventory.stock.receive) at outlet A. */
async function signedInWarehouse(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantA, userId, await roleIdOf("warehouse"), outletA],
  );
  return { client, userId };
}

type PhotoOptions = {
  tenantId?: string;
  outletId?: string;
  purpose?: string;
  ownerUserId?: string | null;
  sourceKind?: string | null;
  sourceId?: string | null;
  /** SQL interval before now, e.g. "25 hours". */
  age?: string;
};

/** Storage rows are seeded as the migration owner (FKs skipped so tenant B needs no outlet). */
async function insertPhoto(options: PhotoOptions = {}): Promise<string> {
  const id = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          owner_user_id, source_kind, source_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'image/webp', 1024, $6, $7, $8,
               now() - $9::interval)`,
      [
        options.tenantId ?? tenantA,
        options.outletId ?? outletA,
        id,
        options.purpose ?? "receipt",
        `legend-9h4qh/${id}.webp`,
        options.ownerUserId === undefined
          ? receiver.userId
          : options.ownerUserId,
        options.sourceKind ?? null,
        options.sourceId ?? null,
        options.age ?? "1 minute",
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

async function linkOf(
  objectId: string,
): Promise<{ source_kind: string | null; source_id: string | null }> {
  const { rows } = await owner.query<{
    source_kind: string | null;
    source_id: string | null;
  }>("SELECT source_kind, source_id FROM core_storage_objects WHERE id = $1", [
    objectId,
  ]);
  return rows[0]!;
}

async function objectExists(objectId: string): Promise<boolean> {
  const { rows } = await owner.query(
    "SELECT 1 FROM core_storage_objects WHERE id = $1",
    [objectId],
  );
  return rows.length === 1;
}

const referenceRowCleanups: Array<{ sql: string; args: unknown[] }> = [];

/** Seed rows as the migration owner with FK checks skipped (no real parents needed). */
async function seedWithoutForeignKeys(
  sql: string,
  args: unknown[],
): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(sql, args);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A goods_receipt_media row that references the photo (the photo keeps source_id null). */
async function insertGoodsReceiptMediaRef(objectId: string): Promise<void> {
  const receiptId = randomUUID();
  await seedWithoutForeignKeys(
    `INSERT INTO goods_receipt_media
       (tenant_id, outlet_id, goods_receipt_id, storage_object_id, position)
     VALUES ($1, $2, $3, $4, 0)`,
    [tenantA, outletA, receiptId, objectId],
  );
  referenceRowCleanups.push({
    sql: "DELETE FROM goods_receipt_media WHERE tenant_id = $1 AND storage_object_id = $2",
    args: [tenantA, objectId],
  });
}

/** A reimbursement claim whose receipt_upload_ref is the photo id. */
async function insertReimbursementRef(objectId: string): Promise<void> {
  await seedWithoutForeignKeys(
    `INSERT INTO reimbursements
       (id, tenant_id, employee_id, category_id, expense_date, amount_idr,
        description, receipt_upload_ref, payout, status)
     VALUES ($1, $2, $3, $4, '2026-11-01', 25000, 'Klaim foto', $5, 'cash', 'submitted')`,
    [randomUUID(), tenantA, randomUUID(), randomUUID(), objectId],
  );
  referenceRowCleanups.push({
    sql: "DELETE FROM reimbursements WHERE tenant_id = $1 AND receipt_upload_ref = $2",
    args: [tenantA, objectId],
  });
}

async function insertUom(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
  );
  createdUomIds.push(rows[0]!.id);
  return rows[0]!.id;
}

type Fixture = { poId: string; line: string; item: string; location: string };

/** A sent order with one line of 10 kg flour at Rp 10.000 and a warehouse at outlet A. */
async function seedFixture(): Promise<Fixture> {
  const { rows: itemRows } = await owner.query<{ id: string }>(
    "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
    [tenantA, `Tepung PL ${randomUUID().slice(0, 6)}`, uomKg],
  );
  const item = itemRows[0]!.id;
  createdItemIds.push(item);
  const { rows: locRows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantA, outletA, `Gudang PL ${randomUUID().slice(0, 6)}`],
  );
  const location = locRows[0]!.id;
  createdLocationIds.push(location);
  const poId = randomUUID();
  await owner.query(
    `INSERT INTO purchase_orders
       (id, tenant_id, outlet_id, supplier_id, number, status, expected_date,
        subtotal_idr, tax_idr, total_idr, source, created_by, approved_by,
        approved_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, 'sent', '2099-12-20', 100000, 0, 100000, 'user',
        $6, $7, now(), now())`,
    [
      poId,
      tenantA,
      outletA,
      supplierId,
      `PO/209912/${randomBytes(4).toString("hex")}`,
      creatorId,
      approverId,
    ],
  );
  createdOrderIds.push(poId);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO purchase_order_lines
       (tenant_id, outlet_id, purchase_order_id, inventory_item_id, quantity,
        uom_id, unit_price_idr, line_total_idr, line_no)
     VALUES ($1, $2, $3, $4, 10.0000, $5, 10000.0000, 100000, 1) RETURNING id`,
    [tenantA, outletA, poId, item, uomKg],
  );
  return { poId, line: rows[0]!.id, item, location };
}

function receiptBody(
  fx: Fixture,
  overrides: Record<string, unknown> = {},
  received = "1.0000",
) {
  return {
    outletId: outletA,
    purchaseOrderId: fx.poId,
    lines: [
      {
        purchaseOrderLineId: fx.line,
        locationId: fx.location,
        quantityReceived: received,
        quantityRejected: "0.0000",
      },
    ],
    idempotencyKey: key(),
    ...overrides,
  };
}

const receive = (
  client: ReturnType<typeof agent>,
  body: Record<string, unknown>,
) =>
  client
    .post("/api/inventory/goods-receipts")
    .set(originHeader)
    .send(body as object);

async function receiptCount(poId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = $2",
    [tenantA, poId],
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await liftDocumentCounters(owner, tenantA);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Receipt Photo Link Tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `pl-b-${randomUUID().slice(0, 8)}`,
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
  approverId = await plainUser("approver");
  otherUploaderId = await plainUser("other uploader");
  receiver = await signedInWarehouse("PL receiver");
  uomKg = await insertUom("kg");
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO suppliers (tenant_id, name, payment_terms_days, is_active, created_by)
     VALUES ($1, $2, 30, true, $3) RETURNING id`,
    [tenantA, `Supplier PL ${randomUUID().slice(0, 6)}`, creatorId],
  );
  supplierId = rows[0]!.id;
  createdSupplierIds.push(supplierId);
});

afterAll(async () => {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const cleanup of referenceRowCleanups)
      await client.query(cleanup.sql, cleanup.args);
    const receipts = `(SELECT id FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[]))`;
    const args = [tenantA, createdOrderIds];
    await client.query(
      `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id IN ${receipts}`,
      args,
    );
    await client.query(
      `DELETE FROM stock_ledger WHERE tenant_id = $1 AND source_id IN ${receipts}`,
      args,
    );
    await client.query(
      `DELETE FROM goods_receipt_media WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts}`,
      args,
    );
    await client.query(
      `DELETE FROM goods_receipt_lines WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts}`,
      args,
    );
    await client.query(
      "DELETE FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[])",
      args,
    );
    for (const table of ["stock_balances", "stock_batches"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND location_id = ANY($2::uuid[])`,
        [tenantA, createdLocationIds],
      );
    await client.query(
      "DELETE FROM purchase_order_lines WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[])",
      args,
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
    await client.query(
      "DELETE FROM inventory_items WHERE id = ANY($1::uuid[])",
      [createdItemIds],
    );
    await client.query("DELETE FROM uoms WHERE id = ANY($1::uuid[])", [
      createdUomIds,
    ]);
    await client.query("DELETE FROM suppliers WHERE id = ANY($1::uuid[])", [
      createdSupplierIds,
    ]);
    await client.query(
      "DELETE FROM core_storage_objects WHERE id = ANY($1::uuid[])",
      [createdStorageIds],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantA, createdUserIds],
    );
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

describe("legend-9h4qh M2 goods receipt photo link", () => {
  it("[9h4qh-M2-1] a photo uploaded by another user is refused, the receipt is not created and the photo stays free", async () => {
    const fx = await seedFixture();
    const mine = await insertPhoto();
    const others = await insertPhoto({ ownerUserId: otherUploaderId });

    const res = await receive(
      receiver.client,
      receiptBody(fx, { mediaIds: [mine, others] }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await receiptCount(fx.poId)).toBe(0);
    expect((await linkOf(others)).source_id).toBeNull();
    expect((await linkOf(mine)).source_id).toBeNull();
  });

  it("[9h4qh-M2-2] a photo of another kind (cash_deposit) is refused and stays free", async () => {
    const fx = await seedFixture();
    const deposit = await insertPhoto({ sourceKind: "cash_deposit" });

    const res = await receive(
      receiver.client,
      receiptBody(fx, { mediaIds: [deposit] }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await receiptCount(fx.poId)).toBe(0);
    expect(await linkOf(deposit)).toEqual({
      source_kind: "cash_deposit",
      source_id: null,
    });
  });

  it("[9h4qh-M2-3] a photo already linked to a document is refused, whether to a goods receipt we made or to another document", async () => {
    const fx = await seedFixture();
    const linkedElsewhere = await insertPhoto({
      sourceKind: "goods_receipt",
      sourceId: randomUUID(),
    });
    const linkedToPetty = await insertPhoto({
      sourceKind: "petty_purchase",
      sourceId: randomUUID(),
    });
    for (const mediaId of [linkedElsewhere, linkedToPetty]) {
      const res = await receive(
        receiver.client,
        receiptBody(fx, { mediaIds: [mediaId] }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(await receiptCount(fx.poId)).toBe(0);

    // One photo documents one receipt: a second receipt cannot reuse it.
    const photo = await insertPhoto();
    const first = await receive(
      receiver.client,
      receiptBody(fx, { mediaIds: [photo] }),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await receive(
      receiver.client,
      receiptBody(fx, { mediaIds: [photo] }),
    );
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe("VALIDATION_ERROR");
    expect(await receiptCount(fx.poId)).toBe(1);
    expect((await linkOf(photo)).source_id).toBe(first.body.data.receipt.id);
  });

  it("[9h4qh-M2-4] a successful create links every photo to the receipt as goods_receipt", async () => {
    const fx = await seedFixture();
    const p1 = await insertPhoto();
    // Uploaded with the kind already chosen (the web upload sends sourceKind).
    const p2 = await insertPhoto({ sourceKind: "goods_receipt" });

    const res = await receive(
      receiver.client,
      receiptBody(fx, { mediaIds: [p1, p2] }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const receiptId = res.body.data.receipt.id as string;
    expect(res.body.data.receipt.mediaIds).toEqual([p1, p2]);
    for (const photo of [p1, p2])
      expect(await linkOf(photo)).toEqual({
        source_kind: "goods_receipt",
        source_id: receiptId,
      });
  });

  it("[9h4qh-M2-5] a refused create leaves no photo linked, even the valid ones sent with it", async () => {
    const fx = await seedFixture();
    const valid = await insertPhoto();
    const taken = await insertPhoto({
      sourceKind: "goods_receipt",
      sourceId: randomUUID(),
    });

    // One bad photo among good ones: nothing is linked, nothing is created.
    const badPhoto = await receive(
      receiver.client,
      receiptBody(fx, { mediaIds: [valid, taken] }),
    );
    expect(badPhoto.status, JSON.stringify(badPhoto.body)).toBe(422);
    expect(await receiptCount(fx.poId)).toBe(0);
    expect((await linkOf(valid)).source_id).toBeNull();

    // A refused document (more than the order allows) links nothing either.
    const tooMuch = await receive(
      receiver.client,
      receiptBody(fx, { mediaIds: [valid] }, "999.0000"),
    );
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect(tooMuch.status).toBeLessThan(500);
    expect(await receiptCount(fx.poId)).toBe(0);
    expect((await linkOf(valid)).source_id).toBeNull();

    // The free photo is still usable afterwards.
    const ok = await receive(
      receiver.client,
      receiptBody(fx, { mediaIds: [valid] }),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await linkOf(valid)).source_id).toBe(ok.body.data.receipt.id);
  });

  it("[9h4qh-M2-6] replaying the same create returns the stored receipt, keeps the link and does not fail", async () => {
    const fx = await seedFixture();
    const photo = await insertPhoto();
    const body = receiptBody(fx, { mediaIds: [photo] });

    const first = await receive(receiver.client, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const receiptId = first.body.data.receipt.id as string;

    const replay = await receive(receiver.client, body);
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(replay.body.data.receipt.id).toBe(receiptId);
    expect(replay.body.data.receipt.mediaIds).toEqual([photo]);
    expect(await receiptCount(fx.poId)).toBe(1);
    expect(await linkOf(photo)).toEqual({
      source_kind: "goods_receipt",
      source_id: receiptId,
    });
  });

  it("[9h4qh-M2-7] a photo stored at another outlet is refused and stays free", async () => {
    const fx = await seedFixture();
    const otherOutlet = await insertPhoto({ outletId: outletB });

    const res = await receive(
      receiver.client,
      receiptBody(fx, { mediaIds: [otherOutlet] }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await receiptCount(fx.poId)).toBe(0);
    expect((await linkOf(otherOutlet)).source_id).toBeNull();
  });

  it("[9h4qh-M2-8] the sweeper removes only receipt objects (row and blob) that are unlinked, older than 24 hours and of the swept tenant", async () => {
    const oldOrphan = await insertPhoto({
      age: "25 hours",
      sourceKind: "goods_receipt",
    });
    const oldOrphanNoOwner = await insertPhoto({
      age: "30 hours",
      ownerUserId: null,
      sourceKind: "goods_receipt",
    });
    const freshOrphan = await insertPhoto({
      age: "23 hours",
      sourceKind: "goods_receipt",
    });
    const justUploaded = await insertPhoto({
      age: "1 minute",
      sourceKind: "goods_receipt",
    });
    const oldLinked = await insertPhoto({
      age: "48 hours",
      sourceKind: "goods_receipt",
      sourceId: randomUUID(),
    });
    // Same age and no link, but not a receipt: other purposes are not swept.
    const oldDocument = await insertPhoto({
      age: "48 hours",
      purpose: "document",
      sourceKind: "goods_receipt",
    });
    const oldSelfie = await insertPhoto({
      age: "48 hours",
      purpose: "selfie",
      sourceKind: "goods_receipt",
    });
    // Another tenant's old orphan must survive a sweep limited to tenant A.
    const otherTenantOrphan = await insertPhoto({
      tenantId: tenantB,
      age: "48 hours",
      ownerUserId: null,
      sourceKind: "goods_receipt",
    });

    const storage = new FakeObjectStorage();
    const all = [
      oldOrphan,
      oldOrphanNoOwner,
      freshOrphan,
      justUploaded,
      oldLinked,
      oldDocument,
      oldSelfie,
    ];
    for (const id of all) await putBlob(storage, tenantA, id);
    await putBlob(storage, tenantB, otherTenantOrphan);

    const result = await sweepOrphanReceiptPhotos(new Date(), {
      storage,
      log: { error: () => undefined },
      listTenantIds: async () => [tenantA],
    });
    expect(result).toEqual({ deleted: 2, failed: 0 });

    for (const id of [oldOrphan, oldOrphanNoOwner]) {
      expect(await objectExists(id)).toBe(false);
      expect(await blobExists(storage, tenantA, id)).toBe(false);
    }
    for (const id of [
      freshOrphan,
      justUploaded,
      oldLinked,
      oldDocument,
      oldSelfie,
    ]) {
      expect(await objectExists(id)).toBe(true);
      expect(await blobExists(storage, tenantA, id)).toBe(true);
    }
    expect(await objectExists(otherTenantOrphan)).toBe(true);
    expect(await blobExists(storage, tenantB, otherTenantOrphan)).toBe(true);

    // A second run finds nothing more.
    expect(
      await sweepOrphanReceiptPhotos(new Date(), {
        storage,
        log: { error: () => undefined },
        listTenantIds: async () => [tenantA],
      }),
    ).toEqual({ deleted: 0, failed: 0 });
  });

  // M2-9..M2-13 (sweeper safety). A receipt photo can be referenced by another
  // document without core_storage_objects.source_id being set. Assumption:
  // the sweeper must treat any such reference as "linked" and keep row + blob;
  // only photos nobody references are orphans.
  const sweepTenantA = (
    storage: FakeObjectStorage,
    log: { error: (...args: unknown[]) => void } = { error: () => undefined },
  ) =>
    sweepOrphanReceiptPhotos(new Date(), {
      storage,
      log,
      listTenantIds: async () => [tenantA],
    });

  it("[9h4qh-M2-9] an old photo without source_id that a goods_receipt_media row references is kept (row and blob)", async () => {
    const referenced = await insertPhoto({
      age: "72 hours",
      sourceKind: "goods_receipt",
    });
    await insertGoodsReceiptMediaRef(referenced);
    const realOrphan = await insertPhoto({
      age: "72 hours",
      sourceKind: "goods_receipt",
    });
    const storage = new FakeObjectStorage();
    await putBlob(storage, tenantA, referenced);
    await putBlob(storage, tenantA, realOrphan);

    const result = await sweepTenantA(storage);

    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(await objectExists(referenced)).toBe(true);
    expect(await blobExists(storage, tenantA, referenced)).toBe(true);
    expect(await objectExists(realOrphan)).toBe(false);
    expect(await blobExists(storage, tenantA, realOrphan)).toBe(false);
  });

  it("[9h4qh-M2-10] an old photo without source_id that a reimbursement claim references (receipt_upload_ref) is kept (row and blob)", async () => {
    const referenced = await insertPhoto({
      age: "72 hours",
      sourceKind: "goods_receipt",
    });
    await insertReimbursementRef(referenced);
    const realOrphan = await insertPhoto({
      age: "72 hours",
      sourceKind: "goods_receipt",
    });
    const storage = new FakeObjectStorage();
    await putBlob(storage, tenantA, referenced);
    await putBlob(storage, tenantA, realOrphan);

    const result = await sweepTenantA(storage);

    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(await objectExists(referenced)).toBe(true);
    expect(await blobExists(storage, tenantA, referenced)).toBe(true);
    expect(await objectExists(realOrphan)).toBe(false);
    expect(await blobExists(storage, tenantA, realOrphan)).toBe(false);
  });

  it("[9h4qh-M2-11] an old photo whose source_kind is cash_deposit is kept even when source_id is still null", async () => {
    const cashDeposit = await insertPhoto({
      age: "72 hours",
      sourceKind: "cash_deposit",
    });
    const realOrphan = await insertPhoto({
      age: "72 hours",
      sourceKind: "goods_receipt",
    });
    const storage = new FakeObjectStorage();
    await putBlob(storage, tenantA, cashDeposit);
    await putBlob(storage, tenantA, realOrphan);

    const result = await sweepTenantA(storage);

    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(await objectExists(cashDeposit)).toBe(true);
    expect(await blobExists(storage, tenantA, cashDeposit)).toBe(true);
    expect(await objectExists(realOrphan)).toBe(false);
  });

  it("[9h4qh-M2-12] only a goods_receipt orphan (source_id null, over 24 hours) is removed; one with source_kind NULL is kept, row and blob", async () => {
    // The general upload (SOP, checklist, repair ticket) stores source_kind NULL
    // and never links it, so the sweeper must not touch it.
    const noKind = await insertPhoto({ age: "25 hours" });
    const receiptKindNoId = await insertPhoto({
      age: "25 hours",
      sourceKind: "goods_receipt",
      sourceId: null,
    });
    const storage = new FakeObjectStorage();
    await putBlob(storage, tenantA, noKind);
    await putBlob(storage, tenantA, receiptKindNoId);

    const result = await sweepTenantA(storage);

    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(await objectExists(receiptKindNoId)).toBe(false);
    expect(await blobExists(storage, tenantA, receiptKindNoId)).toBe(false);
    expect(await objectExists(noKind)).toBe(true);
    expect(await blobExists(storage, tenantA, noKind)).toBe(true);
  });

  it("[9h4qh-M2-14] an old unlinked photo of another source kind (petty_purchase, waste_log) is kept, row and blob", async () => {
    const pettyPurchase = await insertPhoto({
      age: "72 hours",
      sourceKind: "petty_purchase",
    });
    const wasteLog = await insertPhoto({
      age: "72 hours",
      sourceKind: "waste_log",
    });
    const storage = new FakeObjectStorage();
    await putBlob(storage, tenantA, pettyPurchase);
    await putBlob(storage, tenantA, wasteLog);

    const result = await sweepTenantA(storage);

    expect(result).toEqual({ deleted: 0, failed: 0 });
    for (const id of [pettyPurchase, wasteLog]) {
      expect(await objectExists(id)).toBe(true);
      expect(await blobExists(storage, tenantA, id)).toBe(true);
    }
  });

  it("[9h4qh-M2-13] when deleting the blob fails the row is already gone, the run counts it as failed and does not throw", async () => {
    // Safe order: row first, blob second. A failed blob delete leaves at worst
    // an unreferenced blob, never a row that points at a deleted file.
    // Assumption: the exact `deleted` count for this case is not pinned.
    class FailingDeleteStorage extends FakeObjectStorage {
      override async delete(): ReturnType<FakeObjectStorage["delete"]> {
        throw new Error("storage unavailable");
      }
    }
    const orphan = await insertPhoto({
      age: "72 hours",
      sourceKind: "goods_receipt",
    });
    const storage = new FailingDeleteStorage();
    await putBlob(storage, tenantA, orphan);

    let result: { deleted: number; failed: number } | undefined;
    await expect(
      (async () => {
        result = await sweepTenantA(storage);
      })(),
    ).resolves.toBeUndefined();

    expect(result!.failed).toBe(1);
    expect(await objectExists(orphan)).toBe(false);
  });
});
