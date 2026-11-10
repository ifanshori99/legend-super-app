// Mock mode for open bill: the per-outlet policy lives in memory (starting at
// the defaults), and converting a pay-first session mutates the shared WS-03
// engine, so the floor board changes with it (bead legend-8cm4, legend-2zb5).
//
// Handlers behave like the API will: input is parsed by the runtime, the
// approver is checked before the PIN, the PIN before anything else, and
// refusals use the error codes the screens map to catalog text. Two sample
// approvers exist; the accepted PIN is 123456.
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { ws03Store } from "@/lib/mock/ws03/store";
import { ApiError } from "@/lib/api/errors";
import {
  OPEN_BILL_APPROVER_DENIED,
  convertSessionToOpenBill,
  getOpenBillPolicy,
  listOpenBillApprovers,
  openBillApproverSchema,
  openBillPolicySchema,
  updateOpenBillPolicy,
  type OpenBillPolicy,
} from "@starter/shared/qr-order";
import { cafeLegendQrOrderFixtures } from "@starter/shared/qr-order/sample";
import { OPEN_BILL_DEFAULTS } from "./lib";

/** The only PIN the mock accepts for an approver. */
const MOCK_SUPERVISOR_PIN = "123456";

/** Supervisor-and-above staff with a PIN at the sample outlet, by name. */
const MOCK_APPROVERS = [
  openBillApproverSchema.parse({
    userId: "7c1e5a92-3b4d-4f60-8a2e-9d0b1c3e5f71",
    displayName: "Dewi Anggraini",
  }),
  openBillApproverSchema.parse({
    userId: "b4f2d8c6-1a73-4e95-bd08-2c6e4a8f0d13",
    displayName: "Rudi Hartono",
  }),
];

const seedPolicy = (): OpenBillPolicy => {
  const { floorBoard, zones } = cafeLegendQrOrderFixtures;
  return openBillPolicySchema.parse({
    tenantId: zones[0].tenantId,
    outletId: floorBoard.outletId,
    ...OPEN_BILL_DEFAULTS,
    isDefault: true,
  });
};

const policyStore = createMockStore<OpenBillPolicy>(seedPolicy);

registerMock(getOpenBillPolicy, ({ params, scenario }) => {
  ws03Store.get().assertOutlet(params.outletId);
  // "empty" is an outlet that never saved a policy: the defaults apply.
  if (scenario === "empty") return { data: seedPolicy() };
  return { data: policyStore.get() };
});

registerMock(listOpenBillApprovers, ({ params, scenario }) => {
  ws03Store.get().assertOutlet(params.outletId);
  // "empty" is an outlet where nobody with the permission has set a PIN.
  if (scenario === "empty") return { data: [] };
  return { data: MOCK_APPROVERS };
});

registerMock(updateOpenBillPolicy, ({ params, body }) => {
  ws03Store.get().assertOutlet(params.outletId);
  const next = openBillPolicySchema.parse({
    ...policyStore.get(),
    ...body,
    isDefault: false,
  });
  policyStore.set(next);
  return { data: next };
});

registerMock(convertSessionToOpenBill, ({ params, body }) => {
  if (
    !MOCK_APPROVERS.some((approver) => approver.userId === body.approverUserId)
  )
    throw new ApiError(
      403,
      OPEN_BILL_APPROVER_DENIED,
      "Penyetuju tidak memegang izin open bill di outlet ini.",
    );
  if (body.pin !== MOCK_SUPERVISOR_PIN)
    throw new ApiError(401, "PIN_INVALID", "PIN salah.");
  return {
    data: ws03Store
      .get()
      .convertSessionToOpenBill(
        params.sessionId,
        policyStore.get().maxBillValueIdr,
      ),
  };
});
