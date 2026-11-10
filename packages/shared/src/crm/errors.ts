// CRM and loyalty error codes, declared next to the schemas (docs/plan/
// contracts.md D-CORE-4). The UI maps `code` to catalog text; `message` is the
// safe Indonesian fallback the API returns. HTTP status is chosen by the
// route from the code (see crmErrorHttpStatus); codes are stable once shipped.

import { z } from "../core/index.ts";

export const crmErrorHttpStatus = {
  /** Redemption needs more points than the balance (LOY-03). */
  POINTS_INSUFFICIENT: 409,
  /** Reward stock is exhausted (LOY-03). */
  REWARD_OUT_OF_STOCK: 409,
  REWARD_EXPIRED: 409,
  REDEMPTION_LIMIT_REACHED: 409,
  /** Voucher unknown, expired, already redeemed or not for this customer. */
  VOUCHER_INVALID: 422,
  PROMO_BUDGET_EXHAUSTED: 409,
  PROMO_QUOTA_EXHAUSTED: 409,
  /** LOY-04: the customer never consented to marketing. */
  MARKETING_CONSENT_REQUIRED: 403,
  /** Membership needs a verified WhatsApp number and loyalty consent. */
  MEMBERSHIP_NOT_ACTIVE: 403,
  CUSTOMER_NOT_FOUND: 404,
  CAMPAIGN_NOT_SCHEDULABLE: 409,
  // legend-111j
  /** A consent grant names a policy version that is no longer the active one. */
  CONSENT_POLICY_OUTDATED: 409,
  /** A cashier used up the daily phone-number lookups (use the member QR). */
  PHONE_LOOKUP_CAP_REACHED: 429,
  // legend-m4p5
  /** The redemption is not pending, or its voucher was already used. */
  REDEMPTION_NOT_CANCELLABLE: 409,
  // legend-xzr10
  /** The reward still has pending redemptions, so type, value or stock cannot change. */
  REWARD_HAS_PENDING_REDEMPTIONS: 409,
  /** A unique redemption code could not be generated after several tries. */
  REDEMPTION_CODE_UNAVAILABLE: 503,
} as const satisfies Record<string, number>;

export type CrmErrorCode = keyof typeof crmErrorHttpStatus;
export const CRM_ERROR_CODES = Object.keys(
  crmErrorHttpStatus,
) as CrmErrorCode[];

export const crmErrorCodeSchema = z.enum(
  CRM_ERROR_CODES as [CrmErrorCode, ...CrmErrorCode[]],
);

/** Safe Indonesian fallback messages, one per code. */
export const crmErrorMessages: Record<CrmErrorCode, string> = {
  POINTS_INSUFFICIENT: "Poin Anda belum cukup untuk penukaran ini.",
  REWARD_OUT_OF_STOCK: "Stok hadiah sudah habis.",
  REWARD_EXPIRED: "Hadiah ini sudah tidak berlaku.",
  REDEMPTION_LIMIT_REACHED: "Batas penukaran untuk hadiah ini sudah tercapai.",
  VOUCHER_INVALID: "Kode voucher tidak valid atau sudah tidak berlaku.",
  PROMO_BUDGET_EXHAUSTED: "Anggaran promo sudah habis.",
  PROMO_QUOTA_EXHAUSTED: "Kuota promo sudah habis.",
  MARKETING_CONSENT_REQUIRED:
    "Pelanggan ini tidak memberikan persetujuan pemasaran.",
  MEMBERSHIP_NOT_ACTIVE:
    "Keanggotaan aktif setelah nomor WhatsApp terverifikasi dan persetujuan program diberikan.",
  CUSTOMER_NOT_FOUND: "Pelanggan tidak ditemukan.",
  CAMPAIGN_NOT_SCHEDULABLE: "Kampanye tidak dapat dijadwalkan pada status ini.",
  CONSENT_POLICY_OUTDATED:
    "Versi kebijakan sudah diperbarui. Muat ulang lalu setujui versi terbaru.",
  PHONE_LOOKUP_CAP_REACHED:
    "Batas cari nomor hari ini tercapai. Pakai QR member.",
  // legend-m4p5
  REDEMPTION_NOT_CANCELLABLE: "Penukaran ini tidak bisa dibatalkan.",
  // legend-xzr10
  REWARD_HAS_PENDING_REDEMPTIONS:
    "Hadiah masih punya penukaran yang belum selesai.",
  REDEMPTION_CODE_UNAVAILABLE: "Kode penukaran belum bisa dibuat. Coba lagi.",
};
