// Pure logic of the tenant Owner screen (bead legend-be0lx; mockup
// design/mockups/platform/owner-be0lx.html): form rules, the account lookup,
// the request body, the API error mapping and the screen state. No React, no
// framework imports, no `@/` aliases and no TypeScript-only runtime syntax, so
// the unit tests load it directly with native Node type stripping.
//
// The error mapping is duck-typed on `status`, `code`, `message` and `details`
// (an `ApiError` has them), so tests can pass plain objects.

/** Same limits as `assignTenantOwnerInputSchema` in @starter/shared/platform. */
export const OWNER_REASON_MAX = 500;
export const OWNER_TOTP_LENGTH = 6;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Indonesian copy, verbatim from the mockup. Kept here (not in the shared i18n
// catalog) so this screen edits no shared file; move it to the catalog when it
// is mounted if the team wants one place for text.
export const OWNER_COPY = {
  title: "Owner tenant",
  subtitle: (tenant: string) => `Kelola penetapan Owner untuk ${tenant}.`,
  currentTitle: "Owner saat ini",
  active: "Aktif",
  name: "Nama",
  account: "Akun",
  replaceAction: "Ganti Owner",
  assignAction: "Tetapkan Owner",
  cancel: "Batal",
  guideTitle: "Perubahan akses",
  guideBody:
    "Pastikan akun yang dipilih adalah penerima akses yang benar. Penetapan dan penggantian memerlukan alasan serta kode TOTP terbaru dari aplikasi autentikator.",
  // No owner-list endpoint yet (backend card filed): the panel cannot tell
  // "no owner" from "owner not loaded", so the copy must not claim either.
  emptyTitle: "Owner saat ini belum bisa ditampilkan",
  emptyBody: (tenant: string) =>
    `Panel belum bisa membaca Owner tenant ${tenant}. Tetapkan Owner hanya bila tenant ini memang belum punya Owner.`,
  loadingTitle: "Memuat Owner tenant",
  loadingBody: "Mohon tunggu sebentar.",
  loadingSr: "Memuat Owner tenant…",
  loadErrorTitle: "Owner tenant belum dapat dimuat.",
  loadErrorBody: "Periksa koneksi dan coba lagi.",
  retry: "Coba lagi",
  formTitleAssign: "Tetapkan Owner",
  formTitleReplace: "Ganti Owner",
  formHintAssign: "Pilih akun yang akan menjadi Owner tenant ini.",
  formHintReplace: (name: string) => `Owner saat ini: ${name}`,
  accountLabelAssign: "Akun Owner",
  accountLabelReplace: "Akun Owner baru",
  accountPlaceholder: "Cari akun berdasarkan nama atau email",
  accountHint: "Pilih akun tenant yang sesuai.",
  // No account list or search endpoint yet (backend card legend-co93l): only a
  // pasted account id (UUID) resolves, so the field says so.
  accountLabelAssignById: "ID akun Owner (UUID)",
  accountLabelReplaceById: "ID akun Owner baru (UUID)",
  accountPlaceholderById: "Tempel ID akun (UUID)",
  accountHintById:
    "Tempel ID akun dari daftar pengguna. Pencarian nama atau email menyusul.",
  accountInvalidId: "Masukkan ID akun yang valid (UUID).",
  reasonLabel: "Alasan perubahan",
  totpLabel: "Kode autentikator (TOTP)",
  totpPlaceholder: "Masukkan kode terbaru",
  totpHint: "Gunakan kode terbaru dari aplikasi autentikator Anda.",
  note: "Periksa akun dan alasan sebelum melanjutkan.",
  submitting: "Menyimpan…",
  successAssigned: "Owner berhasil ditetapkan.",
  successReplaced: "Owner berhasil diganti.",
  successBody: "Penetapan telah tersimpan.",
  failedTitle: "Perubahan belum tersimpan.",
  failedBody:
    "Periksa koneksi dan coba lagi. Data yang Anda isi tetap tersedia.",
  accountRequired: "Pilih akun Owner.",
  accountUnknown: "Akun tidak ditemukan. Pilih akun tenant yang sesuai.",
  accountSame: "Pilih akun yang berbeda dari Owner saat ini.",
  accountRefused:
    "Akun ini tidak dapat ditetapkan sebagai Owner. Pilih akun tenant yang lain.",
  accountNotMember: "Akun ini bukan anggota aktif tenant.",
  // 409 CONFLICT on assign: the API sends the same code for every conflict
  // and has no message for "tenant already has an Owner", so any 409 that is
  // not the last-Owner rule means an Owner exists. No Owner list yet, so the
  // panel cannot replace it (backend card legend-co93l).
  tenantHasOwner:
    "Tenant ini sudah punya Owner. Ganti Owner belum bisa dari panel ini sampai daftar Owner tersedia.",
  reasonRequired: "Masukkan alasan perubahan.",
  reasonTooLong: `Alasan paling banyak ${OWNER_REASON_MAX} karakter.`,
  totpRequired: "Masukkan kode terbaru dari aplikasi autentikator.",
  totpFormat: "Masukkan 6 digit kode dari aplikasi autentikator.",
  totpRejected:
    "Kode tidak valid atau kedaluwarsa. Masukkan kode terbaru dari aplikasi autentikator.",
  // 403 without a known cause: neutral, never blames the chosen account.
  forbidden:
    "Anda tidak memiliki izin untuk mengubah Owner lewat Panel Platform.",
  forbiddenImpersonation:
    "Sesi impersonasi tidak dapat mengubah Owner. Keluar dari sesi impersonasi, lalu masuk sebagai Super Admin.",
  forbiddenNotSuperAdmin:
    "Akun Anda bukan Super Admin, jadi tidak dapat mengubah Owner tenant.",
  forbiddenSelf:
    "Anda tidak dapat menetapkan diri sendiri sebagai Owner. Pilih akun lain.",
  forbiddenSuperAdminTarget:
    "Akun Super Admin tidak dapat ditetapkan sebagai Owner lewat Panel Platform. Pilih akun tenant yang lain.",
  stale:
    "Penugasan Owner ini sudah berubah. Muat ulang halaman lalu coba lagi.",
  lastOwner: "Tenant harus memiliki minimal satu Owner aktif.",
} as const;

export type OwnerFormMode = "assign" | "replace";

/** Owner as the screen shows it. `assignmentId` is what replace needs. */
export type OwnerSummary = {
  assignmentId: string;
  userId: string;
  name: string | null;
  email: string | null;
};

/** An account the Super Admin can pick (name and email for the label). */
export type OwnerAccountOption = {
  userId: string;
  name: string;
  email: string;
};

export type OwnerFormValues = {
  account: string;
  reason: string;
  code: string;
};

export type OwnerField = "account" | "reason" | "code";
export type OwnerFieldErrors = Partial<Record<OwnerField, string>>;

export type OwnerAccountFieldCopy = {
  label: string;
  placeholder: string;
  hint: string;
};

/** Label, placeholder and hint of the account field. With no account list the
 * field accepts an account id only, so the text must say so. */
export function accountFieldCopy(
  mode: OwnerFormMode,
  hasAccounts: boolean,
): OwnerAccountFieldCopy {
  const replace = mode === "replace";
  if (hasAccounts)
    return {
      label: replace
        ? OWNER_COPY.accountLabelReplace
        : OWNER_COPY.accountLabelAssign,
      placeholder: OWNER_COPY.accountPlaceholder,
      hint: OWNER_COPY.accountHint,
    };
  return {
    label: replace
      ? OWNER_COPY.accountLabelReplaceById
      : OWNER_COPY.accountLabelAssignById,
    placeholder: OWNER_COPY.accountPlaceholderById,
    hint: OWNER_COPY.accountHintById,
  };
}

/** "Andi Saputra · andi@example.com" as the mockup writes it. */
export function accountLabel(
  option: Pick<OwnerAccountOption, "name" | "email">,
): string {
  return `${option.name} · ${option.email}`;
}

/** Name and email for display, with a fallback when only the id is known. */
export function ownerDisplay(owner: OwnerSummary): {
  name: string;
  account: string;
} {
  const shortId = owner.userId.slice(0, 8);
  return {
    name: owner.name ?? `Akun ${shortId}`,
    account: owner.email ?? owner.userId,
  };
}

/** One line for the replace form: "Dewi Pratama · dewi@example.com". */
export function ownerLine(owner: OwnerSummary): string {
  const display = ownerDisplay(owner);
  return owner.name && owner.email
    ? `${owner.name} · ${owner.email}`
    : owner.email
      ? owner.email
      : display.name;
}

/** Keep digits only, at most 6 (a pasted "123 456" still works). */
export function sanitizeTotp(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, OWNER_TOTP_LENGTH);
}

