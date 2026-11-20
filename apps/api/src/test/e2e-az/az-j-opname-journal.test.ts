// Alur J (A-Z, WS-13, brief 91 potongan 4): stok opname bulanan, dari sesi
// hitung sampai jurnal otomatis di GL. Sumber kebenaran: docs/PRD.md
// "J. Alur Stok Opname Bulanan" (baris ~1206), INV-01, INV-03, ACC-01 (baris
// ~774-779). Tes ditulis sebagai cerita berurutan: aktor, aksi, hasil.
//
// Aktor (pengguna nyata yang masuk lewat Better Auth, peran dari template):
//   gudang     warehouse @ outlet           (penghitung)
//   manajer    outlet_manager @ outlet      (penyetuju)
//   rangkap    warehouse + outlet_manager   (bisa menghitung DAN menyetujui)
//   kasir      cashier @ outlet             (tanpa izin stok)
//
// Asumsi (PRD tidak merinci):
// - "Outlet manager meninjau penjelasan" dipetakan ke `note` pada transisi
//   submit; PRD tidak menyebut bentuknya, jadi isi note tidak di-assert.
// - Kebijakan approval `stock_adjustment` tanpa ambang (setiap opname lewat
//   satu penyetuju outlet_manager) dipasang di beforeAll dan dikembalikan di
//   afterAll. PRD INV-03 hanya mewajibkan penyetuju != penghitung.
// - Selisih rupiah = selisih kuantitas x rata-rata biaya pada snapshot sesi,
//   dibulatkan rupiah penuh.
// - Penyetuju yang ikut menghitung ditolak dengan kode STOCK_COUNT_SELF_APPROVAL
//   (status 4xx); pengguna tanpa izin menyetujui mendapat 403.
// - Jurnal GL: satu opname menghasilkan jurnal yang seimbang per entri dan
//   efek bersih pada akun persediaan sama dengan selisih bersih; struktur baris
//   persisnya (satu atau dua jurnal) tidak di-assert.
// - Jembatan GL (ws/inventory-gl) belum di m1: bagian jurnal dibungkus
//   describeUntilMerged. Event `stock.moved` diantar ke konsumen yang sama
//   dengan worker (deliverInventoryGlEvent) karena worker tidak jalan di tes.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decimal4,
  tenantIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../../app.ts";
import { db } from "../../db/index.ts";
import { withTenant } from "../../db/tenant.ts";
import { recordStockMovement } from "../../services/inventory.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "../helpers.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const brandId = cafeLegendPlatformFixtures.brand.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const app = createApp();
const createdUserIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];

const short = () => randomUUID().slice(0, 6);
const key = (prefix: string) => `${prefix}-${randomUUID()}`;
// Business dates are Asia/Jakarta calendar days, not the UTC date.
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
}).format(new Date());

function tenantScope(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

// ------------------------------------------------------------------ seeding

async function insertUom(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantId, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
  );
  return rows[0]!.id;
}

async function insertLocation(outletId: string, name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantId, outletId, `${name} ${short()}`],
  );
  return rows[0]!.id;
}

async function insertItem(name: string, baseUomId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantId, `${name} ${short()}`, baseUomId],
  );
  return rows[0]!.id;
}

async function receive(
  outletId: string,
  locationId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
): Promise<void> {
  await recordStockMovement(tenantScope(), {
    outletId,
    locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
    batchId: null,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    actor: { type: "system" },
  });
}

async function balanceOf(locationId: string, itemId: string) {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantId, locationId, itemId],
  );
  return rows[0]?.quantity ?? null;
}

type LedgerRow = {
  id: string;
  movement_type: string;
  source_type: string;
  inventory_item_id: string;
  quantity: string;
};

/** Ledger rows written by one count (the count id is the source id). */
async function countLedger(countId: string): Promise<LedgerRow[]> {
  const { rows } = await owner.query<LedgerRow>(
    `SELECT id, movement_type, source_type, inventory_item_id, quantity::text AS quantity
     FROM stock_ledger WHERE tenant_id = $1 AND source_id = $2
     ORDER BY inventory_item_id`,
    [tenantId, countId],
  );
  return rows;
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant`);
  return rows[0].id;
}

async function assignRole(
  userId: string,
  templateKey: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
): Promise<void> {
  // Backdated: the container clock may drift from the Node clock.
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      await roleIdOf(templateKey),
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

// -------------------------------------------------------------------- actors

type Actor = { client: ReturnType<typeof agent>; userId: string };

async function makeActor(
  name: string,
  roles: Array<[templateKey: string, scope: Parameters<typeof assignRole>[2]]>,
  options: { mfa?: boolean } = {},
): Promise<Actor> {
  const client = agent(app);
  const email = await signUp(client, `${name} ${short()}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  for (const [templateKey, scope] of roles)
    await assignRole(userId, templateKey, scope);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId };
}

