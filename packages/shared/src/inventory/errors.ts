// Domain codes for the inventory contract (bead legend-p38, PRD v1.7 §16,
// §17, §6.E). The API maps them to HTTP responses the same way it maps core
// codes; the UI maps them to catalog text. Codes are UPPER_SNAKE_CASE and
// stable once shipped (docs/plan/contracts.md, D-CORE-4).

import { z } from "../core/index.ts";

export const INVENTORY_ERROR_CODES = [
  /** A recipe component graph loops back to a recipe already being costed. */
  "RECIPE_CYCLE",
  /** A referenced recipe does not exist in the cost book. */
  "RECIPE_NOT_FOUND",
  /** A nested recipe has no output item, so its unit cost cannot be derived. */
  "RECIPE_OUTPUT_MISSING",
  /** A recipe line points at an item or recipe that does not exist. */
  "RECIPE_COMPONENT_MISSING",
  /** An item has no moving-average unit cost yet, so HPP cannot be computed. */
  "UNIT_COST_MISSING",
  /** Two units of an item cannot be converted with the stored factors. */
  "UOM_CONVERSION_MISSING",
  /** The requested stock-count action is not allowed from its status. */
  "STOCK_COUNT_INVALID_TRANSITION",
  /** Approval was attempted before the count was submitted. */
  "STOCK_COUNT_NOT_PENDING_APPROVAL",
  /** PRD INV-03: the counter and the approver must be different people. */
  "STOCK_COUNT_SELF_APPROVAL",
  /** Blind count: full detail (system qty, variance) is hidden from this viewer (403). */
  "STOCK_COUNT_BLIND_HIDDEN",
  /** Blind count: lines must be edited through the sheet endpoint (409). */
  "STOCK_COUNT_BLIND_USE_SHEET",
  /** The location already has an open (not posted/cancelled) count (409). */
  "STOCK_COUNT_LOCATION_BUSY",
  /** Submit needs every line counted (422). */
  "STOCK_COUNT_LINES_INCOMPLETE",
  /** No approval policy routed the count to an approver; fails closed (409). */
  "STOCK_COUNT_APPROVAL_UNROUTED",
  /** Lines changed after the approval request was opened (409). */
  "STOCK_COUNT_VERSION_MISMATCH",
  /** Lines can only be edited while the count is in `counting` (409). */
  "STOCK_COUNT_NOT_EDITABLE",
  /** A positive count difference has no unit cost to value it (422). */
  "STOCK_COUNT_COST_MISSING",
  /** Someone who approved or rejected this count cannot enter a line (403). */
  "STOCK_COUNT_DECIDER_CANNOT_COUNT",
  /** Someone who opened the blind detail (system quantity) cannot enter a line (403). */
  "STOCK_COUNT_VIEWER_CANNOT_COUNT",
  /** The approval deadline passed; approve is refused until it is settled (409). */
  "STOCK_COUNT_APPROVAL_EXPIRED",
  /** The requested production-order action is not allowed from its status. */
  "PRODUCTION_INVALID_TRANSITION",
  /** A stock-out would take the location below zero on hand (F16/F17). */
  "INSUFFICIENT_STOCK",
  /** A counter of an open blind count cannot move that item out of the counted location (409). */
  "BLIND_COUNT_LOCKED",
  /** Production could not resolve a single kitchen location for the outlet. */
  "PRODUCTION_LOCATION_UNRESOLVED",
  /** A waste entry points at a photo or media file that does not exist (404). */
  "WASTE_MEDIA_NOT_FOUND",
] as const;

export const inventoryErrorCodeSchema = z.enum(INVENTORY_ERROR_CODES);
export type InventoryErrorCode = z.infer<typeof inventoryErrorCodeSchema>;

/** Thrown by the pure inventory helpers; services map `code` to a response. */
export class InventoryError extends Error {
  readonly code: InventoryErrorCode;

  constructor(code: InventoryErrorCode, message: string) {
    super(message);
    this.name = "InventoryError";
    this.code = code;
  }
}

/**
 * HTTP status per inventory code (docs/plan/contracts.md, "Inventory and
 * purchasing error statuses"). A `Record` over the code union: a new code
 * without a status fails the typecheck.
 */
