// Ports the reservation service codes against (playbook "Missing dependency?
// Do not block"). The DP is a WS-05 payment intent; opening its hosted payment
// page and refunding it are payment actions, so reservations only depend on
// this small interface. The default is fail-closed: with no port wired, a
// booking that needs a DP is refused (503) and a refund stays `pending`.
import { HttpError } from "../lib/http-error.ts";
import type { ScopedTenantContext } from "@starter/shared/core";

export type OpenedReservationDeposit = {
  /** `payment_intents.id` the gateway collects (stored as deposit_payment_id). */
  readonly paymentIntentId: string;
  /** Hosted payment page, https only. */
  readonly paymentUrl: string;
  readonly expiresAt: string;
};

export interface ReservationDepositPort {
  /**
   * Opens a payable DP for the reservation. Must be idempotent per
   * `idempotencyKey` (a retry returns the same intent).
   */
  openDeposit(input: {
    context: ScopedTenantContext;
    outletId: string;
    reservationId: string;
    amountIdr: number;
    expiresInMinutes: number;
    idempotencyKey: string;
    now: Date;
  }): Promise<OpenedReservationDeposit>;
  /** Asks WS-05 to refund `refundIdr` of the settled DP. Idempotent per key. */
  requestRefund(input: {
    context: ScopedTenantContext;
    paymentIntentId: string;
    refundIdr: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<void>;
}

const unavailable = (): HttpError =>
  new HttpError(
    503,
    "SERVICE_UNAVAILABLE",
    "Pembayaran DP belum tersedia. Coba lagi nanti.",
  );

/** Fail-closed default: no deposit can be opened, no refund requested. */
export const unconfiguredReservationDepositPort: ReservationDepositPort = {
  openDeposit: () => Promise.reject(unavailable()),
  requestRefund: () => Promise.reject(unavailable()),
};

let current: ReservationDepositPort = unconfiguredReservationDepositPort;

/** Wiring point for the payment bead and test double; null restores fail-closed. */
export function setReservationDepositPort(
  port: ReservationDepositPort | null,
): void {
  current = port ?? unconfiguredReservationDepositPort;
}

export function reservationDepositPort(): ReservationDepositPort {
  return current;
}