const outletScope = (id: string) => ({ type: "outlet", id }) as const;

type Crew = {
  gudang: Actor;
  manajer: Actor;
  rangkap: Actor;
  kasir: Actor;
};

async function makeCrew(outletId: string): Promise<Crew> {
  const scope = outletScope(outletId);
  return {
    gudang: await makeActor("Opname Gudang", [["warehouse", scope]]),
    manajer: await makeActor("Opname Manajer", [["outlet_manager", scope]], {
      mfa: true,
    }),
    rangkap: await makeActor(
      "Opname Rangkap",
      [
        ["warehouse", scope],
        ["outlet_manager", scope],
      ],
      { mfa: true },
    ),
    kasir: await makeActor("Opname Kasir", [["cashier", scope]]),
  };
}

// ------------------------------------------------------------------ HTTP kit

const base = "/api/inventory/stock-counts";
const get = (actor: Actor, path: string) => actor.client.get(`${base}${path}`);
const post = (actor: Actor, path: string, body: unknown) =>
  actor.client
    .post(`${base}${path}`)
    .set(originHeader)
    .send(body as object);
const patch = (actor: Actor, path: string, body: unknown) =>
  actor.client
    .patch(`${base}${path}`)
    .set(originHeader)
    .send(body as object);

async function ok(response: Response, status = 200): Promise<Response> {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response;
}

function expectError(response: Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(response.body.error?.code).toBe(code);
}

function transition(
  actor: Actor,
  countId: string,
  action: string,
  extra: Record<string, unknown> = {},
) {
  return post(actor, `/${countId}/transitions`, {
    action,
    idempotencyKey: key(action),
    ...extra,
  });
}

/** The count status as the manager (a non-counter) reads it. */
async function statusOf(viewer: Actor, countId: string): Promise<string> {
  const detail = await ok(await get(viewer, `/${countId}`));
  return detail.body.data.count.status as string;
}

// ------------------------------------------------------------ the monthly job

const FORBIDDEN_FOR_COUNTER = ["systemQty", "varianceIdr", "unitCostIdr"];

type Item = {
  name: string;
  onHand: string;
  cost: string;
  counted: string;
  /** Expected rupiah variance: (counted - onHand) x cost. */
  varianceIdr: number;
};

/** One shelf of stock: a loss, a gain and an exact match. Net = -1.500. */
const SHELF: Item[] = [
  {
    name: "Kopi",
    onHand: "10.0000",
    cost: "1500.0000",
    counted: "8.0000",
    varianceIdr: -3000,
  },
  {
    name: "Gula",
    onHand: "10.0000",
    cost: "1500.0000",
    counted: "11.0000",
    varianceIdr: 1500,
  },
  {
    name: "Susu",
    onHand: "4.0000",
    cost: "2000.0000",
    counted: "4.0000",
    varianceIdr: 0,
  },
];

type Shelf = {
  outletId: string;
  locationId: string;
  itemIds: string[];
  uomId: string;
};

async function seedShelf(
  outletId: string,
  uomId: string,
  specs: Item[] = SHELF,
): Promise<Shelf> {
  const locationId = await insertLocation(outletId, "Gudang Opname");
  const itemIds: string[] = [];
  for (const spec of specs) {
    const itemId = await insertItem(spec.name, uomId);
    await receive(outletId, locationId, itemId, spec.onHand, spec.cost);
    itemIds.push(itemId);
  }
  return { outletId, locationId, itemIds, uomId };
}

async function createBlindCount(actor: Actor, shelf: Shelf) {
  const response = await post(actor, "", {
    outletId: shelf.outletId,
    locationId: shelf.locationId,
    type: "cycle",
    blind: true,
    businessDate: today,
    inventoryItemIds: shelf.itemIds,
    idempotencyKey: key("sc"),
  });
  await ok(response, 201);
  return response.body.data.count as {
    id: string;
    status: string;
    blind: boolean;
  };
}

