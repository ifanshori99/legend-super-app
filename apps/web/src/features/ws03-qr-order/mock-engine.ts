// In-memory "server" behind VITE_API_MOCK for the QR order journey: the guest
// cart, quote, payments, split bill, waiter calls, failed-item recovery, review
// and point claim. It enforces the same rules the real API will (version
// conflicts, sold-out items, closed sessions, exact split sums) and takes every
// fixture from @starter/shared/qr-order.
//
// Sessions, orders, splits, waiter calls and table QR are NOT private to this
// file: they live in the shared WS-03 floor engine (../../lib/mock/ws03), the
// same instance the floor board and floor editor mocks bind to, so a scan, a
// merge or a layout edit is one truth (bead legend-jzud). This engine keeps the
// guest-only state: menu, cart lines, payment intents, review and point claim.
// Relative imports only: Node tests load it directly.
import { allocateIdr, idr, type Idr } from "@starter/shared/core";
import {
  computeQuote,
  createGuestPaymentInputSchema,
  GOOGLE_REVIEW_MIN_RATING,
  splitBill,
  tableSessionTokenExpiresAt,
  type BillSplit,
  type CartLine,
  type FloorZone,
  type GuestOrderIssue,
  type GuestPayment,
  type GuestPaymentMethod,
  type GuestPaymentOptions,
  type GuestPaymentTarget,
  type PointClaim,
  type SplitClaim,
  type QrMenu,
  type QrMenuItem,
  type QrMenuTheme,
  type QrOrder,
  type ServiceRequest,
  type Table,
  type TableReview,
  type TableSession,
  type TableSessionView,
} from "@starter/shared/qr-order";
import {
  buildQrMenu,
  cafeLegendTaxRules,
  guestOrderIssueFixtures,
  hidePhotoLessMenuItems,
  pointClaimFixture,
  qrOrderFixtures as F,
  quoteConfigForZone,
} from "@starter/shared/qr-order/sample";
import {
  legacyPhotoMissingItem,
  legacyPhotoMissingPrice,
} from "@starter/shared/menu";
import { ApiError } from "../../lib/api/errors.ts";
import { demoMenuPhoto } from "../../lib/mock/demo-photos.ts";
import { getScenario } from "../../lib/mock/control.ts";
import {
  createWs03Engine,
  type FloorSnapshot,
  type Ws03Engine,
} from "../../lib/mock/ws03/engine.ts";
import { orderHasPaidShare, splitScope } from "./domain.ts";

const STAFF_USER = "00000000-0000-4000-8000-000000009001";
const EARN_SPEND_IDR = 10_000; // fixture loyalty program earnRate: 1 point / Rp10.000
/** A mock payment settles this long after it is created (webhook stand-in). */
export const MOCK_PAYMENT_SETTLE_MS = 4000;
/** Mock stand-in for DOIT's VA channel list (prefix shapes the number). */
const MOCK_VA_BANKS = [
  { code: "bmri", name: "Mandiri", prefix: "8890" },
  { code: "bnia", name: "BNI", prefix: "8808" },
  { code: "brin", name: "BRI", prefix: "2620" },
  { code: "permata", name: "Permata", prefix: "8528" },
] as const;
const VA_WINDOW_MS = 24 * 60 * 60_000;
/** Mock stand-in for Duitku's e-wallet channels (C2b, legend-osqou.4). */
const MOCK_EWALLETS = [
  { code: "OV", name: "OVO" },
  { code: "DA", name: "DANA" },
  { code: "SA", name: "ShopeePay" },
  { code: "LA", name: "LinkAja" },
] as const;

/**
 * Duitku switches of the mock (cookie `legend-mock-duitku`, read in mock.ts):
 * `partial` = the outlet has only QRIS, DANA and ShopeePay on; `open-fail` =
 * opening an e-wallet or card payment fails; `pending`, `failed`, `expired` =
 * what the gateway reports for an e-wallet or card payment instead of paid;
 * `late-paid` = failed first, paid 20 s later (a late settlement), `refunded` =
 * paid then refunded, `no-login` = the guest's session is not in this tab (401),
 * `down` = the payment lookup answers 503.
 */
export type MockDuitkuMode =
  | "normal"
  | "partial"
  | "open-fail"
  | "pending"
  | "failed"
  | "expired"
  | "late-paid"
  | "refunded"
  | "no-login"
  | "down";

/** `late-paid`: how long the mock gateway reports "failed" before "paid". */
export const MOCK_LATE_PAID_AFTER_MS = 20_000;

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

type PaymentRec = {
  payment: GuestPayment;
  createdMs: number;
  applied: boolean;
  /** Split part payments only: the payer's own proof (legend-r77pq). */
  payerSecret?: string;
  /** The claim token of this paid part was handed out once (wwyyk). */
  claimIssued?: boolean;
};

type PlacedResult = {
  order: QrOrder;
  quote: ReturnType<typeof computeQuote>;
  session: TableSession;
};

/** Mock-only kitchen simulation for orders the guest placed (not API state). */
type OrderMeta = {
  firedAtMs: number | null;
  simulate: boolean;
};

/** Guest-only state for one table session. */
type GuestRec = {
  sessionId: string;
  cartVersion: number;
  lines: CartLine[];
  issues: GuestOrderIssue[];
  payments: Map<string, PaymentRec>;
  review: TableReview | null;
  claimed: boolean;
  placed: Map<string, PlacedResult>;
};

