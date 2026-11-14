// Mock mode for the delivery channel ops screen (VITE_API_MOCK=true): serves
// the @starter/shared/delivery fixtures with the same validation, state
// machine and reconciliation rules the API will apply, so the store switches,
// the incoming orders, the D12 manual entry and the commission reconciliation
// fully work with no API (docs/frontend.md "Mock mode").
//
// Loaded in Node by a future contract test, so every import here is a bare
// package import or a relative `.ts` path (no `@/` alias).
//
// Per-runtime stores: a mutation changes this browser session only, and
// `window.__legendMock.reset()` re-seeds. The settlement statement stays the
// platform's own fixture rows — a manual order never fabricates a settlement;
// it appears once the platform reports it, which is exactly what the real
// reconciliation flow waits for.
import {
  cafeLegendDeliveryFixtures,
  canTransitionDeliveryOrder,
  createManualDeliveryOrder,
  deliveryChannelOrderSchema,
  deliveryChannelSchema,
  deliveryErrorHttpStatus,
  deliveryErrorMessages,
  deliveryOrderIsInjectable,
  deliveryReconciliationSchema,
  deliveryReconciliationSummaryOf,
  getDeliveryOrder,
  getDeliveryReconciliation,
  listDeliveryChannels,
  listDeliveryOrders,
  mapDeliveryOrderLines,
  resendDeliveryOrderSync,
  resolveDeliveryOrderSync,
  setDeliveryChannelState,
  syncDeliveryChannelMenu,
  updateDeliveryOrderStatus,
} from "@starter/shared/delivery";
import type {
  DeliveryChannel,
  DeliveryChannelOrder,
  DeliveryErrorCode,
  DeliveryPlatform,
  DeliveryPlatformSync,
} from "@starter/shared/delivery";
import {
  cafeLegendFixtures,
  createUlidFactory,
  idr,
} from "@starter/shared/core";
import { cafeLegendMenuFixtures } from "@starter/shared/menu";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { channelIsManual, lineNeedsMapping, orderIsFinal } from "./lib.ts";

const fixtures = cafeLegendDeliveryFixtures;
const outlet = cafeLegendFixtures.outlets[0];
const tenantId = outlet.tenantId;
const secondOutlet = cafeLegendFixtures.outlets[1];

/**
 * Demo commission of a manual row: 20% of gross, the same ratio the GoFood
 * fixtures carry. The real adapter records the commission the platform
 * reports; a manual row has no statement yet, so the mock uses one documented
 * demo ratio instead of inventing a per-platform figure.
 */
const MANUAL_COMMISSION_BP = 2_000;

const nowIso = () => new Date().toISOString();
const mintId = () => newIdempotencyKey();
const mintOrderId = createUlidFactory();
let orderNumberSequence = 240;

function fail(code: DeliveryErrorCode): never {
  throw new ApiError(
    deliveryErrorHttpStatus[code],
    code,
    deliveryErrorMessages[code],
  );
}

/**
 * The outlet an endpoint addresses: the first fixture outlet, or the second
 * (`?outlets=many`), which has its own stores below. Any other id is 404.
 */
function requireOutlet(requested: string) {
  const found = [outlet, secondOutlet].find((row) => row.id === requested);
  if (!found) throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  return found;
}

// ---- Second outlet (`?outlets=many`) --------------------------------------

/**
 * The second fixture outlet runs its own channels and queue, cloned from the
 * first outlet's fixtures inside this store (never edited in
 * `@starter/shared`): the same three platforms, with GoFood live and one
 * fresh GoFood order waiting for the cashier. It has no platform statement
 * yet, so its reconciliation honestly reads zero.
 */
const secondScope = { tenantId, outletId: secondOutlet.id };
const secondOutletChannels: DeliveryChannel[] = fixtures.channels.map((row) =>
  deliveryChannelSchema.parse({
    ...structuredClone(row),
    ...secondScope,
    // Only GoFood is integrated here; GrabFood joins later.
    ...(row.platform === "grabfood"
      ? {
          isOpen: false,
          closedReason: "Integrasi GrabFood outlet ini belum aktif.",
          syncStatus: "error",
          syncError: "Integrasi GrabFood belum aktif.",
          lastSyncedAt: null,
          menuItemCount: 0,
          soldOutItemCount: 0,
        }
      : {}),
  }),
);
const secondOutletOrders: DeliveryChannelOrder[] = [
  deliveryChannelOrderSchema.parse({
    ...structuredClone(fixtures.orders[0]),
    ...secondScope,
    id: "00000000-0000-4000-8000-000000007501",
    externalOrderId: "GF-2026-1101-5102",
  }),
];

