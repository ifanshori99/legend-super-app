// Alur D: pesanan di dapur hingga meja (PRD §4 Alur D, baris ~1166; F12 baris
// ~655; kriteria KDS-01..07 baris ~667 dan ORD-02 baris ~620). WS-13 brief 91,
// potongan 3.
//
// Ditulis dari PRD dan kontrak bersama `packages/shared/src/kitchen`, bukan
// dari kode service. Real Express app, Better Auth, RBAC dan PostgreSQL ber-RLS
// dalam tenant terisolasi milik file ini. Tes berulang aman: data unik per run.
//
// Tidak satu pun dari ini ada di milestone/m1 (KDS belum digabung), jadi semua
// adegan dibungkus `describeUntilMerged`:
//   - `ws/kds`           routing per stasiun, mulai/selesai, void, jejak status,
//                        feed dan resync, QR bayar di muka (ORD-02).
//   - card legend-5rzy expo + runner + diantar, void tampil di expo, remake
//                        dan comp (KDS-07), pacing (KDS-05). Kontraknya sudah di
//                        m1 (`kitchen/endpoints.ts`), implementasinya belum ada
//                        di cabang mana pun.
//   - card legend-2lp.3 KDS mati -> tiket dicetak + supervisor diberi tahu.
//
// Asumsi (juga di laporan):
//  1. Jalur HTTP stasiun mengikuti kontrak `ws/kds`: GET
//     /kitchen/stations/:id/tickets (snapshot + sequence), /feed?after=n,
//     /kitchen/tickets/:id, POST /start /bump /recall /void,
//     POST /kitchen/ticket-items/:id/status {action}.
//  2. Pesanan POS takeaway dipecah saat "fire"; helper `placeOrder` men-submit
//     draft lalu fire baris yang masih tertahan, sehingga tiket ada.
//  3. Void di KDS hanya dapur; kasir diberi tahu lewat event pesanan
//     `order.kitchen_voided` (tagihan tak berubah sampai ada void di POS).
//  4. Runner = pengguna ber-izin `kds.ticket.process`. PRD tidak menyebut kode
//     izin khusus runner.
//  5. Label meja di expo = kode meja. Kanal QR dine_in dipakai agar ada meja.
//  6. Audit KDS-04 dibaca dari tabel `kitchen_ticket_status_changes` (satu-
//     satunya tempat yang mencatat pengguna + waktu per perubahan).
//  7. Penyebab "KDS mati" belum punya kontrak (tidak ada endpoint di m1 atau
//     ws/kds): `simulateKdsStationOffline` sengaja belum terisi.
//  8. KDS-06 (median estimasi vs aktual pada uji beban) adalah uji beban, bukan
//     alur A-Z: ditulis sebagai skip [PENDING-DECISION load-test].

import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../../app.ts";
import { db } from "../../db/index.ts";
import { withTenant } from "../../db/tenant.ts";
import { setStaffPin } from "../../services/device-pin.service.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../../services/payment-gateway.ts";
import { confirmPayment } from "../../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../../services/qr-order-payment.ts";
import { qrOrderSettlementLookup } from "../../services/qr-order.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../../services/pos-order-ports.ts";
import { createPosOverride } from "../../services/staff-override.service.ts";
import { setTableSessionSettlementLookup } from "../../services/table-session.service.ts";
import { agent, originHeader, signUp } from "../helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "../floor-test-helpers.ts";
import { describeUntilBuilt, itUntilBuilt } from "./pending-branch.ts";

const PIN = "582914";
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

const ids = {
  category: randomUUID(),
  priceListPos: randomUUID(),
  priceListQr: randomUUID(),
  kopi: randomUUID(), // -> Bar Kopi (beverage_bar)
  nasi: randomUUID(), // -> Dapur Panas (hot_kitchen)
  air: randomUUID(), // tanpa stasiun: bukan item dapur
  bar: randomUUID(),
  kitchen: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  kdsRole: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let floorStaff: Staff;
let cashier: Member;
let supervisor: Member;
let cook: Member; // kds.ticket.process, seluruh tenant (dapur panas)
let barista: Member; // kds.ticket.process hanya stasiun Bar Kopi
let runner: Member; // runner (asumsi 4)

// ---- Pembayaran QR (FakeGateway DOIT, wajib lewat setPaymentGateway) ------------

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKEQRORDER",
      issuer: null,
    };
    return {
      providerRef: `QRO-${randomBytes(6).toString("hex")}-${this.created}`,
      instructions,
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}
const gateway = new FakeGateway();

// Nomor struk (tidak dipakai alur ini, tetapi port harus ada bila POS menerbitkan).
function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let seq = 0;
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      seq += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? randomUUID(),
        number: `KDSAZ-${String(seq).padStart(6, "0")}`,
        sequenceNumber: seq,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx, _context, orderId) {
      return byOrder.get(orderId) ?? null;
    },
    async voidForOrder() {
      return null;
    },
  };
}

// ---- Fixture ----------------------------------------------------------------------

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function member(
  roleId: string,
  scope: { type: "tenant" | "station"; id: string | null },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

async function insertRole(
  id: string,
  name: string,
  permissions: string[],
  scopes: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [
      id,
      tenant.tenantId,
      name,
      JSON.stringify(permissions),
      JSON.stringify(scopes),
    ],
  );
}

let setupPromise: Promise<void> | null = null;

/** Satu kali per file; tiap describe memanggilnya dari beforeAll-nya sendiri. */
function ensureSetup(): Promise<void> {
  setupPromise ??= setup();
  return setupPromise;
}