export type ResolvedAccount =
  | { ok: true; userId: string; option: OwnerAccountOption | null }
  | { ok: false; reason: "required" | "unknown" };

/** Turns what the Super Admin typed or picked into an account id. Matches the
 * label, the email or the id of a listed account, or a bare account id. */
export function resolveAccount(
  input: string,
  accounts: readonly OwnerAccountOption[] = [],
): ResolvedAccount {
  const text = input.trim();
  if (!text) return { ok: false, reason: "required" };
  const lower = text.toLowerCase();
  const found = accounts.find(
    (option) =>
      accountLabel(option).toLowerCase() === lower ||
      option.email.toLowerCase() === lower ||
      option.userId.toLowerCase() === lower,
  );
  if (found) return { ok: true, userId: found.userId, option: found };
  if (UUID.test(text))
    return { ok: true, userId: text.toLowerCase(), option: null };
  return { ok: false, reason: "unknown" };
}

export type OwnerFormCheck =
  | { ok: true; userId: string; option: OwnerAccountOption | null }
  | { ok: false; errors: OwnerFieldErrors };

/** Same checks and order as the mockup: account, reason, then the code. */
export function validateOwnerForm(
  values: OwnerFormValues,
  options: {
    mode: OwnerFormMode;
    current?: OwnerSummary | null;
    accounts?: readonly OwnerAccountOption[];
  },
): OwnerFormCheck {
  const errors: OwnerFieldErrors = {};
  const account = resolveAccount(values.account, options.accounts);
  let userId = "";
  let option: OwnerAccountOption | null = null;
  if (!account.ok) {
    errors.account =
      account.reason === "required"
        ? OWNER_COPY.accountRequired
        : (options.accounts?.length ?? 0) > 0
          ? OWNER_COPY.accountUnknown
          : OWNER_COPY.accountInvalidId;
  } else if (
    options.mode === "replace" &&
    options.current?.userId === account.userId
  ) {
    errors.account = OWNER_COPY.accountSame;
  } else {
    userId = account.userId;
    option = account.option;
  }
  const reason = values.reason.trim();
  if (!reason) errors.reason = OWNER_COPY.reasonRequired;
  else if (reason.length > OWNER_REASON_MAX)
    errors.reason = OWNER_COPY.reasonTooLong;
  const code = values.code.trim();
  if (!code) errors.code = OWNER_COPY.totpRequired;
  else if (!/^\d{6}$/.test(code)) errors.code = OWNER_COPY.totpFormat;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, userId, option };
}

