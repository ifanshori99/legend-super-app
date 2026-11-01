// Daily-operations error codes (docs/plan/contracts.md D-CORE-4: a domain
// declares its own UPPER_SNAKE codes next to its schemas). The API error
// handler maps OperationsError the same way it maps CoreError.

export const operationsErrorHttpStatus = {
  /** OPS-01: a checklist item is claimed done but its required evidence is missing. */
  CHECKLIST_ITEM_INCOMPLETE: 422,
  /** The item is not part of the run's template snapshot (`run.items`). */
  CHECKLIST_ITEM_NOT_IN_RUN: 404,
  /** The checklist run status does not allow the requested action. */
  CHECKLIST_TRANSITION_INVALID: 409,
  /** OPS-02: an out-of-range temperature needs a corrective action before it can be saved. */
  TEMPERATURE_CORRECTIVE_ACTION_REQUIRED: 422,
  /** The temperature reading or threshold is not a valid number pair. */
  TEMPERATURE_READING_INVALID: 422,
  /** A prep list that is already completed cannot go back. */
  PREP_LIST_TRANSITION_INVALID: 409,
  /** The equipment status does not allow the requested action. */
  EQUIPMENT_TRANSITION_INVALID: 409,
  /** A breakdown ticket needs at least one photo (PRD §3 F45). */
  MAINTENANCE_PHOTO_REQUIRED: 422,
  /** The maintenance ticket status does not allow the requested action. */
  MAINTENANCE_TRANSITION_INVALID: 409,
  /** OPS-05: a shift handover cannot close before the next shift confirms it. */
  HANDOVER_ACKNOWLEDGEMENT_REQUIRED: 422,
  /** OPS-05: the receiving shift confirms, not the submitting shift itself. */
  HANDOVER_SELF_ACKNOWLEDGEMENT: 403,
  /** The handover was already acknowledged. */
  HANDOVER_ALREADY_ACKNOWLEDGED: 409,
} as const satisfies Record<string, number>;

export type OperationsErrorCode = keyof typeof operationsErrorHttpStatus;
export const OPERATIONS_ERROR_CODES = Object.keys(
  operationsErrorHttpStatus,
) as OperationsErrorCode[];

/** Safe Indonesian fallback messages; the UI maps `code` to catalog text. */
const defaultMessages: Record<OperationsErrorCode, string> = {
  CHECKLIST_ITEM_INCOMPLETE:
    "Butir checklist belum lengkap. Lengkapi foto, angka, atau tanda tangan yang diminta.",
  CHECKLIST_ITEM_NOT_IN_RUN:
    "Butir checklist ini tidak ada pada checklist tersebut.",
  CHECKLIST_TRANSITION_INVALID:
    "Checklist ini tidak dapat diubah ke status tersebut.",
  TEMPERATURE_CORRECTIVE_ACTION_REQUIRED:
    "Suhu di luar ambang wajib disertai tindakan korektif.",
  TEMPERATURE_READING_INVALID: "Pembacaan suhu tidak valid.",
  PREP_LIST_TRANSITION_INVALID:
    "Daftar prep ini tidak dapat diubah ke status tersebut.",
  EQUIPMENT_TRANSITION_INVALID:
    "Peralatan tidak dapat diubah ke status tersebut.",
  MAINTENANCE_PHOTO_REQUIRED:
    "Tiket kerusakan wajib dilengkapi minimal satu foto.",
  MAINTENANCE_TRANSITION_INVALID:
    "Tiket perawatan tidak dapat diubah ke status tersebut.",
  HANDOVER_ACKNOWLEDGEMENT_REQUIRED:
    "Serah terima belum dikonfirmasi shift penerima.",
  HANDOVER_SELF_ACKNOWLEDGEMENT:
    "Serah terima dikonfirmasi oleh shift penerima, bukan shift yang menyerahkan.",
  HANDOVER_ALREADY_ACKNOWLEDGED: "Serah terima ini sudah dikonfirmasi.",
};

export class OperationsError extends Error {
  readonly code: OperationsErrorCode;
  readonly status: number;

  constructor(
    code: OperationsErrorCode,
    message: string = defaultMessages[code],
  ) {
    super(message);
    this.name = "OperationsError";
    this.code = code;
    this.status = operationsErrorHttpStatus[code];
  }
}
