// One in-memory "server" for WS-03: the floor plan, table sessions, orders,
// splits, waiter calls and table QR. The floor board, the floor editor and the
// QR guest journey bind to this same state, so a scan, a staff confirmation, a
// merge, a re-split or a layout edit is seen everywhere (bead legend-jzud).
//
// Rules are the contract's (PRD §3 F9/F10): ORD-04 signed QR + session token,
// ORD-06 paid-share lock, ORD-10 close/merge/move guards, F9 layout guards.
// Every rule that the real API will enforce lives here once; the feature mocks
// only translate endpoints to calls. Pure TypeScript (relative `.ts` imports,
// no `@/` alias) so the Node contract test can load it directly.
import { createUlid, idr } from "@starter/shared/core";
import {
  canApplyTableStatusAction,
  canCloseTableSession,
  computeQuote,
  createFloorZoneInputSchema,
  createTableInputSchema,
  floorBoardSchema,
  floorZoneSchema,
  qrOrderSchema,
  saveFloorLayoutInputSchema,
  sessionBillSchema,
  tableLiveStatusSchema,
  tableQrSchema,
  tableSchema,
  tableSessionSchema,
  tableStatusActionTarget,
  updateFloorZoneInputSchema,
  updateTableInputSchema,
  type BillSplit,
  type FloorBoard,
  type FloorZone,
  type QrOrder,
  type QrOrderItem,
  type ServiceRequest,
  type Table,
  type TableLiveStatus,
  type TableQr,
  type TableSession,
  type TableStatusAction,
} from "@starter/shared/qr-order";
import {
  cafeLegendQrOrderFixtures,
  cafeLegendTaxRules,
  qrTokenTableCodes,
  quoteConfigForZone,
} from "@starter/shared/qr-order/sample";
import type { z } from "zod";
import { ApiError } from "../../api/errors.ts";
import { newIdempotencyKey } from "../../idempotency.ts";

const fixtures = cafeLegendQrOrderFixtures;
const outletId = fixtures.floorBoard.outletId;
const staffUserId = "00000000-0000-4000-8000-000000009001";

export type MockServiceRequest = {
  request: ServiceRequest;
  createdMs: number;
};

export type FloorState = {
  zones: FloorZone[];
  tables: Table[];
  /** Every session, including the closed ones the fixture keeps for history. */
  sessions: Record<string, TableSession>;
  /** Live binding: table id → session id. Merged tables point at one session. */
  bindings: Record<string, string>;
  orders: Record<string, QrOrder[]>;
  splits: Record<string, BillSplit[]>;
  /** Money settled per session, including full-bill QR payments (decision C2). */
  paidIdr: Record<string, number>;
  requests: Record<string, MockServiceRequest[]>;
  qr: Record<string, { qr: TableQr; generation: number }>;
};

/** Serialized floor state; the QR engine keeps it in its browser snapshot. */
export type FloorSnapshot = FloorState & { version: 1 };
export const FLOOR_SNAPSHOT_VERSION = 1;

const isActive = (session: TableSession) =>
  session.status !== "closed" && session.status !== "voided";

