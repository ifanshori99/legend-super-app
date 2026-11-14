// KDS fixtures and transitions share the kitchen contract with the future API.
import {
  cafeLegendKitchenFixtures,
  kitchenFixtureSchema,
  orderHeaders,
  getKitchenBoard,
  getKitchenStationSummary,
  getStationCapacityRules,
  listKitchenStationLabels,
  stationCapacityRuleSchema,
  stationCapacityRules,
  stationLabelSchema,
  stationLabels,
  startKitchenTicket,
  bumpKitchenTicket,
  recallKitchenTicket,
  setKitchenTicketPriority,
  updateKitchenTicketItem,
  canTransitionKitchenTicket,
  transitionKitchenTicket,
  canTransitionKitchenItem,
  transitionKitchenItem,
} from "@starter/shared/kitchen";
import type {
  KitchenTicketAction,
  KitchenTicketDetail,
  KitchenTicketItem,
  StationBoard,
} from "@starter/shared/kitchen";
import { ApiError } from "../../lib/api/errors.ts";
import { getKdsScannerStatus } from "./contract-gap.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";

const fixtures = kitchenFixtureSchema.parse(cafeLegendKitchenFixtures);
const boards = createMockStore<StationBoard[]>(() =>
  fixtures.stationConfigs.map((config) => {
    const pacing = fixtures.pacing.stations.find(
      (row) => row.stationId === config.stationId,
    );
    if (!pacing) throw new Error("Missing fixture station pacing");
    return {
      tenantId: config.tenantId,
      outletId: config.outletId,
      stationId: config.stationId,
      generatedAt: fixtures.pacing.generatedAt,
      pacing,
      tickets: fixtures.tickets
        .filter((ticket) => ticket.stationId === config.stationId)
        .map((ticket) => {
          const header = orderHeaders[ticket.orderId];
          if (!header) throw new Error("Missing fixture order header");
          return {
            ...ticket,
            ...header,
            items: fixtures.ticketItems.filter(
              (item) => item.ticketId === ticket.id,
            ),
          };
        }),
      allDay: {
        tenantId: config.tenantId,
        outletId: config.outletId,
        stationId: config.stationId,
        generatedAt: fixtures.pacing.generatedAt,
        rows: [],
      },
    };
  }),
);

function withCounts(board: StationBoard): StationBoard {
  const rows: StationBoard["allDay"]["rows"] = [];
  for (const ticket of board.tickets) {
    for (const item of ticket.items) {
      if (item.status !== "queued" && item.status !== "in_progress") continue;
      const row = rows.find(
        (r) =>
          r.menuItemId === item.menuItemId && r.variantId === item.variantId,
      );
      if (row) {
        row.quantity += item.quantity;
        if (item.firedAt < row.oldestFiredAt) row.oldestFiredAt = item.firedAt;
      } else
        rows.push({
          stationId: board.stationId,
          menuItemId: item.menuItemId,
          variantId: item.variantId,
          name: item.name,
          quantity: item.quantity,
          oldestFiredAt: item.firedAt,
        });
    }
  }
  return { ...board, allDay: { ...board.allDay, rows } };
}
function updateTicket(
  id: string,
  change: (ticket: KitchenTicketDetail) => KitchenTicketDetail,
) {
  let changed: KitchenTicketDetail | undefined;
  const next = boards.get().map((board) => ({
    ...board,
    tickets: board.tickets.map((ticket) => {
      if (ticket.id !== id) return ticket;
      changed = change(ticket);
      return changed;
    }),
  }));
  if (!changed) throw new ApiError(404, "NOT_FOUND", "Tiket tidak ditemukan.");
  boards.set(next);
  return changed;
}
function transition(id: string, action: KitchenTicketAction) {
  return updateTicket(id, (ticket) => {
    if (!canTransitionKitchenTicket(ticket.status, action))
      throw new ApiError(409, "CONFLICT", "Status tiket sudah berubah.");
    const now = new Date().toISOString();
    return {
      ...ticket,
      status: transitionKitchenTicket(ticket.status, action),
      startedAt: action === "start" ? now : ticket.startedAt,
      doneAt: action === "bump" ? now : ticket.doneAt,
      items: ticket.items.map((item): KitchenTicketItem => {
        const itemAction =
          action === "start"
            ? "start"
            : action === "bump"
              ? "ready"
              : action === "recall"
                ? "recall"
                : "void";
        if (!canTransitionKitchenItem(item.status, itemAction)) return item;
        return {
          ...item,
          status: transitionKitchenItem(item.status, itemAction),
          startedAt: itemAction === "start" ? now : item.startedAt,
          readyAt: itemAction === "ready" ? now : item.readyAt,
          recalledCount:
            itemAction === "recall"
              ? item.recalledCount + 1
              : item.recalledCount,
        };
      }),
    };
  });
}
// listKitchenStations is owned by ws04-kitchen-config/mock.ts (the station
// settings screen); both features read the same fixture list (bead legend-jzud).
// legend-gt7f: the cook reads of the station label and capacity rules.
const labelRows = stationLabelSchema.array().parse(stationLabels);
const capacityRows = stationCapacityRuleSchema
  .array()
  .parse(stationCapacityRules);