async function setup() {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  tenant = await createIsolatedTenant(`azd-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  floorStaff = await staffOfIsolatedTenant(app, tenant);

  await insertRole(
    ids.cashierRole,
    "AZ-D Kasir",
    [
      "order.view",
      "pos.sale.create",
      "pos.payment.accept",
      "pos.discount.apply",
      "pos.void.request",
    ],
    ["tenant"],
  );
  await insertRole(
    ids.supervisorRole,
    "AZ-D Supervisor",
    ["order.view", "pos.void.approve"],
    ["tenant"],
  );
  await insertRole(
    ids.kdsRole,
    "AZ-D Dapur",
    ["kds.ticket.process"],
    ["tenant", "station"],
  );

  // Stasiun lebih dulu: menu_items.station_id dan penugasan barista merujuknya.
  await asOwnerTenant(async (client) => {
    for (const [id, name, type] of [
      [ids.bar, "Bar Kopi", "beverage_bar"],
      [ids.kitchen, "Dapur Panas", "hot_kitchen"],
    ] as const)
      await client.query(
        `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
        [id, tenant.tenantId, tenant.outletId, name, type],
      );
  });

  cashier = await member(
    ids.cashierRole,
    { type: "tenant", id: null },
    "AZ-D Kasir",
  );
  supervisor = await member(
    ids.supervisorRole,
    { type: "tenant", id: null },
    "AZ-D Supervisor",
  );
  cook = await member(ids.kdsRole, { type: "tenant", id: null }, "AZ-D Koki");
  barista = await member(
    ids.kdsRole,
    { type: "station", id: ids.bar },
    "AZ-D Barista",
  );
  runner = await member(
    ids.kdsRole,
    { type: "tenant", id: null },
    "AZ-D Runner",
  );

  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );

  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Alur D', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name, stationId, stationType] of [
      [ids.kopi, "Kopi Susu", ids.bar, "beverage_bar"],
      [ids.nasi, "Nasi Goreng", ids.kitchen, "hot_kitchen"],
      [ids.air, "Air Mineral", null, null],
    ] as const)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_id, station_type)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)`,
        [
          id,
          tenant.tenantId,
          tenant.brandId,
          ids.category,
          name,
          randomUUID(),
          stationId,
          stationType,
        ],
      );
    for (const [listId, channel] of [
      [ids.priceListPos, "takeaway"],
      [ids.priceListQr, "dine_in"],
    ] as const) {
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, $4, '2026-01-01')`,
        [listId, tenant.tenantId, tenant.outletId, channel],
      );
      for (const id of [ids.kopi, ids.nasi, ids.air])
        await client.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
           VALUES ($1, $2, $3, $4, 20000)`,
          [randomUUID(), tenant.tenantId, listId, id],
        );
    }
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-AZD', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
  });
}

afterAll(async () => {
  setPosReceiptPort(null);
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  if (setupPromise) {
    // Riwayat KDS append-only: tenant uji tetap di database sekali pakai.
    // Beri pembuat valid agar daftar tenant platform tetap terbaca.
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenant.tenantId,
      randomUUID(),
    ]);
  }
  await owner.end();
});

// ---- POS ----------------------------------------------------------------------------

type Line = { menuItemId: string; quantity?: number; note?: string };
type PlacedLine = { id: string; menuItemId: string; fireStatus: string };
type Placed = { orderId: string; status: string; lines: PlacedLine[] };

function posOf(who: Member = cashier) {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: (lines: Line[], extra: Record<string, unknown> = {}) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: lines.map((line) => ({
          menuItemId: line.menuItemId,
          quantity: line.quantity ?? 1,
          modifierIds: [],
          ...(line.note ? { note: line.note } : {}),
        })),
        ...extra,
      }),
    get: (orderId: string) =>
      who.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    events: (orderId: string) =>
      who.client
        .get(`${base}/${orderId}/events?limit=50`)
        .set(headers)
        .set(originHeader),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    fire: (orderId: string, itemIds: string[], expectedStatus: string) =>
      send(`/${orderId}/fire`, { itemIds, expectedStatus }),
    voidItem: (
      orderId: string,
      itemId: string,
      body: Record<string, unknown>,
    ) => send(`/${orderId}/items/${itemId}/void`, body),
    voidOrder: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/void`, body),
  };
}

function linesOf(body: { items: PlacedLine[] }): PlacedLine[] {
  return body.items.map((item) => ({
    id: item.id,
    menuItemId: item.menuItemId,
    fireStatus: item.fireStatus,
  }));
}

