// POS-domain error codes (docs/plan/contracts.md D-CORE-4: domain contracts
// declare their own UPPER_SNAKE codes next to their schemas). The API error
// handler maps PosError the same way it maps CoreError.

export const posErrorHttpStatus = {
  /** POS-04: a completed or voided order is never edited or deleted. */
  ORDER_FINAL_IMMUTABLE: 409,
  /** EDC-01: an EDC request is still waiting for its result; the bill is locked. */
  EDC_REQUEST_OPEN: 409,
  /** The action is not one of the order's explicit transitions. */
  ORDER_TRANSITION_INVALID: 409,
  /** Fire needs at least one held item; everything is already in the kitchen. */
  ORDER_HAS_NO_HELD_ITEMS: 409,
  /** An order cannot be settled while it is a draft or already voided. */
  ORDER_NOT_PAYABLE: 409,
  /** POS-02: a void of an order or item always carries a verified approval. */
  VOID_APPROVAL_REQUIRED: 403,
  /** POS-02: a manual discount above the tenant threshold needs approval. */
  DISCOUNT_APPROVAL_REQUIRED: 403,
  /** A manual discount cannot be larger than the discounted subtotal. */
  DISCOUNT_EXCEEDS_SUBTOTAL: 422,
  /** POS-02: a refund always carries a verified approval. */
  REFUND_APPROVAL_REQUIRED: 403,
  /** EDC-04: a standalone EDC payment always carries a verified approval. */
  EDC_STANDALONE_APPROVAL_REQUIRED: 403,
  /** X1 1273: the slip number already paid a bill; a supervisor may allow it. */
  EDC_SLIP_REF_USED: 409,
  /** A refund may not exceed what is still refundable on the order. */
  REFUND_EXCEEDS_PAID: 422,
  /** POS-04: corrections (void/refund records) only target final orders. */
  CORRECTION_TARGET_NOT_FINAL: 409,
  /** The captured tenders do not equal the order total. */
  TENDER_TOTAL_MISMATCH: 422,
  /** Only a cash tender records received cash and change. */
  CASH_TENDER_MISMATCH: 422,
  /** POS-03: cash may only move while the shift is open. */
  SHIFT_NOT_OPEN: 409,
  /** POS-03: a shift closes once. */
  SHIFT_ALREADY_CLOSED: 409,
  /** POS-03: after approval the counted amount and variance are locked. */
  SHIFT_VARIANCE_LOCKED: 409,
  /** U9: a cash difference is explained before the shift closes. */
  SHIFT_VARIANCE_NOTE_REQUIRED: 422,
  /** The drawer changed after the count: the cashier counts again. */
  SHIFT_COUNT_STALE: 409,
  /** A newer count of the same shift replaced this one. */
  SHIFT_COUNT_SUPERSEDED: 409,
  /** The cashier used all recounts of the shift: a supervisor force closes it. */
  SHIFT_COUNT_LIMIT: 409,
  /** A device holds one open shift at a time. */
  SHIFT_ALREADY_OPEN: 409,
  /** An order can only be billed to an open shift of its own terminal. */
  SHIFT_ORDER_MISMATCH: 403,
  /** POS-06: every receipt ordinal of a device exists; none is missing. */
  RECEIPT_SEQUENCE_GAP: 409,
  /** POS-06: a device may not rewrite or reuse an already issued number. */
  RECEIPT_SEQUENCE_REGRESSION: 409,
  /** The receipt number does not belong to this device's prefix/ordinal. */
  RECEIPT_PREFIX_MISMATCH: 422,
  /** An edge sale needs a verified device to take a receipt number. */
  RECEIPT_DEVICE_REQUIRED: 422,
  /** The edge has no cloud-provisioned receipt sequence for this device. */
  RECEIPT_SEQUENCE_NOT_PROVISIONED: 409,
  /** A merged receipt says voided but the cloud holds no matching void. */
  RECEIPT_VOID_UNMATCHED: 409,
  /** S-K1 (legend-3yqy): the device numbers on the outlet edge, not the cloud. */
  RECEIPT_DEVICE_ON_EDGE: 409,
  /** A receipt is voided once; its number stays on record. */
  RECEIPT_ALREADY_VOIDED: 409,
  /** The business day was already closed for this outlet. */
  BUSINESS_DAY_ALREADY_CLOSED: 409,
  /** legend-k0i8: the outlet closes its business day on its edge, not in the cloud. */
  DAY_CLOSE_ON_EDGE: 409,
  /** 1269 E3: the outlet sells and runs its drawers on its edge, not in the cloud. */
  POS_WRITE_ON_EDGE: 409,
  /** legend-yhia9: a QRIS can still be paid; the bill's money is frozen. */
  QRIS_HOLD_ACTIVE: 409,
  /** legend-yhia9 D-09: an edge without gateway credentials cannot issue QRIS. */
  QRIS_NEEDS_CLOUD: 409,
  /** O3 (legend-wasr7.7): the tablet still holds offline sales it has not synced. */
  OFFLINE_QUEUE_PENDING: 409,
  /** Review O3 P2 1: the shift has an offline kit but its device did not report the queue. */
  OFFLINE_QUEUE_UNVERIFIED: 409,
  /** Review O3 P1: the offline sale's eventId is already stored under another kit. */
  OFFLINE_EVENT_CONFLICT: 409,
  /** 1271 F1: the outlet edge sent a heartbeat recently; failover needs an override. */
  FAILOVER_EDGE_HEALTHY: 409,
  /** 1271 F1: the outlet sells through the cloud (failover window open). */
  FAILOVER_ACTIVE: 409,
  /** 1271 F1: open failover work (unpaid order, QRIS hold, shift without count). */
  FAILOVER_OPEN_WORK: 409,
  /** 1271 F1: the outlet has no failover window in the state this action needs. */
  FAILOVER_NOT_ACTIVE: 409,
  /** 1271 F1 D6: failover is switched off on this server (EDGE_FAILOVER_ENABLED). */
  FAILOVER_DISABLED: 403,
  /** 1271 F3: return to the edge needs a fresh edge heartbeat (< 60 s). */
  FAILOVER_EDGE_OFFLINE: 409,
} as const satisfies Record<string, number>;

