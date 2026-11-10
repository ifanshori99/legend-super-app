// Personal-data scan for config templates (bead legend-ms2a, TEN-09).
// A template is global and reusable, so free text a tenant typed into a
// checklist, a text override or a generic item must not carry a phone number,
// an e-mail, a NIK or a person's name. This is a heuristic with a low
// false-positive bias, not a guarantee: the platform admin confirms findings
// before a template is stored. Findings never hold the full value.
// Browser- and Node-safe.

export const PII_KINDS = ["phone", "email", "nik", "person_name"] as const;
export type PiiKind = (typeof PII_KINDS)[number];

export type PiiFinding = {
  section: string;
  /** Path inside the section, e.g. `items[0].items[1].label`. */
  path: string;
  kind: PiiKind;
  /** The match with most characters replaced by `*`. */
  excerpt: string;
};

type Match = { kind: PiiKind; start: number; end: number; text: string };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// 16 digits, written as one run or split by single space, dot or dash
// separators; digits are not allowed on either side of the whole run.
const NIK_CANDIDATE = /(?<!\d[ .-]?)\d(?:[ .-]?\d){15}(?![ .-]?\d)/g;
// 08xx / +62 8xx / 62 8xx, with optional space, dot or dash separators and
// optional parentheses around the country code or the operator prefix.
const PHONE =
  /(?<![\d+])\(?(?:\+62|62|0)\)?[ .-]?\(?8\d{2}\)?(?:[ .-]?\d){6,9}(?!\d)/g;
// Honorifics match in any letter case ("pak joko", "PAK BUDI"). The first
// name word may be written in any case; further words must be capitalised so
// a lower-case sentence is not swallowed into the name.
const anyCase = (word: string) =>
  [...word].map((char) => `[${char.toUpperCase()}${char}]`).join("");
const HONORIFIC = `(?:(?:${["bapak", "ibu", "pak", "bu", "mas", "mbak"]
  .map(anyCase)
  .join("|")})|(?:${["sdri", "sdr", "dr"].map(anyCase).join("|")})\\.?)`;
const PERSON_NAME = new RegExp(
  String.raw`(?<![A-Za-z])${HONORIFIC}\s+([A-Za-z]{3,}(?:\s+(?:[A-Z][a-z]{2,}|[A-Z]{3,})){0,2})(?![A-Za-z])`,
  "g",
);

/** Words after an honorific (any case) that name a role or a thing, or are plain function words. */
const NOT_A_NAME = new Set(
  [
    "admin",
    "akan",
    "area",
    "bar",
    "barista",
    "bisa",
    "boleh",
    "chef",
    "customer",
    "dan",
    "dapat",
    "dapur",
    "dari",
    "dengan",
    "gudang",
    "hamil",
    "harus",
    "karyawan",
    "kasir",
    "kepala",
    "koki",
    "kota",
    "kunci",
    "manager",
    "manajer",
    "menyusui",
    "owner",
    "pelanggan",
    "pemilik",
    "petugas",
    "rumah",
    "sedang",
    "staf",
    "staff",
    "sudah",
    "supervisor",
    "tamu",
    "tangga",
    "tidak",
    "toko",
    "tunggal",
    "untuk",
    "waiter",
    "yang",
  ].map((word) => word.toLowerCase()),
);

// Province codes in use (Kemendagri), the first two digits of a NIK.
const NIK_PROVINCES = new Set([
  ...[11, 12, 13, 14, 15, 16, 17, 18, 19, 21],
  ...[31, 32, 33, 34, 35, 36],
  ...[51, 52, 53],
  ...[61, 62, 63, 64, 65],
  ...[71, 72, 73, 74, 75, 76],
  ...[81, 82],
  ...[91, 92, 93, 94, 95, 96],
]);

/** Province, then day (+40 for women) and month of birth at digits 7-10. */
function isPlausibleNik(digits: string): boolean {
  if (!NIK_PROVINCES.has(Number(digits.slice(0, 2)))) return false;
  const day = Number(digits.slice(6, 8));
  const month = Number(digits.slice(8, 10));
  const dayOk = (day >= 1 && day <= 31) || (day >= 41 && day <= 71);
  return dayOk && month >= 1 && month <= 12;
}