/** Kasir membuat pesanan, men-submit, dan memastikan baris non-tahan sudah di-fire. */
async function placeOrder(
  lines: Line[],
  options: { hold?: boolean } = {},
): Promise<Placed> {
  const pos = posOf();
  const created = await pos.create(
    lines,
    options.hold ? { holdItems: true } : {},
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await pos.submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  let current = await pos.get(orderId);
  let placed = linesOf(current.body.data);
  if (!options.hold) {
    const held = placed.filter((line) => line.fireStatus === "held");
    if (held.length > 0) {
      const fired = await pos.fire(
        orderId,
        held.map((line) => line.id),
        status,
      );
      expect(fired.status, JSON.stringify(fired.body)).toBe(200);
      current = await pos.get(orderId);
      placed = linesOf(current.body.data);
    }
  }
  return { orderId, status: current.body.data.status as string, lines: placed };
}

const lineOf = (placed: Placed, menuItemId: string): PlacedLine => {
  const line = placed.lines.find(
    (candidate) => candidate.menuItemId === menuItemId,
  );
  if (!line) throw new Error(`Tidak ada baris untuk ${menuItemId}`);
  return line;
};

/** Persetujuan PIN supervisor sekali pakai untuk void baris/pesanan. */
async function approval(
  orderId: string,
  valueIdr: number,
  object: { objectType: "order" | "order_item"; objectId: string } = {
    objectType: "order",
    objectId: orderId,
  },
) {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    {
      outletId: tenant.outletId,
      action: "void",
      valueIdr,
      reason: "Pelanggan salah pesan",
      objectType: object.objectType,
      objectId: object.objectId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: supervisor.userId, overrideId: override.id };
}

async function posVoidLine(placed: Placed, menuItemId: string) {
  const itemId = lineOf(placed, menuItemId).id;
  return posOf().voidItem(placed.orderId, itemId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan batal",
    ...(await approval(placed.orderId, 200_000, {
      objectType: "order_item",
      objectId: itemId,
    })),
  });
}

// ---- KDS ----------------------------------------------------------------------------

type Ticket = {
  id: string;
  orderId: string;
  stationId: string;
  status: string;
  startedAt: string | null;
  doneAt: string | null;
  servedAt: string | null;
  printedFallback: boolean;
  items: {
    id: string;
    orderItemId: string;
    name: string;
    quantity: number;
    note: string | null;
    status: string;
    readyAt: string | null;
    servedAt: string | null;
  }[];
};

function kdsOf(who: Member = cook, outletId: string = tenant.outletId) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}`;
  const get = (path: string) =>
    who.client.get(`${base}${path}`).set(headers).set(originHeader);
  const post = (path: string, body: Record<string, unknown> = {}) =>
    who.client.post(`${base}${path}`).set(headers).set(originHeader).send(body);
  return {
    snapshot: (stationId: string) =>
      get(`/kitchen/stations/${stationId}/tickets`),
    feed: (stationId: string, after: number) =>
      get(`/kitchen/stations/${stationId}/feed?after=${after}`),
    ticket: (ticketId: string) => get(`/kitchen/tickets/${ticketId}`),
    start: (ticketId: string) => post(`/kitchen/tickets/${ticketId}/start`),
    bump: (ticketId: string) => post(`/kitchen/tickets/${ticketId}/bump`),
    recall: (ticketId: string, reason: string) =>
      post(`/kitchen/tickets/${ticketId}/recall`, { reason }),
    voidTicket: (ticketId: string, reason: string) =>
      post(`/kitchen/tickets/${ticketId}/void`, { reason }),
    item: (itemId: string, action: string) =>
      post(`/kitchen/ticket-items/${itemId}/status`, { action }),
    expo: () => get(`/expo`),
    expoRunners: () => get(`/expo/runners`),
    assignRunner: (orderId: string, runnerId: string) =>
      post(`/expo/${orderId}/runner`, { runnerId }),
    pacing: () => get(`/kitchen/pacing`),
    estimate: (channel: string) =>
      get(`/serving-time-estimate?channel=${channel}&loadPoints=0`),
    setCapacity: (stationId: string, rules: unknown[]) =>
      who.client
        .put(`${base}/kitchen/stations/${stationId}/capacity-rules`)
        .set(headers)
        .set(originHeader)
        .send({ rules }),
    reportIssue: (orderId: string, body: Record<string, unknown>) =>
      post(`/orders/${orderId}/issues`, body),
    issues: () => get(`/order-issues`),
  };
}

/** Layar sebuah stasiun: semua tiket terbuka + kursor feed. */
async function board(stationId: string, who: Member = cook) {
  const response = await kdsOf(who).snapshot(stationId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as { sequence: number; tickets: Ticket[] };
}

async function ticketOf(stationId: string, orderId: string): Promise<Ticket> {
  const found = (await board(stationId)).tickets.find(
    (t) => t.orderId === orderId,
  );
  if (!found)
    throw new Error(`Tiket ${orderId} tidak tampil di stasiun ${stationId}`);
  return found;
}

async function ticketDetail(ticketId: string): Promise<Ticket> {
  const response = await kdsOf().ticket(ticketId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as Ticket;
}

async function feed(stationId: string, after: number) {
  const response = await kdsOf().feed(stationId, after);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as {
    afterSequence: number;
    toSequence: number;
    hasMore: boolean;
    entries: { sequence: number; ticket: Ticket }[];
  };
}

type ChangeRow = {
  from_status: string | null;
  to_status: string;
  order_item_id: string | null;
  source: string;
  actor_id: string | null;
  reason: string | null;
  occurred_at: Date | null;
};

async function changesOf(ticketId: string): Promise<ChangeRow[]> {
  return asOwnerTenant(async (client) => {
    const result = await client.query<ChangeRow>(
      `SELECT from_status, to_status, order_item_id::text AS order_item_id,
              source, actor_id::text AS actor_id, reason, occurred_at
       FROM kitchen_ticket_status_changes
       WHERE ticket_id = $1::uuid ORDER BY occurred_at, id`,
      [ulidToUuid(ticketId)],
    );
    return result.rows;
  });
}

// ---- QR di meja (untuk ORD-02 dan expo per meja) ----------------------------------

type Guest = { token: string; sessionId: string };

function contextOf(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function newTable(paymentMode: "pay_first" | "open_bill") {
  const zone = await createZone(
    floorStaff.client,
    { paymentMode, serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(
    floorStaff.client,
    { zoneId: zone.id },
    headers,
  );
  const qr = await issueQr(floorStaff.client, table.id, headers);
  return { table, qrToken: qr.token as string };
}

async function seat(qrToken: string): Promise<Guest> {
  const response = await scan(app, {
    token: qrToken,
    hostname: tenant.hostname,
  });
  expect(response.status).toBe(201);
  return {
    token: response.body.data.sessionToken,
    sessionId: response.body.data.session.id,
  };
}

function asGuest(guest: Guest) {
  const client = agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader);
  const base = `/api/table-sessions/${guest.sessionId}`;
  return {
    add: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        ...body,
      }),
    checkout: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/orders`)).send(body),
    pay: (orderId: string) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "order", orderId },
        method: "qris",
        idempotencyKey: randomUUID(),
      }),
    payment: (paymentId: string) =>
      auth(client.get(`${base}/payments/${paymentId}`)),
  };
}

