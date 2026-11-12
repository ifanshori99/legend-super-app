// Pure logic of the MFA recovery code screens (bead legend-sw980; PRD §3 F6,
// AUTH-05): input rules, the API error classification, the status view and the
// text that is copied. No React and no framework imports, so the unit tests
// load it directly with native Node type stripping.
//
// The error classification is duck-typed on `status` and `code` (an `ApiError`
// has both), so tests can pass plain objects.

/** Same as MFA_RECOVERY_CODE_COUNT in the identity contract (checked by a test). */
export const RECOVERY_CODE_COUNT = 10;
/** Characters in one code, without the dash. */
export const RECOVERY_CODE_LENGTH = 10;
/** At or below this many unused codes the panel nudges to regenerate. */
export const RECOVERY_LOW_THRESHOLD = 2;

export type RecoveryErrorKind =
  | "invalid"
  | "rate_limited"
  | "mfa_required"
  | "no_factor"
  | "session_ended"
  | "network"
  | "unknown";

export type RecoveryCodeCheck =
  { ok: true; code: string } | { ok: false; reason: "empty" | "incomplete" };

export type RecoveryStatusInput = {
  remaining: number;
  generatedAt: string | null;
};
export type RecoveryStatusView = "not_generated" | "depleted" | "low" | "ok";

/** Upper case letters and digits only (spaces, dashes and symbols dropped), at most 10. */
export function cleanRecoveryCode(raw: string): string {
  return String(raw)
    .replace(/[^0-9A-Za-z]/g, "")
    .toUpperCase()
    .slice(0, RECOVERY_CODE_LENGTH);
}

/** What the field shows while typing or pasting: `XXXXX-XXXXX`. */
export function formatRecoveryCodeInput(raw: string): string {
  const clean = cleanRecoveryCode(raw);
  return clean.length > 5 ? `${clean.slice(0, 5)}-${clean.slice(5)}` : clean;
}

export function isRecoveryCodeComplete(value: string): boolean {
  return cleanRecoveryCode(value).length === RECOVERY_CODE_LENGTH;
}

/** The value to send (`XXXXX-XXXXX`) or why it cannot be sent yet. */
export function checkRecoveryCode(value: string): RecoveryCodeCheck {
  const clean = cleanRecoveryCode(value);
  if (clean.length === 0) return { ok: false, reason: "empty" };
  if (clean.length < RECOVERY_CODE_LENGTH)
    return { ok: false, reason: "incomplete" };
  return { ok: true, code: `${clean.slice(0, 5)}-${clean.slice(5)}` };
}

/**
 * Maps a failed call to what the person can do about it. Per the API: a wrong,
 * used or unknown code is 401 MFA_RECOVERY_CODE_INVALID (always the same
 * answer), five wrong codes lock for 15 minutes with 429, generating needs a
 * verified session (403 MFA_REQUIRED) and a user without a factor (409).
 */
export function classifyRecoveryError(error: unknown): RecoveryErrorKind {
  const failure = error as { status?: unknown; code?: unknown } | null;
  const code = typeof failure?.code === "string" ? failure.code : "";
  const status = typeof failure?.status === "number" ? failure.status : 0;
  if (code === "NETWORK_ERROR") return "network";
  if (code === "MFA_RECOVERY_CODE_INVALID") return "invalid";
  if (status === 429 || code === "RATE_LIMITED") return "rate_limited";
  if (code === "MFA_REQUIRED") return "mfa_required";
  if (status === 409) return "no_factor";
  if (status === 401) return "session_ended";
  if (status === 400 || status === 422) return "invalid";
  return "unknown";
}

/** How the backup-code section describes the stored set. */
export function recoveryStatusView(
  status: RecoveryStatusInput,
): RecoveryStatusView {
  if (status.generatedAt === null) return "not_generated";
  if (status.remaining <= 0) return "depleted";
  if (status.remaining <= RECOVERY_LOW_THRESHOLD) return "low";
  return "ok";
}

/** Whether the person should be told to regenerate the set. */
export function recoveryNeedsRegeneration(view: RecoveryStatusView): boolean {
  return view === "depleted" || view === "low";
}

/** One code per line, the text "Salin kode" puts on the clipboard. */
export function recoveryCodesClipboardText(codes: readonly string[]): string {
  return codes.join("\n");
}

/**
 * Whether the backup-code card replaces the second-factor screen. It needs no
 * TOTP factor: a person with only a passkey must be able to use a backup code
 * too. It never shows once the session ended or while enrollment is required.
 */
export function canShowRecoveryLogin(input: {
  recoveryMode: boolean;
  state: { ended: boolean; enrollmentRequired: boolean } | null;
}): boolean {
  return (
    input.recoveryMode &&
    input.state !== null &&
    !input.state.ended &&
    !input.state.enrollmentRequired
  );
}
