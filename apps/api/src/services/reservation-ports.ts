// Ports the reservation service codes against (playbook "Missing dependency?
// Do not block"). The DP is a WS-05 bill link: booking opens the link, the
// guest opens the hosted payment page and creates the intent there (WS-05 as
// built), and `payment.paid` on that link confirms the reservation. Refunds are
// not a port: they go through the WS-05 refund request in
// reservation-refunds.ts. The default is fail-closed: with no port wired, a
// booking that needs a DP is refused (503) before anything is held.
// Wiring: server.ts and worker-main.ts install
// `createPaymentReservationDepositPort()` (reservation-deposit-payment.ts).
import { HttpError } from "../lib/http-error.ts";
import type { ScopedTenantContext } from "@starter/shared/core";

export type OpenedReservationDeposit = {
  /** `payment_links.id` (stored as deposit_payment_link_id). */
  readonly paymentLinkId: string;
  /** App-local hosted payment page path (`/bayar/<token>`); a credential. */
  readonly paymentPath: string;
  readonly expiresAt: string;
};

export interface ReservationDepositPort {
  /**
   * Throws a 503 when online DP payments cannot be collected right now
   * (gateway unconfigured or down). Called BEFORE a DP booking holds tables.
   */
  assertReady(context: ScopedTenantContext): Promise<void>;
  /** Opens the payable DP bill link for the reservation. */
  openDeposit(input: {
    context: ScopedTenantContext;
    outletId: string;
    reservationId: string;
    amountIdr: number;
    expiresInMinutes: number;
    now: Date;
  }): Promise<OpenedReservationDeposit>;
}

/** Online DP payments are not configured: the guest must contact the venue. */
export const depositUnavailable = (): HttpError =>
  new HttpError(
    503,
    "SERVICE_UNAVAILABLE",
    "Pembayaran DP online belum tersedia untuk outlet ini. Silakan hubungi outlet untuk reservasi.",
  );

/** Fail-closed default: no DP booking is accepted, no link is opened. */
export const unconfiguredReservationDepositPort: ReservationDepositPort = {
  assertReady: () => Promise.reject(depositUnavailable()),
  openDeposit: () => Promise.reject(depositUnavailable()),
};

let current: ReservationDepositPort = unconfiguredReservationDepositPort;

/** Wiring point for the payment adapter and test doubles; null restores fail-closed. */
export function setReservationDepositPort(
  port: ReservationDepositPort | null,
): void {
  current = port ?? unconfiguredReservationDepositPort;
}

export function reservationDepositPort(): ReservationDepositPort {
  return current;
}