/** Body for POST .../owners and .../owners/:assignmentId/replace. */
export function buildOwnerBody(
  values: OwnerFormValues,
  userId: string,
): { account: { userId: string }; reason: string; mfaCode: string } {
  return {
    account: { userId },
    reason: values.reason.trim(),
    mfaCode: values.code.trim(),
  };
}

type ErrorLike = {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  details?: unknown;
};

export type OwnerFailure =
  /** Shown under one field; the form keeps what was typed. */
  | { kind: "field"; field: OwnerField; message: string }
  /** Shown as the banner above the form; the form keeps what was typed. */
  | { kind: "banner"; message: string };

function firstDetailField(details: unknown): string | null {
  if (!Array.isArray(details) || details.length === 0) return null;
  const first: unknown = details[0];
  if (typeof first !== "object" || first === null) return null;
  const field = (first as { field?: unknown }).field;
  return typeof field === "string" ? field : null;
}

/** The server words each 403 differently (platform-tenant-owner.service), and
 * sends the same code for all of them, so the message tells them apart. The
 * order matters: "Akun ini bukan Super Admin" must not match the target rule. */
function forbiddenCopy(message: string): string {
  if (/impersonasi/i.test(message)) return OWNER_COPY.forbiddenImpersonation;
  if (/bukan Super Admin/i.test(message))
    return OWNER_COPY.forbiddenNotSuperAdmin;
  if (/dirinya sendiri/i.test(message)) return OWNER_COPY.forbiddenSelf;
  if (/Akun Super Admin/i.test(message))
    return OWNER_COPY.forbiddenSuperAdminTarget;
  return OWNER_COPY.forbidden;
}

