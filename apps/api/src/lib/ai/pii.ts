// PII scanner run before any request to the AI provider (PRD §27 Input
// Minimum, AIG-02) and on audit params. Ported from 119connect and extended
// with NPWP, salary context, and bank accounts. The own-data exception (a user
// asking about their own payslip) is decided by the gateway, not here.

export type PiiKind =
  "login_code" | "nik" | "npwp" | "bank_account" | "salary" | "phone" | "email";

export const PII_LABELS: Record<PiiKind, string> = {
  login_code: "login code",
  nik: "NIK",
  npwp: "NPWP",
  bank_account: "bank account number",
  salary: "salary amount",
  phone: "phone number",
  email: "email address",
};

// Order matters: longer, more specific patterns first so a NIK or NPWP is not
// also reported as a phone number or bank account.
const PATTERNS: [PiiKind, RegExp][] = [
  ["login_code", /\bMASUK\s+[\w-]+\s+[A-Z0-9]{4}-[A-Z0-9]{4}\b/gi],
  // One-time codes named in context: "kode login saya 482913", "OTP: 1234",
  // "kode verifikasi 55-12-90". Only digits near a login/OTP word count.
  [
    "login_code",
    /\b(?:(?:kode|code)\s+(?:login|masuk|otp|verifikasi|verification|akses)|otp|pin)\b[^\d\n]{0,20}\d(?:[\s-]?\d){3,7}\b/gi,
  ],
  // NPWP: 15 digits (formatted 99.999.999.9-999.999) or 16 digits. Formatted
  // forms are matched before the plain NIK so a 16-digit NPWP is not a NIK.
  ["npwp", /(?:\bNPWP\b[\s:.-]*)?\b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b/gi],
  ["npwp", /\bNPWP\b[\s:.-]*\d{15,16}\b/gi],
  ["nik", /\b\d{16}\b/g],
  ["npwp", /\b\d{15}\b/g],
  ["email", /[\w.+-]+@[\w-]+(\.[\w-]+)+/g],
  // "rek. BCA 123 456 7890", "no rek: 1234567890", "rekening Mandiri 12-34..."
  [
    "bank_account",
    /\b(?:rek(?:ening)?\.?|no\.?\s*rek\.?|account(?:\s+(?:no|number))?\.?|acc\.?\s*no\.?)\s*(?:[A-Za-z]{2,12}\s+)?:?\s*\d[\d\s.-]{7,20}\d/gi,
  ],
  // Salary or payroll words followed by an amount: "gaji Rp 8.500.000",
  // "salary: 12000000", "THP 7,5jt". Words may sit up to a few tokens away.
  [
    "salary",
    /\b(?:gaji|salary|thp|take[\s-]?home(?:[\s-]?pay)?|payroll|upah|penghasilan)\b[^\d\n]{0,25}(?:rp\.?\s*)?\d[\d.,]*(?:\s*(?:jt|juta|rb|ribu|k|m))?/gi,
  ],
  // No word character or hyphen directly before the number: a UUID segment or
  // a longer digit string must not be read as a phone number.
  ["phone", /(?<![\w-])(\+62|62|0)8\d{1,3}[\s.-]?\d{3,4}[\s.-]?\d{3,5}\b/g],
];

export type PiiFinding = {
  kind: PiiKind;
  text: string;
  start: number;
  end: number;
};

function findAll(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  for (const [kind, pattern] of PATTERNS)
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (findings.some((f) => start < f.end && end > f.start)) continue;
      findings.push({ kind, text: match[0], start, end });
    }
  return findings.sort((a, b) => a.start - b.start);
}

export function scanPii(text: string): { found: PiiKind[] } {
  return { found: [...new Set(findAll(text).map((f) => f.kind))] };
}

/** Replaces each finding with a neutral placeholder, e.g. [phone number]. */
export function redactPii(text: string): string {
  let result = text;
  for (const f of findAll(text).reverse())
    result = `${result.slice(0, f.start)}[${PII_LABELS[f.kind]}]${result.slice(f.end)}`;
  return result;
}

// Keys that name a personal-data field. Matched on whole words after splitting
// camelCase and snake_case, so ids and chart-of-accounts fields (accountId,
// accountCode, microphone) stay intact.
const SENSITIVE_WORDS = new Set([
  "phone",
  "telp",
  "telepon",
  "mobile",
  "whatsapp",
  "email",
  "nik",
  "npwp",
  "rekening",
]);

function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some(
    (word, i) =>
      SENSITIVE_WORDS.has(word) ||
      (word === "account" && ["number", "no"].includes(words[i + 1] ?? "")) ||
      (word === "bank" && words[i + 1] === "account"),
  );
}

/**
 * Deep copy of a JSON value with every string passed through redactPii.
 * Object keys are redacted too, and a string or number stored under a key that
 * names personal data (phone, email, nik, npwp, rekening ...) is masked whole,
 * because a bare value like "1234567890" has no context for the patterns.
 */
export function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redactPii(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactPii(key),
        isSensitiveKey(key) &&
        (typeof item === "string" || typeof item === "number")
          ? "[redacted]"
          : redactJson(item),
      ]),
    );
  return value;
}

/**
 * Tool results are JSON text (or an error message) that is sent back to the
 * provider on the next turn (AIG-02). Redact every string value inside a JSON
 * result; text that is not JSON is redacted as plain text. Content with no
 * personal data is returned unchanged, byte for byte.
 */
export function redactToolResultContent(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return redactPii(content);
  }
  const redacted = JSON.stringify(redactJson(parsed));
  return redacted === JSON.stringify(parsed) ? content : redacted;
}
