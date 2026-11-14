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
  // Salary context is separate from its amount so dates and words stay intact.
  [
    "salary",
    /\b(?:gaji|salary|thp|take[\s-]?home(?:[\s-]?pay)?|payroll|upah|penghasilan)\b/gi,
  ],
  ["phone", /(\+62|62|0)8\d{1,3}[\s.-]?\d{3,4}[\s.-]?\d{3,5}\b/g],
];

export type PiiFinding = {
  kind: PiiKind;
  text: string;
  start: number;
  end: number;
};

const DATE_MONTH =
  "(?:jan(?:uari|uary)?|feb(?:ruari|ruary)?|mar(?:et|ch)?|apr(?:il)?|mei|may|jun[ie]?|jul[iy]?|agu(?:stus)?|aug(?:ust)?|sep(?:t(?:ember)?)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|des(?:ember)?|dec(?:ember)?)";
const SALARY_DATES = new RegExp(
  `\\b(?:\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{4}[-/]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|${DATE_MONTH}\\.?\\s+\\d{1,2}(?:,?\\s+\\d{4})?|\\d{1,2}\\s+${DATE_MONTH}\\.?(?:\\s+\\d{4})?|${DATE_MONTH}\\.?\\s+\\d{4})\\b`,
  "gi",
);

function salaryAmountAfter(
  text: string,
  contextEnd: number,
): PiiFinding | null {
  const newline = text.indexOf("\n", contextEnd);
  const tail = text.slice(contextEnd, newline < 0 ? undefined : newline);
  // A title/date is not salary PII. Explicit currency or a magnitude suffix
  // still wins, including small amounts such as "Rp 2026".
  const dates = [...tail.matchAll(SALARY_DATES)];
  for (const match of tail.matchAll(
    /(?:\brp\.?\s*)?\d(?:[\d.,]*\d)?(?:\s*(?:juta|jt|ribu|rb|k|m)\b)?/gi,
  )) {
    const offset = match.index ?? 0;
    const amount = match[0];
    const explicitAmount = /^(?:rp\.?)/i.test(amount) || /[a-z]$/i.test(amount);
    if (
      !explicitAmount &&
      dates.some((date) => {
        const dateStart = date.index ?? 0;
        return (
          offset >= dateStart &&
          offset + amount.length <= dateStart + date[0].length
        );
      })
    )
      continue;
    const skippedDateLength = dates.reduce((length, date) => {
      const dateEnd = (date.index ?? 0) + date[0].length;
      return dateEnd <= offset ? length + date[0].length : length;
    }, 0);
    if (offset - skippedDateLength > 25) break;
    const start = contextEnd + offset;
    return { kind: "salary", text: amount, start, end: start + amount.length };
  }
  return null;
}

function findAll(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  for (const [kind, pattern] of PATTERNS)
    for (const match of text.matchAll(pattern)) {
      let start = match.index ?? 0;
      let value = match[0];
      if (kind === "salary") {
        const amount = salaryAmountAfter(text, start + value.length);
        if (!amount) continue;
        start = amount.start;
        value = amount.text;
      }
      const end = start + value.length;
      if (findings.some((f) => start < f.end && end > f.start)) continue;
      findings.push({ kind, text: value, start, end });
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

/** Deep copy of a JSON value with every string passed through redactPii. */
export function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redactPii(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJson(item)]),
    );
  return value;
}