/** API error to what the screen shows. Network and unknown errors keep the
 * mockup's "Perubahan belum tersimpan" banner. */
export function classifyOwnerError(err: unknown): OwnerFailure {
  const e: ErrorLike =
    typeof err === "object" && err !== null ? (err as ErrorLike) : {};
  const status = typeof e.status === "number" ? e.status : 0;
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  const mfa =
    code === "MFA_INVALID" ||
    code === "MFA_REQUIRED" ||
    code === "REAUTH_REQUIRED" ||
    (status === 403 && /\bMFA\b/i.test(message));
  if (mfa)
    return { kind: "field", field: "code", message: OWNER_COPY.totpRejected };
  if (status === 403)
    return { kind: "banner", message: forbiddenCopy(message) };
  if (status === 404) return { kind: "banner", message: OWNER_COPY.stale };
  if (status === 409) {
    if (/minimal satu Owner/i.test(message))
      return { kind: "banner", message: OWNER_COPY.lastOwner };
    return { kind: "banner", message: OWNER_COPY.tenantHasOwner };
  }
  if (status === 422 || code === "VALIDATION_ERROR") {
    const field = firstDetailField(e.details);
    if (field?.includes("mfaCode"))
      return { kind: "field", field: "code", message: OWNER_COPY.totpRejected };
    if (field?.includes("reason"))
      return {
        kind: "field",
        field: "reason",
        message: OWNER_COPY.reasonRequired,
      };
    if (/tidak aktif/i.test(message))
      return { kind: "banner", message: OWNER_COPY.stale };
    return {
      kind: "field",
      field: "account",
      message: /anggota aktif/i.test(message)
        ? OWNER_COPY.accountNotMember
        : OWNER_COPY.accountRefused,
    };
  }
  return { kind: "banner", message: OWNER_COPY.failedBody };
}

export type OwnerView =
  "loading" | "load-error" | "empty" | "owner" | "assign" | "replace";

/** Which block of the mockup to show. A form needs its prerequisites:
 * replace needs a known owner (its assignment id), so without one the screen
 * falls back to the empty or owner view instead of an unusable form. */
export function ownerView(input: {
  loading: boolean;
  loadFailed: boolean;
  owner: OwnerSummary | null;
  form: OwnerFormMode | null;
}): OwnerView {
  if (input.loading) return "loading";
  if (input.loadFailed) return "load-error";
  if (input.form === "assign") return "assign";
  if (input.form === "replace" && input.owner) return "replace";
  return input.owner ? "owner" : "empty";
}

/** Owner to remember after a successful call: what the Super Admin picked,
 * with the assignment id from the response. */
export function ownerFromResult(
  result: { assignmentId: string; userId: string },
  option: OwnerAccountOption | null,
): OwnerSummary {
  return {
    assignmentId: result.assignmentId,
    userId: result.userId,
    name: option?.name ?? null,
    email: option?.email ?? null,
  };
}
