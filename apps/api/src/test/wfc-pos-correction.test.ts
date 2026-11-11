// legend-tz4dg (bz9h round 4, D11): a POS void or refund must not take back the
// money of a WFC sale that is still live. Written from the round-4 spec
// (scratchpad bz9h-spec4.md, D11), never from the implementation.
//
// Rule under test (jangan sampai rugi: the guest cannot keep a live pass, seat
// or bundle AND get the POS payment back):
//   A POS void (`voidPosOrderCorrection`) or refund (`refundPosOrder`) of an
//   order whose tender funded a WFC sale (a row in `wfc_payment_captures` for
//   that order) is refused with 409 WFC_SALE_ACTIVE
//   ("Penjualan WFC dari pembayaran ini masih aktif; batalkan dulu.") while the
//   sale is active. Active = seat reservation confirmed / checked_in /
//   completed / no_show, day pass not refunded, bundle purchase not refunded.
//   Nothing is recorded (no void or refund row; the order stays completed).
//   After the WFC sale is fully refunded or cancelled, the POS correction works.
//
// Assumptions (the spec leaves them open):
// - The corrections are driven through the POS HTTP routes
//   (`/corrections/void` and `/corrections/refund`), which call the two
//   services; the error is read as `body.error.code`.
// - Each WFC kind (day pass, seat reservation, bundle) is sold at the POS as its
//   own menu item (a product/bundle `menu_item_id`), bought with quantity 1,
//   paid in cash with an open shift, then the WFC service is called with the
//   tender id as `paymentRef`.
// - ANY POS refund amount is blocked while the sale is live (also a partial
//   one): the check is "is there a live WFC sale on this order", not an amount.
// - A partially refunded day pass is still active (status stays 'paid'); the
//   remainder is refundable (D5), after which the POS correction works.
// - (round 4b F2) A confirmed reservation leaves the active set ONLY by a WFC
//   refund: a cancelled reservation still holds its paid money until it is
//   refunded, so the POS correction stays 409 after the cancel.
// - (round 4b F1) A bundle purchase is active unless status 'refunded' AND
//   refunded_idr >= price_paid_idr: a partial WFC refund of the unused value
//   (the used value stays with the guest) keeps it active for the POS.
// - An order that never funded a WFC sale, and other orders of the tenant, are
//   unaffected (regression / scoping).
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import {
  createWfcBundle,
  purchaseWfcBundle,
  refundWfcBundle,
} from "../services/wfc-bundle.service.ts";
import {
  cancelWfcReservation,
  confirmWfcReservationPaid,
  createWfcSeat,
  purchaseDayPass,
  refundDayPass,
  refundWfcReservation,
  reserveWfcSeat,
} from "../services/wfc-seat.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  NOW,
  asTenant,
  contextOf,
  owner as loyaltyOwner,
  seedProfile,
  short,
  type World,
} from "./member-loyalty-helpers.ts";
import {
  entitlementsOf,
  inHours,
  seedFacility,
} from "./facility-entitlement-helpers.ts";

const PIN = "582914";
const TEST_TIMEOUT = 60_000;
/** Every POS menu item costs this: at or above every WFC price below. */
const MENU_PRICE_IDR = 60_000;
const WFC_PRICE_IDR = 40_000;
/** Bundle components: 15.000 + 50.000 = 65.000 list; 40.000 is above the 50% floor. */
const SHOWER_PRICE_IDR = 15_000;
const DAY_PASS_COMPONENT_PRICE_IDR = 50_000;
const SEAT_DURATION_MINUTES = 120;

const ids = {
  category: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  device: randomUUID(),
  /** One POS menu item per sold thing, so a line funds exactly one kind. */
  plain: randomUUID(),
  dayPass: randomUUID(),
  seat: randomUUID(),
  bundle: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;
let wfcActor: string;
let coworkingFacility: string;
let zoneId: string;
let dayPassProduct: string;
let seatProduct: string;
let bundleId: string;
let showerFacilityId: string;
let showerBundleItemId: string;

// ---- Receipt numbering double (the real allocator is another module) ---------------

function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  const next = new Map<string, number>();
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      const sequenceNumber = (next.get(input.outletId) ?? 0) + 1;
      next.set(input.outletId, sequenceNumber);
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? ids.device,
        number: `POS1-${String(sequenceNumber).padStart(6, "0")}`,
        sequenceNumber,
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
    async voidForOrder(_tx, _context, input) {
      const found = byOrder.get(input.orderId);
      if (!found) return null;
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, voided);
      return voided;
    },
  };
}