/** Tamu memesan Kopi Susu + Nasi Goreng + Air Mineral; mengembalikan versi keranjang. */
async function fillCart(guest: Guest): Promise<number> {
  let version = 0;
  for (const menuItemId of [ids.kopi, ids.nasi, ids.air]) {
    const added = await asGuest(guest).add({
      menuItemId,
      quantity: 1,
      expectedCartVersion: version,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    version = added.body.data.cart.version as number;
  }
  return version;
}

/** Webhook gateway terverifikasi: WS-05 menyelesaikan intent, konsumer menembak pesanan. */
async function payVerified(intentId: string, amountIdr: number) {
  await confirmPayment(contextOf(), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2
     ORDER BY created_at, id`,
    [tenant.tenantId, intentId],
  );
  const event = eventEnvelopeSchema.parse(rows[0]?.event);
  const context = contextOf();
  await withTenant(db, context, (tx) =>
    deliverQrOrderPaymentEvent(context, event, event.id, tx),
  );
}

/** Pesanan QR meja (open bill) yang sudah diteruskan ke dapur; kembalikan id + meja. */
async function qrOpenBillOrder() {
  const { table, qrToken } = await newTable("open_bill");
  const guest = await seat(qrToken);
  const version = await fillCart(guest);
  const confirmed = await floorStaff.client
    .post(`/api/table-sessions/${guest.sessionId}/confirm`)
    .set(headers)
    .set(originHeader);
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  const placed = await asGuest(guest).checkout({
    expectedCartVersion: version,
    idempotencyKey: randomUUID(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  return { orderId: placed.body.data.order.id as string, table };
}

// =====================================================================================
// Alur D langkah 1-2: pecah per stasiun, mulai, selesai
// =====================================================================================

describe("Alur D langkah 1-2: pesanan dipecah per stasiun, barista/cook mulai lalu selesai (KDS-01, KDS-04)", () => {
  beforeAll(ensureSetup);

  it("KDS-01 kasir kirim kopi + nasi + air: tiap stasiun hanya melihat itemnya, item tanpa stasiun tidak punya tiket", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.kopi, quantity: 2, note: "Less sugar" },
      { menuItemId: ids.nasi },
      { menuItemId: ids.air },
    ]);

    const bar = await ticketOf(ids.bar, placed.orderId);
    expect(bar.status).toBe("new");
    expect(bar.items).toHaveLength(1);
    expect(bar.items[0]).toMatchObject({
      name: "Kopi Susu",
      quantity: 2,
      note: "Less sugar", // catatan tampil menonjol di tiket
      status: "queued",
    });

    const kitchen = await ticketOf(ids.kitchen, placed.orderId);
    expect(kitchen.items.map((item) => item.name)).toEqual(["Nasi Goreng"]);

    // Layar bar tidak memuat tiket dapur, dan sebaliknya.
    const barBoard = await board(ids.bar);
    const kitchenBoard = await board(ids.kitchen);
    expect(barBoard.tickets.map((t) => t.id)).not.toContain(kitchen.id);
    expect(kitchenBoard.tickets.map((t) => t.id)).not.toContain(bar.id);
    // Air Mineral tidak muncul di layar mana pun.
    for (const t of [...barBoard.tickets, ...kitchenBoard.tickets])
      expect(t.items.map((item) => item.name)).not.toContain("Air Mineral");
  });

  it("KDS-01 API papan stasiun memuat tiket item yang benar paling lambat 2 detik setelah diteruskan (waktu API, bukan render layar)", async () => {
    const placed = await placeOrder([{ menuItemId: ids.kopi }], {
      hold: true,
    });
    const before = await board(ids.bar);
    // Jam mulai saat fire ("setelah diteruskan"), bukan saat pesanan dibuat.
    const started = performance.now();
    const fired = await posOf().fire(
      placed.orderId,
      placed.lines.map((line) => line.id),
      placed.status,
    );
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    const after = await board(ids.bar);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(after.tickets.map((t) => t.orderId)).toContain(placed.orderId);
    expect(after.sequence).toBeGreaterThan(before.sequence);
  });

  it("KDS-04 barista menekan mulai lalu selesai: status per item berubah dan tiap perubahan tercatat dengan waktu dan pengguna", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi, quantity: 3 }]);
    const ticket = await ticketOf(ids.kitchen, placed.orderId);

    const started = await kdsOf(cook).start(ticket.id);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.data.status).toBe("in_progress");
    expect(started.body.data.startedAt).not.toBeNull();
    expect(
      started.body.data.items.every(
        (i: { status: string }) => i.status === "in_progress",
      ),
    ).toBe(true);

    const bumped = await kdsOf(cook).bump(ticket.id);
    expect(bumped.status, JSON.stringify(bumped.body)).toBe(200);
    expect(bumped.body.data.status).toBe("done");
    expect(bumped.body.data.doneAt).not.toBeNull();
    expect(
      bumped.body.data.items.every(
        (i: { status: string; readyAt: string | null }) =>
          i.status === "ready" && i.readyAt !== null,
      ),
    ).toBe(true);

    const log = (await changesOf(ticket.id)).filter(
      (row) => row.order_item_id === null,
    );
    expect(log.map((row) => [row.from_status, row.to_status])).toEqual([
      [null, "new"],
      ["new", "in_progress"],
      ["in_progress", "done"],
    ]);
    for (const row of log) {
      expect(row.occurred_at).toBeInstanceOf(Date);
      expect(row.actor_id).not.toBeNull();
    }
    expect(log[0]?.actor_id).toBe(cashier.userId); // kasir meneruskan
    expect(log[1]?.actor_id).toBe(cook.userId); // koki mulai
    expect(log[2]?.actor_id).toBe(cook.userId); // koki selesai
  });

  it("KDS-04 tombol selesai sebelum mulai ditolak 409 dan tiket tetap baru", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi }]);
    const ticket = await ticketOf(ids.kitchen, placed.orderId);
    const bump = await kdsOf(cook).bump(ticket.id);
    expect(bump.status).toBe(409);
    expect((await ticketDetail(ticket.id)).status).toBe("new");
  });

  it("KDS-04 tiket yang sudah selesai bisa dipanggil ulang dengan alasan, dan alasan wajib diisi", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi }]);
    const ticket = await ticketOf(ids.kitchen, placed.orderId);
    expect((await kdsOf(cook).start(ticket.id)).status).toBe(200);
    expect((await kdsOf(cook).bump(ticket.id)).status).toBe(200);

    const noReason = await kdsOf(cook).recall(ticket.id, "");
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe("VALIDATION_ERROR");
    expect((await ticketDetail(ticket.id)).status).toBe("done");

    const recalled = await kdsOf(cook).recall(ticket.id, "Salah meja");
    expect(recalled.status, JSON.stringify(recalled.body)).toBe(200);
    expect(recalled.body.data.status).toBe("recalled");
    const log = await changesOf(ticket.id);
    expect(log.find((row) => row.to_status === "recalled")?.reason).toBe(
      "Salah meja",
    );
  });

  it("TEN-03 barista yang ditugaskan di Bar Kopi hanya bisa membuka stasiunnya sendiri", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.kopi },
      { menuItemId: ids.nasi },
    ]);
    const own = await kdsOf(barista).snapshot(ids.bar);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data.tickets.map((t: Ticket) => t.orderId)).toContain(
      placed.orderId,
    );
    // PRD baris 573: barista/cook hanya KDS stasiun yang ditugaskan.
    expect((await kdsOf(barista).snapshot(ids.kitchen)).status).toBe(403);
    const kitchenTicket = await ticketOf(ids.kitchen, placed.orderId);
    expect((await kdsOf(barista).start(kitchenTicket.id)).status).toBe(403);
    expect((await ticketDetail(kitchenTicket.id)).status).toBe("new");
  });
});

// =====================================================================================
// Alur D, void: item dibatalkan setelah diteruskan (KDS-03) dan void KDS tampil di POS
// =====================================================================================

describe("Alur D void: item dibatalkan setelah diteruskan (KDS-03, KDS-04)", () => {
  beforeAll(ensureSetup);

  it("KDS-03 kasir void satu baris setelah diteruskan: item ditandai batal di layar stasiun segera, tiket tetap selama baris lain hidup", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.kopi },
      { menuItemId: ids.kopi, note: "Es banyak" },
    ]);
    const ticket = await ticketOf(ids.bar, placed.orderId);
    const cursor = (await board(ids.bar)).sequence;

    const voided = await posVoidLine(placed, ids.kopi);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);

    const after = await ticketDetail(ticket.id);
    expect(after.status).toBe("new"); // baris lain masih hidup
    expect(after.items.filter((item) => item.status === "voided")).toHaveLength(
      1,
    );
    expect(after.items.filter((item) => item.status === "queued")).toHaveLength(
      1,
    );
    // Perubahan sampai ke layar lewat feed, tanpa muat ulang manual.
    const changes = await feed(ids.bar, cursor);
    expect(changes.entries.map((entry) => entry.ticket.id)).toContain(
      ticket.id,
    );
    const log = await changesOf(ticket.id);
    expect(log.some((row) => row.order_item_id !== null)).toBe(true);
  });

  it("KDS-03 kasir void seluruh pesanan: semua tiketnya dibatalkan, termasuk yang sudah dimulai, dan tidak bisa dimulai lagi", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.kopi },
      { menuItemId: ids.nasi },
    ]);
    const bar = await ticketOf(ids.bar, placed.orderId);
    const kitchen = await ticketOf(ids.kitchen, placed.orderId);
    expect((await kdsOf(cook).start(kitchen.id)).status).toBe(200);

    const current = await posOf().get(placed.orderId);
    const voided = await posOf().voidOrder(placed.orderId, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      expectedStatus: current.body.data.status,
      ...(await approval(placed.orderId, 200_000)),
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);

    expect((await ticketDetail(bar.id)).status).toBe("cancelled");
    expect((await ticketDetail(kitchen.id)).status).toBe("cancelled");
    expect((await kdsOf(cook).start(kitchen.id)).status).toBe(409);
  });

  it("KDS-03 cook membatalkan tiket di KDS dengan alasan: kasir melihatnya di POS, tagihan tidak berubah", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.kopi },
      { menuItemId: ids.nasi },
    ]);
    const before = await posOf().get(placed.orderId);
    const ticket = await ticketOf(ids.bar, placed.orderId);

    const noReason = await kdsOf(cook).voidTicket(ticket.id, "");
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe("VALIDATION_ERROR");

    const voided = await kdsOf(cook).voidTicket(ticket.id, "Susu habis");
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.status).toBe("cancelled");

    // Void di KDS hanya urusan dapur: tagihan tidak berubah sampai ada void di POS.
    const after = await posOf().get(placed.orderId);
    expect(after.body.data.totalIdr).toBe(before.body.data.totalIdr);

    // Kasir melihat pemberitahuannya (event pesanan) lengkap dengan siapa dan alasannya.
    const events = await posOf().events(placed.orderId);
    expect(events.status, JSON.stringify(events.body)).toBe(200);
    const notices = (
      events.body.data as {
        type: string;
        actorId: string | null;
        payload: Record<string, unknown>;
      }[]
    ).filter((event) => event.type === "order.kitchen_voided");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.actorId).toBe(cook.userId);
    expect(notices[0]?.payload).toMatchObject({
      ticketId: ticket.id,
      stationId: ids.bar,
      ticketCancelled: true,
      reason: "Susu habis",
    });
  });
});

// =====================================================================================
// KDS-02: perangkat KDS terputus lalu tersambung kembali
// =====================================================================================

describe("Alur D: perangkat KDS terputus lalu tersambung kembali (KDS-02)", () => {
  beforeAll(ensureSetup);

  it("KDS-02 tablet bar terputus saat dua pesanan masuk: setelah tersambung tiap tiket muncul tepat satu kali, tanpa celah", async () => {
    const first = await placeOrder([{ menuItemId: ids.kopi }]);
    const snapshot = await board(ids.bar); // tablet memuat layar, menyimpan kursor
    expect(snapshot.tickets.map((t) => t.orderId)).toContain(first.orderId);

    // Tablet putus. Dua pesanan masuk dan satu tiket lama sudah dimulai.
    const second = await placeOrder([{ menuItemId: ids.kopi }]);
    const third = await placeOrder([{ menuItemId: ids.kopi, quantity: 2 }]);
    const firstTicket = await ticketOf(ids.bar, first.orderId);
    expect((await kdsOf(cook).start(firstTicket.id)).status).toBe(200);

    // Tablet tersambung kembali dan meminta semua perubahan setelah kursornya.
    const changes = await feed(ids.bar, snapshot.sequence);
    const orderIds = changes.entries.map((entry) => entry.ticket.orderId);
    expect(orderIds.filter((id) => id === second.orderId)).toHaveLength(1);
    expect(orderIds.filter((id) => id === third.orderId)).toHaveLength(1);
    expect(orderIds.filter((id) => id === first.orderId)).toHaveLength(1);
    const sequences = changes.entries.map((entry) => entry.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);

    // Layar lama + perubahan = layar baru: tidak ada yang hilang atau ganda.
    const merged = new Map(snapshot.tickets.map((t) => [t.id, t]));
    for (const entry of changes.entries)
      merged.set(entry.ticket.id, entry.ticket);
    const fresh = await board(ids.bar);
    expect([...merged.keys()].sort()).toEqual(
      fresh.tickets.map((t) => t.id).sort(),
    );
    expect(changes.toSequence).toBe(fresh.sequence);

    // Sambung lagi dari kursor terbaru: tidak ada yang diputar ulang.
    expect((await feed(ids.bar, changes.toSequence)).entries).toEqual([]);
  });

  it("KDS-02 kursor yang tidak masuk akal (melebihi stasiun) diminta memuat ulang layar dengan 409 KDS_RESYNC_REQUIRED", async () => {
    const { sequence } = await board(ids.bar);
    const response = await kdsOf(cook).feed(ids.bar, sequence + 1_000);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("KDS_RESYNC_REQUIRED");
  });
});

// =====================================================================================
// ORD-02: bayar di muka, tidak ada item ke KDS sebelum webhook terverifikasi
// =====================================================================================

describe("Alur A/D: pesanan QR bayar di muka sampai ke dapur hanya setelah pembayaran terverifikasi (ORD-02, KDS-01)", () => {
  beforeAll(ensureSetup);

  it("ORD-02 tamu memesan dan membuat pembayaran QRIS: dapur tidak melihat apa pun sampai webhook terverifikasi, lalu tiket muncul satu kali per stasiun", async () => {
    const { qrToken } = await newTable("pay_first");
    const guest = await seat(qrToken);
    const version = await fillCart(guest);
    const placed = await asGuest(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const orderId = placed.body.data.order.id as string;

    const noneYet = async () => {
      for (const stationId of [ids.bar, ids.kitchen])
        expect(
          (await board(stationId)).tickets.map((t) => t.orderId),
        ).not.toContain(orderId);
    };
    await noneYet(); // pesanan dibuat tetapi belum dibayar

    const paid = await asGuest(guest).pay(orderId);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const intentId = paid.body.data.id as string;
    await noneYet(); // intent QRIS dibuat tetapi belum ada konfirmasi gateway

    // Tamu memeriksa status: masih menunggu. Pemeriksaan itu sendiri tidak menembak dapur.
    const status = await asGuest(guest).payment(intentId);
    expect(status.status).toBe(200);
    await noneYet();

    await payVerified(intentId, paid.body.data.amountIdr as number);

    const bar = await ticketOf(ids.bar, orderId);
    const kitchen = await ticketOf(ids.kitchen, orderId);
    expect(bar.items.map((i) => i.name)).toEqual(["Kopi Susu"]);
    expect(kitchen.items.map((i) => i.name)).toEqual(["Nasi Goreng"]);
    const count = (await board(ids.bar)).tickets.filter(
      (t) => t.orderId === orderId,
    );
    expect(count).toHaveLength(1);
  });
});

// =====================================================================================
// Alur D langkah 3-4: expo, runner, diantar
// =====================================================================================

describeUntilBuilt(
  "legend-5rzy",
  "Alur D langkah 3-4: expo menandai meja lengkap, runner mengantar (F12 Expo, KDS-03, KDS-04)",
  () => {
    beforeAll(ensureSetup);

    it("KDS-04 expo menggabungkan item semua stasiun per meja, menandai lengkap saat semua stasiun selesai, menugaskan runner, dan runner menandai diantar", async () => {
      const { orderId, table } = await qrOpenBillOrder();
      const expoTicket = async () => {
        const response = await kdsOf(cook).expo();
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return (
          response.body.data.tickets as {
            orderId: string;
            tableLabel: string | null;
            isComplete: boolean;
            readyAt: string | null;
            runnerId: string | null;
            stations: { stationName: string; status: string }[];
          }[]
        ).find((t) => t.orderId === orderId);
      };

      // Expo melihat pesanan meja ini dengan dua stasiun, belum lengkap.
      let onExpo = await expoTicket();
      expect(onExpo?.tableLabel).toBe(table.code); // asumsi 5
      expect(onExpo?.stations).toHaveLength(2);
      expect(onExpo?.isComplete).toBe(false);

      // Bar selesai, dapur belum: tetap belum lengkap.
      const bar = await ticketOf(ids.bar, orderId);
      const kitchen = await ticketOf(ids.kitchen, orderId);
      expect((await kdsOf(cook).start(bar.id)).status).toBe(200);
      expect((await kdsOf(cook).bump(bar.id)).status).toBe(200);
      expect((await expoTicket())?.isComplete).toBe(false);

      // Dapur ikut selesai: meja ditandai lengkap dengan waktu siap.
      expect((await kdsOf(cook).start(kitchen.id)).status).toBe(200);
      expect((await kdsOf(cook).bump(kitchen.id)).status).toBe(200);
      onExpo = await expoTicket();
      expect(onExpo?.isComplete).toBe(true);
      expect(onExpo?.readyAt).not.toBeNull();

      // Expo memilih runner dari daftar staf dan menugaskannya.
      const runners = await kdsOf(cook).expoRunners();
      expect(runners.status, JSON.stringify(runners.body)).toBe(200);
      expect(
        (runners.body.data as { userId: string }[]).map((r) => r.userId),
      ).toContain(runner.userId);
      const assigned = await kdsOf(cook).assignRunner(orderId, runner.userId);
      expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
      expect(assigned.body.data.runnerId).toBe(runner.userId);
      expect((await expoTicket())?.runnerId).toBe(runner.userId);

      // Runner mengantar dan menandai diantar dari ponselnya.
      const readyBar = await ticketDetail(bar.id);
      const readyKitchen = await ticketDetail(kitchen.id);
      for (const item of [...readyBar.items, ...readyKitchen.items]) {
        const served = await kdsOf(runner).item(item.id, "serve");
        expect(served.status, JSON.stringify(served.body)).toBe(200);
        expect(served.body.data.status).toBe("served");
        expect(served.body.data.servedAt).not.toBeNull();
      }
      expect((await ticketDetail(bar.id)).servedAt).not.toBeNull();
      expect((await ticketDetail(kitchen.id)).servedAt).not.toBeNull();
    });

    it("KDS-03 item yang dibatalkan setelah diteruskan juga ditandai batal di layar expo", async () => {
      const { orderId } = await qrOpenBillOrder();
      const bar = await ticketOf(ids.bar, orderId);
      expect((await kdsOf(cook).voidTicket(bar.id, "Susu habis")).status).toBe(
        200,
      );
      const response = await kdsOf(cook).expo();
      const onExpo = (
        response.body.data.tickets as {
          orderId: string;
          stations: { ticketId: string; status: string }[];
        }[]
      ).find((t) => t.orderId === orderId);
      expect(onExpo?.stations.find((s) => s.ticketId === bar.id)?.status).toBe(
        "cancelled",
      );
    });

    it("runner yang bukan staf outlet ini ditolak saat ditugaskan", async () => {
      const { orderId } = await qrOpenBillOrder();
      const stranger = randomUUID();
      const response = await kdsOf(cook).assignRunner(orderId, stranger);
      expect([400, 404, 409, 422]).toContain(response.status);
    });
  },
);

// =====================================================================================
// KDS-07 remake dan comp; KDS-05 pacing
// =====================================================================================

describeUntilBuilt(
  "legend-5rzy",
  "Alur D: remake dan comp (KDS-07) serta kapasitas stasiun (KDS-05)",
  () => {
    beforeAll(ensureSetup);

    it("KDS-07 remake karena kualitas dicatat dengan alasan baku, stasiun, karyawan, pelapor, dan biaya bahan", async () => {
      const placed = await placeOrder([{ menuItemId: ids.kopi }]);
      const orderItemId = lineOf(placed, ids.kopi).id;
      const reported = await kdsOf(cook).reportIssue(placed.orderId, {
        orderItemId,
        type: "remake",
        reason: "quality",
        reasonNote: "Kopi terlalu pahit, dibuat ulang",
        stationId: ids.bar,
        employeeId: barista.userId,
        resolution: "swap",
        voucherId: null,
        approvedBy: null,
      });
      expect(reported.status, JSON.stringify(reported.body)).toBe(201);
      expect(reported.body.data).toMatchObject({
        orderId: placed.orderId,
        orderItemId,
        type: "remake",
        reason: "quality",
        stationId: ids.bar,
        employeeId: barista.userId,
        reportedBy: cook.userId,
      });
      // Biaya bahan dihitung server dari resep, bukan dari klien. Fixture ini
      // belum punya resep, jadi hanya bentuknya yang bisa dipastikan: rupiah
      // bulat >= 0.
      expect(Number.isInteger(reported.body.data.costIdr)).toBe(true);
      expect(reported.body.data.costIdr).toBeGreaterThanOrEqual(0);

      const log = await kdsOf(cook).issues();
      expect(log.status, JSON.stringify(log.body)).toBe(200);
      expect(
        (log.body.data as { orderItemId: string }[]).map(
          (issue) => issue.orderItemId,
        ),
      ).toContain(orderItemId);
    });

    it("KDS-07 remake tanpa karyawan penanggung jawab ditolak", async () => {
      const placed = await placeOrder([{ menuItemId: ids.kopi }]);
      // Muatan sama dengan remake valid di atas; hanya employeeId yang diubah.
      const valid = {
        orderItemId: lineOf(placed, ids.kopi).id,
        type: "remake",
        reason: "quality",
        reasonNote: "Kopi terlalu pahit, dibuat ulang",
        stationId: ids.bar,
        employeeId: barista.userId,
        resolution: "swap",
        voucherId: null,
        approvedBy: null,
      };
      const response = await kdsOf(cook).reportIssue(placed.orderId, {
        ...valid,
        employeeId: null,
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.details).toContainEqual(
        expect.objectContaining({ field: "employeeId" }),
      );
    });

    it("KDS-05 saat kapasitas bar penuh, status kapasitas berubah dan estimasi waktu saji tidak turun", async () => {
      const all = {
        windowMinutes: 15,
        capacityPoints: 2,
        nearCapacityBp: 5_000,
        schedule: ALL_DAY,
        channelPriority: ["dine_in", "takeaway"],
      };
      const set = await kdsOf(cook).setCapacity(ids.bar, [all]);
      expect(set.status, JSON.stringify(set.body)).toBe(200);

      const before = await kdsOf(cook).estimate("dine_in");
      expect(before.status, JSON.stringify(before.body)).toBe(200);

      for (let i = 0; i < 3; i += 1)
        await placeOrder([{ menuItemId: ids.kopi }]);

      const pacing = await kdsOf(cook).pacing();
      expect(pacing.status, JSON.stringify(pacing.body)).toBe(200);
      const bar = (
        pacing.body.data.stations as { stationId: string; status: string }[]
      ).find((s) => s.stationId === ids.bar);
      expect(bar?.status).toBe("at_capacity");
      const after = await kdsOf(cook).estimate("dine_in");
      // Kapasitas penuh harus benar-benar menambah estimasi, bukan sekadar sama.
      expect(after.body.data.estimatedMinutes).toBeGreaterThan(
        before.body.data.estimatedMinutes,
      );
      // PRD KDS-05 juga menyebut menu yang dijeda tidak bisa dipesan dari kanal
      // terkait; jeda otomatis belum punya endpoint baca di kontrak, jadi belum
      // diuji di sini.
    });

    it.skip("[PENDING-DECISION load-test] KDS-06 median estimasi waktu saji berselisih <= 3 menit dari aktual pada uji beban (bukan bagian alur A-Z; butuh uji beban terpisah)", () => {});
  },
);

// =====================================================================================
// Alur D langkah 5: KDS mati -> cetak
// =====================================================================================

/**
 * PRD tidak mendefinisikan kontrak untuk "tablet KDS tidak merespons" (tidak ada
 * endpoint di m1 maupun ws/kds). Isi saat cabangnya ada: hentikan heartbeat
 * perangkat KDS stasiun `stationId` melewati batas deteksi (EDG-05, <= 30 dtk).
 */
async function simulateKdsStationOffline(stationId: string): Promise<void> {
  throw new Error(
    `simulateKdsStationOffline(${stationId}) belum punya kontrak; isi bersama cabang fallback cetak`,
  );
}

describeUntilBuilt(
  "legend-2lp.3",
  "Alur D langkah 5: tablet KDS bermasalah, tiket dicetak otomatis dan supervisor diberi tahu (EDG-05)",
  () => {
    beforeAll(ensureSetup);

    itUntilBuilt(
      "legend-2lp.3",
      "KDS mati: tiket pesanan baru ditandai dicetak di printer stasiun dan supervisor menerima notifikasi",
      async () => {
        await simulateKdsStationOffline(ids.bar);
        const placed = await placeOrder([{ menuItemId: ids.kopi }]);
        const ticket = await ticketOf(ids.bar, placed.orderId);
        expect(ticket.printedFallback).toBe(true);

        const inbox = await supervisor.client
          .get("/api/notifications")
          .set(headers)
          .set(originHeader);
        expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
        // Bentuk notifikasi belum dikontrakkan; cukup pastikan menyebut stasiun.
        expect(JSON.stringify(inbox.body).toLowerCase()).toContain("bar kopi");
      },
    );
  },
);