registerMock(listKitchenStationLabels, ({ scenario }) => ({
  data: scenario === "empty" ? [] : labelRows,
}));
registerMock(getStationCapacityRules, ({ params, scenario }) => ({
  data:
    scenario === "empty"
      ? []
      : capacityRows.filter((rule) => rule.stationId === params.stationId),
}));
registerMock(getKitchenBoard, ({ params, scenario }) => {
  const board = boards
    .get()
    .find(
      (row) =>
        row.outletId === params.outletId && row.stationId === params.stationId,
    );
  if (!board) throw new ApiError(404, "NOT_FOUND", "Stasiun tidak ditemukan.");
  const result = withCounts(board);
  return {
    data:
      scenario === "empty"
        ? { ...result, tickets: [], allDay: { ...result.allDay, rows: [] } }
        : result,
  };
});
registerMock(getKitchenStationSummary, ({ params, scenario }) => ({
  data: {
    ...fixtures.stationSummary,
    stations:
      scenario === "empty"
        ? []
        : boards
            .get()
            .filter((board) => board.outletId === params.outletId)
            .map((board) => ({
              stationId: board.stationId,
              openTickets: board.tickets.filter(
                (ticket) =>
                  ticket.status !== "done" && ticket.status !== "cancelled",
              ).length,
            })),
  },
}));
registerMock(startKitchenTicket, ({ params }) => ({
  data: transition(params.ticketId, "start"),
}));
registerMock(bumpKitchenTicket, ({ params }) => ({
  data: transition(params.ticketId, "bump"),
}));
registerMock(recallKitchenTicket, ({ params }) => ({
  data: transition(params.ticketId, "recall"),
}));
registerMock(setKitchenTicketPriority, ({ params, body }) => ({
  data: updateTicket(params.ticketId, (ticket) => ({
    ...ticket,
    priority: body.priority,
  })),
}));
registerMock(updateKitchenTicketItem, ({ params, body }) => {
  const ticket = boards
    .get()
    .flatMap((board) => board.tickets)
    .find((row) => row.items.some((item) => item.id === params.itemId));
  if (!ticket) throw new ApiError(404, "NOT_FOUND", "Item tidak ditemukan.");
  let result: KitchenTicketItem | undefined;
  updateTicket(ticket.id, (row) => ({
    ...row,
    items: row.items.map((item) => {
      if (item.id !== params.itemId) return item;
      if (!canTransitionKitchenItem(item.status, body.action))
        throw new ApiError(409, "CONFLICT", "Status item sudah berubah.");
      const now = new Date().toISOString();
      result = {
        ...item,
        status: transitionKitchenItem(item.status, body.action),
        startedAt: body.action === "start" ? now : item.startedAt,
        readyAt: body.action === "ready" ? now : item.readyAt,
        servedAt: body.action === "serve" ? now : item.servedAt,
        recalledCount:
          body.action === "recall"
            ? item.recalledCount + 1
            : item.recalledCount,
      };
      return result;
    }),
  }));
  if (!result) throw new ApiError(404, "NOT_FOUND", "Item tidak ditemukan.");
  return { data: result };
});
// Scanner connection (contract gap, see contract-gap.ts). `?scanner=disconnected`
// in the URL shows the disconnected state; any other value is connected.
registerMock(getKdsScannerStatus, () => ({
  data: {
    status:
      typeof location !== "undefined" &&
      new URLSearchParams(location.search).get("scanner") === "disconnected"
        ? ("disconnected" as const)
        : ("connected" as const),
  },
}));
