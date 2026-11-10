// legend-3usn8: the DOIT adapter's last fence. A worker that stalls between the
// DB send-right check and the network send (slow credentials, slow DNS) must
// not send once `sendBy` has passed: fetch is never called and the outcome is
// unknown (never a decline). Real adapter, injected fetch / lookup /
// credentials; the pause is a clock jump inside the injected steps.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { createDoitGateway } from "../services/payment-doit";
import { DoitRefundUnknownError } from "../services/payment-doit-wire";
import type { GatewayRefundRequest } from "../services/payment-refund-gateway";

const INTEGRATION_ID = "5b0b3f7e-2f4a-4c0e-9a55-5d3c1a7e9f01";
const OUTLET_ID = "0c4f1c8e-4d6b-4a3e-8f0a-1b2c3d4e5f60" as OutletId;
const TENANT_ID = "7a1e2d3c-4b5a-4968-8776-655443322110";
const REFUND_ID = "22222222-2222-4222-8222-222222222222";
const PAYMENT_REF = "pay_0001";
const AMOUNT = 50_000;
const BASE_URL = "https://pay.doit.test";

const tenantContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({
    tenantId: TENANT_ID,
    brandId: null,
    source: "webhook",
  }),
  { kind: "tenant" },
);

afterEach(() => {
  vi.restoreAllMocks();
});

function refundRequest(
  overrides: Partial<GatewayRefundRequest> = {},
): GatewayRefundRequest {
  return {
    context: tenantContext,
    refundId: REFUND_ID,
    idempotencyKey: `refund:${REFUND_ID}`,
    paymentIntentId: "11111111-1111-4111-8111-111111111111",
    paymentProviderRef: PAYMENT_REF,
    integrationId: null,
    outletId: OUTLET_ID,
    amountIdr: AMOUNT,
    reason: "Pelanggan membatalkan pesanan",
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Real adapter whose credential and DNS steps each run `onStep` (the pause). */
function makeGateway(onStep: () => void) {
  const fetchStub = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "ref_0001",
          payment_id: PAYMENT_REF,
          amount: AMOUNT,
          status: "succeeded",
          reason: "x",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
  );
  const loadCredentials = async () => {
    onStep();
    return {
      integration: {
        id: INTEGRATION_ID,
        outletId: null,
        config: { baseUrl: BASE_URL },
      },
      credentials: { apiKey: "test-api-key", webhookSecret: "test-secret" },
    };
  };
  const gateway = createDoitGateway({
    fetch: fetchStub as unknown as typeof fetch,
    lookup: async () => {
      onStep();
      return [{ address: "8.8.8.8" }];
    },
    loadCredentials,
    loadCredentialsById: loadCredentials,
  });
  return { gateway, fetchStub };
}

describe("DOIT refund adapter: sendBy fence (legend-3usn8)", () => {
  it("sends nothing and stays unknown when the clock passes sendBy during the pause", async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const sendBy = clock + 5_000;
    // The stall: credentials and DNS together outlast the send deadline.
    const { gateway, fetchStub } = makeGateway(() => {
      clock += 4_000;
    });

    const error = await gateway.refund(refundRequest({ sendBy })).then(
      () => null,
      (e: unknown) => e,
    );

    expect(fetchStub).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(DoitRefundUnknownError);
    expect((error as DoitRefundUnknownError).code).toBe(
      "DOIT_SEND_DEADLINE_PASSED",
    );
  });

  it("sends nothing when the signal aborted during the pause", async () => {
    const controller = new AbortController();
    const { gateway, fetchStub } = makeGateway(() => controller.abort());

    await expect(
      gateway.refund(refundRequest({ signal: controller.signal })),
    ).rejects.toBeDefined();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("control: within sendBy the request is sent exactly once", async () => {
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const sendBy = clock + 10_000;
    const { gateway, fetchStub } = makeGateway(() => {
      clock += 1_000;
    });

    await expect(
      gateway.refund(refundRequest({ sendBy })),
    ).resolves.toMatchObject({ status: "succeeded", providerRef: "ref_0001" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("control: no sendBy behaves as before", async () => {
    const { gateway, fetchStub } = makeGateway(() => undefined);
    await gateway.refund(refundRequest());
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
