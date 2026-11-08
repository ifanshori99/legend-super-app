// Reservation, waitlist and event pre-order error codes, declared next to the
// schemas (docs/plan/contracts.md D-CORE-4). The UI maps `code` to catalog text;
// `message` is the safe Indonesian fallback the API returns. Codes are stable
// once shipped.

import { z } from "../core/index.ts";

export const reservationErrorHttpStatus = {
  /** RSV-01: another reservation already holds one of the tables in the slot. */
  RESERVATION_SLOT_TAKEN: 409,
  RESERVATION_NOT_FOUND: 404,
  /** The requested status change is not in the reservation state machine. */
  RESERVATION_TRANSITION_INVALID: 409,
  /** A required DP has not been paid yet (RSV-02). */
  RESERVATION_DEPOSIT_UNPAID: 409,
  /** The zone or requested slot is outside opening hours / has no free table. */
  RESERVATION_SLOT_UNAVAILABLE: 409,
  /** The pre-order package is inactive or inside its lead time. */
  RESERVATION_PACKAGE_UNAVAILABLE: 409,
  WAITLIST_ENTRY_NOT_FOUND: 404,
  /** Calling, seating or closing an entry outside the waitlist machine. */
  WAITLIST_TRANSITION_INVALID: 409,
  /** The guest is already on today's waitlist at this outlet. */
  WAITLIST_DUPLICATE_ENTRY: 409,
  /** Guest link is malformed, unknown, expired or revoked; never says which. */
  RESERVATION_LINK_INVALID: 404,
  /** The guest already has a reschedule request waiting for staff. */
  RESERVATION_RESCHEDULE_PENDING: 409,
  /** The requested new time is not allowed for this reservation. */
  RESERVATION_RESCHEDULE_INVALID: 422,
} as const satisfies Record<string, number>;

export type ReservationErrorCode = keyof typeof reservationErrorHttpStatus;
export const RESERVATION_ERROR_CODES = Object.keys(
  reservationErrorHttpStatus,
) as ReservationErrorCode[];

export const reservationErrorCodeSchema = z.enum(
  RESERVATION_ERROR_CODES as [ReservationErrorCode, ...ReservationErrorCode[]],
);

/** Safe Indonesian fallback messages, one per code. */
export const reservationErrorMessages: Record<ReservationErrorCode, string> = {
  RESERVATION_SLOT_TAKEN:
    "Meja yang dipilih sudah dipesan tamu lain pada jam tersebut.",
  RESERVATION_NOT_FOUND: "Reservasi tidak ditemukan.",
  RESERVATION_TRANSITION_INVALID:
    "Status reservasi tidak dapat diubah ke tahap tersebut.",
  RESERVATION_DEPOSIT_UNPAID: "DP reservasi belum dibayar.",
  RESERVATION_SLOT_UNAVAILABLE:
    "Tidak ada meja yang tersedia pada tanggal dan jam tersebut.",
  RESERVATION_PACKAGE_UNAVAILABLE:
    "Paket pre-order tidak tersedia atau sudah melewati batas pemesanan.",
  WAITLIST_ENTRY_NOT_FOUND: "Pendaftaran daftar tunggu tidak ditemukan.",
  WAITLIST_TRANSITION_INVALID:
    "Status daftar tunggu tidak dapat diubah ke tahap tersebut.",
  WAITLIST_DUPLICATE_ENTRY:
    "Tamu ini sudah terdaftar di daftar tunggu hari ini.",
  RESERVATION_LINK_INVALID: "Tautan reservasi tidak berlaku.",
  RESERVATION_RESCHEDULE_PENDING:
    "Permintaan jadwal ulang sebelumnya masih diproses.",
  RESERVATION_RESCHEDULE_INVALID:
    "Jadwal baru tidak dapat diminta untuk reservasi ini.",
};

/**
 * Domain error for reservation rules. Like the other domain errors it carries
 * the code and the safe message; the route maps the code to an HTTP status.
 */
export class ReservationError extends Error {
  readonly code: ReservationErrorCode;

  constructor(code: ReservationErrorCode, message?: string) {
    super(message ?? reservationErrorMessages[code]);
    this.name = "ReservationError";
    this.code = code;
  }
}
