// Mock mode handlers for the shared POS endpoints (VITE_API_MOCK=true). The
// logic lives in mock-engine.ts and the wire shapes in mock-wire.ts; this file
// only binds them to the contract endpoints. The screens' own view-model calls
// (./api.ts) read the same engine, so both stay one truth.
import {
  addPosTender,
  closePosDay,
  closePosShift,
  forceClosePosShift,
  completePosOrder,
  getEndOfDayRecap,
  getPosApprovalPolicy,
  getPosOrder,
  getPosShift,
  getPosShiftPrint,
  issuePosReceipt,
  listPosCashMovements,
  listPosShiftCounts,
  listPosShifts,
  openPosShift,
  recordPosCashMovement,
  submitPosShiftCount,
} from "@starter/shared/pos";
import {
  createPosOverride,
  getPosOverride,
} from "@starter/shared/access/override";
import { ApiError } from "@/lib/api/errors";
import { testPrintPayload } from "./print/test-page";
import {
  devicePinOverride,
  devicePinPosOverride,
} from "@/features/ws01-device-pin/mock";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { callPosKasirEngine } from "./mock-engine";
import {
  approvalPolicyWire,
  movementWire,
  orderDetailWire,
  overrideViewWire,
  receiptIssueWire,
  shiftCountWire,
  recapWire,
  shiftWire,
  tenderResultWire,
} from "./mock-wire";
import type { OverrideAction } from "./types";

/**
 * Handlers return the wire shape; the mock transport parses it with the
 * endpoint's response schema, and the unit test does the same offline.
 */
const wire = (value: unknown) => value as never;

const orderState = (orderId: string) =>
  callPosKasirEngine((engine) => ({
    order: engine.rawOrder(orderId),
    remaining: engine.rawRemainingIdr(orderId),
  }));

registerMock(getPosOrder, ({ params }) => {
  const { order, remaining } = orderState(params.orderId);
  return wire({ data: orderDetailWire(order, remaining) });
});

registerMock(addPosTender, ({ params, body }) => {
  // Only cash settles locally; gateway and EDC tenders come from WS-05.
  if (body.method !== "cash" || body.receivedIdr === undefined)
    throw new ApiError(
      422,
      "TENDER_METHOD_UNSUPPORTED",
      "Mock hanya menerima tender tunai di endpoint ini.",
    );
  const received = body.receivedIdr;
  const result = callPosKasirEngine((engine) => {
    const remaining = engine.rawRemainingIdr(params.orderId);
    engine.confirmCash({
      orderId: params.orderId,
      amountIdr: Math.min(received, remaining),
      receivedIdr: received,
    });
    const order = engine.rawOrder(params.orderId);
    return {
      order,
      remaining: engine.rawRemainingIdr(params.orderId),
      tender: order.tenders[order.tenders.length - 1],
    };
  });
  return wire({
    data: tenderResultWire(result.order, result.remaining, result.tender),
  });
});

registerMock(completePosOrder, ({ params }) => {
  const { order, remaining } = orderState(params.orderId);
  if (remaining > 0)
    throw new ApiError(
      409,
      "ORDER_NOT_SETTLED",
      "Pesanan belum lunas, belum bisa diselesaikan.",
    );
  return wire({ data: orderDetailWire(order, remaining) });
});

registerMock(issuePosReceipt, ({ params }) => {
  const order = callPosKasirEngine((engine) => {
    engine.printReceipt(params.orderId);
    return engine.rawOrder(params.orderId);
  });
  return wire({ data: receiptIssueWire(order) });
});

registerMock(getPosApprovalPolicy, () => wire({ data: approvalPolicyWire }));

registerMock(openPosShift, ({ body }) => {
  const shift = callPosKasirEngine((engine) => {
    engine.openShift({ openingFloatIdr: body.openingFloatIdr });
    return { shift: engine.rawShift(), blind: engine.drawerHidden() };
  });
  return wire({ data: shiftWire(shift.shift!, shift.blind) });
});

registerMock(listPosShifts, ({ query, scenario }) => {
  const { shift, blind } = callPosKasirEngine((engine) => ({
    shift: engine.rawShift(),
    blind: engine.drawerHidden(),
  }));
  const rows = shift ? [shiftWire(shift, blind)] : [];
  return wire(paginateFixture(rows, query, (row) => row.id, scenario));
});

// P3: mock mode prints the same short test page the printer settings use.
registerMock(getPosShiftPrint, ({ query }) => ({
  data: testPrintPayload(query.paperWidth),
}));

registerMock(getPosShift, ({ params }) => {
  const result = callPosKasirEngine((engine) => {
    const movements = engine.rawMovements(params.shiftId);
    return {
      shift: engine.rawShift(),
      movements,
      held: engine.rawHeldMovementIds(params.shiftId),
      blind: engine.drawerHidden(),
    };
  });
  return wire({
    data: {
      shift: shiftWire(result.shift!, result.blind),
      movements: result.movements.map((m) =>
        movementWire(
          m,
          params.shiftId,
          // `needsApproval` only goes to callers that see live figures.
          result.blind ? undefined : result.held.includes(m.id),
        ),
      ),
      receiptGaps: [],
    },
  });
});

