import assert from "node:assert/strict";
import { test } from "node:test";
import * as admin from "../packages/shared/src/payment/admin.ts";
import "../apps/web/src/features/ws05-payment-admin/mock.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";

const fixtures = admin.cafeLegendPaymentAdminFixtures;
const route = fixtures.routes[0];
const terminal = fixtures.terminals[0];
const cashier = fixtures.cashiers[0];
const reconciliation = fixtures.reconciliationCases.find(
  (entry) => entry.status === "open",
);
const base = "/api/payments/admin";
const requests = [
  {
    method: "PUT",
    path: `${base}/routing/${route.method}`,
    body: {
      outletId: null,
      provider: route.provider,
      fallbackProvider: route.fallbackProvider,
      enabled: route.enabled,
    },
  },
  {
    method: "POST",
    path: `${base}/edc/terminals`,
    body: {
      outletId: terminal.outletId,
      bankCode: terminal.bankCode,
      terminalId: "new-terminal",
      merchantId: terminal.merchantId,
      model: terminal.model,
      connection: terminal.connection,
      ipAddress: terminal.ipAddress,
      supportedMethods: terminal.supportedMethods,
      status: terminal.status,
    },
  },
  {
    method: "PATCH",
    path: `${base}/edc/terminals/${terminal.id}`,
    body: { model: "Changed model" },
  },
  {
    method: "PUT",
    path: `${base}/edc/cashier-defaults/${cashier.cashierId}`,
    body: {
      outletId: cashier.outletId,
      terminalId: null,
      defaultMethod: "qris_doit",
    },
  },
  {
    method: "POST",
    path: `${base}/reconciliation/cases/${reconciliation.id}/resolve`,
    body: { note: "Resolved by investigation" },
  },
];

test("legend-8tv6 payment admin mocks require valid header and replay each mutation", async () => {
  for (const [index, request] of requests.entries()) {
    resetMocks();
    await assert.rejects(dispatchMock(request), {
      status: 400,
      code: "VALIDATION_ERROR",
    });
    await assert.rejects(
      dispatchMock({ ...request, headers: { "Idempotency-Key": "bad" } }),
      { status: 400, code: "VALIDATION_ERROR" },
    );
    const headers = { "Idempotency-Key": `attempt-${index}-12345678` };
    const result = await dispatchMock({ ...request, headers });
    assert.deepEqual(await dispatchMock({ ...request, headers }), result);
    const changed = requests[(index + 1) % requests.length];
    await assert.rejects(dispatchMock({ ...changed, headers }), {
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  }
});