/** Counter-visible sheet lines (blind: no system numbers) keyed by item. */
async function sheetOf(actor: Actor, countId: string) {
  const sheet = await ok(await get(actor, `/${countId}/sheet`));
  const lines = sheet.body.data.lines as Array<{
    id: string;
    inventoryItemId: string;
    countedQty: string | null;
  }>;
  return {
    raw: sheet.body,
    lines: new Map(lines.map((l) => [l.inventoryItemId, l])),
  };
}

async function enterCounts(
  actor: Actor,
  countId: string,
  counted: Record<string, string>,
) {
  const { lines } = await sheetOf(actor, countId);
  for (const [itemId, countedQty] of Object.entries(counted)) {
    const line = lines.get(itemId);
    expect(line, `sheet line for ${itemId}`).toBeDefined();
    await ok(
      await patch(actor, `/${countId}/sheet/lines/${line!.id}`, { countedQty }),
    );
  }
}

const countedBy = (shelf: Shelf, specs: Item[] = SHELF) =>
  Object.fromEntries(shelf.itemIds.map((id, i) => [id, specs[i]!.counted]));

/** Draft -> counting -> every line counted -> pending_approval. */
async function submitCount(
  counter: Actor,
  shelf: Shelf,
  specs: Item[] = SHELF,
) {
  const count = await createBlindCount(counter, shelf);
  await ok(await transition(counter, count.id, "start"));
  await enterCounts(counter, count.id, countedBy(shelf, specs));
  const submitted = await ok(
    await transition(counter, count.id, "submit", {
      note: "Selisih kopi: tumpah saat penyajian; gula: salah catat penerimaan.",
    }),
  );
  expect(submitted.body.data.status).toBe("pending_approval");
  return count;
}

let crew: Crew;
let gramId: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  gramId = await insertUom("g");

  // Every stock_adjustment routes to one outlet manager (INV-03: always a
  // second person). Existing tenant policies are restored in afterAll.
  savedPolicies = (
    await owner.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'stock_adjustment'`,
      [tenantId],
    )
  ).rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'stock_adjustment'`,
    [tenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'stock_adjustment', NULL, $2, 1)`,
    [tenantId, await roleIdOf("outlet_manager")],
  );

  crew = await makeCrew(outletA);
});

afterAll(async () => {
  await owner.query(
    `DELETE FROM approval_requests WHERE tenant_id = $1 AND source_module = 'inventory_count'`,
    [tenantId],
  );
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'stock_adjustment'`,
    [tenantId],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
  // Ledger and journal rows are append-only; fixtures carry random names.
  await owner.end();
});

// ============================================================================
// Alur J, langkah 1-4: gudang hitung buta, manajer menyetujui, stok disesuaikan.

