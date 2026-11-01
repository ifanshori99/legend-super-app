// In-memory "server" behind VITE_API_MOCK for the QR order journey: sessions,
// shared cart, server quote, orders, payments, split bill, waiter calls,
// failed-item recovery, review and point claim. It enforces the same rules the
// real API will (version conflicts, sold-out items, closed sessions, exact
// split sums) and takes every fixture from @starter/shared/qr-order. Relative
// imports only: Node tests load it directly.
import { allocateIdr, idr, type Idr } from "@starter/shared/core";
import {
  buildQrMenu,
  cafeLegendTaxRules,
  computeQuote,
  GOOGLE_REVIEW_MIN_RATING,
  guestOrderIssueFixtures,
  pointClaimFixture,
  qrOrderFixtures as F,
  qrTokenTableCodes,
  quoteConfigForZone,
  splitBill,
  tableSessionTokenExpiresAt,
  type BillSplit,
  type CartLine,
  type FloorZone,
  type GuestOrderIssue,
  type GuestPayment,
  type GuestPaymentMethod,
  type GuestPaymentTarget,
  type PointClaim,
  type QrMenu,
  type QrMenuItem,
  type QrOrder,
  type ServiceRequest,
  type Table,
  type TableReview,
  type TableSession,
  type TableSessionView,
} from "@starter/shared/qr-order";
import { ApiError } from "../../lib/api/errors.ts";

const STAFF_USER = "00000000-0000-4000-8000-000000009001";
const EARN_SPEND_IDR = 10_000; // fixture loyalty program earnRate: 1 point / Rp10.000
/** A mock payment settles this long after it is created (webhook stand-in). */
export const MOCK_PAYMENT_SETTLE_MS = 4000;

type Clock = () => number;

