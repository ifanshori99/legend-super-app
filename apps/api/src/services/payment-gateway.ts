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

/**
 * Every online method a gateway may offer. Founder rule (8 Nov 2026): the
 * customer web takes QRIS, VA, e-wallet and card (plus pay at the cashier); POS
 * adds EDC. DOIT serves QRIS and VA at release (e-wallets pay through QRIS);
 * Duitku adds direct e-wallet and card (pay-by-link). A gateway reports what it
 * serves from `methods()`, so no caller contract changes.
 */
export type OnlinePaymentMethod =
  "qris" | "va" | "bank_transfer" | "ewallet" | "card";

export type GatewayPaymentMethod = OnlinePaymentMethod;

/** One method as the provider reports it (PRD: "Daftar metode aktif diambil
 * dari endpoint DOIT, bukan ditulis tetap di kode"). */
export type GatewayMethodAvailability = {
  readonly method: GatewayPaymentMethod;
  readonly enabled: boolean;
  readonly channels: readonly PaymentChannel[];
};

export type GatewayHealth = {
  readonly status: PaymentGatewayStatus;
  /** `unconfigured`: the outlet has no usable gateway account (never set up).
   * It reads as `down` for the guest, but it is not an outage, so it opens no
   * failover incident and alerts nobody. */
  readonly reason?: "unconfigured";
};

export type GatewayIntentRequest = {
  readonly context: ScopedTenantContext;
  /** Outlet of the bill. A tenant-scoped caller (guest QR order) carries no
   * outlet in its context, so the adapter picks that outlet's own credentials
   * from here; absent, it falls back to the context's single outlet. */
  readonly outletId?: string;
  readonly provider: string;
  readonly intentId: string;
  /** A gateway refuses (CoreError VALIDATION_ERROR) a method it does not
   * report as enabled from `methods()`. */
  readonly method: GatewayPaymentMethod;
  readonly channelCode: string | null;
  /** Server-priced amount (PAY-01): the bill, never the guest fee. */
  readonly amountIdr: number;
  /** 1272 K1: guest service fee from `guestFeeSchedule` (design
   * duitku-fee-passthrough §2). The gateway charges `amountIdr + guestFeeIdr`
   * and refuses a fee it does not compute itself for that channel. Absent = 0;
   * a gateway without `guestFeeSchedule` refuses any other value. */
  readonly guestFeeIdr?: number;
  readonly idempotencyKey: string;
  readonly expiresAt: string;
};

export type GatewayIntent = {
  readonly providerRef: string;
  readonly instructions: PaymentInstructions;
  /** The provider may shorten the lifetime (QRIS is about 10 minutes). */
  readonly expiresAt: string;
  /** Integration row whose credentials created the payment; stored on the
   * intent so status checks and webhooks use the same account later. Absent
   * for a gateway without per-tenant integrations. */
  readonly integrationId?: string | null;
  /** 1272 K1: the provider's own fee quote for the charged amount, when it
   * gave one (Duitku `totalFee`). Absent or null = no quote. */
  readonly feeQuoteIdr?: number | null;
};

/**
 * 1272 K1: guest service fee of paying `baseIdr` (the bill) with a method and
 * channel: 0 = the method carries no fee; null = it should and the channel has
 * no usable rate (hide it, never a silent 0); else the fee on top of the bill.
 */
export type GuestFeeSchedule = (
  method: GatewayPaymentMethod,
  channelCode: string | null,
  baseIdr: number,
) => number | null;

/** No fee on anything: every gateway without `guestFeeSchedule`. */
export const NO_GUEST_FEE: GuestFeeSchedule = () => 0;

export type GatewayPaymentStatus = {
  readonly status: "pending" | "paid" | "expired" | "failed";
  readonly providerRef: string;
  /** Amount the provider settled, when it reports one. */
  readonly amountIdr: number | null;
  /** Provider time of the payment (ISO), when it reports one. A poll that
   * finds the payment after the code lapsed records this time, not the poll
   * time, so a payment made before expiry is never flagged late. Optional so
   * test doubles written before it stay valid; absent means "not reported". */
  readonly paidAt?: string | null;
  /** The provider's own status code (Duitku `"00"`/`"01"`/`"02"`). The mapped
   * `status` loses it, and a QRIS hold closes only on provider proof
   * (design legend-yhia9 D-03), so the code is carried as evidence. Optional:
   * DOIT and test doubles written before it stay valid. */
  readonly rawStatus?: string;
  /** Other provider transactions already paid on the same code, apart from
   * `providerRef` (a code can be paid again under a new provider reference).
   * The caller parks each one as unallocated funds; it never settles the
   * bill with them. Optional: gateways that cannot see them leave it out. */
  readonly extraPayments?: ReadonlyArray<{
    readonly providerRef: string;
    readonly amountIdr: number;
    readonly paidAt?: string | null;
  }>;
};