// ---- POS fixtures (same pattern as pos-order-void-noncash.test.ts) ------------------

async function member(roleId: string, label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

function posScope() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

function pos() {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    cashier.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      // The till: cash goes into the drawer of the shift open on this device.
      .set(
        DEVICE_TOKEN_HEADER,
        signDeviceToken({
          version: 1,
          issuedAt: Math.floor(Date.now() / 1000),
          tenantId: tenant.tenantId,
          brandId: null,
          deviceId: ids.device,
        }),
      )
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: (menuItemId: string) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId, quantity: 1, modifierIds: [] }],
      }),
    get: (orderId: string) =>
      cashier.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      send(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    complete: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/complete`, { expectedStatus }),
    correctionVoid: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/void`, body),
    refund: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/refund`, body),
  };
}

/** The supervisor's own tile + PIN approving one void/refund of `orderId`. */
async function pinApproval(input: {
  action: "void" | "refund";
  orderId: string;
  valueIdr: number;
}): Promise<{ approvedBy: string; overrideId: string }> {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    {
      outletId: tenant.outletId,
      action: input.action,
      valueIdr: input.valueIdr,
      reason: "Pelanggan salah pesan",
      objectType: "order",
      objectId: input.orderId,
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

type Sale = { orderId: string; totalIdr: number; tenderId: string };

/** create -> submit -> cash (exact total) -> complete, on the open shift. */
async function completedSale(menuItemId: string): Promise<Sale> {
  const created = await pos().create(menuItemId);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  const totalIdr = created.body.data.totalIdr as number;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const paid = await pos().cash(orderId, status, totalIdr);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const completed = await pos().complete(
    orderId,
    paid.body.data.order.status as string,
  );
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  const tenderId = await asTenant(tenant.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM pos_order_tenders
        WHERE tenant_id = $1 AND order_id = $2 AND status = 'captured'`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(rows).toHaveLength(1);
    return rows[0].id as string;
  });
  return { orderId, totalIdr, tenderId };
}

type Correction = "void" | "refund";
type CorrectionResponse = {
  status: number;
  body: {
    error?: { code?: string; message?: string };
    code?: string;
    message?: string;
    data?: Record<string, unknown>;
  };
};

/** Asks for a void, or a refund of `amountIdr` (default: the whole sale). */
async function correct(
  sale: Sale,
  correction: Correction,
  amountIdr: number = sale.totalIdr,
): Promise<CorrectionResponse> {
  if (correction === "void")
    return pos().correctionVoid(sale.orderId, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan salah pesan",
      ...(await pinApproval({
        action: "void",
        orderId: sale.orderId,
        valueIdr: sale.totalIdr,
      })),
    });
  return pos().refund(sale.orderId, {
    reason: "quality_complaint",
    reasonNote: "Pelanggan salah pesan",
    amountIdr,
    ...(await pinApproval({
      action: "refund",
      orderId: sale.orderId,
      valueIdr: amountIdr,
    })),
  });
}

const errorCode = (body: CorrectionResponse["body"]) =>
  body.error?.code ?? body.code;
const errorMessage = (body: CorrectionResponse["body"]) =>
  body.error?.message ?? body.message ?? "";

const CORRECTION_TABLE: Record<Correction, string> = {
  void: "pos_order_voids",
  refund: "pos_order_refunds",
};

