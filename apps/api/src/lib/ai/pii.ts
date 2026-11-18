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

const DATE_MONTH =
  "(?:jan(?:uari|uary)?|feb(?:ruari|ruary)?|mar(?:et|ch)?|apr(?:il)?|mei|may|jun[ie]?|jul[iy]?|agu(?:stus)?|aug(?:ust)?|sep(?:t(?:ember)?)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|des(?:ember)?|dec(?:ember)?)";
const SALARY_DATES = new RegExp(
  `\\b(?:(?:19|20)\\d{2}[-/.]\\d{1,2}[-/.]\\d{1,2}|(?:19|20)\\d{2}[-/]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.](?:\\d{2}|(?:19|20)\\d{2})|${DATE_MONTH}\\.?\\s+\\d{1,2}(?:,?\\s+(?:19|20)\\d{2})?|\\d{1,2}\\s+${DATE_MONTH}\\.?(?:\\s+(?:19|20)\\d{2})?|${DATE_MONTH}\\.?\\s+(?:19|20)\\d{2})\\b`,
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

const SALARY_SUFFIX = /\s*(juta|jt|ribu|rb|k|m)$/i;
const SALARY_MULTIPLIER: Record<string, number> = {
  juta: 1_000_000,
  jt: 1_000_000,
  m: 1_000_000,
  ribu: 1_000,
  rb: 1_000,
  k: 1_000,
};

/**
 * Digits-only form of a salary amount: "Rp 5.000.000", "5000000" and
 * "5.000.000,00" all give "5000000"; "2,5 juta" gives "2500000". Returns null
 * when no amount can be read.
 */
export function normalizeSalaryAmount(raw: string): string | null {
  let text = raw.replace(/^\s*rp\.?\s*/i, "").trim();
  const suffix = SALARY_SUFFIX.exec(text);
  if (suffix) {
    text = text.slice(0, suffix.index);
    const value = Number(text.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) return null;
    return String(
      Math.round(value * SALARY_MULTIPLIER[suffix[1]!.toLowerCase()]!),
    );
  }
  // A trailing decimal part (",00" or ".5") is not part of the rupiah amount.
  text = text.replace(/[,.]\d{1,2}$/, "");
  const digits = text.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return digits === "" ? null : digits;
}

// Amounts shorter than this are never treated as a salary figure to allow, so
// a year, count or day number in a tool result cannot unmask a small amount.
const MIN_ALLOWED_SALARY_DIGITS = 5;

/**
 * Adds every amount found in a tool result (numbers and numeric text inside
 * strings, at any depth) to `into`, in the normalised form used by
 * `allowSalaryAmounts`.
 */
export function collectSalaryAmounts(
  value: unknown,
  into: Set<string> = new Set(),
): Set<string> {
  const add = (raw: string) => {
    const amount = normalizeSalaryAmount(raw);
    if (amount && amount.length >= MIN_ALLOWED_SALARY_DIGITS) into.add(amount);
  };
  if (typeof value === "number") {
    if (Number.isFinite(value)) add(String(Math.trunc(Math.abs(value))));
  } else if (typeof value === "string") {
    for (const match of value.matchAll(
      /(?:\brp\.?\s*)?\d(?:[\d.,]*\d)?(?:\s*(?:juta|jt|ribu|rb|k|m)\b)?/gi,
    ))
      add(match[0]);
  } else if (Array.isArray(value)) {
    for (const item of value) collectSalaryAmounts(item, into);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectSalaryAmounts(item, into);
  }
  return into;
}

/**
 * A salary finding is kept (not masked) only when its normalised amount is in
 * `allowSalaryAmounts`. Every other finding, and every other salary amount,
 * is masked.
 */
function isMasked(
  finding: PiiFinding,
  allowSalaryAmounts?: ReadonlySet<string>,
): boolean {
  if (finding.kind !== "salary" || !allowSalaryAmounts) return true;
  const amount = normalizeSalaryAmount(finding.text);
  return amount === null || !allowSalaryAmounts.has(amount);
}

export function scanPii(
  text: string,
  allowSalaryAmounts?: ReadonlySet<string>,
): { found: PiiKind[] } {
  return {
    found: [
      ...new Set(
        findAll(text)
          .filter((f) => isMasked(f, allowSalaryAmounts))
          .map((f) => f.kind),
      ),
    ],
  };
}

/** Replaces each finding with a neutral placeholder, e.g. [phone number]. */
export function redactPii(
  text: string,
  allowSalaryAmounts?: ReadonlySet<string>,
): string {
  let result = text;
  for (const f of findAll(text)
    .filter((f) => isMasked(f, allowSalaryAmounts))
    .reverse())
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