function seedState(clock: () => number): FloorState {
  // Clone everything: handlers mutate tables and replace sessions, and a reset
  // must start from the same fixtures again.
  const zones = structuredClone(fixtures.zones);
  const tables = structuredClone(fixtures.tables);
  const sessions: Record<string, TableSession> = {};
  for (const session of structuredClone(fixtures.sessions))
    sessions[session.id] = session;
  const orders: Record<string, QrOrder[]> = {};
  for (const order of structuredClone(fixtures.orders))
    (orders[order.tableSessionId] ??= []).push(order);
  const splits: Record<string, BillSplit[]> = {};
  for (const split of structuredClone(fixtures.billSplits))
    (splits[split.tableSessionId] ??= []).push(split);
  const bindings: Record<string, string> = {};
  const requests: Record<string, MockServiceRequest[]> = {};
  const qr: FloorState["qr"] = {};

  // Fixtures are dated 2026-11-01; shift running sessions to "now" so seat
  // durations and "opened at" read like a live service, not stale data.
  const nowMs = clock();
  const reference = Date.parse("2026-11-01T05:10:00.000Z");
  const at = (iso: string) =>
    new Date(nowMs + (Date.parse(iso) - reference)).toISOString();

  // A second running open-bill session makes merge/move/split reviewable: the
  // shared fixtures only have one running open-bill party (P1).
  const w02 = tables.find((table) => table.code === "W02");
  if (w02) {
    const extraId = "00000000-0000-4000-8000-000000000406";
    const scope = { tenantId: zones[0].tenantId, outletId };
    const joinedAt = at("2026-11-01T04:40:00.000Z");
    const extra = tableSessionSchema.parse({
      id: extraId,
      ...scope,
      tableId: w02.id,
      pax: 2,
      paymentMode: "open_bill",
      status: "open",
      confirmedBy: staffUserId,
      reservationId: null,
      participants: [
        {
          id: mintUuid(),
          tenantId: zones[0].tenantId,
          tableSessionId: extraId,
          deviceHash: "device-w02-guest-1",
          userId: null,
          joinedAt,
          lastSeenAt: at("2026-11-01T05:09:00.000Z"),
        },
      ],
      openedAt: joinedAt,
      closedAt: null,
      lastActivityAt: at("2026-11-01T05:09:00.000Z"),
      billRequestedAt: null,
      closedReason: null,
    });
    sessions[extra.id] = extra;
    w02.status = "occupied";
    const template = fixtures.orders[0];
    if (template) {
      const orderId = createUlid() as QrOrder["id"];
      // W02 runs inclusive prices (harga nett, legend-zmc2) so the guest bill
      // and receipt show service and tax as "termasuk" in mock mode.
      const inclusiveQuote = computeQuote({
        sessionId: extra.id,
        cartVersion: 1,
        lines: template.items.map((item) => ({
          cartLineId: newIdempotencyKey(),
          menuItemId: item.menuItemId,
          name: item.name,
          quantity: item.quantity,
          unitPriceIdr: item.unitPriceIdr,
          modifiersTotalIdr: item.modifiersTotalIdr,
          taxRuleId: cafeLegendTaxRules[0].id,
        })),
        config: {
          ...quoteConfigForZone(zones[0]),
          pricesIncludeTaxAndService: true,
        },
        computedAt: new Date(nowMs).toISOString(),
      });
      orders[extra.id] = [
        qrOrderSchema.parse({
          ...structuredClone(template),
          id: orderId,
          number: "QR-20261101-0043",
          tableSessionId: extra.id,
          // Pay-first (ORD-06): the guest split scope is the one order waiting
          // for payment (legend-jzud), so the seeded W02 order awaits payment.
          status: "awaiting_payment",
          subtotalIdr: inclusiveQuote.subtotalIdr,
          discountIdr: inclusiveQuote.discountIdr,
          serviceChargeIdr: inclusiveQuote.serviceCharge.amountIdr,
          taxIdr: inclusiveQuote.taxIdr,
          roundingIdr: inclusiveQuote.rounding.adjustmentIdr,
          totalIdr: inclusiveQuote.totalIdr,
          pricesIncludeTaxAndService: true,
          items: template.items.map((item) => ({
            ...structuredClone(item),
            id: createUlid() as QrOrderItem["id"],
            orderId,
          })),
        }),
      ];
    }
  }

  // Open-bill conversion (bead legend-8cm4) needs running pay-first tables to
  // review: B01 owes a small bill (below the Rp3.000.000 default limit) and A02
  // owes one over it. The shared fixtures have no pay-first order or session
  // for either table.
  const payFirstTemplate = fixtures.orders[0];
  const seedPayFirstOrder = (
    sessionId: string,
    zone: FloorZone,
    number: string,
    scale: number,
  ) => {
    if (!payFirstTemplate) return;
    const orderId = createUlid() as QrOrder["id"];
    const quote = computeQuote({
      sessionId,
      cartVersion: 1,
      lines: payFirstTemplate.items.map((item) => ({
        cartLineId: newIdempotencyKey(),
        menuItemId: item.menuItemId,
        name: item.name,
        quantity: item.quantity * scale,
        unitPriceIdr: item.unitPriceIdr,
        modifiersTotalIdr: item.modifiersTotalIdr,
        taxRuleId: cafeLegendTaxRules[0].id,
      })),
      config: quoteConfigForZone(zone),
      computedAt: payFirstTemplate.createdAt,
    });
    orders[sessionId] = [
      qrOrderSchema.parse({
        ...structuredClone(payFirstTemplate),
        id: orderId,
        number,
        tableSessionId: sessionId,
        subtotalIdr: quote.subtotalIdr,
        discountIdr: quote.discountIdr,
        serviceChargeIdr: quote.serviceCharge.amountIdr,
        taxIdr: quote.taxIdr,
        roundingIdr: quote.rounding.adjustmentIdr,
        totalIdr: quote.totalIdr,
        items: payFirstTemplate.items.map((item) => ({
          ...structuredClone(item),
          id: createUlid() as QrOrderItem["id"],
          orderId,
          quantity: item.quantity * scale,
          lineTotalIdr: idr(
            (item.unitPriceIdr + item.modifiersTotalIdr) *
              item.quantity *
              scale,
          ),
        })),
      }),
    ];
  };
  const seedPayFirstSession = (
    table: Table,
    sessionId: string,
    orderNumber: string,
    scale: number,
  ) => {
    const zone = zones.find((entry) => entry.id === table.zoneId) ?? zones[0];
    const scope = { tenantId: zones[0].tenantId, outletId };
    const joinedAt = "2026-11-01T04:00:00.000Z";
    const lastSeenAt = "2026-11-01T05:08:00.000Z";
    sessions[sessionId] = tableSessionSchema.parse({
      id: sessionId,
      ...scope,
      tableId: table.id,
      pax: 2,
      paymentMode: "pay_first",
      status: "open",
      confirmedBy: null,
      reservationId: null,
      participants: [
        {
          id: mintUuid(),
          tenantId: zones[0].tenantId,
          tableSessionId: sessionId,
          deviceHash: `device-${table.code.toLowerCase()}-guest-1`,
          userId: null,
          joinedAt,
          lastSeenAt,
        },
      ],
      openedAt: joinedAt,
      closedAt: null,
      lastActivityAt: lastSeenAt,
      billRequestedAt: null,
      closedReason: null,
    });
    table.status = "occupied";
    seedPayFirstOrder(sessionId, zone, orderNumber, scale);
  };
  const b01 = tables.find((table) => table.code === "B01");
  let b01SessionId: string | null = null;
  if (b01) {
    b01SessionId = "00000000-0000-4000-8000-000000000408";
    seedPayFirstSession(b01, b01SessionId, "QR-20261101-0044", 1);
  }
  const a02 = tables.find((table) => table.code === "A02");
  let a02SessionId: string | null = null;
  if (a02) {
    a02SessionId = "00000000-0000-4000-8000-000000000407";
    seedPayFirstSession(a02, a02SessionId, "QR-20261101-0045", 16);
  }

  for (const row of fixtures.floorBoard.tables) {
    if (row.session) bindings[row.table.id] = row.session.id;
  }
  if (w02) {
    const extra = Object.values(sessions).find(
      (session) => session.tableId === w02.id,
    );
    if (extra) bindings[w02.id] = extra.id;
  }
  if (a02 && a02SessionId) bindings[a02.id] = a02SessionId;
  if (b01 && b01SessionId) bindings[b01.id] = b01SessionId;

  for (const session of Object.values(sessions)) {
    if (!isActive(session)) continue;
    session.openedAt = at(session.openedAt);
    session.lastActivityAt = at(session.lastActivityAt);
    if (session.billRequestedAt)
      session.billRequestedAt = at(session.billRequestedAt);
    session.participants = session.participants.map((participant) => ({
      ...participant,
      joinedAt: at(participant.joinedAt),
      lastSeenAt: at(participant.lastSeenAt),
    }));
  }
  for (const list of Object.values(orders))
    for (const order of list) {
      order.createdAt = at(order.createdAt);
      order.placedAt = at(order.placedAt);
    }
  for (const list of Object.values(splits))
    for (const split of list) split.createdAt = at(split.createdAt);

  for (const request of structuredClone(fixtures.serviceRequests)) {
    (requests[request.tableSessionId] ??= []).push({
      request,
      createdMs: Date.parse(at(request.createdAt)),
    });
  }

  const paidIdr: Record<string, number> = {};
  for (const list of Object.values(splits))
    for (const split of list)
      if (split.status === "paid")
        paidIdr[split.tableSessionId] =
          (paidIdr[split.tableSessionId] ?? 0) + split.amountIdr;

  return {
    zones,
    tables,
    sessions,
    bindings,
    orders,
    splits,
    paidIdr,
    requests,
    qr,
  };
}