/** A code that was replaced by another one on the same bill. */
export type GatewayCancelRequest = {
  readonly intentId: string;
  /** Provider of the intent (`payment_intents.provider`). */
  readonly provider: string;
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
    /** Outlet of the bill the payment belongs to (see GatewayIntentRequest). */
    outletId?: string;
    /** Integration that created the payment (`GatewayIntent.integrationId`).
     * When given it wins over the outlet resolution, even if that row has
     * been disabled since (money already in flight). */
    integrationId?: string | null;
    providerRef: string;
    /** When given, the adapter refuses (as a gateway error) a provider
     * payment that was not created for this intent. */
    intentId?: string;
  }): Promise<GatewayPaymentStatus>;
  /** Banks/channels for `va`, `bank_transfer` and `ewallet`; empty for `qris`
   * and `card`. */
  channels(
    context: ScopedTenantContext,
    method: OnlinePaymentMethod,
    outletId?: string,
  ): Promise<PaymentChannel[]>;
  /** Active methods from the provider's own endpoint. Optional so test
   * doubles written before it stay valid; a missing method means "use
   * `channels()` per online method". With `amountIdr` the list is the one
   * valid for that bill amount (a method can be out of limits for it, legend-
   * kt3t1); omitted, it is the merchant's general list. */
  methods?(
    context: ScopedTenantContext,
    outletId?: string,
    amountIdr?: number,
  ): Promise<readonly GatewayMethodAvailability[]>;
  /** 1272 K1: the outlet's guest fee schedule, read from its integration
   * config without a provider call. Optional: absent = `NO_GUEST_FEE`. */
  guestFeeSchedule?(
    context: ScopedTenantContext,
    outletId?: string,
  ): Promise<GuestFeeSchedule>;
  /**
   * Best effort: closes a superseded code at the provider so it stops taking
   * money (a VA lives 3 hours). Optional; a code paid anyway is still settled
   * by its verified webhook and its money returned (qr-order-consumers.ts).
   */
  cancel?(
    context: ScopedTenantContext,
    intent: GatewayCancelRequest,
  ): Promise<void>;
  /** Credential check for the admin "test connection" button (sub-302 D16).
   * Works on a `draft` integration. Never returns secrets or raw provider
   * bodies. Optional: a gateway without it answers NOT_SUPPORTED. */
  testConnection?(
    context: ScopedTenantContext,
    integrationId: string,
  ): Promise<
    | {
        readonly ok: true;
        readonly methods: readonly GatewayMethodAvailability[];
      }
    | {
        readonly ok: false;
        readonly code:
          "GATEWAY_AUTH_FAILED" | "GATEWAY_UNREACHABLE" | "GATEWAY_REJECTED";
      }
  >;
}

/**
 * Fail-closed default. `health()` reports `down`, so a payment link renders the
 * cashier fallback; creating or polling an intent answers 503 rather than
 * making up a payment.
 */
export const unconfiguredPaymentGateway: PaymentGatewayPort = {
  provider: "unconfigured",
  async health() {
    return { status: "down", reason: "unconfigured" };
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

/** Registered adapters by provider code (sub-302 D1). */
const registry = new Map<string, PaymentGatewayPort>();
/** Test-only singleton mode (D2): `setPaymentGateway` makes one port answer
 * for every provider, as the old singleton did. */
let legacyPort: PaymentGatewayPort | null = null;

/** True while a test installed a port through `setPaymentGateway`. */
export function paymentGatewayLegacyMode(): boolean {
  return legacyPort !== null;
}

/**
 * Installed by the API bootstrap with one configured adapter per provider.
 * Adds or replaces `port.provider` and leaves legacy mode. Never install an
 * adapter that skips verification: `confirmPayment` expects the caller to have
 * verified the evidence already.
 */
export function registerPaymentGateway(port: PaymentGatewayPort): void {
  legacyPort = null;
  registry.set(port.provider, port);
}

/** Adapter of `provider`; fails closed (`unconfiguredPaymentGateway`) when none
 * is registered. */
export function paymentGatewayFor(provider: string): PaymentGatewayPort {
  if (legacyPort) return legacyPort;
  return registry.get(provider) ?? unconfiguredPaymentGateway;
}

export function registeredGatewayProviders(): readonly string[] {
  if (legacyPort) return [legacyPort.provider];
  return [...registry.keys()];
}

/** Tests: drop every adapter and leave legacy mode. */
export function resetPaymentGateways(): void {
  registry.clear();
  legacyPort = null;
}

/**
 * Test-only shim (sub-302 D2): clears the registry, registers `next` and turns
 * on legacy mode, where `paymentGatewayFor(anything)` returns `next`. `null`
 * resets. Production code (`server.ts`, `worker-main.ts`) must call
 * `registerPaymentGateway`, never this.
 */
export function setPaymentGateway(next: PaymentGatewayPort | null): void {
  resetPaymentGateways();
  if (!next) return;
  registry.set(next.provider, next);
  legacyPort = next;
}