describe("Alur J stok opname bulanan: hitung buta sampai penyesuaian (INV-01, INV-03)", () => {
  let shelf: Shelf;
  let countId: string;

  beforeAll(async () => {
    shelf = await seedShelf(outletA, gramId);
  });

  it("INV-03 langkah 1: gudang membuka sesi hitung buta; lokasi yang sama tidak bisa dibuka dua kali", async () => {
    const count = await createBlindCount(crew.gudang, shelf);
    countId = count.id;
    expect(count.blind).toBe(true);
    expect(count.status).toBe("draft");

    // Error state: a second open session at the same location is refused.
    expectError(
      await post(crew.gudang, "", {
        outletId: outletA,
        locationId: shelf.locationId,
        type: "cycle",
        blind: true,
        businessDate: today,
        inventoryItemIds: shelf.itemIds,
        idempotencyKey: key("sc"),
      }),
      409,
      "STOCK_COUNT_LOCATION_BUSY",
    );

    const started = await ok(await transition(crew.gudang, countId, "start"));
    expect(started.body.data.status).toBe("counting");
  });

  it("INV-03 langkah 2: penghitung hanya melihat lembar hitung tanpa angka sistem", async () => {
    const { raw, lines } = await sheetOf(crew.gudang, countId);
    expect(lines.size).toBe(SHELF.length);
    for (const field of FORBIDDEN_FOR_COUNTER)
      expect(JSON.stringify(raw), field).not.toContain(field);
    for (const line of lines.values()) expect(line.countedQty).toBeNull();

    // The full detail (with system numbers) is closed to the counter.
    expectError(
      await get(crew.gudang, `/${countId}`),
      403,
      "STOCK_COUNT_BLIND_HIDDEN",
    );

    await enterCounts(crew.gudang, countId, countedBy(shelf));
    const after = await sheetOf(crew.gudang, countId);
    expect([...after.lines.values()].map((line) => line.countedQty)).toEqual(
      expect.arrayContaining(["8.0000", "11.0000", "4.0000"]),
    );
    for (const field of FORBIDDEN_FOR_COUNTER)
      expect(JSON.stringify(after.raw), field).not.toContain(field);

    const submitted = await ok(
      await transition(crew.gudang, countId, "submit", {
        note: "Selisih kopi: tumpah saat penyajian; gula: salah catat penerimaan.",
      }),
    );
    expect(submitted.body.data.status).toBe("pending_approval");
  });

  it("INV-03 langkah 3: selisih bernilai rupiah tampil bagi manajer, tetap tertutup bagi penghitung", async () => {
    const detail = await ok(await get(crew.manajer, `/${countId}`));
    const byItem = new Map(
      (
        detail.body.data.lines as Array<{
          inventoryItemId: string;
          systemQty: string;
          countedQty: string;
          varianceIdr: number;
        }>
      ).map((line) => [line.inventoryItemId, line]),
    );
    SHELF.forEach((spec, i) => {
      const line = byItem.get(shelf.itemIds[i]!);
      expect(line, spec.name).toMatchObject({
        systemQty: spec.onHand,
        countedQty: spec.counted,
        varianceIdr: spec.varianceIdr,
      });
    });
    const net = [...byItem.values()].reduce((sum, l) => sum + l.varianceIdr, 0);
    expect(net).toBe(-1500);

    // Langkah 4: the manager reviews the counter's explanation (PRD Alur J.4).
    const inbox = await ok(
      await crew.manajer.client.get(
        "/api/approvals?status=pending&actionType=stock_adjustment&limit=100",
      ),
    );
    const request = (inbox.body.data as Array<Record<string, unknown>>).find(
      (row) => row.objectId === countId,
    );
    expect(request, "approval request in the manager inbox").toBeDefined();
    expect(
      JSON.stringify({ count: detail.body.data.count, request }),
      "the counter's explanation reaches the manager",
    ).toContain("tumpah");

    // The counter still cannot read the variance, also after submitting.
    expectError(
      await get(crew.gudang, `/${countId}`),
      403,
      "STOCK_COUNT_BLIND_HIDDEN",
    );
  });

  it("INV-03 sebelum disetujui stok belum berubah dan ledger kosong", async () => {
    expect(await countLedger(countId)).toEqual([]);
    expect(await balanceOf(shelf.locationId, shelf.itemIds[0]!)).toBe(
      "10.0000",
    );
    expect(await balanceOf(shelf.locationId, shelf.itemIds[1]!)).toBe(
      "10.0000",
    );
    expect(await balanceOf(shelf.locationId, shelf.itemIds[2]!)).toBe("4.0000");
  });

  it("INV-03 penghitung dan pengguna tanpa izin tidak bisa menyetujui", async () => {
    expect((await transition(crew.gudang, countId, "approve")).status).toBe(
      403,
    );
    expect((await transition(crew.kasir, countId, "approve")).status).toBe(403);
    expect(await countLedger(countId)).toEqual([]);
    expect(await statusOf(crew.manajer, countId)).toBe("pending_approval");
  });

  it("INV-01 INV-03 langkah 4: manajer menyetujui dan hanya selisih yang dibukukan sebagai penyesuaian", async () => {
    const approved = await ok(
      await transition(crew.manajer, countId, "approve"),
    );
    expect(approved.body.data.status).toBe("posted");

    // One adjustment row per differing item; the exact match writes nothing.
    const ledger = await countLedger(countId);
    expect(ledger).toHaveLength(2);
    expect(ledger.every((row) => row.movement_type === "adjustment")).toBe(
      true,
    );
    expect(ledger.every((row) => row.source_type === "stock_count")).toBe(true);
    const qty = new Map(
      ledger.map((row) => [row.inventory_item_id, row.quantity]),
    );
    expect(qty.get(shelf.itemIds[0]!)).toBe("-2.0000");
    expect(qty.get(shelf.itemIds[1]!)).toBe("1.0000");
    expect(qty.has(shelf.itemIds[2]!)).toBe(false);

    // On-hand stock now equals the physical count.
    expect(await balanceOf(shelf.locationId, shelf.itemIds[0]!)).toBe("8.0000");
    expect(await balanceOf(shelf.locationId, shelf.itemIds[1]!)).toBe(
      "11.0000",
    );
    expect(await balanceOf(shelf.locationId, shelf.itemIds[2]!)).toBe("4.0000");

    // The manager sees the adjustments on the stock card.
    const card = await ok(
      await crew.manajer.client.get(
        `/api/inventory/stock-ledger?outletId=${outletA}&locationId=${shelf.locationId}&movementType=adjustment`,
      ),
    );
    expect(card.body.data).toHaveLength(2);
  });

  it("INV-01 baris penyesuaian tidak bisa diubah atau dihapus dan menyetujui ulang tidak menggandakan", async () => {
    const ledger = await countLedger(countId);
    await expect(
      owner.query("UPDATE stock_ledger SET quantity = 99 WHERE id = $1", [
        ledger[0]!.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.query("DELETE FROM stock_ledger WHERE id = $1", [ledger[0]!.id]),
    ).rejects.toThrow(/append-only/);

    // A repeated approval (double click) never posts the adjustment twice.
    await transition(crew.manajer, countId, "approve");
    expect(await countLedger(countId)).toHaveLength(2);
    expect(await balanceOf(shelf.locationId, shelf.itemIds[0]!)).toBe("8.0000");
    expect(await statusOf(crew.manajer, countId)).toBe("posted");
  });
});

// ============================================================================
// Jalur kesalahan dan keadaan kosong.

describe("Alur J jalur kesalahan: penyetuju harus orang lain (INV-03)", () => {
  it("INV-03 penghitung yang juga punya izin menyetujui tetap ditolak; manajer lain bisa menyetujui", async () => {
    const shelf = await seedShelf(outletA, gramId);
    const count = await submitCount(crew.rangkap, shelf);

    expectError(
      await transition(crew.rangkap, count.id, "approve"),
      403,
      "STOCK_COUNT_SELF_APPROVAL",
    );
    expect(await countLedger(count.id)).toEqual([]);
    expect(await statusOf(crew.manajer, count.id)).toBe("pending_approval");
    expect(await balanceOf(shelf.locationId, shelf.itemIds[0]!)).toBe(
      "10.0000",
    );

    await ok(await transition(crew.manajer, count.id, "approve"));
    expect(await countLedger(count.id)).toHaveLength(2);
    expect(await balanceOf(shelf.locationId, shelf.itemIds[0]!)).toBe("8.0000");
  });

  it("INV-03 penghitung tidak bisa menolak hitungannya sendiri", async () => {
    const shelf = await seedShelf(outletA, gramId);
    const count = await submitCount(crew.rangkap, shelf);
    expectError(
      await transition(crew.rangkap, count.id, "reject"),
      403,
      "STOCK_COUNT_SELF_APPROVAL",
    );
    expect(await statusOf(crew.manajer, count.id)).toBe("pending_approval");
  });

  it("INV-03 penolakan tidak membukukan apa pun; hitung ulang lalu disetujui", async () => {
    const shelf = await seedShelf(outletA, gramId);
    const count = await submitCount(crew.gudang, shelf);

    const rejected = await ok(
      await transition(crew.manajer, count.id, "reject", {
        note: "Hitung ulang rak belakang",
      }),
    );
    expect(rejected.body.data.status).toBe("counting");
    expect(await countLedger(count.id)).toEqual([]);
    expect(await balanceOf(shelf.locationId, shelf.itemIds[0]!)).toBe(
      "10.0000",
    );

    // Recount: kopi is 9 this time, the others unchanged.
    const recount: Item[] = [
      { ...SHELF[0]!, counted: "9.0000", varianceIdr: -1500 },
      { ...SHELF[1]!, counted: "10.0000", varianceIdr: 0 },
      { ...SHELF[2]! },
    ];
    await enterCounts(crew.gudang, count.id, countedBy(shelf, recount));
    await ok(await transition(crew.gudang, count.id, "submit"));
    await ok(await transition(crew.manajer, count.id, "approve"));

    const ledger = await countLedger(count.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      inventory_item_id: shelf.itemIds[0],
      quantity: "-1.0000",
    });
    expect(await balanceOf(shelf.locationId, shelf.itemIds[0]!)).toBe("9.0000");
  });

  it("INV-01 hitungan tanpa selisih disetujui tanpa membukukan penyesuaian (keadaan kosong)", async () => {
    const exact = SHELF.map((spec) => ({
      ...spec,
      counted: spec.onHand,
      varianceIdr: 0,
    }));
    const shelf = await seedShelf(outletA, gramId, exact);
    const count = await submitCount(crew.gudang, shelf, exact);

    await ok(await transition(crew.manajer, count.id, "approve"));
    expect(await statusOf(crew.manajer, count.id)).toBe("posted");
    expect(await countLedger(count.id)).toEqual([]);
    expect(await balanceOf(shelf.locationId, shelf.itemIds[0]!)).toBe(
      "10.0000",
    );
  });

  it("INV-03 hitungan yang belum diajukan tidak bisa disetujui; kasir dan tamu tidak bisa membuat sesi", async () => {
    const shelf = await seedShelf(outletA, gramId);
    const count = await createBlindCount(crew.gudang, shelf);
    await ok(await transition(crew.gudang, count.id, "start"));
    expectError(
      await transition(crew.manajer, count.id, "approve"),
      409,
      "STOCK_COUNT_INVALID_TRANSITION",
    );
    expect(await countLedger(count.id)).toEqual([]);

    const body = {
      outletId: outletA,
      locationId: shelf.locationId,
      type: "cycle",
      blind: true,
      businessDate: today,
      inventoryItemIds: shelf.itemIds,
      idempotencyKey: key("sc"),
    };
    expect((await post(crew.kasir, "", body)).status).toBe(403);
    expect(
      (await agent(app).post(base).set(originHeader).send(body)).status,
    ).toBe(401);
  });
});

// ============================================================================
// Alur J langkah 4 (bagian akhir): jurnal otomatis seimbang di GL.
// Menunggu ws/inventory-gl (jembatan stock.moved -> jurnal).

type GlWorld = {
  entity: string;
  outletId: string;
  inventoryAccount: string;
  adjustmentAccount: string;
};

async function makeGlWorld(): Promise<GlWorld> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenantId, `Entity Opname ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Opname', 'Jl. Opname', 'Asia/Jakarta', '04:00', $6::jsonb, 'active')`,
    [
      outletId,
      tenantId,
      brandId,
      entity,
      `OP-${short()}`.toUpperCase(),
      // Ledger rows are append-only, so this outlet outlives the file. Give it
      // the seeded outlet's valid hours so later outlet-list tests still parse it.
      JSON.stringify(cafeLegendPlatformFixtures.outlets[0]!.openingHours),
    ],
  );
  const chart: Array<
    [role: string, code: string, name: string, type: string, group: string]
  > = [
    ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
    ["cogs", "5101", "HPP Makanan dan Minuman", "expense", "cogs"],
    ["waste_expense", "5102", "Waste dan Spoilage", "expense", "cogs"],
    ["inventory_adjustment", "5103", "Selisih Stok Opname", "expense", "cogs"],
  ];
  const accounts = new Map<string, string>();
  for (const [role, code, name, type, group] of chart) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entity, code, name, type, group],
    );
    accounts.set(role, rows[0]!.id);
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, rows[0]!.id],
    );
  }
  // Open fiscal periods around today (the count posts "now").
  for (const offset of [-1, 0, 1]) {
    const date = new Date();
    date.setUTCDate(15);
    date.setUTCMonth(date.getUTCMonth() + offset);
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entity, date.toISOString().slice(0, 7)],
    );
  }
  return {
    entity,
    outletId,
    inventoryAccount: accounts.get("inventory")!,
    adjustmentAccount: accounts.get("inventory_adjustment")!,
  };
}