// ---- Stores ---------------------------------------------------------------

const channels = createMockStore(() => [
  ...structuredClone(fixtures.channels),
  ...structuredClone(secondOutletChannels),
]);
// Demo platform sync (legend-u37u3): the shared fixtures stay `ok`; the mock
// seeds one order per non-ok state so the staff screen shows all three.
const DEMO_PLATFORM_SYNC: Record<string, DeliveryPlatformSync> = {
  [fixtures.orders[0].id]: "needs_action",
  [fixtures.orders[1].id]: "retrying",
  // A closed order whose closing step the platform refused: no later step can
  // clear the mark.
  [fixtures.orders[3].id]: "needs_action",
};
const orders = createMockStore(() => [
  ...structuredClone(fixtures.orders).map((order) => ({
    ...order,
    platformSync: DEMO_PLATFORM_SYNC[order.id] ?? order.platformSync,
  })),
  ...structuredClone(secondOutletOrders),
]);

function findChannel(
  outlet: string,
  platform: DeliveryPlatform,
): DeliveryChannel {
  const found = channels
    .get()
    .find((row) => row.platform === platform && row.outletId === outlet);
  if (!found) fail("DELIVERY_CHANNEL_UNKNOWN");
  return found;
}

function saveChannel(next: DeliveryChannel): DeliveryChannel {
  const parsed = deliveryChannelSchema.parse(next);
  channels.set(
    channels
      .get()
      .map((row) =>
        row.platform === parsed.platform && row.outletId === parsed.outletId
          ? parsed
          : row,
      ),
  );
  return parsed;
}

function findOrder(outlet: string, id: string): DeliveryChannelOrder {
  const found = orders
    .get()
    .find((row) => row.id === id && row.outletId === outlet);
  if (!found) fail("DELIVERY_ORDER_NOT_FOUND");
  return found;
}

function saveOrder(next: DeliveryChannelOrder): DeliveryChannelOrder {
  const parsed = deliveryChannelOrderSchema.parse(next);
  orders.set(orders.get().map((row) => (row.id === parsed.id ? parsed : row)));
  return parsed;
}

// ---- Menu resolution for manual rows (D12) --------------------------------

function menuItemOf(menuItemId: string) {
  const item = cafeLegendMenuFixtures.items.find(
    (entry) => entry.id === menuItemId,
  );
  if (!item)
    throw new ApiError(400, "VALIDATION_ERROR", "Item menu tidak dikenal.", [
      { field: "lines", message: "Muat ulang menu lalu pilih item lagi." },
    ]);
  return item;
}

/** Our channel price of an item (WS-03 price list), resolved by the server. */
function channelPriceOf(menuItemId: string): number {
  const row = cafeLegendMenuFixtures.priceListItems.find(
    (entry) => entry.itemId === menuItemId,
  );
  if (!row)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Item belum punya harga di daftar harga kanal.",
      [{ field: "lines", message: "Pilih item yang punya harga kanal." }],
    );
  return row.priceIdr;
}

/**
 * 64-hex digest of the typed input (the contract stores SHA-256 of the raw
 * platform payload; a manual row hashes what the cashier typed). Web Crypto is
 * unavailable in an insecure LAN context, so a stable local digest covers it.
 */
async function payloadDigest(value: unknown): Promise<string> {
  const text = JSON.stringify(value);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = new TextEncoder().encode(text);
    const hash = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  let state = 0x811c9dc5;
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    state ^= text.charCodeAt(index);
    state = Math.imul(state, 0x01000193) >>> 0;
    out += state.toString(16).padStart(8, "0");
  }
  return out.padEnd(64, "0").slice(0, 64);
}

// ---- Channels -------------------------------------------------------------

registerMock(listDeliveryChannels, ({ params, scenario }) => {
  requireOutlet(params.outletId);
  if (scenario === "empty") return { data: [] };
  return {
    data: channels.get().filter((row) => row.outletId === params.outletId),
  };
});

registerMock(setDeliveryChannelState, ({ params, body }) => {
  requireOutlet(params.outletId);
  const current = findChannel(params.outletId, params.platform);
  // Reopening clears the closing window; closing keeps an optional promise to
  // reopen (the contract forbids both at once).
  const next = saveChannel({
    ...current,
    isOpen: body.isOpen,
    closedUntil: body.isOpen ? null : (body.closedUntil ?? null),
    closedReason: body.isOpen ? null : (body.closedReason ?? null),
    updatedAt: nowIso(),
  });
  return { data: next };
});