function rand(chars: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
const HEX = "0123456789abcdef";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const uuid = () =>
  `${rand(HEX, 8)}-${rand(HEX, 4)}-4${rand(HEX, 3)}-8${rand(HEX, 3)}-${rand(HEX, 12)}`;
const ulid = () => `0${rand(CROCKFORD, 25)}`;

type OrderRec = QrOrder & {
  firedAtMs: number | null;
  /** New orders walk through the kitchen steps over time; fixtures stay put. */
  simulate: boolean;
};

type PaymentRec = {
  payment: GuestPayment;
  createdMs: number;
  applied: boolean;
};

type PlacedResult = {
  order: QrOrder;
  quote: ReturnType<typeof computeQuote>;
  session: TableSession;
};

type SessionRec = {
  session: TableSession;
  table: Table;
  zone: FloorZone;
  menu: QrMenu;
  cartVersion: number;
  lines: CartLine[];
  orders: OrderRec[];
  requests: { request: ServiceRequest; createdMs: number }[];
  splits: BillSplit[];
  issues: GuestOrderIssue[];
  payments: Map<string, PaymentRec>;
  review: TableReview | null;
  paidIdr: number;
  claimed: boolean;
  placed: Map<string, PlacedResult>;
};

const iso = (ms: number) => new Date(ms).toISOString();

/** Bumped when the serialized shape changes; stale browser snapshots are dropped. */
export const ENGINE_SNAPSHOT_VERSION = 1;

/** Serialized engine state kept in sessionStorage so a page reload keeps the table session. */
export type QrEngineSnapshot = {
  version: typeof ENGINE_SNAPSHOT_VERSION;
  callerParticipantId: string | null;
  orderSeq: number;
  records: {
    session: TableSession;
    tableCode: string;
    cartVersion: number;
    lines: CartLine[];
    orders: OrderRec[];
    requests: { request: ServiceRequest; createdMs: number }[];
    splits: BillSplit[];
    issues: GuestOrderIssue[];
    payments: PaymentRec[];
    review: TableReview | null;
    paidIdr: number;
    claimed: boolean;
    placed: [string, PlacedResult][];
  }[];
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function conflict(code: string, message: string): never {
  throw new ApiError(409, code, message);
}

export function createEngine(clock: Clock = Date.now) {
  const records = new Map<string, SessionRec>();
  let callerParticipantId: string | null = null;
  let orderSeq = 43;

  const tableByCode = (code: string) => {
    const table = F.tables.find((entry) => entry.code === code);
    if (!table) throw new RangeError(`Unknown table ${code}`);
    return table;
  };
  const zoneOf = (table: Table) => {
    const zone = F.zones.find((entry) => entry.id === table.zoneId);
    if (!zone) throw new RangeError(`Unknown zone for ${table.code}`);
    return zone;
  };

  function newRec(session: TableSession, table: Table): SessionRec {
    const zone = zoneOf(table);
    return {
      session: clone(session),
      table,
      zone,
      menu: buildQrMenu({ table, zone }),
      cartVersion: 0,
      lines: [],
      orders: [],
      requests: [],
      splits: [],
      issues: [],
      payments: new Map(),
      review: null,
      paidIdr: 0,
      claimed: false,
      placed: new Map(),
    };
  }

  // ---- Seed from the fixtures -------------------------------------------
  {
    // The fixtures are dated, so a running mock shifts the seeded sessions to
    // "opened N minutes ago": they stay live (session token < 12 h) whenever the
    // demo runs, and the bill/status screens show sensible times.
    const recent = (
      session: TableSession,
      minutesAgo: number,
    ): TableSession => ({
      ...clone(session),
      openedAt: iso(clock() - minutesAgo * 60_000),
      lastActivityAt: iso(clock()),
    });
    const [indoor, privateRoom, wfc] = [
      recent(F.sessions[0], 90),
      recent(F.sessions[1], 150),
      recent(F.sessions[2], 30),
    ];
    const a03 = newRec(indoor, tableByCode("A03"));
    a03.lines = clone(F.cart.lines);
    a03.cartVersion = F.cart.version;
    // A guest added "Sup Buntut" before it sold out: checkout removes it (ORD-05).
    const soldOutItem = a03.menu.items.find(
      (item) => item.status === "sold_out",
    );
    if (soldOutItem) {
      const at = "2026-11-01T05:08:00.000Z";
      a03.lines.push({
        id: uuid() as CartLine["id"],
        tenantId: indoor.tenantId,
        outletId: indoor.outletId,
        tableSessionId: indoor.id,
        menuItemId: soldOutItem.id,
        variantId: null,
        name: soldOutItem.name,
        quantity: 1,
        modifiers: [],
        note: null,
        unitPriceIdr: soldOutItem.priceIdr,
        modifiersTotalIdr: idr(0),
        lineTotalIdr: soldOutItem.priceIdr,
        addedByParticipantId: indoor.participants[1]?.id ?? null,
        addedAt: at,
        updatedAt: at,
      } as CartLine);
      a03.cartVersion += 1;
    }
    a03.requests = clone(
      F.serviceRequests.filter((r) => r.tableSessionId === indoor.id),
    ).map((request) => ({ request, createdMs: clock() - 90_000 }));
    records.set(indoor.id, a03);

    const p1 = newRec(privateRoom, tableByCode("P1"));
    p1.cartVersion = 1;
    p1.orders = [{ ...clone(F.orders[0]), firedAtMs: null, simulate: false }];
    p1.splits = clone(F.billSplits);
    p1.paidIdr = F.billSplits[0].amountIdr;
    p1.issues = clone(guestOrderIssueFixtures);
    p1.requests = clone(
      F.serviceRequests.filter((r) => r.tableSessionId === privateRoom.id),
    ).map((request) => ({ request, createdMs: clock() - 600_000 }));
    records.set(privateRoom.id, p1);

    records.set(wfc.id, newRec(wfc, tableByCode("W01")));
  }

  function activeSessionFor(tableId: string): SessionRec | undefined {
    for (const rec of records.values())
      if (
        rec.table.id === tableId &&
        rec.session.status !== "closed" &&
        rec.session.status !== "voided"
      )
        return rec;
    return undefined;
  }

  function tableForToken(qrToken: string): Table {
    const code = qrTokenTableCodes[qrToken];
    if (!code) throw new ApiError(404, "NOT_FOUND", "QR meja tidak dikenali.");
    return tableByCode(code);
  }

  function recOf(sessionId: string): SessionRec {
    const rec = records.get(sessionId);
    if (!rec)
      throw new ApiError(404, "NOT_FOUND", "Sesi meja tidak ditemukan.");
    return rec;
  }

  function usable(rec: SessionRec): void {
    if (rec.session.status === "closed" || rec.session.status === "voided")
      conflict(
        "SESSION_CLOSED",
        "Sesi meja ini sudah ditutup. Scan ulang QR di meja.",
      );
  }

  // ---- Scan -----------------------------------------------------------------
  function scan(input: { qrToken: string; pax: number; deviceHash: string }) {
    const table = tableForToken(input.qrToken);
    let rec = activeSessionFor(table.id);
    const now = clock();
    let outcome: "opened" | "joined" = "joined";
    if (!rec) {
      outcome = "opened";
      const zone = zoneOf(table);
      const base = F.sessions[0];
      const session: TableSession = {
        ...base,
        id: uuid() as TableSession["id"],
        tableId: table.id,
        pax: input.pax,
        paymentMode: zone.paymentMode,
        status:
          zone.paymentMode === "open_bill" ? "pending_confirmation" : "open",
        confirmedBy: null,
        participants: [],
        openedAt: iso(now),
        closedAt: null,
        lastActivityAt: iso(now),
        billRequestedAt: null,
        closedReason: null,
      };
      rec = newRec(session, table);
      records.set(session.id, rec);
    }
    let me = rec.session.participants.find(
      (participant) => participant.deviceHash === input.deviceHash,
    );
    if (!me) {
      me = {
        id: uuid() as TableSession["participants"][number]["id"],
        tenantId: rec.session.tenantId,
        tableSessionId: rec.session.id,
        deviceHash: input.deviceHash,
        userId: null,
        joinedAt: iso(now),
        lastSeenAt: iso(now),
      };
      rec.session.participants.push(me);
    } else me.lastSeenAt = iso(now);
    callerParticipantId = me.id;
    return {
      outcome,
      table: rec.table,
      zone: rec.zone,
      outlet: F.scanResult.outlet,
      brand: F.scanResult.brand,
      session: clone(rec.session),
      sessionToken: `st_${rand("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789_-", 32)}`,
      // ORD-04: at most 12 h from the session open and never past the close.
      sessionTokenExpiresAt: tableSessionTokenExpiresAt(rec.session),
      menuUpdatedAt: rec.menu.menuUpdatedAt,
      soldOutItemIds: rec.menu.items
        .filter((item) => item.status === "sold_out")
        .map((item) => item.id),
      serverTime: iso(now),
    };
  }

  function menuFor(qrToken: string): QrMenu {
    const table = tableForToken(qrToken);
    return clone(buildQrMenu({ table, zone: zoneOf(table) }));
  }

  // ---- Cart -------------------------------------------------------------------
  const itemOf = (rec: SessionRec, id: string): QrMenuItem => {
    const item = rec.menu.items.find((entry) => entry.id === id);
    if (!item) throw new ApiError(404, "NOT_FOUND", "Menu tidak ditemukan.");
    return item;
  };

  function checkVersion(rec: SessionRec, expected: number) {
    if (expected !== rec.cartVersion)
      conflict(
        "CONFLICT",
        "Keranjang baru saja diubah tamu lain. Muat ulang lalu coba lagi.",
      );
  }

  /** Server-side re-validation of the selection, mirroring the item sheet. */
  function resolveLine(
    item: QrMenuItem,
    variantId: string | null | undefined,
    modifierIds: readonly string[],
  ) {
    if (item.status === "sold_out")
      conflict("ITEM_SOLD_OUT", `${item.name} sedang habis.`);
    let unit = item.priceIdr as number;
    if (item.variants.length > 0) {
      const variant = item.variants.find((entry) => entry.id === variantId);
      if (!variant)
        throw new ApiError(
          422,
          "SELECTION_INVALID",
          "Pilih varian terlebih dahulu.",
        );
      unit = variant.priceIdr;
    } else if (variantId)
      throw new ApiError(422, "SELECTION_INVALID", "Varian tidak dikenal.");
    const chosen = [];
    for (const group of item.modifierGroups) {
      const picked = group.modifiers.filter((m) => modifierIds.includes(m.id));
      if (picked.length < group.minSelect || picked.length > group.maxSelect)
        throw new ApiError(
          422,
          "SELECTION_INVALID",
          `Pilihan "${group.name}" belum sesuai aturan.`,
        );
      for (const modifier of picked) {
        if (modifier.soldOut)
          conflict("ITEM_SOLD_OUT", `${modifier.name} sedang habis.`);
        chosen.push({
          modifierId: modifier.id,
          groupId: group.id,
          name: modifier.name,
          priceIdr: modifier.priceIdr,
        });
      }
    }
    const known = new Set(
      item.modifierGroups.flatMap((g) => g.modifiers.map((m) => m.id)),
    );
    if (modifierIds.some((id) => !known.has(id)))
      throw new ApiError(422, "SELECTION_INVALID", "Pilihan tidak dikenal.");
    const modifiersTotal = chosen.reduce((sum, m) => sum + m.priceIdr, 0);
    return { unit, chosen, modifiersTotal };
  }

  function cartOf(rec: SessionRec) {
    return {
      sessionId: rec.session.id,
      version: rec.cartVersion,
      lines: clone(rec.lines),
      updatedAt: iso(clock()),
    };
  }

  function touch(rec: SessionRec) {
    rec.cartVersion += 1;
    rec.session.lastActivityAt = iso(clock());
  }

  function addLine(
    sessionId: string,
    body: {
      menuItemId: string;
      variantId?: string | null;
      quantity: number;
      modifierIds: string[];
      note?: string;
      expectedCartVersion: number;
    },
  ) {
    const rec = recOf(sessionId);
    usable(rec);
    checkVersion(rec, body.expectedCartVersion);
    const item = itemOf(rec, body.menuItemId);
    const { unit, chosen, modifiersTotal } = resolveLine(
      item,
      body.variantId,
      body.modifierIds,
    );
    const variantName = item.variants.find(
      (v) => v.id === body.variantId,
    )?.name;
    const name = variantName ? `${item.name} (${variantName})` : item.name;
    const note = body.note?.trim() ? body.note.trim() : null;
    const sameConfig = (line: CartLine) =>
      line.menuItemId === item.id &&
      (line.variantId ?? null) === (body.variantId ?? null) &&
      (line.note ?? null) === note &&
      line.modifiers
        .map((m) => m.modifierId)
        .sort()
        .join() === [...body.modifierIds].sort().join();
    const existing = rec.lines.find(sameConfig);
    const now = iso(clock());
    let line: CartLine;
    if (existing) {
      existing.quantity = Math.min(99, existing.quantity + body.quantity);
      existing.lineTotalIdr = idr(
        (existing.unitPriceIdr + existing.modifiersTotalIdr) *
          existing.quantity,
      );
      existing.updatedAt = now;
      line = existing;
    } else {
      line = {
        id: uuid() as CartLine["id"],
        tenantId: rec.session.tenantId,
        outletId: rec.session.outletId,
        tableSessionId: rec.session.id,
        menuItemId: item.id,
        variantId: (body.variantId ?? null) as CartLine["variantId"],
        name,
        quantity: body.quantity,
        modifiers: chosen as CartLine["modifiers"],
        note,
        unitPriceIdr: idr(unit),
        modifiersTotalIdr: idr(modifiersTotal),
        lineTotalIdr: idr((unit + modifiersTotal) * body.quantity),
        addedByParticipantId:
          callerParticipantId as CartLine["addedByParticipantId"],
        addedAt: now,
        updatedAt: now,
      };
      rec.lines.push(line);
    }
    touch(rec);
    return { cart: cartOf(rec), line: clone(line) };
  }

  function lineOf(rec: SessionRec, lineId: string): CartLine {
    const line = rec.lines.find((entry) => entry.id === lineId);
    if (!line)
      throw new ApiError(404, "NOT_FOUND", "Baris keranjang tidak ditemukan.");
    return line;
  }

  function updateLine(
    sessionId: string,
    lineId: string,
    body: {
      quantity?: number;
      note?: string | null;
      expectedCartVersion: number;
    },
  ) {
    const rec = recOf(sessionId);
    usable(rec);
    checkVersion(rec, body.expectedCartVersion);
    const line = lineOf(rec, lineId);
    if (body.quantity !== undefined) line.quantity = body.quantity;
    if (body.note !== undefined)
      line.note = body.note?.trim() ? body.note.trim() : null;
    line.lineTotalIdr = idr(
      (line.unitPriceIdr + line.modifiersTotalIdr) * line.quantity,
    );
    line.updatedAt = iso(clock());
    touch(rec);
    return { cart: cartOf(rec), line: clone(line) };
  }

  function removeLine(
    sessionId: string,
    lineId: string,
    expectedCartVersion: number,
  ) {
    const rec = recOf(sessionId);
    usable(rec);
    checkVersion(rec, expectedCartVersion);
    lineOf(rec, lineId);
    rec.lines = rec.lines.filter((entry) => entry.id !== lineId);
    touch(rec);
    return { cart: cartOf(rec), line: null };
  }

  // ---- Quote ----------------------------------------------------------------
  const taxRuleId = cafeLegendTaxRules[0].id;

  function orderableLines(rec: SessionRec) {
    const live: CartLine[] = [];
    const removed: CartLine[] = [];
    for (const line of rec.lines) {
      const item = rec.menu.items.find((entry) => entry.id === line.menuItemId);
      if (!item || item.status === "sold_out") removed.push(line);
      else live.push(line);
    }
    return { live, removed };
  }

  function servingEstimate(count: number) {
    const min = 8 + Math.min(count, 12) * 2;
    return { minMinutes: min, maxMinutes: min + 6, computedAt: iso(clock()) };
  }

  function quote(
    sessionId: string,
    codes: { promoCode?: string; voucherCode?: string } = {},
  ) {
    const rec = recOf(sessionId);
    const { live, removed } = orderableLines(rec);
    if (codes.promoCode)
      throw new ApiError(
        422,
        "VOUCHER_INVALID",
        "Kode promo tidak valid atau sudah tidak berlaku.",
      );
    const subtotal = live.reduce((sum, line) => sum + line.lineTotalIdr, 0);
    const discounts = [];
    if (codes.voucherCode) {
      const voucher = F.apologyVouchers.find(
        (entry) => entry.code === codes.voucherCode,
      );
      if (!voucher || voucher.status !== "issued" || live.length === 0)
        throw new ApiError(
          422,
          "VOUCHER_INVALID",
          "Kode voucher tidak valid atau sudah tidak berlaku.",
        );
      discounts.push({
        label: "Voucher permintaan maaf",
        source: "voucher" as const,
        amountIdr: idr(Math.min(voucher.valueIdr, subtotal)),
      });
    }
    return clone(
      computeQuote({
        sessionId: rec.session.id,
        cartVersion: rec.cartVersion,
        lines: live.map((line) => ({
          cartLineId: line.id,
          menuItemId: line.menuItemId,
          name: line.name,
          quantity: line.quantity,
          unitPriceIdr: line.unitPriceIdr,
          modifiersTotalIdr: line.modifiersTotalIdr,
          taxRuleId,
        })),
        config: quoteConfigForZone(rec.zone),
        discounts,
        removedLines: removed.map((line) => ({
          cartLineId: line.id,
          menuItemId: line.menuItemId,
          name: line.name,
          reason: "sold_out" as const,
        })),
        servingEstimate:
          live.length > 0 ? servingEstimate(live.length) : undefined,
        computedAt: iso(clock()),
      }),
    );
  }

  // ---- Orders ---------------------------------------------------------------
  function simulatedOrder(order: OrderRec): QrOrder {
    const out = clone(order) as QrOrder & {
      firedAtMs?: number;
      simulate?: boolean;
    };
    delete out.firedAtMs;
    delete out.simulate;
    if (order.simulate && order.firedAtMs !== null) {
      const elapsed = clock() - order.firedAtMs;
      const status: QrOrder["items"][number]["status"] =
        elapsed < 15_000
          ? "queued"
          : elapsed < 45_000
            ? "in_progress"
            : elapsed < 80_000
              ? "ready"
              : "served";
      out.items = out.items.map((item) => ({ ...item, status }));
    }
    return out;
  }

  function visibleRequests(rec: SessionRec): ServiceRequest[] {
    const now = clock();
    const out: ServiceRequest[] = [];
    for (const entry of rec.requests) {
      const age = now - entry.createdMs;
      if (
        entry.request.status === "resolved" ||
        entry.request.status === "cancelled"
      )
        continue;
      if (age > 40_000) continue; // resolved by the waiter
      const acknowledged = age > 6000;
      out.push({
        ...entry.request,
        status: acknowledged ? "acknowledged" : "pending",
        assignedTo: acknowledged
          ? (STAFF_USER as ServiceRequest["assignedTo"])
          : null,
        acknowledgedAt: acknowledged ? iso(entry.createdMs + 6000) : null,
      });
    }
    return out;
  }

  function view(sessionId: string, scenario?: string): TableSessionView {
    const rec = recOf(sessionId);
    const empty = scenario === "empty";
    const lines = empty ? [] : rec.lines;
    const cart = { ...cartOf(rec), lines: clone(lines) };
    return {
      session: clone(rec.session),
      cart,
      quote: lines.length > 0 ? quote(sessionId) : null,
      orders: empty ? [] : rec.orders.map(simulatedOrder),
      openServiceRequests: empty ? [] : visibleRequests(rec),
    } as unknown as TableSessionView;
  }

  function place(
    sessionId: string,
    body: {
      expectedCartVersion: number;
      idempotencyKey: string;
      note?: string;
    },
  ) {
    const rec = recOf(sessionId);
    const replay = rec.placed.get(body.idempotencyKey);
    if (replay)
      return clone({
        ...replay,
        kitchenFire:
          replay.order.status === "sent"
            ? ("fired" as const)
            : ("held_for_payment" as const),
      });
    usable(rec);
    checkVersion(rec, body.expectedCartVersion);
    if (
      rec.session.paymentMode === "open_bill" &&
      rec.session.status === "pending_confirmation"
    )
      conflict(
        "SESSION_NOT_CONFIRMED",
        "Waiter belum mengonfirmasi meja ini. Tunggu sebentar.",
      );
    const { live } = orderableLines(rec);
    if (live.length === 0)
      throw new ApiError(
        422,
        "CART_EMPTY",
        "Keranjang kosong. Tambahkan menu dulu.",
      );
    const q = quote(sessionId);
    if (q.minimumSpend.shortfallIdr > 0)
      throw new ApiError(
        422,
        "MINIMUM_SPEND_NOT_MET",
        "Pesanan belum mencapai minimum belanja zona ini.",
      );
    const now = clock();
    const payFirst = rec.session.paymentMode === "pay_first";
    const orderId = ulid();
    orderSeq += 1;
    const items = live.map((line) => ({
      id: ulid(),
      tenantId: rec.session.tenantId,
      orderId,
      menuItemId: line.menuItemId,
      variantId: line.variantId,
      name: line.name,
      quantity: line.quantity,
      unitPriceIdr: line.unitPriceIdr,
      modifiersTotalIdr: line.modifiersTotalIdr,
      lineTotalIdr: line.lineTotalIdr,
      modifiers: line.modifiers.map((m) => ({
        modifierId: m.modifierId,
        name: m.name,
        priceIdr: m.priceIdr,
      })),
      note: line.note,
      course:
        rec.menu.items.find((entry) => entry.id === line.menuItemId)?.type ===
        "combo"
          ? null
          : null,
      fireStatus: payFirst ? "held" : "fired",
      status: "queued",
    }));
    const order = {
      id: orderId,
      tenantId: rec.session.tenantId,
      outletId: rec.session.outletId,
      number: `QR-20261101-${String(orderSeq).padStart(4, "0")}`,
      channel: "qr",
      serviceType: "dine_in",
      tableSessionId: rec.session.id,
      customerProfileId: null,
      subtotalIdr: q.subtotalIdr,
      discountIdr: q.discountIdr,
      serviceChargeIdr: q.serviceCharge.amountIdr,
      taxIdr: q.taxIdr,
      roundingIdr: q.rounding.adjustmentIdr,
      totalIdr: q.totalIdr,
      status: payFirst ? "awaiting_payment" : "sent",
      items,
      createdAt: iso(now),
      placedAt: iso(now),
      firedAtMs: payFirst ? null : now,
      simulate: true,
    } as unknown as OrderRec;
    rec.orders.push(order);
    rec.lines = rec.lines.filter((line) => !live.includes(line));
    // Sold-out lines are dropped with the order and reported in the quote.
    rec.lines = [];
    touch(rec);
    const result = {
      order: simulatedOrder(order),
      quote: q,
      session: clone(rec.session),
    };
    rec.placed.set(body.idempotencyKey, result as never);
    return clone({
      ...result,
      kitchenFire: (payFirst ? "held_for_payment" : "fired") as
        "fired" | "held_for_payment",
    });
  }

  // ---- Bill and split -------------------------------------------------------
  /** The bill covers every placed order, paid or not (a pay-first order awaiting payment is still owed). */
  const settledOrders = (rec: SessionRec) =>
    rec.orders.filter((o) => o.status !== "voided");

  function bill(sessionId: string) {
    const rec = recOf(sessionId);
    const orders = settledOrders(rec).map(simulatedOrder);
    const sum = (pick: (o: QrOrder) => number) =>
      orders.reduce((s, o) => s + pick(o), 0);
    const total = sum((o) => o.totalIdr);
    return clone({
      sessionId: rec.session.id,
      orders,
      totals: {
        subtotalIdr: sum((o) => o.subtotalIdr),
        discountIdr: sum((o) => o.discountIdr),
        serviceChargeIdr: sum((o) => o.serviceChargeIdr),
        taxIdr: sum((o) => o.taxIdr),
        roundingIdr: sum((o) => o.roundingIdr),
        totalIdr: total,
        paidIdr: rec.paidIdr,
        outstandingIdr: Math.max(0, total - rec.paidIdr),
      },
      splits: rec.splits,
      computedAt: iso(clock()),
    });
  }

  function createSplits(
    sessionId: string,
    body: Parameters<typeof splitBill>[0] extends never
      ? never
      : Record<string, unknown>,
  ) {
    const rec = recOf(sessionId);
    usable(rec);
    const awaiting = rec.orders.find((o) => o.status === "awaiting_payment");
    const target = awaiting ?? null;
    const orders = target ? [target] : settledOrders(rec);
    if (orders.length === 0)
      throw new ApiError(
        422,
        "NOTHING_TO_SPLIT",
        "Belum ada pesanan yang bisa dibagi.",
      );
    const totalIdr = idr(orders.reduce((s, o) => s + o.totalIdr, 0)) as Idr;
    if (rec.splits.some((s) => s.status === "paid"))
      conflict(
        "SPLIT_LOCKED",
        "Sebagian bagian sudah dibayar, pembagian tidak bisa diubah.",
      );
    const lines = orders.flatMap((o) =>
      o.items.map((item) => ({
        orderItemId: item.id,
        lineTotalIdr: item.lineTotalIdr,
      })),
    );
    let drafts;
    const method = body.method as string;
    if (method === "equal")
      drafts = splitBill({
        method: "equal",
        totalIdr,
        parts: body.parts as number,
      });
    else if (method === "by_person")
      drafts = splitBill({
        method: "by_person",
        totalIdr,
        participantIds: body.participantIds as string[],
      });
    else
      drafts = splitBill({
        method: "by_item",
        totalIdr,
        lines,
        assignments: body.assignments as never,
      });
    for (const old of rec.splits)
      if (old.status === "pending") old.status = "voided";
    const created: BillSplit[] = drafts.map((draft) => ({
      id: uuid() as BillSplit["id"],
      tenantId: rec.session.tenantId,
      outletId: rec.session.outletId,
      tableSessionId: rec.session.id,
      orderId: target ? target.id : null,
      method: draft.method,
      shareIndex: draft.shareIndex,
      amountIdr: draft.amountIdr,
      status: "pending",
      label: draft.label,
      itemIds: [...draft.itemIds] as BillSplit["itemIds"],
      participantId: draft.participantId as BillSplit["participantId"],
      createdAt: iso(clock()),
    }));
    rec.splits.push(...created);
    return clone({ bill: bill(sessionId), splits: created });
  }

  // ---- Service requests -----------------------------------------------------
  function createRequest(
    sessionId: string,
    body: {
      type: ServiceRequest["type"];
      reason?: ServiceRequest["reason"];
      message?: string;
    },
  ) {
    const rec = recOf(sessionId);
    usable(rec);
    if (rec.session.status === "pending_confirmation")
      conflict("SESSION_NOT_CONFIRMED", "Waiter belum mengonfirmasi meja ini.");
    const now = clock();
    const request: ServiceRequest = {
      id: uuid() as ServiceRequest["id"],
      tenantId: rec.session.tenantId,
      outletId: rec.session.outletId,
      tableSessionId: rec.session.id,
      tableId: rec.table.id,
      zoneId: rec.zone.id,
      type: body.type,
      reason: body.type === "call_waiter" ? (body.reason ?? "other") : null,
      message: body.message ?? null,
      status: "pending",
      assignedTo: null,
      createdAt: iso(now),
      acknowledgedAt: null,
      resolvedAt: null,
    };
    rec.requests.push({ request, createdMs: now });
    if (body.type === "request_bill" && rec.session.status === "open") {
      rec.session.status = "bill_requested";
      rec.session.billRequestedAt = iso(now);
    }
    rec.session.lastActivityAt = iso(now);
    return clone(request);
  }

  // ---- Payments -------------------------------------------------------------
  function amountFor(rec: SessionRec, target: GuestPaymentTarget): number {
    if (target.kind === "order") {
      const order = rec.orders.find((o) => o.id === target.orderId);
      if (!order)
        throw new ApiError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
      if (order.status !== "awaiting_payment")
        conflict("ALREADY_PAID", "Pesanan ini sudah dibayar.");
      return order.totalIdr;
    }
    if (target.kind === "split") {
      const split = rec.splits.find((s) => s.id === target.billSplitId);
      if (!split)
        throw new ApiError(404, "NOT_FOUND", "Bagian tagihan tidak ditemukan.");
      if (split.status !== "pending")
        conflict("ALREADY_PAID", "Bagian ini sudah dibayar.");
      return split.amountIdr;
    }
    const outstanding = bill(rec.session.id).totals.outstandingIdr;
    if (outstanding <= 0) conflict("ALREADY_PAID", "Tagihan sudah lunas.");
    return outstanding;
  }

  function startPayment(
    sessionId: string,
    body: {
      target: GuestPaymentTarget;
      method: GuestPaymentMethod;
      idempotencyKey: string;
    },
  ) {
    const rec = recOf(sessionId);
    usable(rec);
    for (const entry of rec.payments.values())
      if (
        (entry.payment as { idemKey?: string }).idemKey === body.idempotencyKey
      )
        return paymentView(entry);
    const amount = amountFor(rec, body.target);
    const now = clock();
    const payment = {
      id: uuid(),
      target: body.target,
      method: body.method,
      amountIdr: idr(amount),
      status: "pending",
      qrisPayload:
        body.method === "qris"
          ? `00020101021226610016ID.CO.QRIS.WWW01189360091400${rand("0123456789", 10)}5204581253033605802ID5913Cafe Legend6007Bandung6304${rand("ABCDEF0123456789", 4)}`
          : null,
      redirectUrl:
        body.method === "ewallet"
          ? "https://pay.example/legend/checkout"
          : null,
      expiresAt: iso(now + 15 * 60_000),
      paidAt: null,
      idemKey: body.idempotencyKey,
    } as unknown as GuestPayment;
    const entry: PaymentRec = { payment, createdMs: now, applied: false };
    rec.payments.set(payment.id, entry);
    return paymentView(entry);
  }

  function paymentView(entry: PaymentRec): GuestPayment {
    const out = clone(entry.payment) as GuestPayment & { idemKey?: string };
    delete out.idemKey;
    return out;
  }

  function settle(rec: SessionRec, entry: PaymentRec, now: number) {
    entry.applied = true;
    entry.payment = { ...entry.payment, status: "paid", paidAt: iso(now) };
    const target = entry.payment.target;
    if (target.kind === "order") {
      const order = rec.orders.find((o) => o.id === target.orderId);
      if (order) {
        order.status = "sent";
        order.firedAtMs = now;
        order.items = order.items.map((item) => ({
          ...item,
          fireStatus: "fired" as const,
        }));
        // ORD-02: only now does the kitchen see the order.
      }
      rec.paidIdr += entry.payment.amountIdr;
      const share = rec.splits.filter(
        (s) => s.orderId === target.orderId && s.status === "pending",
      );
      for (const s of share) s.status = "voided";
    } else if (target.kind === "split") {
      const split = rec.splits.find((s) => s.id === target.billSplitId);
      if (split) {
        split.status = "paid";
        const order = rec.orders.find((o) => o.id === split.orderId);
        if (order && order.status === "awaiting_payment") {
          const allPaid = rec.splits
            .filter((s) => s.orderId === order.id && s.status !== "voided")
            .every((s) => s.status === "paid");
          if (allPaid) {
            order.status = "sent";
            order.firedAtMs = now;
            order.items = order.items.map((item) => ({
              ...item,
              fireStatus: "fired" as const,
            }));
          }
        }
      }
      rec.paidIdr += entry.payment.amountIdr;
    } else {
      rec.paidIdr += entry.payment.amountIdr;
      for (const s of rec.splits) if (s.status === "pending") s.status = "paid";
    }
  }

  function getPayment(sessionId: string, paymentId: string): GuestPayment {
    const rec = recOf(sessionId);
    const entry = rec.payments.get(paymentId);
    if (!entry)
      throw new ApiError(404, "NOT_FOUND", "Pembayaran tidak ditemukan.");
    const now = clock();
    if (!entry.applied && now - entry.createdMs >= MOCK_PAYMENT_SETTLE_MS)
      settle(rec, entry, now);
    return paymentView(entry);
  }

  // ---- Failed item recovery -------------------------------------------------
  function issues(sessionId: string, scenario?: string): GuestOrderIssue[] {
    return scenario === "empty" ? [] : clone(recOf(sessionId).issues);
  }

  function chooseResolution(
    orderIssueId: string,
    body: { choice: "swap" | "voucher"; replacementItemId?: string },
  ) {
    for (const rec of records.values()) {
      const issue = rec.issues.find((entry) => entry.id === orderIssueId);
      if (!issue) continue;
      if (issue.status !== "open")
        conflict("ISSUE_ALREADY_RESOLVED", "Masalah ini sudah diselesaikan.");
      const now = clock();
      const fixture =
        F.orderIssues.find((entry) => entry.id === issue.id) ??
        F.orderIssues[0];
      if (body.choice === "swap") {
        const option = issue.options.swap.items.find(
          (i) => i.menuItemId === body.replacementItemId,
        );
        if (!issue.options.swap.allowed || !option)
          throw new ApiError(
            422,
            "SWAP_NOT_ALLOWED",
            "Menu pengganti tidak tersedia untuk item ini.",
          );
        issue.resolution = "swap";
        issue.replacementItemName = option.name;
        issue.priceDifferenceIdr = option.differenceIdr;
      } else {
        if (!issue.options.voucher.allowed)
          throw new ApiError(
            422,
            "VOUCHER_NOT_ALLOWED",
            "Kredit voucher tidak tersedia untuk item ini.",
          );
        issue.resolution = "voucher";
        issue.voucher = {
          id: uuid() as never,
          code: `LEG-${rand("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 4)}-${rand("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 4)}`,
          valueIdr: issue.options.voucher.valueIdr as never,
          expiresAt: iso(now + 30 * 86_400_000),
        };
      }
      issue.status = "resolved";
      issue.resolvedAt = iso(now);
      return clone({
        ...fixture,
        id: issue.id,
        status: "resolved" as const,
        resolution: issue.resolution,
        replacementItemId: body.replacementItemId ?? null,
        voucherId: issue.voucher?.id ?? null,
        priceDifferenceIdr: issue.priceDifferenceIdr,
        resolvedAt: issue.resolvedAt,
      });
    }
    throw new ApiError(404, "NOT_FOUND", "Masalah pesanan tidak ditemukan.");
  }

  // ---- Review and point claim -----------------------------------------------
  function settled(rec: SessionRec): boolean {
    const b = bill(rec.session.id);
    return b.orders.length > 0 && b.totals.outstandingIdr === 0;
  }

  function reviewEligibility(sessionId: string) {
    const rec = recOf(sessionId);
    return {
      sessionId: rec.session.id,
      eligible: settled(rec),
      alreadySubmitted: rec.review !== null,
      googleReviewUrl: F.reviewEligibility.googleReviewUrl,
    };
  }

  function submitReview(
    sessionId: string,
    body: { rating: number; comment?: string },
  ) {
    const rec = recOf(sessionId);
    if (!settled(rec))
      conflict(
        "REVIEW_NOT_AVAILABLE",
        "Ulasan bisa diberikan setelah tagihan lunas.",
      );
    if (rec.review)
      conflict(
        "REVIEW_ALREADY_SUBMITTED",
        "Ulasan untuk sesi ini sudah dikirim.",
      );
    const prompt = body.rating >= GOOGLE_REVIEW_MIN_RATING;
    rec.review = {
      id: uuid() as TableReview["id"],
      tenantId: rec.session.tenantId,
      outletId: rec.session.outletId,
      tableSessionId: rec.session.id,
      participantId: callerParticipantId as TableReview["participantId"],
      rating: body.rating,
      comment: body.comment?.trim() ? body.comment.trim() : null,
      googleReviewPrompt: prompt,
      googleReviewUrl: prompt ? F.reviewEligibility.googleReviewUrl : null,
      submittedAt: iso(clock()),
    };
    return clone(rec.review);
  }

  function pointClaim(sessionId: string, guest: boolean): PointClaim {
    const rec = recOf(sessionId);
    if (
      rec.session.id === pointClaimFixture.sessionId &&
      !rec.claimed &&
      !guest
    )
      return clone(pointClaimFixture);
    const ok = settled(rec) && rec.paidIdr > 0;
    const status = rec.claimed ? "claimed" : ok ? "available" : "unavailable";
    return {
      sessionId: rec.session.id,
      status,
      paidIdr: idr(rec.paidIdr),
      points: Math.floor(rec.paidIdr / EARN_SPEND_IDR),
      claimableUntil:
        status === "available" ? iso(clock() + 24 * 3_600_000) : null,
      requiresLogin: guest,
    } as PointClaim;
  }

  function claim(sessionId: string, guest: boolean): PointClaim {
    const rec = recOf(sessionId);
    if (guest)
      throw new ApiError(
        401,
        "UNAUTHENTICATED",
        "Masuk dulu untuk mengklaim poin.",
      );
    const current = pointClaim(sessionId, false);
    if (current.status !== "available")
      conflict(
        "CLAIM_NOT_AVAILABLE",
        "Poin untuk sesi ini belum bisa diklaim.",
      );
    rec.claimed = true;
    return { ...current, status: "claimed" } as PointClaim;
  }

  // ---- Suggestions (AI-01) ----------------------------------------------------
  function suggestions(sessionId: string, menuItemId?: string) {
    const rec = recOf(sessionId);
    const orderable = rec.menu.items.filter(
      (item) => item.status === "available",
    );
    const categoryOf = (id: string) =>
      rec.menu.categories.find(
        (c) => c.id === rec.menu.items.find((i) => i.id === id)?.categoryId,
      )?.name;
    const anchorIds = menuItemId
      ? [menuItemId]
      : rec.lines.map((l) => l.menuItemId);
    const inCart = new Set(rec.lines.map((l) => l.menuItemId));
    const picks: {
      menuItemId: string;
      kind: "pairing" | "upgrade";
      basedOnMenuItemId: string | null;
    }[] = [];
    const add = (
      id: string,
      kind: "pairing" | "upgrade",
      basedOn: string | null,
    ) => {
      if (
        !inCart.has(id) &&
        id !== menuItemId &&
        !picks.some((p) => p.menuItemId === id)
      )
        picks.push({ menuItemId: id, kind, basedOnMenuItemId: basedOn });
    };
    for (const anchor of anchorIds) {
      const cat = categoryOf(anchor);
      const wanted =
        cat === "Kopi" || cat === "Nonkopi"
          ? "Pastry"
          : cat === "Dapur"
            ? "Nonkopi"
            : "Kopi";
      for (const item of orderable
        .filter((i) => categoryOf(i.id) === wanted)
        .slice(0, 2))
        add(item.id, "pairing", anchor);
    }
    if (picks.length === 0)
      for (const item of orderable
        .filter((i) => i.labels.includes("terlaris"))
        .slice(0, 3))
        add(item.id, "pairing", null);
    return picks.slice(0, 4);
  }

  function orderEtas(sessionId: string) {
    const rec = recOf(sessionId);
    const out = [];
    for (const order of rec.orders) {
      const live = simulatedOrder(order);
      const items = live.items.filter((item) => item.status !== "voided");
      if (items.length === 0 || items.every((item) => item.status === "served"))
        continue;
      const min = 8 + Math.min(items.length, 12) * 2;
      const from = order.firedAtMs ?? new Date(order.placedAt).getTime();
      out.push({
        orderId: order.id,
        minMinutes: min,
        maxMinutes: min + 6,
        estimatedReadyAt: iso(from + (min + 6) * 60_000),
      });
    }
    return out;
  }

  function setGuest(participantId: string | null) {
    callerParticipantId = participantId;
  }

  // ---- Reload persistence ---------------------------------------------------
  /** Everything the browser needs to keep one table journey across a reload. */
  function snapshot(): QrEngineSnapshot {
    return {
      version: ENGINE_SNAPSHOT_VERSION,
      callerParticipantId,
      orderSeq,
      records: [...records.values()].map((rec) => ({
        session: clone(rec.session),
        tableCode: rec.table.code,
        cartVersion: rec.cartVersion,
        lines: clone(rec.lines),
        orders: clone(rec.orders),
        requests: clone(rec.requests),
        splits: clone(rec.splits),
        issues: clone(rec.issues),
        payments: clone([...rec.payments.values()]),
        review: clone(rec.review),
        paidIdr: rec.paidIdr,
        claimed: rec.claimed,
        placed: clone([...rec.placed.entries()]),
      })),
    };
  }

  /** Rebuilds the seeded and guest-created sessions from a browser snapshot. */
  function restore(saved: QrEngineSnapshot) {
    if (saved.version !== ENGINE_SNAPSHOT_VERSION)
      throw new RangeError("Snapshot mock QR tidak dikenal.");
    const next = new Map<string, SessionRec>();
    for (const entry of saved.records) {
      const table = tableByCode(entry.tableCode);
      const zone = zoneOf(table);
      next.set(entry.session.id, {
        session: clone(entry.session),
        table,
        zone,
        menu: buildQrMenu({ table, zone }),
        cartVersion: entry.cartVersion,
        lines: clone(entry.lines),
        orders: clone(entry.orders),
        requests: clone(entry.requests),
        splits: clone(entry.splits),
        issues: clone(entry.issues),
        payments: new Map(
          clone(entry.payments).map((rec) => [rec.payment.id, rec]),
        ),
        review: clone(entry.review),
        paidIdr: entry.paidIdr,
        claimed: entry.claimed,
        placed: new Map(clone(entry.placed)),
      });
    }
    records.clear();
    for (const [id, rec] of next) records.set(id, rec);
    callerParticipantId = saved.callerParticipantId;
    orderSeq = saved.orderSeq;
  }

  return {
    scan,
    menuFor,
    view,
    addLine,
    updateLine,
    removeLine,
    quote,
    place,
    bill,
    createSplits,
    createRequest,
    startPayment,
    getPayment,
    issues,
    chooseResolution,
    reviewEligibility,
    submitReview,
    pointClaim,
    claim,
    suggestions,
    orderEtas,
    setGuest,
    snapshot,
    restore,
    allocate: allocateIdr,
  };
}

export type MockEngine = ReturnType<typeof createEngine>;
