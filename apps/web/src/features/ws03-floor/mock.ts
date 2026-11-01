// Mock mode for the WS-03 floor board: serves and mutates the shared Cafe
// Legend QR-order fixtures, so the board and its action sheet work with
// VITE_API_MOCK=true and the Playwright spec covers the happy path
// (docs/frontend.md "Mock mode").
//
// Handlers behave like the API will: input is parsed by the runtime, the same
// contract guards run (ORD-10, merge/move rules), bills are recomputed from
// orders with the same pricing engine, and refusals use the error codes the
// screen maps to catalog text.
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { createUlid, idr } from "@starter/shared/core";
import {
  billSplitSchema,
  cafeLegendQrOrderFixtures,
  cafeLegendTaxRules,
  canApplyTableStatusAction,
  canCloseTableSession,
  closeTableSession,
  computeQuote,
  confirmOpenBillSession,
  createSessionSplits,
  floorBoardSchema,
  getFloorBoard,
  getSessionBill,
  issueTableQr,
  mergeTableSessions,
  moveSessionItems,
  moveTableSession,
  qrOrderSchema,
  quoteConfigForZone,
  sessionBillSchema,
  splitBill,
  tableLiveStatusSchema,
  tableQrSchema,
  tableSessionSchema,
  tableStatusActionTarget,
  updateTableStatus,
  type BillSplit,
  type FloorBoard,
  type FloorZone,
  type QrOrder,
  type QrOrderItem,
  type Table,
  type TableLiveStatus,
  type TableQr,
  type TableSession,
} from "@starter/shared/qr-order";

const fixtures = cafeLegendQrOrderFixtures;
const outletId = fixtures.floorBoard.outletId;
const staffUserId = "00000000-0000-4000-8000-000000009001";
const nowIso = () => new Date().toISOString();
const mintId = () => crypto.randomUUID();

type LiveState = {
  zones: FloorZone[];
  tables: Table[];
  /** Every session, including the closed ones the fixture keeps for history. */
  sessions: Record<string, TableSession>;
  /** Active binding: table id → session id. Merged tables point at one session. */
  tableSession: Record<string, string>;
  orders: Record<string, QrOrder[]>;
  splits: Record<string, BillSplit[]>;
  serviceRequests: Record<string, number>;
  qr: Record<string, TableQr>;
};

const isActive = (session: TableSession) =>
  session.status !== "closed" && session.status !== "voided";

function seedState(): LiveState {
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
  const tableSession: Record<string, string> = {};
  const serviceRequests: Record<string, number> = {};
  for (const row of fixtures.floorBoard.tables) {
    if (row.session) tableSession[row.table.id] = row.session.id;
    if (row.openServiceRequestCount > 0)
      serviceRequests[row.table.id] = row.openServiceRequestCount;
  }
  const qr: Record<string, TableQr> = {};

  // A second running open-bill session makes merge/move/split reviewable: the
  // shared fixtures only have one running open-bill party (P1).
  const w02 = tables.find((table) => table.code === "W02");
  if (w02) {
    const extraId = "00000000-0000-4000-8000-000000000406";
    const scope = { tenantId: zones[0].tenantId, outletId };
    const joinedAt = "2026-11-01T04:40:00.000Z";
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
          id: mintId(),
          tenantId: zones[0].tenantId,
          tableSessionId: extraId,
          deviceHash: "device-w02-guest-1",
          userId: null,
          joinedAt,
          lastSeenAt: "2026-11-01T05:09:00.000Z",
        },
      ],
      openedAt: joinedAt,
      closedAt: null,
      lastActivityAt: "2026-11-01T05:09:00.000Z",
      billRequestedAt: null,
      closedReason: null,
    });
    sessions[extra.id] = extra;
    tableSession[w02.id] = extra.id;
    w02.status = "occupied";
    const template = fixtures.orders[0];
    if (template) {
      const orderId = createUlid() as QrOrder["id"];
      orders[extra.id] = [
        qrOrderSchema.parse({
          ...structuredClone(template),
          id: orderId,
          number: "QR-20261101-0043",
          tableSessionId: extra.id,
          items: template.items.map((item) => ({
            ...structuredClone(item),
            id: createUlid() as QrOrderItem["id"],
            orderId,
          })),
        }),
      ];
    }
  }

  // Fixtures are dated 2026-11-01; shift running sessions to "now" so seat
  // durations and "opened at" read like a live service, not stale data.
  const nowMs = Date.now();
  const reference = Date.parse("2026-11-01T05:10:00.000Z");
  const at = (iso: string) =>
    new Date(nowMs + (Date.parse(iso) - reference)).toISOString();
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

  return {
    zones,
    tables,
    sessions,
    tableSession,
    orders,
    splits,
    serviceRequests,
    qr,
  };
}

