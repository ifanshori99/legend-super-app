import { z } from "../core/index.ts";

type Json = z.infer<ReturnType<typeof z.json>>;
export const AUDIT_REDACTED = "[REDACTED]";
// Deny sensitive field names even if accidentally included in the safe list.
const sensitive =
  /email|phone|mobile|telepon|whatsapp|contact|kontak|name|nama|nik|npwp|identity|identitas|account|rekening|salary|gaji|payroll|password|secret|token|credential|authorization|cookie|pin|otp|address|alamat|birth|lahir|passport|card|pan|ipaddress/i;

/** Default-deny recursive masking. Only explicitly safe scalar field names may
 * be retained; callers must ensure their values cannot contain PII or secrets.
 * Validate input as JSON so unsupported objects cannot bypass traversal. */
export function maskAuditChanges(
  value: unknown,
  safeFields: readonly string[] = [],
): Json {
  const input = z.json().parse(value);
  const allowed = new Set(safeFields);
  function mask(item: Json, key?: string): Json {
    if (key && sensitive.test(key.replace(/[^a-z0-9]/gi, "")))
      return AUDIT_REDACTED;
    if (Array.isArray(item)) return item.map((entry) => mask(entry));
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([field, entry]) => [
          field,
          mask(entry, field),
        ]),
      );
    return key && allowed.has(key) ? item : AUDIT_REDACTED;
  }
  return mask(input);
}