export const inventoryErrorHttpStatus = {
  RECIPE_CYCLE: 422,
  RECIPE_NOT_FOUND: 404,
  RECIPE_OUTPUT_MISSING: 422,
  RECIPE_COMPONENT_MISSING: 422,
  UNIT_COST_MISSING: 422,
  UOM_CONVERSION_MISSING: 422,
  STOCK_COUNT_INVALID_TRANSITION: 409,
  STOCK_COUNT_NOT_PENDING_APPROVAL: 409,
  STOCK_COUNT_SELF_APPROVAL: 403,
  STOCK_COUNT_BLIND_HIDDEN: 403,
  STOCK_COUNT_BLIND_USE_SHEET: 409,
  STOCK_COUNT_LOCATION_BUSY: 409,
  STOCK_COUNT_LINES_INCOMPLETE: 422,
  STOCK_COUNT_APPROVAL_UNROUTED: 409,
  STOCK_COUNT_VERSION_MISMATCH: 409,
  STOCK_COUNT_NOT_EDITABLE: 409,
  STOCK_COUNT_COST_MISSING: 422,
  STOCK_COUNT_DECIDER_CANNOT_COUNT: 403,
  STOCK_COUNT_VIEWER_CANNOT_COUNT: 403,
  STOCK_COUNT_APPROVAL_EXPIRED: 409,
  PRODUCTION_INVALID_TRANSITION: 409,
  INSUFFICIENT_STOCK: 409,
  BLIND_COUNT_LOCKED: 409,
  PRODUCTION_LOCATION_UNRESOLVED: 422,
  WASTE_MEDIA_NOT_FOUND: 422,
} as const satisfies Record<InventoryErrorCode, number>;

/**
 * Safe Indonesian fallback message per code. Fixed text: the thrown
 * `InventoryError.message` carries ids and quantities and never reaches a client.
 */
export const inventoryErrorMessages: Record<InventoryErrorCode, string> = {
  RECIPE_CYCLE: "Resep saling mengacu sehingga tidak dapat dihitung.",
  RECIPE_NOT_FOUND: "Resep tidak ditemukan.",
  RECIPE_OUTPUT_MISSING: "Resep turunan belum memiliki item hasil.",
  RECIPE_COMPONENT_MISSING: "Resep memuat komponen yang tidak ditemukan.",
  UNIT_COST_MISSING: "Item belum memiliki harga pokok rata-rata.",
  UOM_CONVERSION_MISSING:
    "Satuan tidak dapat dikonversi dengan faktor yang ada.",
  STOCK_COUNT_INVALID_TRANSITION:
    "Aksi ini tidak dapat dilakukan pada status stok opname saat ini.",
  STOCK_COUNT_NOT_PENDING_APPROVAL:
    "Stok opname belum diajukan untuk persetujuan.",
  STOCK_COUNT_SELF_APPROVAL:
    "Penghitung tidak dapat menyetujui stok opname miliknya sendiri.",
  STOCK_COUNT_BLIND_HIDDEN: "Detail stok opname buta disembunyikan dari Anda.",
  STOCK_COUNT_BLIND_USE_SHEET:
    "Baris stok opname buta harus diubah lewat lembar hitung.",
  STOCK_COUNT_LOCATION_BUSY:
    "Lokasi ini masih memiliki stok opname yang belum selesai.",
  STOCK_COUNT_LINES_INCOMPLETE:
    "Semua baris harus dihitung sebelum stok opname diajukan.",
  STOCK_COUNT_APPROVAL_UNROUTED:
    "Tidak ada kebijakan persetujuan untuk stok opname ini.",
  STOCK_COUNT_VERSION_MISMATCH:
    "Baris stok opname berubah setelah permintaan persetujuan dibuka.",
  STOCK_COUNT_NOT_EDITABLE:
    "Baris stok opname hanya dapat diubah saat status penghitungan.",
  STOCK_COUNT_COST_MISSING:
    "Selisih lebih tidak dapat dinilai karena harga pokok belum ada.",
  STOCK_COUNT_DECIDER_CANNOT_COUNT:
    "Pihak yang memutuskan persetujuan tidak dapat menghitung stok opname ini.",
  STOCK_COUNT_VIEWER_CANNOT_COUNT:
    "Pihak yang telah melihat jumlah sistem tidak dapat menghitung stok opname ini.",
  STOCK_COUNT_APPROVAL_EXPIRED:
    "Batas waktu persetujuan stok opname sudah lewat.",
  PRODUCTION_INVALID_TRANSITION:
    "Aksi ini tidak dapat dilakukan pada status produksi saat ini.",
  INSUFFICIENT_STOCK: "Stok di lokasi ini tidak mencukupi.",
  BLIND_COUNT_LOCKED:
    "Barang ini terkunci untuk Anda selama stok opname buta masih terbuka.",
  PRODUCTION_LOCATION_UNRESOLVED:
    "Lokasi dapur untuk produksi di outlet ini tidak dapat ditentukan.",
  WASTE_MEDIA_NOT_FOUND: "Foto atau berkas waste tidak ditemukan.",
};