async function correctionRows(
  sale: Sale,
  correction: Correction,
): Promise<number> {
  return asTenant(tenant.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${CORRECTION_TABLE[correction]}
        WHERE tenant_id = $1 AND order_id = $2`,
      [tenant.tenantId, ulidToUuid(sale.orderId)],
    );
    return rows[0].n as number;
  });
}

async function expectRefused(
  sale: Sale,
  correction: Correction,
  amount?: number,
) {
  const response = await correct(sale, correction, amount);
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(errorCode(response.body)).toBe("WFC_SALE_ACTIVE");
  expect(errorMessage(response.body)).toContain(
    "Penjualan WFC dari pembayaran ini masih aktif",
  );
  // Nothing moved: no void/refund record, the order is still a paid, completed sale.
  expect(await correctionRows(sale, correction)).toBe(0);
  expect((await pos().get(sale.orderId)).body.data.status).toBe("completed");
}

async function expectAllowed(sale: Sale, correction: Correction) {
  const response = await correct(sale, correction);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  expect(await correctionRows(sale, correction)).toBe(1);
}

// ---- WFC fixtures (same shapes as wfc-seat.test.ts / wfc-bundle.test.ts) ------------

async function seedWfcActor(): Promise<string> {
  const userId = randomUUID();
  const roleId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "WFC POS correction test", `${userId}@example.com`],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
    [
      roleId,
      tenant.tenantId,
      `WFC POS correction ${roleId.slice(0, 8)}`,
      JSON.stringify(["facility.config.manage", "facility.booth.operate"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return userId;
}

async function seedCoworking(): Promise<string> {
  const facilityId = randomUUID();
  await asTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, $4, 'coworking', 60, 0, 10, $5, $6, $7)`,
      [
        facilityId,
        tenant.tenantId,
        tenant.outletId,
        `Coworking ${short()}`,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "00:00",
            closesAt: "23:59",
          },
        ]),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
      ],
    ),
  );
  return facilityId;
}