function mask(text: string): string {
  const keepEnd = text.length >= 10 ? 2 : 0;
  const keepStart = text.length >= 6 ? 2 : 1;
  const hidden = Math.max(text.length - keepStart - keepEnd, 1);
  return `${text.slice(0, keepStart)}${"*".repeat(hidden)}${keepEnd ? text.slice(-keepEnd) : ""}`;
}

function maskedExcerpt(match: Match): string {
  if (match.kind !== "person_name") return mask(match.text);
  const [honorific = "", name = ""] = match.text.split(/\s+/);
  return `${honorific} ${name.slice(0, 1)}***`;
}

/** Matches in `text`, without overlaps (NIK wins over phone). */
function findMatches(text: string): Match[] {
  const matches: Match[] = [];
  const overlaps = (start: number, end: number) =>
    matches.some((match) => start < match.end && end > match.start);
  const collect = (
    kind: PiiKind,
    pattern: RegExp,
    accept: (found: RegExpExecArray) => boolean = () => true,
  ) => {
    for (const found of text.matchAll(pattern)) {
      const start = found.index ?? 0;
      const end = start + found[0].length;
      if (overlaps(start, end) || !accept(found)) continue;
      matches.push({ kind, start, end, text: found[0] });
    }
  };
  collect("email", EMAIL);
  collect("nik", NIK_CANDIDATE, (found) =>
    isPlausibleNik(found[0].replace(/\D/g, "")),
  );
  collect("phone", PHONE);
  collect(
    "person_name",
    PERSON_NAME,
    (found) =>
      !(found[1] ?? "")
        .split(/\s+/)
        .some((word) => NOT_A_NAME.has(word.toLowerCase())),
  );
  return matches;
}

/** Personal data found in one string, masked. */
export function detectPii(text: string): { kind: PiiKind; excerpt: string }[] {
  return findMatches(text).map((match) => ({
    kind: match.kind,
    excerpt: maskedExcerpt(match),
  }));
}

type Json = unknown;
const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Scan the free text of a bundle's `sections`: checklist item label and
 * instruction, text override values, and the `name` / `description` of every
 * generic item. Structured fields (keys, codes, amounts) are not scanned.
 */
export function scanConfigBundlePii(sections: unknown): PiiFinding[] {
  const findings: PiiFinding[] = [];
  const scan = (section: string, path: string, value: Json) => {
    if (typeof value !== "string") return;
    for (const hit of detectPii(value))
      findings.push({ section, path, kind: hit.kind, excerpt: hit.excerpt });
  };
  if (!isRecord(sections)) return findings;

  for (const [section, payload] of Object.entries(sections)) {
    if (!isRecord(payload)) continue;
    if (section === "text_overrides") {
      const sets = Array.isArray(payload.sets) ? payload.sets : [];
      sets.forEach((set, setIndex) => {
        const overrides =
          isRecord(set) && Array.isArray(set.overrides) ? set.overrides : [];
        overrides.forEach((override, index) => {
          if (isRecord(override))
            scan(
              section,
              `sets[${setIndex}].overrides[${index}].value`,
              override.value,
            );
        });
      });
      continue;
    }
    const items = Array.isArray(payload.items) ? payload.items : [];
    items.forEach((item, itemIndex) => {
      if (!isRecord(item)) return;
      scan(section, `items[${itemIndex}].name`, item.name);
      scan(section, `items[${itemIndex}].description`, item.description);
      if (section !== "checklists" || !Array.isArray(item.items)) return;
      item.items.forEach((entry, entryIndex) => {
        if (!isRecord(entry)) return;
        const base = `items[${itemIndex}].items[${entryIndex}]`;
        scan(section, `${base}.label`, entry.label);
        scan(section, `${base}.instruction`, entry.instruction);
      });
    });
  }
  return findings;
}
