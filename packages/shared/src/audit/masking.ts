import { z } from "../core/index.ts";

type Json = z.infer<ReturnType<typeof z.json>>;
export const AUDIT_REDACTED = "[REDACTED]";

// Long, unambiguous terms are matched anywhere in the key with separators and
// case removed ("bank_account" -> "bankaccount"). Indonesian and English.
const sensitiveFragments =
  /email|phone|mobile|telepon|telp|whatsapp|contact|kontak|name|nama|npwp|identity|identitas|account|rekening|salary|gaji|payroll|passw|secret|token|credential|authorization|bearer|cookie|session|signature|apikey|privatekey|secretkey|accesskey|signingkey|encryptionkey|address|alamat|birth|lahir|passport|paspor|card|kartu|ipaddress|msisdn|nohp|nomorhp|photo|foto|selfie|biometric|fingerprint|geolocation|latitude|longitude/;
// Short terms only count as whole words of the key (split on case changes and
// separators), so "pin" and "pinCode" match but "shipping" and "company" do not.
const sensitiveWords = new Set([
  "pin",
  "pan",
  "otp",
  "nik",
  "ktp",
  "hp",
  "ip",
  "dob",
  "cvv",
  "cvc",
  "jwt",
  "face",
  "lat",
  "lng",
  "wa",
]);
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** True if a field name must never carry a raw value in an audit row. The deny
 * list always wins over a caller's safe list. */
export function isSensitiveAuditKey(key: string): boolean {
  return (
    sensitiveFragments.test(key.replace(/[^a-z0-9]/gi, "").toLowerCase()) ||
    words(key).some((word) => sensitiveWords.has(word))
  );
}

/** Default-deny recursive masking. Only explicitly safe scalar field names may
 * be retained (also as elements of an array held by that field); callers must
 * ensure their values cannot contain PII or secrets, e.g. no free text. `null`
 * stays `null`. Validate input as JSON so unsupported objects cannot bypass
 * traversal. */
export function maskAuditChanges(
  value: unknown,
  safeFields: readonly string[] = [],
): Json {
  const input = z.json().parse(value);
  const allowed = new Set(safeFields);
  function mask(item: Json, key?: string): Json {
    if (key !== undefined && isSensitiveAuditKey(key)) return AUDIT_REDACTED;
    if (item === null) return null;
    if (Array.isArray(item)) return item.map((entry) => mask(entry, key));
    if (typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([field, entry]) => [
          field,
          mask(entry, field),
        ]),
      );
    return key !== undefined && allowed.has(key) ? item : AUDIT_REDACTED;
  }
  return mask(input);
}

/** True if every sensitive-named field in `value` holds only the redaction
 * marker. The schema uses it to reject rows that skipped the masker. */
export function auditChangesAreMasked(value: Json, key?: string): boolean {
  if (key !== undefined && isSensitiveAuditKey(key))
    return value === AUDIT_REDACTED;
  if (Array.isArray(value))
    return value.every((entry) => auditChangesAreMasked(entry, key));
  if (value !== null && typeof value === "object")
    return Object.entries(value).every(([field, entry]) =>
      auditChangesAreMasked(entry, field),
    );
  return true;
}