async function seedZone(): Promise<string> {
  const id = randomUUID();
  await asTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, $4, 'pay_first', '[]')`,
      [id, tenant.tenantId, tenant.outletId, `Zona WFC ${short()}`],
    ),
  );
  return id;
}

async function seedWfcProduct(input: {
  kind: "day_pass" | "seat_reservation";
  menuItemId: string;
}): Promise<string> {
  const id = randomUUID();
  await asTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active, wfc_kind, duration_minutes, menu_item_id)
       VALUES ($1, $2, $3, $4, $5, 'single', $6, 1, true, $7, $8, $9)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        coworkingFacility,
        `Produk WFC ${short()}`,
        WFC_PRICE_IDR,
        input.kind,
        input.kind === "seat_reservation" ? SEAT_DURATION_MINUTES : null,
        input.menuItemId,
      ],
    ),
  );
  return id;
}

/** A plain facility product (a bundle component, not itself a WFC product). */
async function seedComponent(
  facilityId: string,
  priceIdr: number,
): Promise<string> {
  const id = randomUUID();
  await asTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active)
       VALUES ($1, $2, $3, $4, $5, 'single', $6, 1, true)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        facilityId,
        `Produk ${id.slice(0, 6)}`,
        priceIdr,
      ],
    ),
  );
  return id;
}

const wfcContext = () => contextOf(tenant.tenantId);

const idOf = (value: unknown): string => {
  const id = (value as { id?: string } | null)?.id;
  if (!id) throw new Error("expected a result with an id");
  return id;
};

async function statusOf(table: string, id: string): Promise<string> {
  return asTenant(tenant.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT status FROM ${table} WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, id],
    );
    if (!rows[0]) throw new Error(`${table} row not found`);
    return rows[0].status as string;
  });
}

/** A WFC sale kind: how it is bought with a POS tender, released, and observed. */
type WfcKind = {
  name: string;
  menuItemId: () => string;
  table: string;
  activeStatus: string;
  buy: (sale: Sale) => Promise<string>;
  /** Fully refund the WFC sale (or cancel the reservation). */
  release: (saleId: string, sale: Sale) => Promise<void>;
  releasedStatus: string;
};

async function newCustomer(): Promise<string> {
  return (await seedProfile(tenant.tenantId)).id;
}

const dayPassKind: WfcKind = {
  name: "day pass",
  menuItemId: () => ids.dayPass,
  table: "wfc_day_pass_purchases",
  activeStatus: "paid",
  buy: async (sale) =>
    idOf(
      await purchaseDayPass(
        wfcContext(),
        wfcActor,
        {
          productId: dayPassProduct,
          customerProfileId: await newCustomer(),
          paymentRef: sale.tenderId,
        },
        NOW,
      ),
    ),
  release: async (_saleId, sale) => {
    await refundDayPass(
      wfcContext(),
      wfcActor,
      { paymentRef: sale.tenderId, refundIdr: WFC_PRICE_IDR },
      NOW,
    );
  },
  releasedStatus: "refunded",
};

/** Reserves a seat (slot 2h after NOW) and confirms it with the sale's tender. */
async function confirmedReservation(sale: Sale): Promise<string> {
  const seatId = idOf(
    await createWfcSeat(
      wfcContext(),
      wfcActor,
      { outletId: tenant.outletId, zoneId, code: `S-${short()}` },
      NOW,
    ),
  );
  const reservationId = idOf(
    await reserveWfcSeat(
      wfcContext(),
      wfcActor,
      {
        seatId,
        productId: seatProduct,
        customerProfileId: await newCustomer(),
        startsAt: inHours(2, NOW).toISOString(),
        idempotencyKey: `idem-${randomUUID()}`,
      },
      NOW,
    ),
  );
  await confirmWfcReservationPaid(
    wfcContext(),
    wfcActor,
    { reservationId, paymentRef: sale.tenderId },
    NOW,
  );
  return reservationId;
}

const reservationKind: WfcKind = {
  name: "seat reservation (refunded)",
  menuItemId: () => ids.seat,
  table: "wfc_seat_reservations",
  activeStatus: "confirmed",
  buy: confirmedReservation,
  release: async (reservationId) => {
    await refundWfcReservation(
      wfcContext(),
      wfcActor,
      { reservationId, refundIdr: WFC_PRICE_IDR },
      NOW,
    );
  },
  releasedStatus: "refunded",
};

const bundleKind: WfcKind = {
  name: "bundle",
  menuItemId: () => ids.bundle,
  table: "wfc_bundle_purchases",
  activeStatus: "paid",
  buy: async (sale) =>
    idOf(
      await purchaseWfcBundle(
        wfcContext(),
        wfcActor,
        {
          bundleId,
          customerProfileId: await newCustomer(),
          paymentRef: sale.tenderId,
        },
        NOW,
      ),
    ),
  release: async (purchaseId) => {
    await refundWfcBundle(
      wfcContext(),
      wfcActor,
      { purchaseId, refundIdr: WFC_PRICE_IDR as never },
      NOW,
    );
  },
  releasedStatus: "refunded",
};

// ---- Suite setup ----------------------------------------------------------------------

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`wpc-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
  );
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "WFC POS Kasir Uji",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "pos.refund.request",
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      "WFC POS Supervisor Uji",
      ["order.view", "pos.void.approve", "pos.refund.approve"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "WFC POS Kasir");
  supervisor = await member(ids.supervisorRole, "WFC POS Supervisor");
  // Cash tenders, refunds and voids of cash-paid orders need the acting
  // cashier's open shift; a big float so no refund runs the drawer dry.
  await openPosShift(
    posScope(),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(5_000_000), idempotencyKey: randomUUID() },
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
  await asTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'WFC POS Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    for (const [menuItemId, name] of [
      [ids.plain, "Kopi Susu"],
      [ids.dayPass, "Day Pass WFC"],
      [ids.seat, "Reservasi Kursi WFC"],
      [ids.bundle, "Pagi Produktif"],
    ] as const) {
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [
          menuItemId,
          tenant.tenantId,
          tenant.brandId,
          ids.category,
          name,
          randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          randomUUID(),
          tenant.tenantId,
          ids.priceList,
          menuItemId,
          MENU_PRICE_IDR,
        ],
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
       VALUES ($1, $2, NULL, 'PBJT-WPC', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
  });

  // The WFC side: coworking facility, zone, the two products and one bundle.
  wfcActor = await seedWfcActor();
  coworkingFacility = await seedCoworking();
  zoneId = await seedZone();
  dayPassProduct = await seedWfcProduct({
    kind: "day_pass",
    menuItemId: ids.dayPass,
  });
  seatProduct = await seedWfcProduct({
    kind: "seat_reservation",
    menuItemId: ids.seat,
  });
  const world = { tenantId: tenant.tenantId, outletA: tenant.outletId };
  const showerFacility = await seedFacility(world);
  const wfcFacility = await seedFacility(world);
  const showerProduct = await seedComponent(showerFacility, SHOWER_PRICE_IDR);
  const dayPassComponent = await seedComponent(
    wfcFacility,
    DAY_PASS_COMPONENT_PRICE_IDR,
  );
  const bundle = await createWfcBundle(
    wfcContext(),
    wfcActor,
    {
      name: `Pagi Produktif ${short()}`,
      priceIdr: WFC_PRICE_IDR as never,
      menuItemId: ids.bundle,
      items: [
        { facilityId: showerFacility, productId: showerProduct, quantity: 1 },
        { facilityId: wfcFacility, productId: dayPassComponent, quantity: 1 },
      ],
      idempotencyKey: `wfc-bundle-${randomUUID()}`,
    },
    NOW,
  );
  bundleId = idOf(bundle);
  showerFacilityId = showerFacility;
  const showerItem = (
    bundle as unknown as { items: { id: string; facilityId: string }[] }
  ).items.find((item) => item.facilityId === showerFacility);
  if (!showerItem) throw new Error("bundle has no shower item");
  showerBundleItemId = showerItem.id;
}, 120_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  setEdgeCredentialVerifier(null);
  // Final orders and audit rows are immutable, so the isolated tenant stays in
  // the disposable database; give it a valid creator so the tenant list parses.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
  await loyaltyOwner.end();
});

