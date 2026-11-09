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

export type GatewayHealth = {
  readonly status: PaymentGatewayStatus;
};

export type GatewayIntentRequest = {
  readonly context: ScopedTenantContext;
  readonly provider: string;
  readonly intentId: string;
  readonly method: OnlinePaymentMethod;
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

/** A code that was replaced by another one on the same bill. */
export type GatewayCancelRequest = {
  readonly intentId: string;
  readonly providerRef: string;
  readonly outletId: string;
};

export interface PaymentGatewayPort {
  /** Provider code of the configured gateway (PRD default: DOIT). */
  readonly provider: string;
  /** `outletId`: outlet of the bill, so a per-outlet adapter (m1 DOIT) picks
   * that outlet's credentials; an adapter without outlets ignores it. */
  health(
    context: ScopedTenantContext,
    outletId?: string,
  ): Promise<GatewayHealth>;
  createIntent(input: GatewayIntentRequest): Promise<GatewayIntent>;
  getStatus(input: {
    context: ScopedTenantContext;
    providerRef: string;
  }): Promise<GatewayPaymentStatus>;
  /** Banks/channels for `va` and `bank_transfer`; empty for `qris`. */
  channels(
    context: ScopedTenantContext,
    method: OnlinePaymentMethod,
    outletId?: string,
  ): Promise<PaymentChannel[]>;
  /**
   * Best effort: closes a superseded code at the provider so it stops taking
   * money (a VA lives 3 hours). Optional; a code paid anyway is still settled
   * by its verified webhook and its money returned (qr-order-consumers.ts).
   */
  cancel?(
    context: ScopedTenantContext,
    intent: GatewayCancelRequest,
  ): Promise<void>;
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
