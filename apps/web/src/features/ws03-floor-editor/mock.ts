// Mock handlers for the floor editor (docs/frontend.md "Typed endpoints and
// mock mode"). `VITE_API_MOCK=true` makes the screens fully workable: the
// handlers serve and mutate the one shared WS-03 session/floor engine
// (lib/mock/ws03), the same state the floor board and the QR guest journey use,
// so a saved layout or a rotated QR is one truth (bead legend-jzud).
//
// The handlers refuse what the API must refuse, so the screens show the real
// failure modes: a duplicate table number (409), a zone that still holds
// tables (409) and a table with an open session (409, PRD ORD-10).
import { registerMock } from "@/lib/mock/registry";
import { ws03Store } from "@/lib/mock/ws03/store";
import {
  createFloorZone,
  createTable,
  deleteFloorZone,
  deleteTable,
  getCurrentFloor,
  rotateTableQr,
  saveFloorLayout,
  updateFloorZone,
  updateTable,
} from "@starter/shared/qr-order";

const engine = () => ws03Store.get();
const now = () => new Date().toISOString();

// ---- Read ---------------------------------------------------------------

registerMock(getCurrentFloor, ({ scenario }) => {
  if (scenario === "empty")
    return {
      data: {
        outletId: engine().board().outletId,
        zones: [],
        tables: [],
        generatedAt: now(),
      },
    };
  return { data: engine().board() };
});

// ---- Zones --------------------------------------------------------------

registerMock(createFloorZone, ({ body }) => ({
  data: engine().createFloorZone(body),
}));

registerMock(updateFloorZone, ({ params, body }) => ({
  data: engine().updateFloorZone(params.zoneId, body),
}));

registerMock(deleteFloorZone, ({ params }) => {
  engine().deleteFloorZone(params.zoneId);
  return undefined;
});

// ---- Tables -------------------------------------------------------------

registerMock(createTable, ({ body }) => ({
  data: engine().createTable(body),
}));

registerMock(updateTable, ({ params, body }) => ({
  data: engine().updateTable(params.tableId, body),
}));

registerMock(deleteTable, ({ params }) => {
  engine().deleteTable(params.tableId);
  return undefined;
});

/** Moves many tables at once; answers the tables that were saved. */
registerMock(saveFloorLayout, ({ body }) => ({
  data: engine().saveFloorLayout(body.placements),
}));

// ---- Signed QR ----------------------------------------------------------

// issueTableQr (print/reprint) is registered by the floor board mock; both
// screens read the same shared QR registry, so the label is one truth. Only
// "Ganti QR" rotates it (coordinator decision, legend-th7 review).
registerMock(rotateTableQr, ({ params }) => ({
  data: engine().rotateTableQr(params.tableId),
}));