// ---- Tests ----------------------------------------------------------------------------

describe("legend-tz4dg a POS void/refund of a sale with no WFC sale is unaffected", () => {
  for (const correction of ["void", "refund"] as const)
    it(
      `D11 a plain sale (no WFC purchase) can be ${correction === "void" ? "voided" : "refunded"} as before`,
      async () => {
        const sale = await completedSale(ids.plain);
        await expectAllowed(sale, correction);
      },
      TEST_TIMEOUT,
    );

  it(
    "D11 a live WFC sale blocks only its own order: another sale of the tenant can still be refunded",
    async () => {
      const wfcSale = await completedSale(dayPassKind.menuItemId());
      await dayPassKind.buy(wfcSale);
      const other = await completedSale(ids.plain);
      await expectAllowed(other, "refund");
      await expectRefused(wfcSale, "refund");
    },
    TEST_TIMEOUT,
  );
});

describe("legend-tz4dg a live WFC sale blocks the POS correction of the tender that paid it", () => {
  for (const kind of [dayPassKind, reservationKind, bundleKind])
    for (const correction of ["void", "refund"] as const)
      it(
        `D11 ${kind.name}: POS ${correction} is 409 WFC_SALE_ACTIVE while the sale is live, and works once it is released`,
        async () => {
          const sale = await completedSale(kind.menuItemId());
          const wfcId = await kind.buy(sale);
          expect(await statusOf(kind.table, wfcId)).toBe(kind.activeStatus);

          await expectRefused(sale, correction);
          // The refused correction left the WFC sale untouched.
          expect(await statusOf(kind.table, wfcId)).toBe(kind.activeStatus);

          await kind.release(wfcId, sale);
          expect(await statusOf(kind.table, wfcId)).toBe(kind.releasedStatus);

          await expectAllowed(sale, correction);
        },
        TEST_TIMEOUT,
      );

  it(
    "D11 any POS refund amount is blocked while the sale is live, not only the full one",
    async () => {
      const sale = await completedSale(dayPassKind.menuItemId());
      const wfcId = await dayPassKind.buy(sale);
      await expectRefused(sale, "refund", 1_000);
      expect(await statusOf(dayPassKind.table, wfcId)).toBe("paid");
    },
    TEST_TIMEOUT,
  );

  it(
    "D11 a partly refunded day pass is still live: the POS refund stays blocked until the pass is fully refunded",
    async () => {
      const sale = await completedSale(dayPassKind.menuItemId());
      const wfcId = await dayPassKind.buy(sale);
      await refundDayPass(
        wfcContext(),
        wfcActor,
        { paymentRef: sale.tenderId, refundIdr: 10_000 },
        NOW,
      );
      expect(await statusOf(dayPassKind.table, wfcId)).toBe("paid");
      await expectRefused(sale, "refund");

      // The rest (D5: refund up to what was paid) closes the sale.
      await refundDayPass(
        wfcContext(),
        wfcActor,
        { paymentRef: sale.tenderId, refundIdr: WFC_PRICE_IDR - 10_000 },
        NOW,
      );
      expect(await statusOf(dayPassKind.table, wfcId)).toBe("refunded");
      await expectAllowed(sale, "refund");
    },
    TEST_TIMEOUT,
  );
});

