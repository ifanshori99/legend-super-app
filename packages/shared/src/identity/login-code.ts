// WhatsApp reverse-OTP text rules (PRD v1.7 §3 F6 "Pelanggan — WhatsApp
// Reverse OTP", AUTH-01..03; flow §4 C "Alur Pelanggan Login dengan
// WhatsApp"): the login code, the message the guest sends, the wa.me deep
// link, and the masking used for phone numbers and emails on screen.
//
// Machinery reuses the 119connect idea (packages/shared/src/masuk.ts:
// Crockford alphabet without I/L/O/U, message parsing, wa.me link, masks) but
// this is Legend's contract: no alumni roster, no reply on success, no
// tenant-specific branch.
//
// The code is a *bearer* secret: 8 Crockford symbols carry 40 bits (AUTH-01
// minimum). It is shown once in the requesting browser, bound to that browser,
// valid 5 minutes and single-use. Only a keyed digest is stored
// (`identityDigestSchema`); nothing here hashes or persists it.

/** Crockford base32: digits and capitals without I, L, O, U. */
export const LOGIN_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 8 symbols x 5 bits = 40 bits of entropy, the AUTH-01 floor. */
export const LOGIN_CODE_LENGTH = 8;
export const LOGIN_CODE_ENTROPY_BITS = LOGIN_CODE_LENGTH * 5;

/** Canonical code: exactly the alphabet, uppercase. */
export const LOGIN_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Symbols a person may type for a digit; Crockford decoding. */
const CONFUSABLE: Record<string, string> = { O: "0", I: "1", L: "1" };

/**
 * "k7q4-m2xd", "K7Q4 M2XD", "K7Q4M2XD" -> "K7Q4M2XD"; null when it cannot be
 * a code. Hyphens and spaces are separators only. U is not in the alphabet and
 * stays invalid, so "K7Q4M2XU" never matches.
 */
export function normalizeLoginCode(
  input: string | null | undefined,
): string | null {
  const cleaned = (input ?? "")
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[OIL]/g, (char) => CONFUSABLE[char] as string);
  return LOGIN_CODE_PATTERN.test(cleaned) ? cleaned : null;
}

/** "K7Q4M2XD" -> "K7Q4-M2XD" for reading and typing. */
export function formatLoginCode(code: string): string {
  const normalized = normalizeLoginCode(code);
  if (normalized === null) throw new RangeError(`Not a login code: ${code}`);
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/**
 * The code in an inbound `MASUK ...` message: the last token (or the last two
 * four-character tokens), whatever words the tenant uses in between, so
 * "MASUK LEGEND K7Q4-M2XD", "masuk K7Q4M2XD" and "MASUK K7Q4 M2XD" all work.
 * A message that does not start with MASUK is not a login message.
 */
export function loginCodeFromMessage(text: string): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words[0]?.toUpperCase() !== "MASUK") return null;
  const last = words[words.length - 1] as string;
  const single = normalizeLoginCode(last);
  if (single !== null) return single;
  if (words.length >= 3 && last.length === 4)
    return normalizeLoginCode(`${words[words.length - 2] ?? ""}${last}`);
  return null;
}

/**
 * The message the guest sends: "MASUK LEGEND K7Q4-M2XD" (PRD §3 F6). The
 * keyword is tenant data (the brand's login command) and must start with
 * MASUK; everything between MASUK and the code is ignored by the parser.
 */
export function whatsAppLoginMessage(
  code: string,
  keyword = "MASUK LEGEND",
): string {
  return `${keyword} ${formatLoginCode(code)}`;
}

/** https://wa.me/<digits>?text=... opens WhatsApp with the message filled in. */
export function whatsAppLoginDeepLink(input: {
  /** Receiving number in normalized digits (see normalizeWhatsAppNumber). */
  readonly numberDigits: string;
  readonly code: string;
  readonly keyword?: string;
}): string {
  const digits = input.numberDigits.replace(/\D/g, "");
  if (!/^[1-9]\d{7,14}$/.test(digits))
    throw new RangeError(`Not a WhatsApp number: ${input.numberDigits}`);
  const text = whatsAppLoginMessage(input.code, input.keyword);
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/**
 * A WhatsApp number in the one form the contract stores: digits only, no
 * plus, no separators, no leading zero (a local Indonesian "0812..." becomes
 * "62812..."). Null when the input cannot be a number.
 */
export function normalizeWhatsAppNumber(
  input: string | null | undefined,
): string | null {
  const digits = (input ?? "")
    .trim()
    .replace(/[\s\-().]/g, "")
    .replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;
  const international = digits.startsWith("0")
    ? `62${digits.slice(1)}`
    : digits;
  return /^[1-9]\d{7,14}$/.test(international) ? international : null;
}

/** "6281234567890" -> "6281••••••890": recognisable, not copyable. */
export function maskWhatsAppNumber(
  input: string | null | undefined,
): string | null {
  const digits = normalizeWhatsAppNumber(input);
  if (digits === null) return null;
  const hidden = Math.max(digits.length - 7, 3);
  return `${digits.slice(0, 4)}${"•".repeat(hidden)}${digits.slice(-3)}`;
}

/** Emails are compared case-insensitively and stored lowercased. */
export function normalizeEmail(
  input: string | null | undefined,
): string | null {
  const email = (input ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** "sari.puspita@gmail.com" -> "sa•••@gmail.com": enough to recognise. */
export function maskEmail(input: string | null | undefined): string | null {
  const email = normalizeEmail(input);
  if (email === null) return null;
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}•••@${domain}`;
}
