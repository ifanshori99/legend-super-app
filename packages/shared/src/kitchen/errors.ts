// Kitchen-domain error codes (docs/plan/contracts.md D-CORE-4: domain
// contracts declare their own UPPER_SNAKE codes; bead legend-usw3). The API
// error handler maps KitchenError the way it maps CoreError. A repeated
// picked-up or delivered call is NOT an error: those endpoints are idempotent
// and answer 200 with the unchanged row.

export const kitchenErrorHttpStatus = {
  /** "Diambil" needs the number to be called first (assigned -> picked_up is not a transition). */
  PICKUP_CALL_NOT_CALLED: 409,
  /** A picked-up number is closed: it can be neither called again nor reopened. */
  PICKUP_CALL_CLOSED: 409,
  /** "Diantar" needs every station ticket done (expo `isComplete`). */
  EXPO_ORDER_NOT_COMPLETE: 409,
  /** "Diantar" is marked by a runner: assign one first. */
  EXPO_RUNNER_NOT_ASSIGNED: 409,
  /** A delivered order keeps its runner: reassigning would rewrite who delivered. */
  EXPO_ORDER_DELIVERED: 409,
} as const satisfies Record<string, number>;

export type KitchenErrorCode = keyof typeof kitchenErrorHttpStatus;
export const KITCHEN_ERROR_CODES = Object.keys(
  kitchenErrorHttpStatus,
) as KitchenErrorCode[];

/** Safe Indonesian fallback messages; the UI maps `code` to catalog text. */
const defaultMessages: Record<KitchenErrorCode, string> = {
  PICKUP_CALL_NOT_CALLED: "Panggil nomor ini dulu sebelum menandai diambil.",
  PICKUP_CALL_CLOSED: "Nomor ini sudah diambil dan tidak bisa dipanggil lagi.",
  EXPO_ORDER_NOT_COMPLETE:
    "Pesanan belum lengkap di semua stasiun, belum bisa ditandai diantar.",
  EXPO_RUNNER_NOT_ASSIGNED:
    "Tugaskan runner dulu sebelum menandai pesanan diantar.",
  EXPO_ORDER_DELIVERED: "Pesanan sudah diantar; runner tidak bisa diganti.",
};

export class KitchenError extends Error {
  readonly code: KitchenErrorCode;
  readonly status: number;

  constructor(code: KitchenErrorCode, message: string = defaultMessages[code]) {
    super(message);
    this.name = "KitchenError";
    this.code = code;
    this.status = kitchenErrorHttpStatus[code];
  }
}
