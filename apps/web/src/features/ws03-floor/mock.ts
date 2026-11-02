// Mock mode for the WS-03 floor board: serves and mutates the one shared WS-03
// session/floor engine (lib/mock/ws03), the same state the QR order journey and
// the floor editor use, so the board and the guest never disagree (bead
// legend-jzud).
//
// Handlers behave like the API will: input is parsed by the runtime, the same
// contract guards run (ORD-10, merge/move rules), bills are recomputed from
// orders with the same pricing engine, and refusals use the error codes the
// screen maps to catalog text.
import { registerMock } from "@/lib/mock/registry";
import { ws03Store } from "@/lib/mock/ws03/store";
import {
  closeTableSession,
  confirmOpenBillSession,
  getFloorBoard,
  issueTableQr,
  mergeTableSessions,
  moveSessionItems,
  moveTableSession,
  updateTableStatus,
  type FloorBoard,
} from "@starter/shared/qr-order";

const engine = () => ws03Store.get();

registerMock(getFloorBoard, ({ params, scenario }) => {
  const current = engine();
  current.assertOutlet(params.outletId);
  // "empty" is the state of an outlet whose floor plan is not set up yet.
  if (scenario === "empty")
    return {
      data: {
        outletId: current.board().outletId,
        zones: [],
        tables: [],
        generatedAt: new Date().toISOString(),
      } satisfies FloorBoard,
    };
  return { data: current.board() };
});

// ---- Session lifecycle ----------------------------------------------------

registerMock(confirmOpenBillSession, ({ params }) => ({
  data: engine().confirmOpenBillSession(params.sessionId),
}));

registerMock(closeTableSession, ({ params, body }) => ({
  data: engine().closeTableSession(params.sessionId, body),
}));

// ---- Table status ---------------------------------------------------------

registerMock(updateTableStatus, ({ params, body }) => ({
  data: { table: engine().updateTableStatus(params.tableId, body) },
}));

// ---- Move a session, merge tables, move items ----------------------------

registerMock(moveTableSession, ({ params, body }) => ({
  data: engine().moveTableSession(params.sessionId, body.toTableId),
}));

registerMock(mergeTableSessions, ({ params, body }) => ({
  data: engine().mergeTableSessions(params.sessionId, body.sourceSessionId),
}));

registerMock(moveSessionItems, ({ params, body }) => ({
  data: engine().moveSessionItems(
    params.sessionId,
    body.toSessionId,
    body.orderItemIds,
  ),
}));

// ---- Table QR -------------------------------------------------------------

// Table QR is issued once per table by the shared engine; this handler only
// exposes it (getSessionBill/createSessionSplits live in the QR order mock,
// which owns the guest bill and the split lock, decision C2).
registerMock(issueTableQr, ({ params }) => ({
  data: engine().issueTableQr(params.tableId),
}));
