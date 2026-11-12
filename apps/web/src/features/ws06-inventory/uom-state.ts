// Pure logic of the unit editor (bead legend-7z38l; mockup
// design/mockups/backoffice/uom-7z38l.html): form validation, the API error
// mapping and the row state. No React, no framework imports and no
// TypeScript-only runtime syntax, so the unit tests load it directly with
// native Node type stripping. Copy lives here (Indonesian, from the mockup).

/** Same pattern as `createUomInputSchema` in the inventory contract. */
export const UOM_CODE_PATTERN = /^[a-z0-9]{1,10}$/;
export const UOM_CODE_MAX = 10;
export const UOM_NAME_MAX = 150;

/**
 * Codes of the standard catalog (`STANDARD_UOM_CATALOG`); the API rejects a
 * tenant unit with one of them. Listed here so the form can say so before the
 * request; the API stays the source of truth.
 */
export const RESERVED_UOM_CODES: readonly string[] = [
  "kg",
  "g",
  "l",
  "ml",
  "pcs",
  "pack",
  "ctn",
  "btl",
  "can",
  "sachet",
  "box",
  "porsi",
];

export const UOM_COPY = {
  heading: "Satuan",
  hint: "Kelola satuan untuk bahan dan persediaan tenant ini.",
  add: "+ Tambah satuan",
  listTitle: "Daftar satuan",
  listHint: "Satuan bawaan terkunci; satuan tenant dapat diubah namanya.",
  columns: { kind: "Jenis", actions: "Aksi" },
  kindSystem: "Bawaan · Terkunci",
  kindTenant: "Tenant",
  locked: "Terkunci",
  rename: "Ubah nama",
  renameLabel: (name: string) => `Ubah nama satuan ${name}`,
  emptyTitle: "Belum ada satuan untuk ditampilkan",
  emptyHint: "Tambahkan satuan yang digunakan tenant.",
  emptyAction: "Tambah satuan",
  errorTitle: "Daftar satuan belum bisa dimuat",
  errorHint: "Periksa koneksi, lalu coba lagi.",
  loading: "Memuat daftar satuan…",
  addTitle: "Tambah satuan",
  addHint: "Tambahkan satuan yang digunakan tenant.",
  editTitle: "Ubah nama satuan",
  editHint: "Kode satuan tetap sama.",
  nameLabel: "Nama satuan",
  codeLabel: "Kode satuan",
  codeHint: "1–10 huruf atau angka. Kode tidak dapat diubah setelah disimpan.",
  cancel: "Batal",
  save: "Simpan satuan",
  createdNotice: "Satuan berhasil disimpan.",
  renamedNotice: "Nama satuan berhasil disimpan.",
  readOnlyNote: "Hanya pengelola persediaan yang dapat mengubah satuan.",
  errors: {
    nameRequired: "Masukkan nama satuan.",
    nameTooLong: "Nama satuan paling banyak 150 karakter.",
    codeInvalid: "Gunakan 1–10 huruf atau angka tanpa spasi.",
    codeReserved: "Kode ini digunakan satuan bawaan. Pilih kode lain.",
    codeTaken: "Kode ini sudah digunakan tenant. Pilih kode lain.",
    forbidden: "Anda tidak punya izin mengubah satuan ini.",
    notFound: "Satuan tidak ditemukan. Muat ulang daftar, lalu coba lagi.",
    network: "Tidak bisa menghubungi server. Periksa koneksi, lalu coba lagi.",
    unknown: "Satuan belum bisa disimpan. Coba lagi.",
  },
} as const;

export type UomUnit = {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
};

export type UomListState = "loading" | "error" | "empty" | "ready";

/** Normalises a typed code the same way the API does (trim + lowercase). */
export function normalizeUomCode(raw: string): string {
  return String(raw).trim().toLowerCase();
}

export function isReservedUomCode(code: string): boolean {
  return RESERVED_UOM_CODES.includes(normalizeUomCode(code));
}

export function uomListState(input: {
  isPending: boolean;
  isError: boolean;
  count: number;
}): UomListState {
  if (input.isPending) return "loading";
  if (input.isError) return "error";
  return input.count === 0 ? "empty" : "ready";
}

/** Locked units (the standard catalog) cannot be renamed. */
export function canRenameUom(unit: Pick<UomUnit, "isSystem">): boolean {
  return !unit.isSystem;
}

export type UomFormErrors = { name?: string; code?: string };

export function validateUomName(raw: string): string | undefined {
  const name = String(raw).trim();
  if (!name) return UOM_COPY.errors.nameRequired;
  if (name.length > UOM_NAME_MAX) return UOM_COPY.errors.nameTooLong;
  return undefined;
}

/** `existing` is the loaded catalog; the check is a courtesy, the API decides. */
export function validateUomCode(
  raw: string,
  existing: readonly Pick<UomUnit, "code">[],
): string | undefined {
  const code = normalizeUomCode(raw);
  if (!UOM_CODE_PATTERN.test(code)) return UOM_COPY.errors.codeInvalid;
  if (isReservedUomCode(code)) return UOM_COPY.errors.codeReserved;
  if (existing.some((unit) => unit.code === code))
    return UOM_COPY.errors.codeTaken;
  return undefined;
}

export type UomFormInput =
  | { mode: "create"; name: string; code: string }
  | { mode: "edit"; name: string };

export type UomFormResult =
  | { ok: true; name: string; code?: string }
  | { ok: false; errors: UomFormErrors };

export function validateUomForm(
  input: UomFormInput,
  existing: readonly Pick<UomUnit, "code">[],
): UomFormResult {
  const errors: UomFormErrors = {};
  const nameError = validateUomName(input.name);
  if (nameError) errors.name = nameError;
  if (input.mode === "create") {
    const codeError = validateUomCode(input.code, existing);
    if (codeError) errors.code = codeError;
  }
  if (errors.name || errors.code) return { ok: false, errors };
  const name = input.name.trim();
  return input.mode === "create"
    ? { ok: true, name, code: normalizeUomCode(input.code) }
    : { ok: true, name };
}

export type UomSaveError = { field: "code" | "name" | "form"; message: string };

type ErrorLike = {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  details?: unknown;
};

/**
 * Maps a failed save to the field it belongs to. The API answers 409 CONFLICT
 * for both a reserved and a taken code and tells them apart only by message,
 * so the message is matched; anything else on 409 is a taken code.
 */
export function mapUomSaveError(error: unknown): UomSaveError {
  const e = (error ?? {}) as ErrorLike;
  const status = typeof e.status === "number" ? e.status : undefined;
  const message = typeof e.message === "string" ? e.message : "";
  if (status === 409) {
    return /reserved/i.test(message)
      ? { field: "code", message: UOM_COPY.errors.codeReserved }
      : { field: "code", message: UOM_COPY.errors.codeTaken };
  }
  if (status === 400 || status === 422) {
    // The API rejected a value the form let through: show it on its field.
    const first = Array.isArray(e.details)
      ? (e.details[0] as { field?: unknown } | undefined)
      : undefined;
    if (first?.field === "code")
      return { field: "code", message: UOM_COPY.errors.codeInvalid };
    if (first?.field === "name")
      return { field: "name", message: UOM_COPY.errors.nameRequired };
  }
  if (status === 403)
    return { field: "form", message: UOM_COPY.errors.forbidden };
  if (status === 404)
    return { field: "form", message: UOM_COPY.errors.notFound };
  if (status === 0 || (status === undefined && e.code === "NETWORK_ERROR"))
    return { field: "form", message: UOM_COPY.errors.network };
  return { field: "form", message: UOM_COPY.errors.unknown };
}