/** Same hand-off the worker does: stock.moved outbox event -> GL consumer. */
async function deliverToGl(ledgerRowId: string): Promise<{ status: string }> {
  const ledgerEntryId = uuidToUlid(ledgerRowId);
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'stock.moved'
        AND event->'payload'->>'ledgerEntryId' = $2`,
    [tenantId, ledgerEntryId],
  );
  expect(rows, `stock.moved outbox row of ${ledgerEntryId}`).toHaveLength(1);
  const event = eventEnvelopeSchema.parse(rows[0]!.event);
  // The module does not exist on m1; resolved at run time once merged.
  const modulePath = "../../services/inventory-gl-consumer.ts";
  const consumer = (await import(/* @vite-ignore */ modulePath)) as {
    deliverInventoryGlEvent: (
      context: ScopedTenantContext,
      event: unknown,
      tx: unknown,
    ) => Promise<{ status: string }>;
  };
  return withTenant(db, tenantScope(), (tx) =>
    consumer.deliverInventoryGlEvent(tenantScope(), event, tx),
  );
}

describe("Alur J jurnal otomatis: selisih opname masuk GL seimbang (INV-03, ACC-01)", () => {
  let world: GlWorld;
  let glCrew: Crew;
  let finance: Actor;
  let shelf: Shelf;
  let countId: string;

  beforeAll(async () => {
    world = await makeGlWorld();
    glCrew = await makeCrew(world.outletId);
    finance = await makeActor(
      "Opname Finance",
      [["finance", { type: "tenant" }]],
      {
        mfa: true,
      },
    );
    shelf = await seedShelf(world.outletId, gramId);
  });

  async function journalsOfCount() {
    const { rows } = await owner.query<{
      id: string;
      debit: string;
      credit: string;
    }>(
      `SELECT e.id,
                COALESCE(SUM(l.debit_idr), 0)::text AS debit,
                COALESCE(SUM(l.credit_idr), 0)::text AS credit
           FROM journal_entries e
           JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
          WHERE e.tenant_id = $1 AND e.legal_entity_id = $2 AND e.source_id = $3
          GROUP BY e.id`,
      [tenantId, world.entity, countId],
    );
    return rows.map((row) => ({
      id: row.id,
      debit: Number(row.debit),
      credit: Number(row.credit),
    }));
  }

  it("INV-03 ACC-01 sebelum disetujui tidak ada jurnal; setelah disetujui satu jurnal seimbang terbentuk otomatis", async () => {
    const count = await submitCount(glCrew.gudang, shelf);
    countId = count.id;
    expect(await journalsOfCount()).toEqual([]);

    await ok(await transition(glCrew.manajer, countId, "approve"));
    // Still nothing until the ledger events reach the GL consumer.
    for (const row of await countLedger(countId)) {
      const result = await deliverToGl(row.id);
      expect(["posted", "already_posted"]).toContain(result.status);
    }

    const journals = await journalsOfCount();
    expect(journals.length).toBeGreaterThanOrEqual(1);
    for (const journal of journals) {
      expect(journal.debit).toBeGreaterThan(0);
      expect(journal.debit).toBe(journal.credit);
    }
  });

  it("ACC-01 efek bersih pada akun persediaan sama dengan selisih bersih Rp1.500 (kurang)", async () => {
    const { rows } = await owner.query<{
      net_credit: string;
      adj_debit: string;
    }>(
      `SELECT COALESCE(SUM(CASE WHEN l.account_id = $4 THEN l.credit_idr - l.debit_idr END), 0)::text AS net_credit,
                COALESCE(SUM(CASE WHEN l.account_id = $5 THEN l.debit_idr - l.credit_idr END), 0)::text AS adj_debit
           FROM journal_entries e
           JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
          WHERE e.tenant_id = $1 AND e.legal_entity_id = $2 AND e.source_id = $3`,
      [
        tenantId,
        world.entity,
        countId,
        world.inventoryAccount,
        world.adjustmentAccount,
      ],
    );
    // Loss 2 x 1.500 = 3.000, gain 1 x 1.500 = 1.500, net loss 1.500:
    // persediaan turun, beban selisih opname naik.
    expect(Number(rows[0]!.net_credit)).toBe(1500);
    expect(Number(rows[0]!.adj_debit)).toBe(1500);
  });

  it("ACC-01 finance membaca jurnal opname lewat API dan melihat debit sama dengan kredit", async () => {
    const month = today.slice(0, 7);
    const list = await finance.client.get(
      `/api/accounting/journals?legalEntityId=${world.entity}&from=${month}-01&to=${today}`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const ours = (
      list.body.data as Array<{ id: string; sourceId: string | null }>
    ).filter((entry) => entry.sourceId === countId);
    expect(ours.length).toBeGreaterThanOrEqual(1);

    const detail = await finance.client.get(
      `/api/accounting/journals/${ours[0]!.id}`,
    );
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const lines = detail.body.data.entry.lines as Array<{
      debitIdr: number;
      creditIdr: number;
    }>;
    const debit = lines.reduce((sum, l) => sum + l.debitIdr, 0);
    const credit = lines.reduce((sum, l) => sum + l.creditIdr, 0);
    expect(debit).toBe(credit);
  });

  it("ACC-01 jurnal final tidak dihapus; selisih kurang (rugi) tidak bisa dibalik manual karena menaikkan laba (1218)", async () => {
    // This count is a net loss (Dr beban selisih opname, Cr persediaan): a manual
    // reversal would raise profit and hide the shortage, so 1218 refuses it and
    // sends the correction through the source flow (fix the stock movement).
    const before = await journalsOfCount();
    expect(before).toHaveLength(1);
    const journal = before[0]!;
    const reverse = () =>
      finance.client
        .post(`/api/accounting/journals/${journal.id}/reversal`)
        .set(originHeader)
        .send({
          entryDate: today,
          reason: "Hitungan ulang menunjukkan selisih salah catat",
          idempotencyKey: key("rev"),
        });
    const attempt = await reverse();
    expect(attempt.status, JSON.stringify(attempt.body)).toBe(409);
    expect(attempt.body.error.code).toBe("AUTO_JOURNAL_LOCKED");

    // The final journal is untouched: still there, balanced, never reversed.
    expect(await journalsOfCount()).toEqual(before);
    const { rows } = await owner.query(
      "SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND reversal_of = $2",
      [tenantId, journal.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("ACC-01 selisih lebih (laba) dikoreksi lewat jurnal pembalik, sekali saja; jurnal asal tetap ada", async () => {
    // A net gain (Dr persediaan, Cr selisih opname): reversing it lowers
    // profit, so 1218 lets the manual reversal through. This keeps the ACC-01
    // path (correct a final journal by reversing it, never by deleting it).
    const gainSpecs: Item[] = [
      {
        name: "Gula lebih",
        onHand: "10.0000",
        cost: "1500.0000",
        counted: "11.0000",
        varianceIdr: 1500,
      },
    ];
    const gainShelf = await seedShelf(world.outletId, gramId, gainSpecs);
    const count = await submitCount(glCrew.gudang, gainShelf, gainSpecs);
    await ok(await transition(glCrew.manajer, count.id, "approve"));
    for (const row of await countLedger(count.id)) {
      const result = await deliverToGl(row.id);
      expect(["posted", "already_posted"]).toContain(result.status);
    }
    const { rows: original } = await owner.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_id = $3`,
      [tenantId, world.entity, count.id],
    );
    expect(original).toHaveLength(1);
    const journalId = original[0]!.id;

    const reverse = () =>
      finance.client
        .post(`/api/accounting/journals/${journalId}/reversal`)
        .set(originHeader)
        .send({
          entryDate: today,
          reason: "Hitungan ulang menunjukkan selisih lebih salah catat",
          idempotencyKey: key("rev-gain"),
        });
    const first = await reverse();
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.reversalOf).toBe(journalId);

    const second = await reverse();
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("JOURNAL_ALREADY_REVERSED");

    // The original stays; exactly one reversal points at it.
    const { rows: after } = await owner.query(
      `SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND id = $2`,
      [tenantId, journalId],
    );
    expect(after).toHaveLength(1);
    const { rows: reversals } = await owner.query(
      "SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND reversal_of = $2",
      [tenantId, journalId],
    );
    expect(reversals).toHaveLength(1);
  });

  it("INV-03 hitungan ditolak tidak menghasilkan jurnal", async () => {
    const other = await seedShelf(world.outletId, gramId);
    const count = await submitCount(glCrew.gudang, other);
    await ok(await transition(glCrew.manajer, count.id, "reject"));
    const { rows } = await owner.query(
      "SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND source_id = $2",
      [tenantId, count.id],
    );
    expect(rows).toHaveLength(0);
  });
});
