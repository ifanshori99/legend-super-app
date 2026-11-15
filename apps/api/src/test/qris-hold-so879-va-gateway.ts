// Test helper (not a test file): lets a ScriptedGateway also create virtual
// account codes and list one VA bank, so a guest or a reservation payer can
// switch method (QR -> VA) and supersede the first code locally.
import type { ScopedTenantContext } from "@starter/shared/core";
import type { PaymentChannel } from "@starter/shared/payment";
import type {
  GatewayIntent,
  GatewayIntentRequest,
  OnlinePaymentMethod,
} from "../services/payment-gateway.ts";
import type { ScriptedGateway } from "./pos-qris-hold-test-helpers.ts";

export const VA_BANK: PaymentChannel = { code: "bmri", name: "Mandiri" };

/** The same object seen through the wider port types (no cast to any). */
type WidenedPort = {
  createIntent(input: GatewayIntentRequest): Promise<GatewayIntent>;
  channels(
    context: ScopedTenantContext,
    method: OnlinePaymentMethod,
  ): Promise<PaymentChannel[]>;
};

export function enableVaBank(gateway: ScriptedGateway): void {
  const port: WidenedPort = gateway;
  const create = port.createIntent.bind(gateway);
  port.createIntent = async (input) => {
    const base = await create(input);
    return input.method === "va"
      ? {
          ...base,
          instructions: {
            method: "va",
            channelCode: input.channelCode ?? VA_BANK.code,
            channelName: VA_BANK.name,
            virtualAccountNumber: "8808123456789012",
          },
        }
      : base;
  };
  port.channels = async (_context, method) =>
    method === "va" ? [VA_BANK] : [];
}