describe("legend-tz4dg F2 a cancelled seat reservation still holds its paid money until the WFC refund", () => {
  for (const correction of ["void", "refund"] as const)
    it(
      `F2 cancelled reservation: POS ${correction} is STILL 409 WFC_SALE_ACTIVE after the cancel, and works only after the WFC refund`,
      async () => {
        const sale = await completedSale(reservationKind.menuItemId());
        const reservationId = await reservationKind.buy(sale);
        expect(await statusOf(reservationKind.table, reservationId)).toBe(
          "confirmed",
        );

        await cancelWfcReservation(
          wfcContext(),
          wfcActor,
          { reservationId },
          NOW,
        );
        expect(await statusOf(reservationKind.table, reservationId)).toBe(
          "cancelled",
        );
        await expectRefused(sale, correction);
        expect(await statusOf(reservationKind.table, reservationId)).toBe(
          "cancelled",
        );

        // The cancelled reservation is refundable (WFC); that closes the sale.
        await refundWfcReservation(
          wfcContext(),
          wfcActor,
          { reservationId, refundIdr: WFC_PRICE_IDR },
          NOW,
        );
        expect(await statusOf(reservationKind.table, reservationId)).toBe(
          "refunded",
        );
        await expectAllowed(sale, correction);
      },
      TEST_TIMEOUT,
    );
});

describe("legend-tz4dg F1 a bundle with used value is never released to the POS by a partial WFC refund", () => {
  it(
    "F1 1 of 2 sessions redeemed, WFC refunds the unused part: POS void and POS refund are still 409 WFC_SALE_ACTIVE and nothing is refunded at the POS",
    async () => {
      const sale = await completedSale(bundleKind.menuItemId());
      const customerProfileId = await newCustomer();
      const bought = await purchaseWfcBundle(
        wfcContext(),
        wfcActor,
        { bundleId, customerProfileId, paymentRef: sale.tenderId },
        NOW,
      );
      const purchaseId = idOf(bought);
      const showerAllocation = (
        bought as unknown as {
          allocations: { itemId: string; allocatedIdr: number }[];
        }
      ).allocations.find((row) => row.itemId === showerBundleItemId);
      if (!showerAllocation) throw new Error("no shower allocation");

      // The guest uses the shower session (value stays with the guest).
      await entitlementsOf({
        context: wfcContext(),
      } as unknown as World).redeem({
        facilityId: showerFacilityId,
        customerProfileId,
      });

      // WFC refunds only the unused part (price - the redeemed value).
      const refundable = WFC_PRICE_IDR - showerAllocation.allocatedIdr;
      expect(refundable).toBeGreaterThan(0);
      expect(refundable).toBeLessThan(WFC_PRICE_IDR);
      await refundWfcBundle(
        wfcContext(),
        wfcActor,
        { purchaseId, refundIdr: refundable as never },
        NOW,
      );
      const refundedIdr = await asTenant(tenant.tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT refunded_idr FROM wfc_bundle_purchases
            WHERE tenant_id = $1 AND id = $2`,
          [tenant.tenantId, purchaseId],
        );
        return Number(rows[0].refunded_idr);
      });
      expect(refundedIdr).toBe(refundable);

      // Refunding the full price at the POS would pay back the used value too.
      await expectRefused(sale, "void");
      await expectRefused(sale, "refund");
      await expectRefused(sale, "refund", 1_000);
    },
    TEST_TIMEOUT,
  );
});