const mintUuid = () => newIdempotencyKey();

function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

function conflict(code: string, message: string): never {
  throw new ApiError(409, code, message);
}

/**
 * The WS-03 mock server. One instance per mock runtime (browser/SSR) and one
 * per QR engine in the Node contract test.
 */
export function createWs03Engine(clock: () => number = Date.now) {
  const state: FloorState = seedState(clock);
  const nowIso = () => new Date(clock()).toISOString();
  /** New rows keep clear of fixture ids (which stay below 900000). */
  let sequence = 900_000;

  // ---- Lookups ------------------------------------------------------------
  const tableOf = (tableId: string): Table =>
    state.tables.find((table) => table.id === tableId) ?? notFound("Meja");

  const tableByCode = (code: string): Table =>
    state.tables.find((table) => table.code === code) ??
    notFound(`Meja ${code}`);

  const zoneOfId = (zoneId: string): FloorZone =>
    state.zones.find((zone) => zone.id === zoneId) ?? notFound("Zona");

  const zoneOf = (table: Table): FloorZone => zoneOfId(table.zoneId);

  const sessionOf = (sessionId: string): TableSession =>
    state.sessions[sessionId] ?? notFound("Sesi meja");

  const activeSessionOfTable = (tableId: string): TableSession | null => {
    const sessionId = state.bindings[tableId];
    if (!sessionId) return null;
    const session = state.sessions[sessionId];
    return session && isActive(session) ? session : null;
  };

  const tableOfSession = (session: TableSession): Table => {
    // After a merge the session keeps its original tableId; the board binds the
    // merged tables to it explicitly, so prefer a live binding that still exists.
    const bound = state.tables.find(
      (table) => state.bindings[table.id] === session.id,
    );
    return bound ?? tableOf(session.tableId);
  };

  const tableOfSessionId = (sessionId: string): string =>
    tableOfSession(sessionOf(sessionId)).id;

  const ordersOf = (sessionId: string): QrOrder[] =>
    (state.orders[sessionId] ??= []);

  const splitsOf = (sessionId: string): BillSplit[] =>
    (state.splits[sessionId] ??= []);

  const requestsOf = (sessionId: string): MockServiceRequest[] =>
    (state.requests[sessionId] ??= []);

  const paidOf = (sessionId: string): number => state.paidIdr[sessionId] ?? 0;

  const addPaid = (sessionId: string, amount: number) => {
    state.paidIdr[sessionId] = paidOf(sessionId) + amount;
  };

  // ---- Bills and board ----------------------------------------------------
  /** Recompute an order's totals with the same server pricing engine. */
  function repricedOrder(order: QrOrder, items: QrOrderItem[]): QrOrder {
    const table = tableOf(tableOfSessionId(order.tableSessionId));
    const quote = computeQuote({
      sessionId: order.tableSessionId,
      cartVersion: 1,
      lines: items.map((item) => ({
        cartLineId: newIdempotencyKey(),
        menuItemId: item.menuItemId,
        name: item.name,
        quantity: item.quantity,
        unitPriceIdr: item.unitPriceIdr,
        modifiersTotalIdr: item.modifiersTotalIdr,
        taxRuleId: cafeLegendTaxRules[0].id,
      })),
      config: {
        ...quoteConfigForZone(zoneOf(table)),
        pricesIncludeTaxAndService: order.pricesIncludeTaxAndService,
      },
      computedAt: nowIso(),
    });
    return qrOrderSchema.parse({
      ...order,
      items,
      subtotalIdr: quote.subtotalIdr,
      discountIdr: quote.discountIdr,
      serviceChargeIdr: quote.serviceCharge.amountIdr,
      taxIdr: quote.taxIdr,
      roundingIdr: quote.rounding.adjustmentIdr,
      totalIdr: quote.totalIdr,
    });
  }

  /** Bill rebuilt from the session's orders; splits stay as they are. */
  function billFor(sessionId: string) {
    sessionOf(sessionId); // 404 for an unknown session id
    const orders = ordersOf(sessionId);
    const splits = splitsOf(sessionId);
    const totalIdr = orders.reduce((sum, order) => sum + order.totalIdr, 0);
    const paidIdr = paidOf(sessionId);
    return sessionBillSchema.parse({
      sessionId,
      orders,
      totals: {
        subtotalIdr: orders.reduce((sum, order) => sum + order.subtotalIdr, 0),
        discountIdr: orders.reduce((sum, order) => sum + order.discountIdr, 0),
        serviceChargeIdr: orders.reduce(
          (sum, order) => sum + order.serviceChargeIdr,
          0,
        ),
        taxIdr: orders.reduce((sum, order) => sum + order.taxIdr, 0),
        roundingIdr: orders.reduce((sum, order) => sum + order.roundingIdr, 0),
        totalIdr: idr(totalIdr),
        paidIdr: idr(paidIdr),
        outstandingIdr: idr(Math.max(0, totalIdr - paidIdr)),
      },
      splits,
      computedAt: nowIso(),
    });
  }

  /** Requests the waiter has not resolved yet (the board's call count). */
  const openRequestCount = (tableId: string): number => {
    const session = activeSessionOfTable(tableId);
    if (!session) return 0;
    return requestsOf(session.id).filter(
      (entry) =>
        entry.request.status !== "resolved" &&
        entry.request.status !== "cancelled",
    ).length;
  };

  /** One board row, built the way the API will (session + bill + open calls). */
  function liveRow(table: Table): TableLiveStatus {
    const session = activeSessionOfTable(table.id);
    const bill = session ? billFor(session.id) : null;
    return tableLiveStatusSchema.parse({
      table,
      session:
        session && bill
          ? {
              id: session.id,
              status: session.status,
              pax: session.pax,
              paymentMode: session.paymentMode,
              openedAt: session.openedAt,
              lastActivityAt: session.lastActivityAt,
              billTotalIdr: bill.totals.totalIdr,
            }
          : null,
      openServiceRequestCount: openRequestCount(table.id),
      outstandingIdr: bill?.totals.outstandingIdr ?? idr(0),
    });
  }

  function board(): FloorBoard {
    return floorBoardSchema.parse({
      outletId,
      zones: state.zones,
      tables: state.tables.map(liveRow),
      generatedAt: nowIso(),
    });
  }

  const rowOf = (tableId: string): TableLiveStatus =>
    board().tables.find((row) => row.table.id === tableId) ?? notFound("Meja");

  function assertOutlet(outletIdFromParams: string) {
    if (outletIdFromParams !== outletId) notFound("Outlet");
  }

  /** Drop splits of a session whose orders changed: they no longer sum (ORD-06).
   * Only unpaid splits ever reach here: refusePaidSessions runs first. */
  function clearSplits(...sessionIds: string[]) {
    for (const sessionId of sessionIds) state.splits[sessionId] = [];
  }

  /** A paid share locks the session's orders (decision C2): no merge or item
   * move, so a recorded payment can never vanish with a cleared split. */
  function refusePaidSessions(...sessionIds: string[]) {
    for (const sessionId of sessionIds)
      if (billFor(sessionId).totals.paidIdr > 0)
        conflict(
          "TABLE_SESSION_PAID",
          "Sesi yang sudah dibayar sebagian tidak dapat digabung atau dipindah itemnya; selesaikan tagihan terlebih dahulu.",
        );
  }

  // ---- Guest entry --------------------------------------------------------
  const tableForToken = (qrToken: string): Table => {
    const code = qrTokenTableCodes[qrToken];
    if (!code) throw new ApiError(404, "NOT_FOUND", "QR meja tidak dikenali.");
    return tableByCode(code);
  };

  function openOrJoinTableSession(input: {
    qrToken: string;
    pax: number;
    deviceHash: string;
  }) {
    const table = tableForToken(input.qrToken);
    let session = activeSessionOfTable(table.id);
    let outcome: "opened" | "joined" = "joined";
    const now = clock();
    if (!session) {
      outcome = "opened";
      const zone = zoneOf(table);
      const base = fixtures.sessions[0];
      session = tableSessionSchema.parse({
        ...base,
        id: mintUuid(),
        tableId: table.id,
        pax: input.pax,
        paymentMode: zone.paymentMode,
        status:
          zone.paymentMode === "open_bill" ? "pending_confirmation" : "open",
        confirmedBy: null,
        participants: [],
        openedAt: new Date(now).toISOString(),
        closedAt: null,
        lastActivityAt: new Date(now).toISOString(),
        billRequestedAt: null,
        closedReason: null,
      });
      state.sessions[session.id] = session;
      state.bindings[table.id] = session.id;
      if (table.status === "available" || table.status === "reserved")
        table.status = "occupied";
    }
    let participant = session.participants.find(
      (entry) => entry.deviceHash === input.deviceHash,
    );
    if (!participant) {
      participant = {
        id: mintUuid() as TableSession["participants"][number]["id"],
        tenantId: session.tenantId,
        tableSessionId: session.id,
        deviceHash: input.deviceHash,
        userId: null,
        joinedAt: new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
      };
      session.participants.push(participant);
    } else participant.lastSeenAt = new Date(now).toISOString();
    session.lastActivityAt = new Date(now).toISOString();
    return { outcome, table, zone: zoneOf(table), session, participant };
  }

  const touchSession = (sessionId: string) => {
    sessionOf(sessionId).lastActivityAt = nowIso();
  };

  function createServiceRequest(
    sessionId: string,
    body: {
      type: ServiceRequest["type"];
      reason?: ServiceRequest["reason"];
      message?: string;
    },
  ): ServiceRequest {
    const session = sessionOf(sessionId);
    if (session.status === "pending_confirmation")
      conflict("SESSION_NOT_CONFIRMED", "Waiter belum mengonfirmasi meja ini.");
    const table = tableOf(session.tableId);
    const now = clock();
    const request: ServiceRequest = {
      id: mintUuid() as ServiceRequest["id"],
      tenantId: session.tenantId,
      outletId: session.outletId,
      tableSessionId: session.id,
      tableId: table.id,
      tableLabel: table.code,
      zoneId: table.zoneId,
      type: body.type,
      reason: body.type === "call_waiter" ? (body.reason ?? "other") : null,
      message: body.message ?? null,
      status: "pending",
      assignedTo: null,
      createdAt: new Date(now).toISOString(),
      acknowledgedAt: null,
      resolvedAt: null,
    };
    requestsOf(session.id).push({ request, createdMs: now });
    if (body.type === "request_bill" && session.status === "open") {
      session.status = "bill_requested";
      session.billRequestedAt = new Date(now).toISOString();
    }
    session.lastActivityAt = new Date(now).toISOString();
    return request;
  }

  // ---- Session lifecycle (floor board) -----------------------------------
  function confirmOpenBillSession(sessionId: string): TableSession {
    const session = sessionOf(sessionId);
    if (session.status !== "pending_confirmation")
      conflict("CONFLICT", "Sesi ini tidak menunggu konfirmasi.");
    const confirmed = tableSessionSchema.parse({
      ...session,
      status: "open",
      confirmedBy: staffUserId,
      lastActivityAt: nowIso(),
    });
    state.sessions[confirmed.id] = confirmed;
    const current = tableOf(tableOfSessionId(confirmed.id));
    if (current.status === "available" || current.status === "reserved")
      current.status = "occupied";
    return confirmed;
  }

  /**
   * Founder Q31/Q32: pay-first -> open bill for a running session. Eligibility
   * and the outlet's bill limit are checked here; the PIN is the feature
   * mock's job (the real API checks it against the staff PINs).
   */
  function convertSessionToOpenBill(
    sessionId: string,
    maxBillValueIdr: number,
  ): TableSession {
    const session = sessionOf(sessionId);
    if (session.paymentMode !== "pay_first" || !isActive(session))
      throw new ApiError(
        409,
        "OPEN_BILL_NOT_ELIGIBLE",
        "Sesi ini bukan sesi bayar dulu yang sedang berjalan.",
      );
    if (billFor(sessionId).totals.outstandingIdr >= maxBillValueIdr)
      throw new ApiError(
        409,
        "OPEN_BILL_CONVERT_LIMIT",
        "Tagihan belum dibayar sudah mencapai batas open bill outlet.",
      );
    const converted = tableSessionSchema.parse({
      ...session,
      paymentMode: "open_bill",
      // The approving supervisor; an open-bill session needs one on record.
      confirmedBy: staffUserId,
      lastActivityAt: nowIso(),
    });
    state.sessions[converted.id] = converted;
    return converted;
  }

  function closeTableSession(
    sessionId: string,
    body: { tableCleaned: boolean; waiterConfirmedEmpty: boolean },
  ): TableSession {
    const session = sessionOf(sessionId);
    const bill = billFor(session.id);
    if (
      !canCloseTableSession({
        billOutstandingIdr: bill.totals.outstandingIdr,
        tableCleaned: body.tableCleaned,
        waiterConfirmedEmpty: body.waiterConfirmedEmpty,
      })
    )
      conflict(
        "TABLE_BILL_OUTSTANDING",
        "ORD-10: meja belum bisa dikosongkan sebelum tagihan lunas atau dikonfirmasi waiter.",
      );
    const closedAt = nowIso();
    const closed = tableSessionSchema.parse({
      ...session,
      status: "closed",
      closedAt,
      lastActivityAt: closedAt,
      closedReason:
        bill.totals.outstandingIdr > 0 ? "voided" : "paid_and_cleaned",
    });
    state.sessions[closed.id] = closed;
    // Every table bound to the session (merged tables) empties together.
    for (const table of state.tables) {
      if (state.bindings[table.id] !== closed.id) continue;
      delete state.bindings[table.id];
      table.status = body.tableCleaned ? "available" : "dirty";
    }
    return closed;
  }

  function updateTableStatus(
    tableId: string,
    body: { action: TableStatusAction },
  ): TableLiveStatus {
    const table = tableOf(tableId);
    const session = activeSessionOfTable(table.id);
    if (
      !canApplyTableStatusAction({
        action: body.action,
        tableStatus: table.status,
        hasActiveSession: session !== null,
      })
    )
      conflict(
        session ? "TABLE_SESSION_ACTIVE" : "TABLE_STATUS_CONFLICT",
        session
          ? "ORD-10: meja masih dipakai sesi aktif; tutup sesi terlebih dahulu."
          : `Aksi ${body.action} tidak berlaku untuk meja berstatus ${table.status}.`,
      );
    table.status = tableStatusActionTarget(body.action);
    return liveRow(table);
  }

  // ---- Move, merge, item moves (ORD-10, ORD-06) --------------------------
  function moveTableSession(sessionId: string, toTableId: string) {
    const session = sessionOf(sessionId);
    if (!isActive(session))
      conflict("CONFLICT", "Sesi sudah ditutup dan tidak dapat dipindah.");
    const target = tableOf(toTableId);
    if (state.bindings[target.id])
      conflict("CONFLICT", "Meja tujuan masih dipakai sesi lain.");
    if (target.status !== "available")
      conflict("CONFLICT", "Meja tujuan tidak kosong.");
    if (zoneOf(target).paymentMode !== session.paymentMode)
      conflict(
        "CONFLICT",
        "Mode bayar sesi berbeda dengan zona meja tujuan; pilih meja di zona dengan mode bayar yang sama.",
      );
    const from = tableOfSession(session);
    delete state.bindings[from.id];
    state.bindings[target.id] = session.id;
    from.status = "dirty";
    target.status = "occupied";
    const moved = tableSessionSchema.parse({
      ...session,
      tableId: target.id,
      lastActivityAt: nowIso(),
    });
    state.sessions[moved.id] = moved;
    return { session: moved, fromTable: from, toTable: target };
  }

  function mergeTableSessions(sessionId: string, sourceSessionId: string) {
    const target = sessionOf(sessionId);
    const source = sessionOf(sourceSessionId);
    for (const session of [target, source])
      if (!isActive(session))
        conflict("CONFLICT", "Sesi yang sudah ditutup tidak dapat digabung.");
    if (target.outletId !== source.outletId || target.id === source.id)
      conflict("CONFLICT", "Sesi tidak dapat digabung.");
    if (target.paymentMode !== source.paymentMode)
      conflict(
        "CONFLICT",
        "Sesi dengan mode bayar berbeda tidak dapat digabung ke satu tagihan.",
      );
    if (
      (target.status !== "open" && target.status !== "bill_requested") ||
      (source.status !== "open" && source.status !== "bill_requested")
    )
      conflict(
        "CONFLICT",
        "Konfirmasi sesi open bill terlebih dahulu sebelum menggabungkan meja.",
      );
    refusePaidSessions(target.id, source.id);

    const movedOrders = ordersOf(source.id);
    const targetOrders = ordersOf(target.id);
    const reassigned = movedOrders.map((order) =>
      qrOrderSchema.parse({ ...order, tableSessionId: target.id }),
    );
    const movedParticipants = source.participants.map((participant) => ({
      ...participant,
      tableSessionId: target.id,
    }));
    const merged = tableSessionSchema.parse({
      ...target,
      participants: [...target.participants, ...movedParticipants],
      lastActivityAt: nowIso(),
    });
    state.sessions[merged.id] = merged;
    state.orders[target.id] = [...targetOrders, ...reassigned];
    state.orders[source.id] = [];
    clearSplits(target.id, source.id);

    const closedAt = nowIso();
    const closedSource = tableSessionSchema.parse({
      ...source,
      status: "closed",
      closedAt,
      lastActivityAt: closedAt,
      closedReason: "voided",
    });
    state.sessions[closedSource.id] = closedSource;
    // The source table stays in use and shares the target's bill.
    const sourceTable = tableOfSession(source);
    state.bindings[sourceTable.id] = merged.id;
    sourceTable.status = "occupied";

    return {
      target: merged,
      source: closedSource,
      movedItemCount: reassigned.reduce(
        (count, order) => count + order.items.length,
        0,
      ),
      movedTotalIdr: reassigned.reduce((sum, order) => sum + order.totalIdr, 0),
    };
  }

  function moveSessionItems(
    sessionId: string,
    toSessionId: string,
    itemIds: string[],
  ) {
    const from = sessionOf(sessionId);
    const to = sessionOf(toSessionId);
    if (from.id === to.id)
      conflict("CONFLICT", "Pilih sesi tujuan yang berbeda.");
    for (const session of [from, to])
      if (session.status !== "open" && session.status !== "bill_requested")
        conflict("CONFLICT", "Pindah item hanya berlaku untuk sesi berjalan.");
    if (from.outletId !== to.outletId)
      conflict("CONFLICT", "Item tidak dapat dipindah antar-outlet.");
    refusePaidSessions(from.id, to.id);

    const wanted = new Set(itemIds);
    const fromOrders = ordersOf(from.id);
    const moved: QrOrderItem[] = [];
    const kept: QrOrder[] = [];
    for (const order of fromOrders) {
      const taken = order.items.filter((item) => wanted.has(item.id));
      if (taken.length === 0) {
        kept.push(order);
        continue;
      }
      moved.push(...taken);
      const remaining = order.items.filter((item) => !wanted.has(item.id));
      if (remaining.length > 0) kept.push(repricedOrder(order, remaining));
    }
    if (moved.length !== wanted.size) notFound("Item pesanan"); // an item id that is not in this session

    const orderId = createUlid() as QrOrder["id"];
    const now = nowIso();
    const movedOrder = repricedOrder(
      {
        id: orderId,
        tenantId: to.tenantId,
        outletId: to.outletId,
        number: `MOV-${String(clock()).slice(-8)}`,
        channel: "qr",
        serviceType: "dine_in",
        tableSessionId: to.id,
        customerProfileId: null,
        subtotalIdr: idr(0),
        discountIdr: idr(0),
        serviceChargeIdr: idr(0),
        taxIdr: idr(0),
        roundingIdr: idr(0),
        totalIdr: idr(0),
        pricesIncludeTaxAndService: false,
        swapReplacementIdr: idr(0),
        status: "sent",
        items: [],
        createdAt: now,
        placedAt: now,
      },
      moved.map((item) => ({ ...item, orderId })),
    );
    state.orders[from.id] = kept;
    state.orders[to.id] = [...ordersOf(to.id), movedOrder];
    clearSplits(from.id, to.id);

    return {
      fromSessionId: from.id,
      toSessionId: to.id,
      movedItemCount: moved.length,
      movedTotalIdr: movedOrder.totalIdr,
    };
  }

  // ---- Table QR (F9 "Meja QR", ORD-04) -----------------------------------
  const SIGNATURE_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  /**
   * Deterministic stand-in for the server's HMAC signature, so a fixture QR is
   * stable across renders and prints. The real API signs with the tenant key
   * (PRD §3 "Keamanan Sesi", ORD-04); the client never verifies it.
   */
  function mockSignature(seed: string): string {
    let hash = 2166136261;
    let out = "";
    for (let index = 0; index < 43; index += 1) {
      for (const character of seed) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      hash = Math.imul(hash ^ index, 16777619) >>> 0;
      out += SIGNATURE_ALPHABET[hash % 64];
    }
    return out;
  }

  const base64Url = (value: string) =>
    btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

  function mintQr(tableId: string, generation: number): TableQr {
    const seed = `${tableId}:${generation}`;
    const token = `v1.${base64Url(`${generation}:${tableId}:qr-2026-11`)}.${mockSignature(seed)}`;
    return tableQrSchema.parse({
      tableId,
      token,
      url: `https://legend.example/t/${token}`,
      issuedAt: nowIso(),
    });
  }

  /** Issues the table's current signed QR; reprinting never rotates it. */
  function issueTableQr(tableId: string): TableQr {
    const table = tableOf(tableId);
    const stored = state.qr[table.id];
    if (stored) return stored.qr;
    const qr = mintQr(table.id, 1);
    state.qr[table.id] = { qr, generation: 1 };
    return qr;
  }

  /** "Ganti QR": the only action that rotates a table's token (ORD-04). */
  function rotateTableQr(tableId: string): TableQr {
    const table = tableOf(tableId);
    const generation = (state.qr[table.id]?.generation ?? 0) + 1;
    const qr = mintQr(table.id, generation);
    state.qr[table.id] = { qr, generation };
    return qr;
  }

  // ---- Floor editor (F9 "Denah & Meja") ----------------------------------
  function nextId(): string {
    sequence += 1;
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  }

  function createFloorZone(
    body: z.input<typeof createFloorZoneInputSchema>,
  ): FloorZone {
    const zone = floorZoneSchema.parse({
      id: nextId(),
      tenantId: state.zones[0]?.tenantId,
      outletId,
      name: body.name,
      paymentMode: body.paymentMode,
      serviceChargeBp: body.serviceChargeBp,
      minimumSpendIdr: body.minimumSpendIdr,
      hours: body.hours,
      status: body.status,
      sortOrder: body.sortOrder,
      isWfc: body.isWfc ?? false,
    });
    state.zones.push(zone);
    return zone;
  }

  function updateFloorZone(
    zoneId: string,
    body: z.input<typeof updateFloorZoneInputSchema>,
  ): FloorZone {
    const current = zoneOfId(zoneId);
    const zone = floorZoneSchema.parse({
      ...current,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.paymentMode === undefined
        ? {}
        : { paymentMode: body.paymentMode }),
      ...(body.serviceChargeBp === undefined
        ? {}
        : { serviceChargeBp: body.serviceChargeBp }),
      ...(body.minimumSpendIdr === undefined
        ? {}
        : { minimumSpendIdr: body.minimumSpendIdr }),
      ...(body.hours === undefined ? {} : { hours: body.hours }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
      ...(body.isWfc === undefined ? {} : { isWfc: body.isWfc }),
    });
    state.zones = state.zones.map((entry) =>
      entry.id === zone.id ? zone : entry,
    );
    return zone;
  }

  function deleteFloorZone(zoneId: string): void {
    zoneOfId(zoneId);
    const used = state.tables.filter((table) => table.zoneId === zoneId).length;
    if (used > 0)
      conflict(
        "CONFLICT",
        `Zona masih berisi ${used} meja. Pindahkan atau hapus dulu.`,
      );
    state.zones = state.zones.filter((zone) => zone.id !== zoneId);
  }

  function assertUniqueCode(code: string, exceptTableId?: string) {
    const taken = state.tables.some(
      (table) => table.code === code && table.id !== exceptTableId,
    );
    if (taken) conflict("CONFLICT", `Kode meja ${code} sudah dipakai.`);
  }

  function createTable(body: z.input<typeof createTableInputSchema>): Table {
    zoneOfId(body.zoneId);
    assertUniqueCode(body.code);
    const table = tableSchema.parse({
      id: nextId(),
      tenantId: state.tables[0]?.tenantId,
      outletId,
      zoneId: body.zoneId,
      code: body.code,
      capacity: body.capacity,
      type: body.type,
      layout: body.layout,
      status: body.status,
    });
    state.tables.push(table);
    return table;
  }

  function updateTable(
    tableId: string,
    body: z.input<typeof updateTableInputSchema>,
  ): Table {
    const current = tableOf(tableId);
    if (body.zoneId !== undefined) zoneOfId(body.zoneId);
    if (body.code !== undefined) assertUniqueCode(body.code, current.id);
    // The editor only activates or deactivates; live states stay on the board.
    if (body.status === "available" && current.status !== "inactive")
      conflict("CONFLICT", "Meja ini sudah aktif.");
    if (body.status === "inactive") {
      const row = rowOf(current.id);
      if (row.session || current.status !== "available")
        conflict(
          "CONFLICT",
          "Meja yang sedang dipakai tidak bisa dinonaktifkan. Kosongkan dulu (ORD-10).",
        );
    }
    const table = tableSchema.parse({
      ...current,
      ...(body.zoneId === undefined ? {} : { zoneId: body.zoneId }),
      ...(body.code === undefined ? {} : { code: body.code }),
      ...(body.capacity === undefined ? {} : { capacity: body.capacity }),
      ...(body.type === undefined ? {} : { type: body.type }),
      ...(body.layout === undefined ? {} : { layout: body.layout }),
      ...(body.status === undefined ? {} : { status: body.status }),
    });
    state.tables = state.tables.map((entry) =>
      entry.id === table.id ? table : entry,
    );
    return table;
  }

  function deleteTable(tableId: string): void {
    const row = rowOf(tableId);
    // ORD-10: a table with an open session cannot leave the floor.
    if (row.session)
      conflict(
        "CONFLICT",
        "Meja masih punya sesi aktif. Tutup sesinya dulu (ORD-10).",
      );
    state.tables = state.tables.filter((table) => table.id !== row.table.id);
  }

  /** Moves many tables at once; answers the tables that were saved. */
  function saveFloorLayout(
    placements: z.input<typeof saveFloorLayoutInputSchema>["placements"],
  ): Table[] {
    const saved = new Map<string, Table>();
    for (const placement of placements) {
      const table = tableOf(placement.tableId);
      saved.set(
        table.id,
        tableSchema.parse({ ...table, layout: placement.layout }),
      );
    }
    state.tables = state.tables.map((table) => saved.get(table.id) ?? table);
    return [...saved.values()];
  }

  // ---- Snapshot -----------------------------------------------------------
  function snapshot(): FloorSnapshot {
    return structuredClone({ version: FLOOR_SNAPSHOT_VERSION, ...state });
  }

  function restore(saved: FloorSnapshot) {
    if (saved.version !== FLOOR_SNAPSHOT_VERSION)
      throw new RangeError("Snapshot mock WS-03 tidak dikenal.");
    const next = structuredClone(saved) as Partial<FloorSnapshot>;
    delete next.version;
    Object.assign(state, next);
  }

  return {
    state,
    board,
    rowOf,
    billFor,
    tableOf,
    tableByCode,
    zoneOf,
    zoneOfId,
    sessionOf,
    activeSessionOfTable,
    tableOfSession,
    ordersOf,
    splitsOf,
    requestsOf,
    paidOf,
    addPaid,
    touchSession,
    tableForToken,
    openOrJoinTableSession,
    createServiceRequest,
    confirmOpenBillSession,
    convertSessionToOpenBill,
    closeTableSession,
    updateTableStatus,
    moveTableSession,
    mergeTableSessions,
    moveSessionItems,
    issueTableQr,
    rotateTableQr,
    createFloorZone,
    updateFloorZone,
    deleteFloorZone,
    createTable,
    updateTable,
    deleteTable,
    saveFloorLayout,
    assertOutlet,
    snapshot,
    restore,
  };
}

export type Ws03Engine = ReturnType<typeof createWs03Engine>;