const store = createMockStore<LiveState>(seedState);
const state = () => store.get();

function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

function refuse(code: string, message: string): never {
  throw new ApiError(409, code, message);
}

function tableOf(tableId: string): Table {
  return (
    state().tables.find((table) => table.id === tableId) ?? notFound("Meja")
  );
}

function zoneOf(table: Table): FloorZone {
  return (
    state().zones.find((zone) => zone.id === table.zoneId) ?? notFound("Zona")
  );
}

function sessionOf(sessionId: string): TableSession {
  return state().sessions[sessionId] ?? notFound("Sesi meja");
}

function activeSessionOfTable(tableId: string): TableSession | null {
  const sessionId = state().tableSession[tableId];
  if (!sessionId) return null;
  const session = state().sessions[sessionId];
  return session && isActive(session) ? session : null;
}

function tableOfSession(session: TableSession): Table {
  // After a merge the session keeps its original tableId; the board binds the
  // merged tables to it explicitly, so prefer a live binding that still exists.
  const bound = state().tables.find(
    (table) => state().tableSession[table.id] === session.id,
  );
  return bound ?? tableOf(session.tableId);
}

/** Recompute an order's totals with the same server pricing engine. */
function repricedOrder(order: QrOrder, items: QrOrderItem[]): QrOrder {
  const table = tableOf(tableOfSessionId(order.tableSessionId));
  const quote = computeQuote({
    sessionId: order.tableSessionId,
    cartVersion: 1,
    lines: items.map((item, index) => ({
      cartLineId: `move-${item.id}-${index}`,
      menuItemId: item.menuItemId,
      name: item.name,
      quantity: item.quantity,
      unitPriceIdr: item.unitPriceIdr,
      modifiersTotalIdr: item.modifiersTotalIdr,
      taxRuleId: cafeLegendTaxRules[0].id,
    })),
    config: quoteConfigForZone(zoneOf(table)),
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

function tableOfSessionId(sessionId: string): string {
  const table = state().tables.find(
    (row) => state().tableSession[row.id] === sessionId,
  );
  return (table ?? tableOf(sessionOf(sessionId).tableId)).id;
}

/** Bill rebuilt from the session's orders; splits stay as they are. */
function billFor(sessionId: string) {
  sessionOf(sessionId); // 404 for an unknown session id
  const orders = state().orders[sessionId] ?? [];
  const splits = state().splits[sessionId] ?? [];
  const totalIdr = orders.reduce((sum, order) => sum + order.totalIdr, 0);
  const paidIdr = splits
    .filter((split) => split.status === "paid")
    .reduce((sum, split) => sum + split.amountIdr, 0);
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
    openServiceRequestCount: state().serviceRequests[table.id] ?? 0,
    outstandingIdr: bill?.totals.outstandingIdr ?? idr(0),
  });
}

function board(): FloorBoard {
  return floorBoardSchema.parse({
    outletId,
    zones: state().zones,
    tables: state().tables.map(liveRow),
    generatedAt: nowIso(),
  });
}

function assertOutlet(outletIdFromParams: string) {
  if (outletIdFromParams !== outletId) notFound("Outlet");
}

/** Drop splits of a session whose orders changed: they no longer sum (ORD-06). */
function clearSplits(...sessionIds: string[]) {
  for (const sessionId of sessionIds) state().splits[sessionId] = [];
}

// ---- Board and bills ------------------------------------------------------

registerMock(getFloorBoard, ({ params, scenario }) => {
  assertOutlet(params.outletId);
  // "empty" is the state of an outlet whose floor plan is not set up yet.
  if (scenario === "empty")
    return {
      data: {
        outletId,
        zones: [],
        tables: [],
        generatedAt: nowIso(),
      } satisfies FloorBoard,
    };
  return { data: board() };
});

registerMock(getSessionBill, ({ params }) => ({
  data: billFor(params.sessionId),
}));

// ---- Session lifecycle ----------------------------------------------------

registerMock(confirmOpenBillSession, ({ params }) => {
  const session = sessionOf(params.sessionId);
  if (session.status !== "pending_confirmation")
    refuse("CONFLICT", "Sesi ini tidak menunggu konfirmasi.");
  const confirmed = tableSessionSchema.parse({
    ...session,
    status: "open",
    confirmedBy: staffUserId,
    lastActivityAt: nowIso(),
  });
  state().sessions[confirmed.id] = confirmed;
  const table = tableOfSessionId(confirmed.id);
  const current = tableOf(table);
  if (current.status === "available" || current.status === "reserved")
    current.status = "occupied";
  return { data: confirmed };
});

registerMock(closeTableSession, ({ params, body }) => {
  const session = sessionOf(params.sessionId);
  const bill = billFor(session.id);
  if (
    !canCloseTableSession({
      billOutstandingIdr: bill.totals.outstandingIdr,
      tableCleaned: body.tableCleaned,
      waiterConfirmedEmpty: body.waiterConfirmedEmpty,
    })
  )
    refuse(
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
  state().sessions[closed.id] = closed;
  // Every table bound to the session (merged tables) empties together.
  for (const table of state().tables) {
    if (state().tableSession[table.id] !== closed.id) continue;
    delete state().tableSession[table.id];
    table.status = body.tableCleaned ? "available" : "dirty";
    delete state().serviceRequests[table.id];
  }
  return { data: closed };
});

// ---- Table status ---------------------------------------------------------

registerMock(updateTableStatus, ({ params, body }) => {
  const table = tableOf(params.tableId);
  const session = activeSessionOfTable(table.id);
  if (
    !canApplyTableStatusAction({
      action: body.action,
      tableStatus: table.status,
      hasActiveSession: session !== null,
    })
  )
    refuse(
      session ? "TABLE_SESSION_ACTIVE" : "TABLE_STATUS_CONFLICT",
      session
        ? "ORD-10: meja masih dipakai sesi aktif; tutup sesi terlebih dahulu."
        : `Aksi ${body.action} tidak berlaku untuk meja berstatus ${table.status}.`,
    );
  table.status = tableStatusActionTarget(body.action);
  return { data: { table: liveRow(table) } };
});

// ---- Move a session, merge tables, move items ----------------------------

registerMock(moveTableSession, ({ params, body }) => {
  const session = sessionOf(params.sessionId);
  if (!isActive(session))
    refuse("CONFLICT", "Sesi sudah ditutup dan tidak dapat dipindah.");
  const target = tableOf(body.toTableId);
  if (state().tableSession[target.id])
    refuse("CONFLICT", "Meja tujuan masih dipakai sesi lain.");
  if (target.status !== "available")
    refuse("CONFLICT", "Meja tujuan tidak kosong.");
  if (zoneOf(target).paymentMode !== session.paymentMode)
    refuse(
      "CONFLICT",
      "Mode bayar sesi berbeda dengan zona meja tujuan; pilih meja di zona dengan mode bayar yang sama.",
    );
  const from = tableOfSession(session);
  delete state().tableSession[from.id];
  state().tableSession[target.id] = session.id;
  from.status = "dirty";
  target.status = "occupied";
  const moved = tableSessionSchema.parse({
    ...session,
    tableId: target.id,
    lastActivityAt: nowIso(),
  });
  state().sessions[moved.id] = moved;
  return { data: { session: moved, fromTable: from, toTable: target } };
});

registerMock(mergeTableSessions, ({ params, body }) => {
  const target = sessionOf(params.sessionId);
  const source = sessionOf(body.sourceSessionId);
  for (const session of [target, source])
    if (!isActive(session))
      refuse("CONFLICT", "Sesi yang sudah ditutup tidak dapat digabung.");
  if (target.outletId !== source.outletId || target.id === source.id)
    refuse("CONFLICT", "Sesi tidak dapat digabung.");
  if (target.paymentMode !== source.paymentMode)
    refuse(
      "CONFLICT",
      "Sesi dengan mode bayar berbeda tidak dapat digabung ke satu tagihan.",
    );
  if (
    (target.status !== "open" && target.status !== "bill_requested") ||
    (source.status !== "open" && source.status !== "bill_requested")
  )
    refuse(
      "CONFLICT",
      "Konfirmasi sesi open bill terlebih dahulu sebelum menggabungkan meja.",
    );

  const movedOrders = state().orders[source.id] ?? [];
  const targetOrders = state().orders[target.id] ?? [];
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
  state().sessions[merged.id] = merged;
  state().orders[target.id] = [...targetOrders, ...reassigned];
  state().orders[source.id] = [];
  clearSplits(target.id, source.id);

  const closedAt = nowIso();
  const closedSource = tableSessionSchema.parse({
    ...source,
    status: "closed",
    closedAt,
    lastActivityAt: closedAt,
    closedReason: "voided",
  });
  state().sessions[closedSource.id] = closedSource;
  // The source table stays in use and shares the target's bill.
  const sourceTable = tableOfSession(source);
  state().tableSession[sourceTable.id] = merged.id;
  sourceTable.status = "occupied";

  return {
    data: {
      target: merged,
      source: closedSource,
      movedItemCount: reassigned.reduce(
        (count, order) => count + order.items.length,
        0,
      ),
      movedTotalIdr: reassigned.reduce((sum, order) => sum + order.totalIdr, 0),
    },
  };
});

registerMock(moveSessionItems, ({ params, body }) => {
  const from = sessionOf(params.sessionId);
  const to = sessionOf(body.toSessionId);
  if (from.id === to.id) refuse("CONFLICT", "Pilih sesi tujuan yang berbeda.");
  for (const session of [from, to])
    if (session.status !== "open" && session.status !== "bill_requested")
      refuse("CONFLICT", "Pindah item hanya berlaku untuk sesi berjalan.");

  const wanted = new Set(body.orderItemIds);
  const fromOrders = state().orders[from.id] ?? [];
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
      number: `MOV-${String(Date.now()).slice(-8)}`,
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
      status: "sent",
      items: [],
      createdAt: now,
      placedAt: now,
    },
    moved.map((item) => ({ ...item, orderId })),
  );
  state().orders[from.id] = kept;
  state().orders[to.id] = [...(state().orders[to.id] ?? []), movedOrder];
  clearSplits(from.id, to.id);

  return {
    data: {
      fromSessionId: from.id,
      toSessionId: to.id,
      movedItemCount: moved.length,
      movedTotalIdr: movedOrder.totalIdr,
    },
  };
});