const iso = (ms: number) => new Date(ms).toISOString();

/** Bumped when the serialized shape changes; stale browser snapshots are dropped. */
export const ENGINE_SNAPSHOT_VERSION = 2;

type GuestSnapshot = {
  sessionId: string;
  cartVersion: number;
  lines: CartLine[];
  issues: GuestOrderIssue[];
  payments: PaymentRec[];
  review: TableReview | null;
  claimed: boolean;
  placed: [string, PlacedResult][];
};

/** Serialized engine state kept in sessionStorage so a page reload keeps the table session. */
export type QrEngineSnapshot = {
  version: typeof ENGINE_SNAPSHOT_VERSION;
  callerParticipantId: string | null;
  orderSeq: number;
  /** Sessions, orders, splits, calls and QR: one truth shared with the board. */
  floor: FloorSnapshot;
  guest: GuestSnapshot[];
  /** Mock kitchen simulation, keyed by order id. */
  orders: [string, OrderMeta][];
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function conflict(code: string, message: string): never {
  throw new ApiError(409, code, message);
}

function isActive(session: TableSession): boolean {
  return session.status !== "closed" && session.status !== "voided";
}

/**
 * Sample active Tenant Theme (blue, not the rust Base Theme) so the mock QR menu
 * shows the brand colors, font and corners of `menu.theme`.
 *
 * "Demo tema tenant": only the demo table below gets it. Every other mock menu
 * carries no theme, so the QR journey keeps its default brown look.
 */
export const mockTenantTheme: QrMenuTheme = {
  tokens: {
    light: {
      primary: "#1d4ed8",
      "primary-foreground": "#ffffff",
      brand: "#1d4ed8",
      "brand-foreground": "#ffffff",
      "brand-subtle": "#dbeafe",
    },
    dark: {
      primary: "#60a5fa",
      "primary-foreground": "#0b1b3a",
      brand: "#60a5fa",
      "brand-foreground": "#0b1b3a",
      "brand-subtle": "#172554",
    },
  },
  fontFamily: "inter",
  corners: "lembut",
  logoUrl: null,
};

/** Demo tema tenant: the one mock table (A01, token `freeTable`) with the blue theme. */
export const MOCK_TENANT_THEME_DEMO_TABLE_CODE = "A01";

/**
 * legend-qf0i (owner Q23): the guest copy of the menu hides every active item
 * without a photo, the same rule the API read applies in SQL. With
 * `?mock=photo-missing` the legacy row is injected *before* the filter, so the
 * demo can prove the item exists (back office shows it with the "Foto wajib"
 * badge) while a guest never sees it.
 */
function guestMenu(table: Table, zone: FloorZone): QrMenu {
  const menu = buildQrMenu({ table, zone }, { photoFor: demoMenuPhoto });
  const withLegacy =
    getScenario() === "photo-missing"
      ? { ...menu, items: [...menu.items, legacyGuestItem(menu)] }
      : menu;
  const guest = hidePhotoLessMenuItems(withLegacy);
  return table.code === MOCK_TENANT_THEME_DEMO_TABLE_CODE
    ? { ...guest, theme: mockTenantTheme }
    : guest;
}

/** The legacy row as a guest menu item: active, priced, and without a photo. */
function legacyGuestItem(menu: QrMenu): QrMenuItem {
  const category = menu.categories[0];
  if (!category) throw new RangeError("The menu fixtures need a category");
  return {
    id: legacyPhotoMissingItem.id,
    categoryId: category.id,
    name: legacyPhotoMissingItem.name,
    description: legacyPhotoMissingItem.description,
    type: legacyPhotoMissingItem.type,
    priceIdr: legacyPhotoMissingPrice.priceIdr,
    labels: legacyPhotoMissingItem.labels,
    allergens: legacyPhotoMissingItem.allergens,
    photoUrl: null,
    variants: [],
    modifierGroups: [],
    status: "available",
    sortOrder: legacyPhotoMissingItem.sortOrder,
  };
}

/**
 * The QR guest engine. Pass the shared floor engine in the browser mock; the
 * default keeps one floor per engine for the Node contract test.
 */
export function createEngine(
  clock: Clock = Date.now,
  floor: Ws03Engine = createWs03Engine(clock),
) {
  const guest = new Map<string, GuestRec>();
  /** Order id → mock kitchen simulation; the shared floor keeps plain orders. */
  const orderMeta = new Map<string, OrderMeta>();
  let callerParticipantId: string | null = null;
  let orderSeq = 43;

  const tableOfSession = (session: TableSession): Table =>
    floor.tableOfSession(session);
  const zoneOfTable = (table: Table) => floor.zoneOf(table);
  const menuOf = (session: TableSession): QrMenu => {
    const table = tableOfSession(session);
    return guestMenu(table, zoneOfTable(table));
  };

  /** The session behind a guest call; closed sessions are gone for guests. */
  function sessionOf(sessionId: string): TableSession {
    const session = floor.state.sessions[sessionId];
    if (!session || !isActive(session))
      throw new ApiError(404, "NOT_FOUND", "Sesi meja tidak ditemukan.");
    return session;
  }

  function emptyRec(sessionId: string): GuestRec {
    return {
      sessionId,
      cartVersion: 0,
      lines: [],
      issues: [],
      payments: new Map(),
      review: null,
      claimed: false,
      placed: new Map(),
    };
  }

  function recOf(sessionId: string): GuestRec {
    sessionOf(sessionId); // 404 when the session is unknown or closed
    let rec = guest.get(sessionId);
    if (!rec) {
      rec = emptyRec(sessionId);
      guest.set(sessionId, rec);
    }
    return rec;
  }

  // ---- Seed from the fixtures -------------------------------------------
  {
    // The shared floor engine seeds the sessions/orders/splits; this adds the
    // guest-only state the QR fixtures describe.
    const a03 = floor.sessionOf(F.sessions[0].id);
    const a03Rec = emptyRec(a03.id);
    a03Rec.lines = clone(F.cart.lines);
    a03Rec.cartVersion = F.cart.version;
    // A guest added "Sup Buntut" before it sold out: checkout removes it (ORD-05).
    const soldOutItem = menuOf(a03).items.find(
      (item) => item.status !== "available",
    );
    if (soldOutItem) {
      const at = "2026-11-01T05:08:00.000Z";
      a03Rec.lines.push({
        id: uuid() as CartLine["id"],
        tenantId: a03.tenantId,
        outletId: a03.outletId,
        tableSessionId: a03.id,
        menuItemId: soldOutItem.id,
        variantId: null,
        name: soldOutItem.name,
        quantity: 1,
        modifiers: [],
        note: null,
        unitPriceIdr: soldOutItem.priceIdr,
        modifiersTotalIdr: idr(0),
        lineTotalIdr: soldOutItem.priceIdr,
        addedByParticipantId: a03.participants[1]?.id ?? null,
        addedAt: at,
        updatedAt: at,
      } as CartLine);
      a03Rec.cartVersion += 1;
    }
    guest.set(a03.id, a03Rec);

    const p1 = emptyRec(F.sessions[1].id);
    p1.issues = clone(guestOrderIssueFixtures);
    guest.set(p1.sessionId, p1);
  }

  function usable(session: TableSession): void {
    if (!isActive(session))
      conflict(
        "SESSION_CLOSED",
        "Sesi meja ini sudah ditutup. Scan ulang QR di meja.",
      );
  }

  // ---- Scan -----------------------------------------------------------------
  function scan(input: { qrToken: string; pax: number; deviceHash: string }) {
    const joined = floor.openOrJoinTableSession(input);
    callerParticipantId = joined.participant.id;
    const menu = guestMenu(joined.table, joined.zone);
    const session = joined.session;
    return {
      outcome: joined.outcome,
      table: joined.table,
      zone: joined.zone,
      outlet: F.scanResult.outlet,
      brand: F.scanResult.brand,
      session: clone(session),
      sessionToken: `st_${rand("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789_-", 32)}`,
      // ORD-04: at most 12 h from the session open and never past the close.
      sessionTokenExpiresAt: tableSessionTokenExpiresAt(session),
      menuUpdatedAt: menu.menuUpdatedAt,
      soldOutItemIds: menu.items
        .filter((item) => item.status !== "available")
        .map((item) => item.id),
      serverTime: iso(clock()),
    };
  }

  function menuFor(qrToken: string): QrMenu {
    const table = floor.tableForToken(qrToken);
    return clone(guestMenu(table, zoneOfTable(table)));
  }

  // ---- Cart -------------------------------------------------------------------
  const itemOf = (menu: QrMenu, id: string): QrMenuItem => {
    const item = menu.items.find((entry) => entry.id === id);
    if (!item) throw new ApiError(404, "NOT_FOUND", "Menu tidak ditemukan.");
    return item;
  };

  function checkVersion(rec: GuestRec, expected: number) {
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
    if (item.status !== "available")
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

  function cartOf(rec: GuestRec) {
    return {
      sessionId: rec.sessionId,
      version: rec.cartVersion,
      lines: clone(rec.lines),
      updatedAt: iso(clock()),
    };
  }

  function touch(rec: GuestRec) {
    rec.cartVersion += 1;
    floor.touchSession(rec.sessionId);
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
    const session = sessionOf(sessionId);
    usable(session);
    checkVersion(rec, body.expectedCartVersion);
    const item = itemOf(menuOf(session), body.menuItemId);
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
        tenantId: session.tenantId,
        outletId: session.outletId,
        tableSessionId: session.id,
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

  function lineOf(rec: GuestRec, lineId: string): CartLine {
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
    usable(sessionOf(sessionId));
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
    usable(sessionOf(sessionId));
    checkVersion(rec, expectedCartVersion);
    lineOf(rec, lineId);
    rec.lines = rec.lines.filter((entry) => entry.id !== lineId);
    touch(rec);
    return { cart: cartOf(rec), line: null };
  }

  // ---- Quote ----------------------------------------------------------------
  const taxRuleId = cafeLegendTaxRules[0].id;

  function orderableLines(session: TableSession, rec: GuestRec) {
    const menu = menuOf(session);
    const live: CartLine[] = [];
    const removed: CartLine[] = [];
    for (const line of rec.lines) {
      const item = menu.items.find((entry) => entry.id === line.menuItemId);
      if (!item || item.status !== "available") removed.push(line);
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
    const session = sessionOf(sessionId);
    const rec = recOf(sessionId);
    const { live, removed } = orderableLines(session, rec);
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
        sessionId: session.id,
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
        config: quoteConfigForZone(zoneOfTable(tableOfSession(session))),
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
  function simulatedOrder(order: QrOrder): QrOrder {
    const out = clone(order);
    const meta = orderMeta.get(order.id);
    if (meta?.simulate && meta.firedAtMs !== null) {
      const elapsed = clock() - meta.firedAtMs;
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

  function visibleRequests(sessionId: string): ServiceRequest[] {
    const now = clock();
    const out: ServiceRequest[] = [];
    for (const entry of floor.requestsOf(sessionId)) {
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
    const session = sessionOf(sessionId);
    const empty = scenario === "empty";
    const lines = empty ? [] : rec.lines;
    const cart = { ...cartOf(rec), lines: clone(lines) };
    return {
      session: clone(session),
      cart,
      quote: lines.length > 0 ? quote(sessionId) : null,
      orders: empty
        ? []
        : floor.ordersOf(sessionId).map((order) => simulatedOrder(order)),
      openServiceRequests: empty ? [] : visibleRequests(sessionId),
      // WS-02: the demo outlet has no edge node, or its link is down.
      orderingAvailable: scenario !== "edge-down",
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
    const session = sessionOf(sessionId);
    const replay = rec.placed.get(body.idempotencyKey);
    if (replay)
      return clone({
        ...replay,
        kitchenFire:
          replay.order.status === "sent"
            ? ("fired" as const)
            : ("held_for_payment" as const),
      });
    usable(session);
    checkVersion(rec, body.expectedCartVersion);
    if (
      session.paymentMode === "open_bill" &&
      session.status === "pending_confirmation"
    )
      conflict(
        "SESSION_NOT_CONFIRMED",
        "Waiter belum mengonfirmasi meja ini. Tunggu sebentar.",
      );
    const menu = menuOf(session);
    const { live } = orderableLines(session, rec);
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
    const payFirst = session.paymentMode === "pay_first";
    const orderId = ulid() as QrOrder["id"];
    orderSeq += 1;
    const items = live.map((line) => ({
      id: ulid() as QrOrder["items"][number]["id"],
      tenantId: session.tenantId,
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
        menu.items.find((entry) => entry.id === line.menuItemId)?.type ===
        "combo"
          ? null
          : null,
      fireStatus: (payFirst ? "held" : "fired") as "held" | "fired",
      status: "queued" as const,
    }));
    const order: QrOrder = {
      id: orderId,
      tenantId: session.tenantId,
      outletId: session.outletId,
      number: `QR-20261101-${String(orderSeq).padStart(4, "0")}`,
      channel: "qr",
      serviceType: "dine_in",
      tableSessionId: session.id,
      customerProfileId: null,
      subtotalIdr: q.subtotalIdr,
      discountIdr: q.discountIdr,
      serviceChargeIdr: q.serviceCharge.amountIdr,
      taxIdr: q.taxIdr,
      roundingIdr: q.rounding.adjustmentIdr,
      totalIdr: q.totalIdr,
      pricesIncludeTaxAndService: q.pricesIncludeTaxAndService,
      swapReplacementIdr: idr(0),
      status: payFirst ? "awaiting_payment" : "sent",
      items,
      createdAt: iso(now),
      placedAt: iso(now),
    };
    floor.ordersOf(session.id).push(order);
    orderMeta.set(order.id, {
      firedAtMs: payFirst ? null : now,
      simulate: true,
    });
    rec.lines = [];
    touch(rec);
    const result = {
      order: simulatedOrder(order),
      quote: q,
      session: clone(session),
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
  const settledOrders = (sessionId: string) =>
    floor.ordersOf(sessionId).filter((order) => order.status !== "voided");

  function bill(sessionId: string) {
    const current = floor.billFor(sessionId);
    return clone({
      ...current,
      orders: current.orders.map((order) => simulatedOrder(order)),
    });
  }

  function createSplits(
    sessionId: string,
    body: Parameters<typeof splitBill>[0] extends never
      ? never
      : Record<string, unknown>,
  ) {
    const session = sessionOf(sessionId);
    usable(session);
    const splits = floor.splitsOf(sessionId);
    if (splits.some((s) => s.status === "paid"))
      conflict(
        "SPLIT_LOCKED",
        "Sebagian bagian sudah dibayar, pembagian tidak bisa diubah.",
      );
    const allOrders = settledOrders(sessionId);
    if (allOrders.length === 0)
      throw new ApiError(
        422,
        "NOTHING_TO_SPLIT",
        "Belum ada pesanan yang bisa dibagi.",
      );
    // Same scope as the bill screen's preview (domain.ts splitScope): the one
    // order waiting for payment, like the server (ORD-06 pay-first).
    const scope = splitScope(allOrders);
    if (!scope) {
      const awaitingCount = allOrders.filter(
        (order) => order.status === "awaiting_payment",
      ).length;
      if (awaitingCount === 0)
        throw new ApiError(
          422,
          "NOTHING_TO_SPLIT",
          "Tidak ada pesanan yang menunggu pembayaran untuk dibagi.",
        );
      conflict(
        "CONFLICT",
        "Ada lebih dari satu pesanan yang menunggu pembayaran.",
      );
    }
    const orders = scope.orders;
    const target = scope.orders[0];
    const totalIdr = idr(scope.totalIdr) as Idr;
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
    for (const old of splits)
      if (old.status === "pending") old.status = "voided";
    const created: BillSplit[] = drafts.map((draft) => ({
      id: uuid() as BillSplit["id"],
      tenantId: session.tenantId,
      outletId: session.outletId,
      tableSessionId: session.id,
      orderId: target.id,
      method: draft.method,
      shareIndex: draft.shareIndex,
      amountIdr: draft.amountIdr,
      status: "pending",
      label: draft.label,
      itemIds: [...draft.itemIds] as BillSplit["itemIds"],
      participantId: draft.participantId as BillSplit["participantId"],
      createdAt: iso(clock()),
    }));
    splits.push(...created);
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
    const session = sessionOf(sessionId);
    usable(session);
    return clone(floor.createServiceRequest(sessionId, body));
  }

  // ---- Payments -------------------------------------------------------------
  function amountFor(
    session: TableSession,
    target: GuestPaymentTarget,
  ): number {
    if (target.kind === "order") {
      const order = floor
        .ordersOf(session.id)
        .find((o) => o.id === target.orderId);
      if (!order)
        throw new ApiError(404, "NOT_FOUND", "Pesanan tidak ditemukan.");
      if (order.status !== "awaiting_payment")
        conflict("ALREADY_PAID", "Pesanan ini sudah dibayar.");
      // A paid share means the order is being paid per person (ORD-06).
      if (orderHasPaidShare(floor.splitsOf(session.id), order.id))
        conflict(
          "SPLIT_LOCKED",
          "Pesanan ini sudah dibagi dan sebagian sudah dibayar. Bayar bagian Anda di Tagihan.",
        );
      return order.totalIdr;
    }
    if (target.kind === "split") {
      const split = floor
        .splitsOf(session.id)
        .find((s) => s.id === target.billSplitId);
      if (!split)
        throw new ApiError(404, "NOT_FOUND", "Bagian tagihan tidak ditemukan.");
      if (split.status !== "pending")
        conflict("ALREADY_PAID", "Bagian ini sudah dibayar.");
      return split.amountIdr;
    }
    const outstanding = bill(session.id).totals.outstandingIdr;
    if (outstanding <= 0) conflict("ALREADY_PAID", "Tagihan sudah lunas.");
    return outstanding;
  }

  /**
   * VA is on unless `vaDown` (cookie switch in mock.ts); `emptyBanks` is the
   * provider listing no VA bank (`no_channels`).
   */
  function paymentOptions(
    sessionId: string,
    flags: {
      vaDown?: boolean;
      emptyBanks?: boolean;
      duitku?: MockDuitkuMode;
    } = {},
  ): GuestPaymentOptions {
    sessionOf(sessionId);
    const partial = flags.duitku === "partial";
    const off = flags.vaDown
      ? ("gateway_down" as const)
      : flags.emptyBanks
        ? ("no_channels" as const)
        : partial
          ? ("routing_disabled" as const)
          : null;
    const wallets = MOCK_EWALLETS.filter(
      (wallet) => !partial || wallet.code === "DA" || wallet.code === "SA",
    ).map(({ code, name }) => ({ code, name }));
    return {
      methods: [
        { method: "qris", enabled: true, unavailableReason: null, banks: [] },
        {
          method: "ewallet",
          enabled: true,
          unavailableReason: null,
          banks: wallets,
        },
        partial
          ? {
              method: "card",
              enabled: false,
              unavailableReason: "routing_disabled",
              banks: [],
            }
          : {
              method: "card",
              enabled: true,
              unavailableReason: null,
              banks: [],
            },
        off
          ? { method: "va", enabled: false, unavailableReason: off, banks: [] }
          : {
              method: "va",
              enabled: true,
              unavailableReason: null,
              banks: MOCK_VA_BANKS.map(({ code, name }) => ({ code, name })),
            },
      ],
    };
  }

  /** 16 digits: bank prefix + 12 digits of the target (same order, same number). */
  function mockVaNumber(prefix: string, seed: string) {
    const digits = seed.replace(/\D/g, "").padStart(12, "0").slice(-12);
    return `${prefix}${digits}`;
  }

  function startPayment(
    sessionId: string,
    body: {
      target: GuestPaymentTarget;
      method: GuestPaymentMethod;
      bankCode?: string | null;
      payerSecret?: string;
      idempotencyKey: string;
    },
    flags: { duitku?: MockDuitkuMode } = {},
  ) {
    const session = sessionOf(sessionId);
    const rec = recOf(sessionId);
    usable(session);
    // Same input rules as the API (VA needs a bank, QRIS takes none).
    if (!createGuestPaymentInputSchema.safeParse(body).success)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Data pembayaran tidak valid.",
      );
    for (const entry of rec.payments.values())
      if (
        (entry.payment as { idemKey?: string }).idemKey === body.idempotencyKey
      ) {
        // A key replays only the request it was first used for.
        const sameRequest =
          entry.payment.method === body.method &&
          entry.payment.bankCode === (body.bankCode ?? null) &&
          JSON.stringify(entry.payment.target) === JSON.stringify(body.target);
        if (!sameRequest)
          conflict(
            "IDEMPOTENCY_CONFLICT",
            "Kunci ini sudah dipakai untuk pembayaran lain.",
          );
        return paymentView(entry);
      }
    const bank =
      body.method === "va"
        ? MOCK_VA_BANKS.find((item) => item.code === body.bankCode)
        : undefined;
    if (body.method === "va" && !bank)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Bank virtual account ini tidak tersedia; pilih bank lain.",
      );
    const wallet =
      body.method === "ewallet"
        ? MOCK_EWALLETS.find((item) => item.code === body.bankCode)
        : undefined;
    if (body.method === "ewallet" && !wallet)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "E-wallet ini tidak tersedia; pilih yang lain.",
      );
    const redirect = body.method === "ewallet" || body.method === "card";
    if (redirect && flags.duitku === "open-fail")
      throw new ApiError(
        503,
        "GATEWAY_UNAVAILABLE",
        "Halaman pembayaran belum bisa dibuka.",
      );
    const amount = amountFor(session, body.target);
    // Like the API: the same VA bank returns the live VA; another choice
    // supersedes it (QRIS after QRIS keeps the older mock behaviour).
    const targetKey = JSON.stringify(body.target);
    for (const entry of rec.payments.values()) {
      const live = entry.payment;
      if (
        live.status !== "pending" ||
        JSON.stringify(live.target) !== targetKey
      )
        continue;
      if (live.method === "va" && bank && live.bankCode === bank.code)
        return paymentView(entry);
      const liveRedirect = live.method === "ewallet" || live.method === "card";
      if (
        live.method === "va" ||
        body.method === "va" ||
        liveRedirect ||
        redirect
      )
        entry.payment = { ...live, status: "expired", redirectUrl: null };
    }
    const target = body.target;
    const seed =
      target.kind === "order"
        ? (floor.ordersOf(session.id).find((o) => o.id === target.orderId)
            ?.number ?? target.orderId)
        : target.kind === "split"
          ? target.billSplitId
          : session.id;
    const now = clock();
    const id = uuid();
    // Duitku sends the guest back to the single return page with these
    // parameters; the mock "page" is that return itself.
    const origin =
      typeof window === "undefined"
        ? "http://localhost"
        : window.location.origin;
    const payment = {
      id,
      target: body.target,
      method: body.method,
      amountIdr: idr(amount),
      status: "pending",
      qrisPayload:
        body.method === "qris"
          ? `00020101021226610016ID.CO.QRIS.WWW01189360091400${rand("0123456789", 10)}5204581253033605802ID5913Cafe Legend6007Bandung6304${rand("ABCDEF0123456789", 4)}`
          : null,
      redirectUrl: redirect
        ? `${origin}/bayar/kembali?merchantOrderId=${id}&resultCode=00&reference=MOCK${rand("0123456789", 8)}`
        : null,
      vaNumber: bank ? mockVaNumber(bank.prefix, seed) : null,
      bankCode: bank?.code ?? wallet?.code ?? null,
      bankName: bank?.name ?? wallet?.name ?? null,
      expiresAt: iso(now + (bank ? VA_WINDOW_MS : 15 * 60_000)),
      paidAt: null,
      idemKey: body.idempotencyKey,
    } as unknown as GuestPayment;
    const entry: PaymentRec = {
      payment,
      createdMs: now,
      applied: false,
      payerSecret: target.kind === "split" ? body.payerSecret : undefined,
    };
    rec.payments.set(payment.id, entry);
    return paymentView(entry);
  }

  function paymentView(entry: PaymentRec): GuestPayment {
    const out = clone(entry.payment) as GuestPayment & { idemKey?: string };
    delete out.idemKey;
    return out;
  }

  function settle(rec: GuestRec, entry: PaymentRec, now: number) {
    entry.applied = true;
    // Settling is lazy (first read after the delay), so the paid time is when it
    // was due, not when someone looked: the 24 h claim window counts from it.
    const paidMs = Math.min(now, entry.createdMs + MOCK_PAYMENT_SETTLE_MS);
    entry.payment = {
      ...entry.payment,
      status: "paid",
      paidAt: iso(paidMs),
      redirectUrl: null,
    };
    const target = entry.payment.target;
    const orders = floor.ordersOf(rec.sessionId);
    const splits = floor.splitsOf(rec.sessionId);
    if (target.kind === "order") {
      const order = orders.find((o) => o.id === target.orderId);
      if (order) {
        order.status = "sent";
        orderMeta.set(order.id, { firedAtMs: now, simulate: true });
        order.items = order.items.map((item) => ({
          ...item,
          fireStatus: "fired" as const,
        }));
        // ORD-02: only now does the kitchen see the order.
      }
      floor.addPaid(rec.sessionId, entry.payment.amountIdr);
      const share = splits.filter(
        (s) => s.orderId === target.orderId && s.status === "pending",
      );
      for (const s of share) s.status = "voided";
    } else if (target.kind === "split") {
      const split = splits.find((s) => s.id === target.billSplitId);
      if (split) {
        split.status = "paid";
        const order = orders.find((o) => o.id === split.orderId);
        if (order && order.status === "awaiting_payment") {
          const allPaid = splits
            .filter((s) => s.orderId === order.id && s.status !== "voided")
            .every((s) => s.status === "paid");
          if (allPaid) {
            order.status = "sent";
            orderMeta.set(order.id, { firedAtMs: now, simulate: true });
            order.items = order.items.map((item) => ({
              ...item,
              fireStatus: "fired" as const,
            }));
          }
        }
      }
      floor.addPaid(rec.sessionId, entry.payment.amountIdr);
    } else {
      floor.addPaid(rec.sessionId, entry.payment.amountIdr);
      for (const s of splits) if (s.status === "pending") s.status = "paid";
    }
  }

  function getPayment(
    sessionId: string,
    paymentId: string,
    flags: { duitku?: MockDuitkuMode } = {},
  ): GuestPayment {
    const rec = recOf(sessionId);
    const entry = rec.payments.get(paymentId);
    if (!entry)
      throw new ApiError(404, "NOT_FOUND", "Pembayaran tidak ditemukan.");
    const now = clock();
    const redirect =
      entry.payment.method === "ewallet" || entry.payment.method === "card";
    const outcome = flags.duitku;
    if (redirect && outcome === "no-login")
      throw new ApiError(401, "UNAUTHORIZED", "Sesi meja tidak ditemukan.");
    if (redirect && outcome === "down")
      throw new ApiError(503, "UNAVAILABLE", "Layanan sedang sibuk.");
    if (redirect && outcome === "late-paid") {
      const elapsed = now - entry.createdMs;
      if (
        elapsed >= MOCK_PAYMENT_SETTLE_MS &&
        elapsed < MOCK_PAYMENT_SETTLE_MS + MOCK_LATE_PAID_AFTER_MS &&
        entry.payment.status === "pending"
      )
        return { ...paymentView(entry), status: "failed", redirectUrl: null };
      if (
        elapsed >= MOCK_PAYMENT_SETTLE_MS + MOCK_LATE_PAID_AFTER_MS &&
        !entry.applied &&
        entry.payment.status === "pending"
      )
        settle(rec, entry, now);
      return paymentView(entry);
    }
    if (
      redirect &&
      outcome === "refunded" &&
      !entry.applied &&
      entry.payment.status === "pending" &&
      now - entry.createdMs >= MOCK_PAYMENT_SETTLE_MS
    ) {
      settle(rec, entry, now);
      entry.payment = { ...entry.payment, status: "refunded" };
      return paymentView(entry);
    }
    if (
      redirect &&
      (outcome === "pending" || outcome === "failed" || outcome === "expired")
    ) {
      if (
        outcome !== "pending" &&
        entry.payment.status === "pending" &&
        now - entry.createdMs >= MOCK_PAYMENT_SETTLE_MS
      )
        entry.payment = {
          ...entry.payment,
          status: outcome,
          redirectUrl: null,
        };
      return paymentView(entry);
    }
    if (
      !entry.applied &&
      entry.payment.status === "pending" &&
      now - entry.createdMs >= MOCK_PAYMENT_SETTLE_MS
    )
      settle(rec, entry, now);
    return paymentView(entry);
  }

  // ---- Split part claim (wwyyk) -----------------------------------------------
  /**
   * Claim token of one paid split part, proven by the payer secret kept at pay
   * time. Wrong, unknown or not-the-payer's: the same 404. A part not paid yet is
   * "unavailable", past 24 h after payment "expired". The token is handed out
   * once: a second ask for the same part answers "claimed" with no token, so a
   * part can never be attached twice (no double payout).
   */
  function splitClaim(
    sessionId: string,
    splitId: string,
    body: { payerSecret: string },
  ): SplitClaim {
    sessionOf(sessionId);
    const rec = recOf(sessionId);
    const notFound = () =>
      new ApiError(404, "NOT_FOUND", "Bagian ini tidak ditemukan.");
    const mine = [...rec.payments.values()].filter(
      (entry) =>
        entry.payment.target.kind === "split" &&
        entry.payment.target.billSplitId === splitId &&
        entry.payerSecret === body.payerSecret,
    );
    if (mine.length === 0) throw notFound();
    const now = clock();
    for (const entry of mine)
      if (
        !entry.applied &&
        entry.payment.status === "pending" &&
        now - entry.createdMs >= MOCK_PAYMENT_SETTLE_MS
      )
        settle(rec, entry, now);
    const paid = mine.find((entry) => entry.payment.status === "paid");
    const billSplitId = splitId as SplitClaim["billSplitId"];
    if (!paid || !paid.payment.paidAt)
      return {
        billSplitId,
        status: "unavailable",
        claimToken: null,
        claimableUntil: null,
      };
    const until = new Date(paid.payment.paidAt).getTime() + 24 * 3_600_000;
    const claimableUntil = iso(until) as SplitClaim["claimableUntil"];
    if (now >= until)
      return {
        billSplitId,
        status: "expired",
        claimToken: null,
        claimableUntil,
      };
    if (paid.claimIssued)
      return {
        billSplitId,
        status: "claimed",
        claimToken: null,
        claimableUntil,
      };
    paid.claimIssued = true;
    return {
      billSplitId,
      status: "available",
      claimToken: `sc_${rand(HEX, 32)}`,
      claimableUntil,
    };
  }

  // ---- Failed item recovery -------------------------------------------------
  function issues(sessionId: string, scenario?: string): GuestOrderIssue[] {
    return scenario === "empty" ? [] : clone(recOf(sessionId).issues);
  }

  function chooseResolution(
    orderIssueId: string,
    body: { choice: "swap" | "voucher"; replacementItemId?: string },
  ) {
    for (const rec of guest.values()) {
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
  function settled(sessionId: string): boolean {
    const b = bill(sessionId);
    return b.orders.length > 0 && b.totals.outstandingIdr === 0;
  }

  function reviewEligibility(sessionId: string) {
    const rec = recOf(sessionId);
    const session = sessionOf(sessionId);
    return {
      sessionId: session.id,
      eligible: settled(session.id),
      alreadySubmitted: rec.review !== null,
      googleReviewUrl: F.reviewEligibility.googleReviewUrl,
    };
  }

  function submitReview(
    sessionId: string,
    body: { rating: number; comment?: string },
  ) {
    const rec = recOf(sessionId);
    const session = sessionOf(sessionId);
    if (!settled(session.id))
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
      tenantId: session.tenantId,
      outletId: session.outletId,
      tableSessionId: session.id,
      participantId: callerParticipantId as TableReview["participantId"],
      rating: body.rating,
      comment: body.comment?.trim() ? body.comment.trim() : null,
      googleReviewPrompt: prompt,
      googleReviewUrl: prompt ? F.reviewEligibility.googleReviewUrl : null,
      submittedAt: iso(clock()),
    };
    return clone(rec.review);
  }

  function pointClaim(sessionId: string, guestUser: boolean): PointClaim {
    const session = sessionOf(sessionId);
    const rec = recOf(sessionId);
    if (
      session.id === pointClaimFixture.sessionId &&
      !rec.claimed &&
      !guestUser
    )
      // The shared fixture is a static contract example, so its deadline is a
      // fixed instant that the wall clock eventually passes. Serve it with the
      // same live 24 h window as every other claim, or the mock ages into
      // "expired" and the bill stops offering the claim (legend-woz ORD-06).
      return {
        ...clone(pointClaimFixture),
        claimableUntil: iso(clock() + 24 * 3_600_000),
      };
    const paidIdr = floor.paidOf(session.id);
    const ok = settled(session.id) && paidIdr > 0;
    const status = rec.claimed ? "claimed" : ok ? "available" : "unavailable";
    return {
      sessionId: session.id,
      status,
      paidIdr: idr(paidIdr),
      points: Math.floor(paidIdr / EARN_SPEND_IDR),
      claimableUntil:
        status === "available" ? iso(clock() + 24 * 3_600_000) : null,
      requiresLogin: guestUser,
    } as PointClaim;
  }

  function claim(sessionId: string, guestUser: boolean): PointClaim {
    const rec = recOf(sessionId);
    if (guestUser)
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
    const session = sessionOf(sessionId);
    const rec = recOf(sessionId);
    const menu = menuOf(session);
    const orderable = menu.items.filter((item) => item.status === "available");
    const categoryOf = (id: string) =>
      menu.categories.find(
        (c) => c.id === menu.items.find((i) => i.id === id)?.categoryId,
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
    const out = [];
    for (const order of floor.ordersOf(sessionId)) {
      const live = simulatedOrder(order);
      const items = live.items.filter((item) => item.status !== "voided");
      if (items.length === 0 || items.every((item) => item.status === "served"))
        continue;
      const min = 8 + Math.min(items.length, 12) * 2;
      const from =
        orderMeta.get(order.id)?.firedAtMs ??
        new Date(order.placedAt).getTime();
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
      floor: floor.snapshot(),
      orders: [...orderMeta.entries()],
      guest: [...guest.values()].map((rec) => ({
        sessionId: rec.sessionId,
        cartVersion: rec.cartVersion,
        lines: clone(rec.lines),
        issues: clone(rec.issues),
        payments: clone([...rec.payments.values()]),
        review: clone(rec.review),
        claimed: rec.claimed,
        placed: clone([...rec.placed.entries()]),
      })),
    };
  }

  /** Rebuilds the seeded and guest-created sessions from a browser snapshot. */
  function restore(saved: QrEngineSnapshot) {
    if (saved.version !== ENGINE_SNAPSHOT_VERSION)
      throw new RangeError("Snapshot mock QR tidak dikenal.");
    floor.restore(saved.floor);
    const next = new Map<string, GuestRec>();
    for (const entry of saved.guest) {
      if (!floor.state.sessions[entry.sessionId]) continue;
      next.set(entry.sessionId, {
        sessionId: entry.sessionId,
        cartVersion: entry.cartVersion,
        lines: clone(entry.lines),
        issues: clone(entry.issues),
        payments: new Map(
          clone(entry.payments).map((rec) => [rec.payment.id, rec]),
        ),
        review: clone(entry.review),
        claimed: entry.claimed,
        placed: new Map(clone(entry.placed)),
      });
    }
    guest.clear();
    for (const [id, rec] of next) guest.set(id, rec);
    orderMeta.clear();
    for (const [id, meta] of saved.orders ?? []) orderMeta.set(id, meta);
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
    paymentOptions,
    startPayment,
    getPayment,
    splitClaim,
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
