// Gateway port for payment intents (bead legend-gz3; PRD v1.7 §3.13
// "Adapter Gateway", PAY-02).
//
// The intent lifecycle never trusts a provider directly: it asks this port for
// the instructions the guest needs and for the provider's own status. The DOIT
// adapter (bead legend-b9i) implements the port; until it lands the default
// implementation fails closed — the link reports the gateway as down and no
// intent is created — which is also what the customer screen renders when a
// gateway outage happens ("Failover" routes the guest to the cashier).
//
// The port is deliberately small: creating a payable code, reading its status,
// the bank/channel list DOIT exposes (PRD: "Daftar metode aktif diambil dari
// endpoint DOIT, bukan ditulis tetap di kode"), and the gateway's health.
// Webhook signature verification and store-then-process dedupe stay with the
// adapter (legend-b9i), which calls `confirmPayment` after it has verified the
// payload.

import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import type {
  PaymentChannel,
  PaymentGatewayStatus,
  PaymentInstructions,
} from "@starter/shared/payment";

/** Online methods the guest screen offers (PRD §3.13 "Metode DOIT"). */
export type OnlinePaymentMethod = "qris" | "va" | "bank_transfer";

/**
 * Every online method a gateway may offer. Founder rule (8 Nov 2026): the
 * customer web takes QRIS, VA, e-wallet and card (plus pay at the cashier); POS
 * adds EDC. DOIT serves QRIS, VA and bank transfer at release (e-wallets pay
 * through QRIS); a gateway that adds direct e-wallet or card implements the
 * same port and reports them from `methods()`, so no caller contract changes.
 */
export type GatewayPaymentMethod = OnlinePaymentMethod | "ewallet" | "card";

/** One method as the provider reports it (PRD: "Daftar metode aktif diambil
 * dari endpoint DOIT, bukan ditulis tetap di kode"). */
export type GatewayMethodAvailability = {
  readonly method: GatewayPaymentMethod;
  readonly enabled: boolean;
  readonly channels: readonly PaymentChannel[];
};

export type GatewayHealth = {
  readonly status: PaymentGatewayStatus;
};

export type GatewayIntentRequest = {
  readonly context: ScopedTenantContext;
  readonly provider: string;
  readonly intentId: string;
  /** A gateway refuses (CoreError VALIDATION_ERROR) a method it does not
   * report as enabled from `methods()`. */
  readonly method: GatewayPaymentMethod;
  readonly channelCode: string | null;
  /** Server-priced amount (PAY-01). */
  readonly amountIdr: number;
  readonly idempotencyKey: string;
  readonly expiresAt: string;
};

export type GatewayIntent = {
  readonly providerRef: string;
  readonly instructions: PaymentInstructions;
  /** The provider may shorten the lifetime (QRIS is about 10 minutes). */
  readonly expiresAt: string;
};

export type GatewayPaymentStatus = {
  readonly status: "pending" | "paid" | "expired" | "failed";
  readonly providerRef: string;
  /** Amount the provider settled, when it reports one. */
  readonly amountIdr: number | null;
};

export interface PaymentGatewayPort {
  /** Provider code of the configured gateway (PRD default: DOIT). */
  readonly provider: string;
  health(context: ScopedTenantContext): Promise<GatewayHealth>;
  createIntent(input: GatewayIntentRequest): Promise<GatewayIntent>;
  getStatus(input: {
    context: ScopedTenantContext;
    providerRef: string;
    /** When given, the adapter refuses (as a gateway error) a provider
     * payment that was not created for this intent. */
    intentId?: string;
  }): Promise<GatewayPaymentStatus>;
  /** Banks/channels for `va` and `bank_transfer`; empty for `qris`. */
  channels(
    context: ScopedTenantContext,
    method: OnlinePaymentMethod,
  ): Promise<PaymentChannel[]>;
  /** Active methods from the provider's own endpoint. Optional so test
   * doubles written before it stay valid; a missing method means "use
   * `channels()` per online method". */
  methods?(
    context: ScopedTenantContext,
  ): Promise<readonly GatewayMethodAvailability[]>;
}

/**
 * Fail-closed default. `health()` reports `down`, so a payment link renders the
 * cashier fallback; creating or polling an intent answers 503 rather than
 * making up a payment.
 */
export const unconfiguredPaymentGateway: PaymentGatewayPort = {
  provider: "unconfigured",
  async health() {
    return { status: "down" };
  },
  async createIntent() {
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Belum ada gateway pembayaran yang aktif. Bayar di kasir.",
    );
  },
  async getStatus() {
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Status pembayaran belum dapat diperiksa. Bayar di kasir.",
    );
  },
  async channels() {
    return [];
  },
};

let gateway: PaymentGatewayPort = unconfiguredPaymentGateway;

/**
 * Installed by the API bootstrap (or a test) with a configured adapter. Never
 * install an adapter that skips verification: `confirmPayment` expects the
 * caller to have verified the evidence already.
 */
export function setPaymentGateway(next: PaymentGatewayPort | null): void {
  gateway = next ?? unconfiguredPaymentGateway;
}

export function paymentGateway(): PaymentGatewayPort {
  return gateway;
}