/**
 * The contract stores a blind count first (`POST .../counts`) and the close
 * names it by `countId`. The engine still closes from the counts, so the mock
 * keeps each submitted count by id until the close reads it back.
 */
const submittedCounts = new Map<
  string,
  { shiftId: string; counts: { denominationIdr: number; quantity: number }[] }
>();

registerMock(submitPosShiftCount, ({ params, body }) => {
  const sequence =
    [...submittedCounts.values()].filter((c) => c.shiftId === params.shiftId)
      .length + 1;
  const id = crypto.randomUUID();
  submittedCounts.set(id, { shiftId: params.shiftId, counts: body.counts });
  return wire({
    data: {
      id,
      shiftId: params.shiftId,
      sequence,
      countedIdr: body.counts.reduce(
        (sum, line) => sum + line.denominationIdr * line.quantity,
        0,
      ),
      noteRequired: false,
      submittedAt: new Date().toISOString(),
    },
  });
});

registerMock(closePosShift, ({ params, body }) => {
  const count = submittedCounts.get(body.countId);
  if (!count || count.shiftId !== params.shiftId)
    throw new ApiError(404, "NOT_FOUND", "Hitungan kas tidak ditemukan.");
  const shift = callPosKasirEngine((engine) => {
    engine.closeShiftWithApprover({
      shiftId: params.shiftId,
      counts: count.counts,
      varianceNote: body.varianceNote,
      approvedBy: body.approvedBy,
    });
    return { shift: engine.rawShift(), blind: engine.drawerHidden() };
  });
  return wire({ data: shiftWire(shift.shift!, shift.blind) });
});

registerMock(listPosShiftCounts, ({ params }) => {
  const counts = callPosKasirEngine((engine) =>
    engine.rawCounts(params.shiftId),
  );
  return wire({
    data: counts.map((count) => shiftCountWire(count, params.shiftId)),
  });
});

/** U9: closes with the approved forced count; the engine holds the witness. */
registerMock(forceClosePosShift, ({ params, body }) => {
  const shift = callPosKasirEngine((engine) => {
    engine.forceClose({ shiftId: params.shiftId, note: body.note });
    return { shift: engine.rawShift(), blind: engine.drawerHidden() };
  });
  return wire({ data: shiftWire(shift.shift!, shift.blind) });
});

registerMock(recordPosCashMovement, ({ params, body }) => {
  const movement = callPosKasirEngine((engine) =>
    engine.recordCashMovement({
      shiftId: params.shiftId,
      type: body.type,
      amountIdr: body.amountIdr,
      reasonNote: body.reasonNote,
    }),
  );
  return wire({ data: movementWire(movement, params.shiftId) });
});

registerMock(listPosCashMovements, ({ params, query, scenario }) => {
  const rows = callPosKasirEngine((engine) =>
    engine.cashMovements(params.shiftId),
  )
    .filter((row) => query.type === undefined || row.type === query.type)
    .map((row) => movementWire(row, params.shiftId));
  return wire(paginateFixture(rows, query, (row) => row.id, scenario));
});

registerMock(getEndOfDayRecap, () =>
  wire({ data: recapWire(callPosKasirEngine((engine) => engine.dayRecap())) }),
);

registerMock(closePosDay, ({ body }) =>
  wire({
    data: recapWire(
      callPosKasirEngine((engine) =>
        engine.closeDay({ inventoryDeduction: body.inventoryDeduction }),
      ),
    ),
  }),
);

registerMock(createPosOverride, ({ body }) => {
  const devicePin = devicePinOverride(body);
  if (devicePin) return devicePin;
  if (body.approval.method !== "supervisor_pin")
    throw new ApiError(
      409,
      "APPROVAL_METHOD_UNSUPPORTED",
      "Mock hanya menerima persetujuan PIN supervisor.",
    );
  const { approverUserId, pin } = body.approval;
  const override = callPosKasirEngine((engine) => {
    const result = engine.requestOverride({
      action: body.action as OverrideAction,
      valueIdr: body.valueIdr,
      reason: body.reason,
      objectType: body.objectType,
      objectId: body.objectId,
      approverUserId,
      pin,
    });
    return engine.override(result.overrideId);
  });
  return wire({ data: overrideViewWire(override) });
});

registerMock(getPosOverride, ({ params }) => {
  // A phone override raised from the device PIN modal (ws01-device-pin).
  const devicePin = devicePinPosOverride(params.overrideId);
  if (devicePin) return devicePin;
  const override = callPosKasirEngine((engine) =>
    engine.override(params.overrideId),
  );
  const view = overrideViewWire(override);
  if (!view)
    throw new ApiError(404, "NOT_FOUND", "Persetujuan tidak ditemukan.");
  return wire({ data: view });
});
