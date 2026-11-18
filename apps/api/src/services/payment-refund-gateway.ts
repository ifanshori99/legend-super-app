// Gateway port for refund payouts (beads legend-hvvn, legend-rbjw; PAY-04).
//
// Money only leaves through this port after an approved refund claimed its
// payout. The port is separate from `PaymentGatewayPort` on purpose: adding a
// method there would break every `FakeGateway` in the tests and the unmerged
// DOIT branch. The DOIT adapter implements this port after `ws/doit-provider`
// merges; until then the default implementation fails closed — a payout answers
// 503 and the refund stays `approved` so it can be retried later. The DOIT
// adapter (`createDoitGateway`) implements this port too.
//
// Contract the adapter must keep:
// - `idempotencyKey` is `refund:<refundId>` and the provider MUST dedupe on it,
//   so a retry after a timeout can never pay twice.
// - A throw means the outcome is UNKNOWN (timeout, 5xx, network). The caller
//   keeps the refund `approved` and retries with the same key. Only a returned
//   `failed` result is a definitive decline.
// - `pending` means the provider accepted the refund and finishes it later
//   (webhook or `getRefundStatus` poll).
// - Every call carries an `AbortSignal` (30 s deadline); the adapter must honour
//   it. A timeout is an unknown outcome like a throw.
// - `refund()` runs on the first attempt only (legend-xd2q tripwire). After an
//   earlier attempt the service only asks `getRefundStatus`; a `not_found`
//   answer never re-sends: the refund is flagged PAYOUT_NOT_FOUND_MAYBE_SENT
//   for ops. An unknown outcome ends in manual reconciliation, never a second
//   payout. A refund finance paid by hand is closed with settle-manually
//   (SETTLED_OUTSIDE_PROVIDER); a later provider success on it is a conflict.
// - `failed` is only for a definitive decline of the first send (or a request
//   that never left, e.g. no payment ref). Any unrecognised answer throws.

import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import { env } from "../config/env";

export type GatewayRefundRequest = {
  readonly context: ScopedTenantContext;
  readonly refundId: string;
  /** `refund:<refundId>`; the provider MUST dedupe on it. */
  readonly idempotencyKey: string;
  readonly paymentIntentId: string;
  /** Provider ref of the original payment (or the fund's evidence). */
  readonly paymentProviderRef: string | null;
  /** Integration that minted the payment intent (`gatewayIntegrationId`); the
   * adapter refunds with its credentials. Null on rows minted before it existed. */
  readonly integrationId: string | null;
  /** Outlet of the payment intent (credential resolution when no integration). */
  readonly outletId: string;
  /** Integer IDR. */
  readonly amountIdr: number;
  readonly reason: string;
  /** Aborts at the call deadline; an abort is an unknown outcome. */
  readonly signal: AbortSignal;
  /** Epoch ms (legend-3usn8): the request must not leave at or after this
   * instant. The adapter checks it directly before the network send; past it,
   * nothing is sent and the outcome is unknown. */
  readonly sendBy?: number;
};

export type GatewayRefundResult =
  | { readonly status: "succeeded"; readonly providerRef: string }
  /** Async: a webhook or poll finishes it. */
  | { readonly status: "pending"; readonly providerRef: string }
  /** Definitive decline; the money did not move. */
  | {
      readonly status: "failed";
      readonly providerRef: string | null;
      readonly code: string;
    };

/** Answer of a status lookup: a result, or the provider never saw the key. */
export type GatewayRefundLookup =
  GatewayRefundResult | { readonly status: "not_found" };

export interface PaymentRefundPort {
  /** Provider code of the configured gateway (PRD default: DOIT). */
  readonly provider: string;
  /** Throwing means the outcome is unknown; retry with the same key. */
  refund(input: GatewayRefundRequest): Promise<GatewayRefundResult>;
  getRefundStatus(input: {
    context: ScopedTenantContext;
    idempotencyKey: string;
    providerRef: string | null;
    paymentIntentId: string;
    /** Provider ref of the original payment. */
    paymentProviderRef: string | null;
    /** Integration that minted the payment intent. */
    integrationId: string | null;
    outletId: string;
    /** Integer IDR. */
    amountIdr: number;
    signal: AbortSignal;
  }): Promise<GatewayRefundLookup>;
}

/** `provider` of the fail-closed default. While it is installed the refund
 * service claims nothing: a claim would count an attempt that never reached any
 * provider and strand the refund once a real gateway is installed. */
export const UNCONFIGURED_REFUND_PROVIDER = "unconfigured";

/**
 * Fail-closed default. Both calls answer 503 rather than pretending money
 * moved; an approved refund then stays `approved` until an adapter is installed.
 */
export const unconfiguredRefundGateway: PaymentRefundPort = {
  provider: UNCONFIGURED_REFUND_PROVIDER,
  async refund() {
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Belum ada gateway refund yang aktif. Refund akan dicoba lagi nanti.",
    );
  },
  async getRefundStatus() {
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Status refund belum dapat diperiksa. Coba lagi nanti.",
    );
  },
};

const registry = new Map<string, PaymentRefundPort>();
/** Test-only singleton mode, same idea as `setPaymentGateway`. */
let legacyPort: PaymentRefundPort | null = null;

/**
 * Installed by the API bootstrap with a configured adapter per provider. The
 * adapter must dedupe on `idempotencyKey`; the service relies on it for retries.
 */
export function registerPaymentRefundGateway(port: PaymentRefundPort): void {
  legacyPort = null;
  registry.set(port.provider, port);
}

/** Provider whose automatic refunds sit behind `DOIT_REFUNDS_ENABLED`. */
const DOIT_REFUND_PROVIDER = "doit";

/** Defence in depth: a registered DOIT adapter stays unreachable while the
 * switch is off, even if some bootstrap registered it by mistake. */
function refundProviderSwitchedOff(provider: string): boolean {
  return provider === DOIT_REFUND_PROVIDER && !env.DOIT_REFUNDS_ENABLED;
}

/** Refund port of `provider`; fails closed when none is registered, or when
 * the provider is DOIT and `DOIT_REFUNDS_ENABLED` is off. */
export function paymentRefundGatewayFor(provider: string): PaymentRefundPort {
  if (legacyPort) return legacyPort;
  if (refundProviderSwitchedOff(provider)) return unconfiguredRefundGateway;
  return registry.get(provider) ?? unconfiguredRefundGateway;
}

/** True while a test installed a port through `setPaymentRefundGateway`. */
export function paymentRefundGatewayLegacyMode(): boolean {
  return legacyPort !== null;
}

export function registeredRefundProviders(): readonly string[] {
  if (legacyPort) return [legacyPort.provider];
  return [...registry.keys()].filter(
    (provider) => !refundProviderSwitchedOff(provider),
  );
}

export function resetPaymentRefundGateways(): void {
  registry.clear();
  legacyPort = null;
}

/** Test-only shim (sub-302 D6): one port answers for every provider. Throws in
 * production so legacy mode (which ignores `DOIT_REFUNDS_ENABLED`) can never run
 * there. */
export function setPaymentRefundGateway(next: PaymentRefundPort | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "setPaymentRefundGateway is test-only; not allowed in production",
    );
  }
  resetPaymentRefundGateways();
  if (!next) return;
  registry.set(next.provider, next);
  legacyPort = next;
}