export type PosErrorCode = keyof typeof posErrorHttpStatus;
export const POS_ERROR_CODES = Object.keys(
  posErrorHttpStatus,
) as PosErrorCode[];

/** Safe Indonesian fallback messages; the UI maps `code` to catalog text. */
const defaultMessages: Record<PosErrorCode, string> = {
  ORDER_FINAL_IMMUTABLE:
    "Transaksi ini sudah final dan tidak dapat diubah atau dihapus.",
  EDC_REQUEST_OPEN:
    "EDC masih menunggu hasil; cek status EDC dulu sebelum mengubah tagihan.",
  ORDER_TRANSITION_INVALID: "Status pesanan tidak mendukung tindakan ini.",
  ORDER_HAS_NO_HELD_ITEMS: "Tidak ada item yang masih ditahan untuk dikirim.",
  ORDER_NOT_PAYABLE: "Pesanan ini tidak dapat dibayar pada status tersebut.",
  VOID_APPROVAL_REQUIRED: "Void memerlukan persetujuan supervisor.",
  DISCOUNT_APPROVAL_REQUIRED: "Diskon di atas ambang memerlukan persetujuan.",
  DISCOUNT_EXCEEDS_SUBTOTAL: "Diskon melebihi nilai pesanan.",
  REFUND_APPROVAL_REQUIRED: "Refund memerlukan persetujuan supervisor.",
  EDC_STANDALONE_APPROVAL_REQUIRED:
    "Pembayaran EDC standalone memerlukan persetujuan supervisor.",
  EDC_SLIP_REF_USED:
    "Nomor referensi slip EDC ini sudah dipakai untuk tagihan lain. Periksa nomor di slip, atau minta persetujuan supervisor bila slip memang benar.",
  REFUND_EXCEEDS_PAID: "Refund melebihi nominal yang masih dapat direfund.",
  CORRECTION_TARGET_NOT_FINAL: "Koreksi hanya untuk transaksi final.",
  TENDER_TOTAL_MISMATCH: "Pembayaran belum menutup seluruh tagihan.",
  CASH_TENDER_MISMATCH: "Hanya pembayaran tunai yang mencatat uang diterima.",
  SHIFT_NOT_OPEN: "Tidak ada shift kasir yang terbuka. Buka shift dulu.",
  SHIFT_ALREADY_CLOSED: "Shift ini sudah ditutup.",
  SHIFT_VARIANCE_LOCKED:
    "Selisih kas yang sudah disetujui tidak dapat diubah lagi.",
  SHIFT_VARIANCE_NOTE_REQUIRED: "Selisih kas wajib diberi penjelasan.",
  SHIFT_COUNT_STALE: "Kas laci berubah setelah dihitung. Hitung ulang.",
  SHIFT_COUNT_SUPERSEDED:
    "Hitungan ini sudah diganti hitungan yang lebih baru.",
  SHIFT_COUNT_LIMIT:
    "Batas hitung ulang tercapai. Minta supervisor menutup shift.",
  SHIFT_ALREADY_OPEN: "Perangkat ini masih memiliki shift yang terbuka.",
  SHIFT_ORDER_MISMATCH: "Pesanan ini bukan milik shift perangkat tersebut.",
  RECEIPT_SEQUENCE_GAP: "Ada nomor struk yang hilang pada perangkat ini.",
  RECEIPT_SEQUENCE_REGRESSION:
    "Nomor struk tidak boleh mundur atau dipakai ulang.",
  RECEIPT_PREFIX_MISMATCH: "Nomor struk tidak cocok dengan prefiks perangkat.",
  RECEIPT_DEVICE_REQUIRED:
    "Penjualan di edge memerlukan perangkat terverifikasi.",
  RECEIPT_SEQUENCE_NOT_PROVISIONED:
    "Perangkat ini belum menerima urutan nomor struk dari cloud.",
  RECEIPT_VOID_UNMATCHED:
    "Struk ditandai void tetapi cloud tidak punya void yang cocok.",
  RECEIPT_DEVICE_ON_EDGE:
    "Perangkat ini memberi nomor struk lewat server lokal outlet. Lakukan penjualan lewat server lokal.",
  RECEIPT_ALREADY_VOIDED: "Struk ini sudah di-void.",
  BUSINESS_DAY_ALREADY_CLOSED: "Hari kerja ini sudah ditutup.",
  DAY_CLOSE_ON_EDGE:
    "Outlet ini menutup hari lewat server lokal. Lakukan Tutup Hari di server lokal outlet.",
  POS_WRITE_ON_EDGE:
    "Kasir outlet ini berjalan lewat server lokal. Lakukan transaksi di server lokal outlet.",
  QRIS_HOLD_ACTIVE:
    "Pembayaran QR sedang dikonfirmasi penyedia. Tunggu konfirmasi sebelum menerima pembayaran lain.",
  QRIS_NEEDS_CLOUD:
    "QRIS belum bisa dibuat dari server lokal outlet. Pakai kasir online atau metode lain.",
  OFFLINE_QUEUE_PENDING:
    "Masih ada penjualan offline yang belum terkirim. Sambungkan tablet ke internet dan tunggu sampai terkirim sebelum tutup shift.",
  OFFLINE_QUEUE_UNVERIFIED:
    "Shift ini memakai bekal offline. Tutup shift dari tablet kasir pemegang bekal, atau minta supervisor menutup paksa.",
  OFFLINE_EVENT_CONFLICT:
    "Penjualan offline ini sudah tercatat dari bekal lain. Tablet mengirim laporan konflik untuk dicek.",
  FAILOVER_EDGE_HEALTHY:
    "Server lokal outlet masih aktif. Pindah ke mode cloud hanya dengan alasan khusus.",
  FAILOVER_ACTIVE:
    "Outlet sedang berjalan dalam mode cloud. Lakukan transaksi lewat kasir mode cloud.",
  FAILOVER_OPEN_WORK:
    "Masih ada pekerjaan mode cloud yang terbuka. Selesaikan dulu sebelum kembali ke server lokal.",
  FAILOVER_NOT_ACTIVE: "Outlet ini tidak sedang dalam mode cloud.",
  FAILOVER_DISABLED: "Mode cloud belum diaktifkan untuk server ini.",
  FAILOVER_EDGE_OFFLINE:
    "Server lokal outlet belum tersambung. Kembali ke server lokal setelah server lokal menyala dan tersambung.",
};

export class PosError extends Error {
  readonly code: PosErrorCode;
  readonly status: number;

  constructor(code: PosErrorCode, message: string = defaultMessages[code]) {
    super(message);
    this.name = "PosError";
    this.code = code;
    this.status = posErrorHttpStatus[code];
  }
}
