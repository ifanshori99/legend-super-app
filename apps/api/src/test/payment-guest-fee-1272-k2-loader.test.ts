// 1272 K2 (legend-osqou.57): the default credential loader with the guest fee
// flag on. A locked channel is hidden and createIntent refuses it; a lock read
// that fails drops every guest-fee channel (QRIS stays), never the whole load.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { env } from "../config/env";
import { CoreError } from "@starter/shared/core";
import { createDuitkuGateway } from "../services/payment-duitku";
import { lockedGuestFeeChannels } from "../services/payment-guest-fee-lock";
import { loadActiveIntegrationCredentials } from "../services/platform-integration.service";

vi.mock("../services/platform-integration.service", () => ({
  loadActiveIntegrationCredentials: vi.fn(),
  loadIntegrationCredentialsById: vi.fn(),
}));
vi.mock("../services/payment-guest-fee-lock", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/payment-guest-fee-lock")
  >()),
  lockedGuestFeeChannels: vi.fn(),
}));

const TENANT_ID = "0b1f2c3d-0000-4000-8000-000000001273";
const INTENT_ID = "11111111-2222-4333-8444-555555551273";
const NOW = new Date("2026-11-27T03:00:00.000Z");
const BILL = 50_000;
const BC_RATE = { bps: 0, flatIdr: 4_000 };
const M2_RATE = { bps: 0, flatIdr: 4_000 };

const context = {
  tenant: { tenantId: TENANT_ID },
  outletScope: { kind: "all", tenantId: TENANT_ID },
} as unknown as ScopedTenantContext;

const loaded = {
  integration: {
    id: "0b1f2c3d-0000-4000-8000-0000000012b2",
    outletId: null,
    config: {
      environment: "production",
      notificationEmail: "owner@example.test",
      maxFeeBps_va: 0,
      maxFeeFlatIdr_va: 5_000,
      maxFeeBps_qris: 70,
      guestFees: { BC: BC_RATE, M2: M2_RATE },
    },
  },
  credentials: { merchantCode: "DS1273", apiKey: "api-key-SECRET" },
};

const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const answer = String(url).endsWith("getpaymentmethod")
    ? {
        responseCode: "00",
        paymentFee: ["SP", "BC", "M2"].map((paymentMethod) => ({
          paymentMethod,
          paymentName: `Method ${paymentMethod}`,
          totalFee: paymentMethod === "SP" ? "0" : "4000",
        })),
      }
    : {
        statusCode: "00",
        reference: "REF-1273",
        paymentUrl: "https://passport.duitku.com/pay/REF-1273",
        vaNumber: "8800123456789",
        qrString: "00020101021226QRSTRING",
        amount: String(body.paymentAmount),
      };
  return new Response(JSON.stringify(answer), { status: 200 });
}) as typeof fetch;

// No loader injected: the default loader (and its lock) is under test.
const port = () =>
  createDuitkuGateway({
    fetch: fetchImpl,
    now: () => NOW,
    callbackBaseUrl: "https://api.example.test",
    returnUrl: "https://app.example.test/paid",
  });

const request = (
  method: "qris" | "va",
  channelCode: string | null,
  guestFeeIdr?: number,
) => ({
  context,
  provider: "duitku",
  intentId: INTENT_ID,
  method,
  channelCode,
  amountIdr: BILL,
  ...(guestFeeIdr === undefined ? {} : { guestFeeIdr }),
  idempotencyKey: "idem-1273",
  expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
});

const saved = {
  methods: env.DUITKU_ENABLED_METHODS,
  fee: env.DUITKU_GUEST_FEE_METHODS,
};
beforeEach(() => {
  env.DUITKU_ENABLED_METHODS = ["qris", "va"];
  env.DUITKU_GUEST_FEE_METHODS = ["va"];
  vi.mocked(loadActiveIntegrationCredentials).mockResolvedValue(
    structuredClone(loaded) as never,
  );
  vi.mocked(lockedGuestFeeChannels).mockReset();
});
afterEach(() => {
  env.DUITKU_ENABLED_METHODS = saved.methods;
  env.DUITKU_GUEST_FEE_METHODS = saved.fee;
});

const channelsOf = async (method: string) =>
  (await port().methods!(context, undefined, BILL))
    .find((entry) => entry.method === method)
    ?.channels.map((c) => c.code);

describe("default loader with the guest fee flag on", () => {
  it("a locked channel is hidden, the others stay, and createIntent refuses it", async () => {
    vi.mocked(lockedGuestFeeChannels).mockResolvedValue(new Set(["BC"]));
    expect(await channelsOf("va")).toEqual(["M2"]);
    const error = await port()
      .createIntent(request("va", "BC", 4_000))
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("VALIDATION_ERROR");
  });

  it("no lock: every rated channel is listed", async () => {
    vi.mocked(lockedGuestFeeChannels).mockResolvedValue(new Set());
    expect(await channelsOf("va")).toEqual(["BC", "M2"]);
  });

  it("a failed lock read drops every guest-fee channel but QRIS stays", async () => {
    vi.mocked(lockedGuestFeeChannels).mockRejectedValue(new Error("db down"));
    expect(await channelsOf("va")).toEqual([]);
    const listed = await port().methods!(context, undefined, BILL);
    expect(listed.find((entry) => entry.method === "va")?.enabled).toBe(false);
    expect(listed.find((entry) => entry.method === "qris")?.enabled).toBe(true);
  });
});
