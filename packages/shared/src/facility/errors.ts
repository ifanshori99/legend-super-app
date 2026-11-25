// Facility-domain error codes (docs/plan/contracts.md D-CORE-4: domain
// contracts declare their own UPPER_SNAKE codes next to their schemas). The
// API error handler maps FacilityError the same way it maps CoreError.

export const facilityErrorHttpStatus = {
  /** FAC-02: another ticket occupies this unit (with its cleaning buffer) at an overlapping time. */
  SLOT_UNAVAILABLE: 409,
  /** FAC-06: the unit is not clean yet, or is under maintenance. */
  UNIT_NOT_BOOKABLE: 409,
  /** FAC-06: the requested slot falls outside the facility's operating hours. */
  FACILITY_CLOSED: 409,
  /** FAC-01: the ticket is not inside its session window (or is not issued/in use). */
  TICKET_WINDOW_CLOSED: 409,
  /** The ticket status does not allow the requested action. */
  TICKET_TRANSITION_INVALID: 409,
  /** FAC-01: a ticket is issued for the area it was booked for, never another. */
  TICKET_WRONG_AREA: 403,
  /** FAC-05: one grant has fewer sessions left than the redemption asks for. */
  ENTITLEMENT_INSUFFICIENT: 422,
  /** FAC-05: this grant or this ticket already has a redemption claim. */
  ENTITLEMENT_ALREADY_REDEEMED: 409,
  /** FAC-07: the subscription quota may not be used (past-due beyond grace, paused, suspended, exhausted). */
  SUBSCRIPTION_QUOTA_UNAVAILABLE: 403,
  /** Subscription plan allows only so many sessions per business day. */
  MAX_PER_DAY_EXCEEDED: 409,
  /** FAC-12: the account already uses the maximum number of Wi-Fi devices. */
  WIFI_DEVICE_LIMIT: 409,
  /** FAC-13: the session was asked for a speed tier the policy does not define. */
  WIFI_POLICY_INVALID: 422,
  /** Cleaning cannot complete before every checklist item is done. */
  CLEANING_CHECKLIST_INCOMPLETE: 422,
  /** FAC-03: lock credentials are time-boxed; after `validUntil` the lock refuses them. */
  LOCK_CREDENTIAL_EXPIRED: 403,
  /** The cleaning task or incident was already closed. */
  ALREADY_CLOSED: 409,
  /** The caller already holds a place in the queue for this facility. */
  ALREADY_QUEUED: 409,
  /** Founder Q43: a breakfast order reaches the kitchen only after it is paid in full. */
  BREAKFAST_NOT_PAID: 409,
  /** The ticket already has a live (not cancelled) breakfast order. */
  BREAKFAST_ORDER_EXISTS: 409,
  /** The kitchen already has this breakfast order; it can no longer be cancelled. */
  BREAKFAST_ALREADY_FIRED: 409,
  /** The breakfast order was cancelled and cannot be paid or fired. */
  BREAKFAST_ORDER_CANCELLED: 409,
  /** The ticket cannot hold a breakfast order (not yours, wrong status, or past the fire time). */
  BREAKFAST_UNAVAILABLE: 422,
  /** 1269 F0: paid shower tickets and their rights are deferred past release 1; the server refuses every new one. */
  FACILITY_TICKETS_DISABLED: 403,
} as const satisfies Record<string, number>;

export type FacilityErrorCode = keyof typeof facilityErrorHttpStatus;
export const FACILITY_ERROR_CODES = Object.keys(
  facilityErrorHttpStatus,
) as FacilityErrorCode[];

/** Safe Indonesian fallback messages; the UI maps `code` to catalog text. */
const defaultMessages: Record<FacilityErrorCode, string> = {
  SLOT_UNAVAILABLE: "Slot ini sudah terisi. Silakan pilih slot lain.",
  UNIT_NOT_BOOKABLE: "Bilik ini belum siap dipakai. Pilih bilik lain.",
  FACILITY_CLOSED: "Fasilitas sedang tutup pada jam tersebut.",
  TICKET_WINDOW_CLOSED: "Tiket ini di luar jendela sesi.",
  TICKET_TRANSITION_INVALID: "Tiket tidak dapat diubah ke status tersebut.",
  TICKET_WRONG_AREA: "Tiket ini hanya berlaku untuk area yang dipesan.",
  ENTITLEMENT_INSUFFICIENT: "Sisa kuota hak akses tidak mencukupi.",
  ENTITLEMENT_ALREADY_REDEEMED: "Hak akses ini sudah ditukar.",
  SUBSCRIPTION_QUOTA_UNAVAILABLE:
    "Kuota langganan belum dapat dipakai. Selesaikan tagihan terlebih dahulu.",
  MAX_PER_DAY_EXCEEDED: "Batas sesi per hari untuk paket ini sudah tercapai.",
  WIFI_DEVICE_LIMIT:
    "Jumlah perangkat untuk akun ini sudah mencapai batas. Putuskan salah satu perangkat.",
  WIFI_POLICY_INVALID: "Kebijakan Wi-Fi tidak valid untuk zona ini.",
  CLEANING_CHECKLIST_INCOMPLETE:
    "Selesaikan seluruh checklist kebersihan sebelum menandai bilik siap.",
  LOCK_CREDENTIAL_EXPIRED: "Kredensial pintu sudah kedaluwarsa.",
  ALREADY_CLOSED: "Data ini sudah ditutup.",
  ALREADY_QUEUED: "Anda sudah berada dalam antrean fasilitas ini.",
  BREAKFAST_NOT_PAID:
    "Pesanan sarapan belum lunas, jadi belum dapat dikirim ke dapur.",
  BREAKFAST_ORDER_EXISTS: "Tiket ini sudah punya pesanan sarapan.",
  BREAKFAST_ALREADY_FIRED:
    "Pesanan sarapan sudah dikirim ke dapur dan tidak dapat dibatalkan.",
  BREAKFAST_ORDER_CANCELLED: "Pesanan sarapan ini sudah dibatalkan.",
  BREAKFAST_UNAVAILABLE: "Tiket ini sudah tidak dapat memesan sarapan.",
  FACILITY_TICKETS_DISABLED:
    "Tiket fasilitas belum dibuka. Layanan ini belum tersedia.",
};

export class FacilityError extends Error {
  readonly code: FacilityErrorCode;
  readonly status: number;

  constructor(
    code: FacilityErrorCode,
    message: string = defaultMessages[code],
  ) {
    super(message);
    this.name = "FacilityError";
    this.code = code;
    this.status = facilityErrorHttpStatus[code];
  }
}