registerMock(syncDeliveryChannelMenu, ({ params }) => {
  requireOutlet(params.outletId);
  const current = findChannel(params.outletId, params.platform);
  // D12: a platform whose integration never activated cannot take a push.
  if (channelIsManual(current)) fail("DELIVERY_CHANNEL_UNKNOWN");
  const pushedItemCount = cafeLegendMenuFixtures.items.length;
  const soldOutItemCount = current.soldOutItemCount;
  const next = saveChannel({
    ...current,
    syncStatus: "ok",
    syncError: null,
    lastSyncedAt: nowIso(),
    menuItemCount: pushedItemCount,
    updatedAt: nowIso(),
  });
  return { data: { channel: next, pushedItemCount, soldOutItemCount } };
});

// ---- Incoming orders ------------------------------------------------------

registerMock(listDeliveryOrders, ({ params, query, scenario }) => {
  requireOutlet(params.outletId);
  // Newest first (contract comment): the cashier works the top of the list.
  const rows = orders
    .get()
    .filter(
      (row) =>
        row.outletId === params.outletId &&
        (query.platform === undefined || row.platform === query.platform) &&
        (query.status === undefined || row.status === query.status),
    )
    .sort(
      (left, right) =>
        Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
    );
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(getDeliveryOrder, ({ params }) => {
  requireOutlet(params.outletId);
  return { data: findOrder(params.outletId, params.deliveryOrderId) };
});

registerMock(createManualDeliveryOrder, async ({ params, body }) => {
  requireOutlet(params.outletId);
  const duplicate = orders
    .get()
    .some(
      (row) =>
        row.outletId === params.outletId &&
        row.platform === body.platform &&
        row.externalOrderId === body.externalOrderId,
    );
  if (duplicate) fail("DELIVERY_ORDER_DUPLICATE");

  // The server resolves every price from the channel price list; the client
  // never sends money (contract input).
  const lines = body.lines.map((line, index) => {
    const item = menuItemOf(line.menuItemId);
    const priceIdr = channelPriceOf(item.id);
    return {
      lineNo: index + 1,
      externalItemId: null,
      externalItemName: item.name,
      menuItemId: item.id,
      variantId: line.variantId ?? null,
      quantity: line.quantity,
      unitPriceIdr: priceIdr,
      lineTotalIdr: priceIdr * line.quantity,
      modifiers: [],
      note: line.note ?? null,
      mapping: "matched" as const,
      channelPriceIdr: priceIdr,
    };
  });
  const grossIdr = lines.reduce((sum, line) => sum + line.lineTotalIdr, 0);
  const commissionIdr = Math.round((grossIdr * MANUAL_COMMISSION_BP) / 10_000);
  const order = deliveryChannelOrderSchema.parse({
    id: mintId(),
    tenantId,
    outletId: params.outletId,
    platform: body.platform,
    externalOrderId: body.externalOrderId,
    orderId: null,
    number: null,
    status: "received",
    source: "manual_pos",
    grossIdr,
    commissionIdr,
    payloadHash: await payloadDigest(body),
    customerNote: body.customerNote ?? null,
    lines,
    receivedAt: nowIso(),
    acceptedAt: null,
    readyAt: null,
    pickedUpAt: null,
    deliveredAt: null,
    closedAt: null,
    closeReason: null,
    settledAt: null,
    settledNetIdr: null,
  });
  orders.set([order, ...orders.get()]);
  return { data: order };
});

registerMock(updateDeliveryOrderStatus, ({ params, body }) => {
  requireOutlet(params.outletId);
  const current = findOrder(params.outletId, params.deliveryOrderId);
  // The store must be open on that platform before a platform order is
  // accepted. A manual row (D12) never goes through the adapter, so it may
  // still be worked while the platform store is closed.
  if (body.status === "accepted" && current.source === "platform") {
    const channel = channels
      .get()
      .find(
        (row) =>
          row.platform === current.platform &&
          row.outletId === current.outletId,
      );
    if (channel && !channel.isOpen) fail("DELIVERY_CHANNEL_CLOSED");
  }
  if (!canTransitionDeliveryOrder(current.status, body.status))
    fail("DELIVERY_TRANSITION_INVALID");
  // Alur G step 2: acceptance injects the order into the KDS, which needs
  // every line mapped to our menu.
  if (body.status === "accepted" && !deliveryOrderIsInjectable(current))
    fail("DELIVERY_MAPPING_INCOMPLETE");

  const at = nowIso();
  const closing = body.status === "cancelled" || body.status === "rejected";
  const injecting = body.status === "accepted" && current.orderId === null;
  const next = saveOrder({
    ...current,
    status: body.status,
    // `createUlidFactory` returns the bare ULID; the schema parse in saveOrder
    // mints the branded OrderId (a ULID-in-uuid) for the contract.
    orderId: (injecting
      ? mintOrderId()
      : current.orderId) as DeliveryChannelOrder["orderId"],
    number: injecting ? `D-0${(orderNumberSequence += 1)}` : current.number,
    acceptedAt: body.status === "accepted" ? at : current.acceptedAt,
    readyAt: body.status === "ready" ? at : current.readyAt,
    pickedUpAt: body.status === "picked_up" ? at : current.pickedUpAt,
    deliveredAt: body.status === "delivered" ? at : current.deliveredAt,
    closedAt: closing ? at : current.closedAt,
    closeReason: closing ? (body.reason ?? null) : null,
    // The platform accepted the next step, so an earlier sync mark clears.
    platformSync: "ok",
  });
  return { data: next };
});

// Q58 staff recovery of a needs_action order. The demo platform takes the
// resend of an order that is still open and refuses one that is already
// closed (a closed order has no next step to carry it), so both outcomes of
// the real endpoint can be seen in mock mode.
registerMock(resendDeliveryOrderSync, ({ params }) => {
  requireOutlet(params.outletId);
  const current = findOrder(params.outletId, params.deliveryOrderId);
  if (current.platformSync !== "needs_action")
    fail("DELIVERY_SYNC_NOT_PENDING");
  const accepted = !orderIsFinal(current.status);
  return {
    data: saveOrder({
      ...current,
      platformSync: accepted ? "ok" : "needs_action",
    }),
  };
});

registerMock(resolveDeliveryOrderSync, ({ params }) => {
  requireOutlet(params.outletId);
  const current = findOrder(params.outletId, params.deliveryOrderId);
  if (current.platformSync !== "needs_action")
    fail("DELIVERY_SYNC_NOT_PENDING");
  return { data: saveOrder({ ...current, platformSync: "ok" }) };
});

// legend-5d76: staff map the unmatched lines of a needs_review order. Like the
// server, the platform price and the order totals stay as received; only the
// line mapping and the internal order change. Already injected: current row.
registerMock(mapDeliveryOrderLines, ({ params, body }) => {
  requireOutlet(params.outletId);
  const current = findOrder(params.outletId, params.deliveryOrderId);
  if (current.orderId !== null || current.status !== "received")
    return { data: current };
  const unmatched = current.lines.filter(lineNeedsMapping);
  const mapped = new Map(body.mappings.map((row) => [row.lineNo, row]));
  if (
    unmatched.length === 0 ||
    body.mappings.length !== unmatched.length ||
    unmatched.some((line) => !mapped.has(line.lineNo))
  )
    fail("DELIVERY_MAPPING_INCOMPLETE");
  const lines = current.lines.map((line) => {
    const row = mapped.get(line.lineNo);
    if (!lineNeedsMapping(line) || !row) return line;
    menuItemOf(row.menuItemId);
    const channelPriceIdr = idr(channelPriceOf(row.menuItemId));
    return {
      ...line,
      menuItemId: row.menuItemId,
      variantId: row.variantId ?? null,
      channelPriceIdr,
      mapping:
        channelPriceIdr === line.unitPriceIdr
          ? ("matched" as const)
          : ("price_mismatch" as const),
    };
  });
  return {
    data: saveOrder({
      ...current,
      lines,
      orderId: mintOrderId() as DeliveryChannelOrder["orderId"],
      number: `D-0${(orderNumberSequence += 1)}`,
    }),
  };
});

// ---- Commission reconciliation -------------------------------------------

registerMock(getDeliveryReconciliation, ({ params, query, scenario }) => {
  requireOutlet(params.outletId);
  // Only the fixture platform has a statement; every other platform (or a
  // period without rows) answers honestly: no lines, zero summary.
  const lines =
    scenario === "empty"
      ? []
      : fixtures.settlementLines.filter(
          (line) =>
            line.outletId === params.outletId &&
            line.platform === query.platform &&
            line.settledOn >= query.periodStart &&
            line.settledOn <= query.periodEnd,
        );
  return {
    data: deliveryReconciliationSchema.parse({
      tenantId,
      outletId: params.outletId,
      platform: query.platform,
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
      lines,
      summary: deliveryReconciliationSummaryOf(lines),
    }),
  };
});