// ---- Split bill and table QR --------------------------------------------

registerMock(createSessionSplits, ({ params, body }) => {
  const session = sessionOf(params.sessionId);
  if (!isActive(session))
    refuse("CONFLICT", "Sesi sudah ditutup; tagihan tidak dapat dibagi.");
  const bill = billFor(session.id);
  if (bill.totals.totalIdr === 0) refuse("CONFLICT", "Tagihan masih kosong.");
  if (body.method === "by_item")
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Mock belum mendukung bagi tagihan per item; pakai bagi rata.",
    );
  const drafts = splitBill(
    body.method === "equal"
      ? {
          method: "equal",
          totalIdr: bill.totals.totalIdr,
          parts: body.parts,
        }
      : {
          method: "by_person",
          totalIdr: bill.totals.totalIdr,
          participantIds: body.participantIds,
        },
  );
  const now = nowIso();
  const splits = drafts.map((draft) =>
    billSplitSchema.parse({
      id: mintId(),
      tenantId: session.tenantId,
      outletId: session.outletId,
      tableSessionId: session.id,
      orderId: null,
      method: draft.method,
      shareIndex: draft.shareIndex,
      amountIdr: draft.amountIdr,
      status: "pending",
      label: draft.label,
      itemIds: draft.itemIds,
      participantId: draft.participantId,
      createdAt: now,
    }),
  );
  state().splits[session.id] = splits;
  return { data: { bill: billFor(session.id), splits } };
});

registerMock(issueTableQr, ({ params }) => {
  const table = tableOf(params.tableId);
  const token = `v1.${"M".repeat(40)}.${"N".repeat(43)}`;
  const qr = tableQrSchema.parse({
    tableId: table.id,
    token,
    url: `https://legend.example/t/${token}`,
    issuedAt: nowIso(),
  });
  if (!state().qr[table.id]) state().qr[table.id] = qr;
  return { data: qr };
});
