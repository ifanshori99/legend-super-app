// Mock mode for open bill: the per-outlet policy lives in memory (starting at
// the defaults), and converting a pay-first session mutates the shared WS-03
// engine, so the floor board changes with it (bead legend-8cm4, legend-2zb5).
//
// Handlers behave like the API will: input is parsed by the runtime, the PIN
// is checked before anything else, and refusals use the error codes the
// screens map to catalog text. The accepted PIN is 123456.
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { ws03Store } from "@/lib/mock/ws03/store";
import { ApiError } from "@/lib/api/errors";
import {
  OPEN_BILL_PIN_REJECTED,
  convertSessionToOpenBill,
  getOpenBillPolicy,
  openBillPolicySchema,
  updateOpenBillPolicy,
  type OpenBillPolicy,
} from "@starter/shared/qr-order";
import { cafeLegendQrOrderFixtures } from "@starter/shared/qr-order/sample";
import { OPEN_BILL_DEFAULTS } from "./lib";

/** The only PIN the mock accepts as a supervisor or above. */
const MOCK_SUPERVISOR_PIN = "123456";

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
  if (body.pin !== MOCK_SUPERVISOR_PIN)
    throw new ApiError(
      403,
      OPEN_BILL_PIN_REJECTED,
      "PIN salah atau bukan milik supervisor.",
    );
  return {
    data: ws03Store
      .get()
      .convertSessionToOpenBill(
        params.sessionId,
        policyStore.get().maxBillValueIdr,
      ),
  };
});
