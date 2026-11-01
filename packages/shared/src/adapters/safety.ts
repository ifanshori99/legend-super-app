// Input guards shared by the provider schemas. Providers sit on the trust
// boundary: they send what tenants or guests control to third parties.
import { z } from "../core/index.ts";

type UrlLike = {
  protocol: string;
  hostname: string;
  username: string;
  password: string;
};
const runtime = globalThis as unknown as {
  URL: new (input: string) => UrlLike;
};

/** WhatsApp ids and recipients: international digits, no `+`, spaces or zero prefix. */
export const phoneDigitsSchema = z.string().regex(/^[1-9][0-9]{7,14}$/);

/** Text for display or a header value: one line, so it cannot inject headers. */
export const singleLineSchema = z
  .string()
  .min(1)
  .max(998)
  .regex(/^[^\r\n]+$/, "Must be a single line");

const privateSuffix = /\.(local|localhost|internal|lan|home\.arpa|intranet)$/;
/** True for a public DNS name over https with no credentials. IP literals
 * (IPv4, IPv6, decimal or hex forms, all normalized by the URL parser) and
 * internal suffixes are refused. Implementations must still resolve DNS and
 * refuse private answers at connect time (rebinding); this is the first gate. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: UrlLike;
  try {
    url = new runtime.URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    host.includes(".") &&
    !host.startsWith("[") &&
    !/^[0-9.]+$/.test(host) &&
    !/^[0-9]+$/.test(host.split(".").at(-1) ?? "") &&
    host !== "localhost" &&
    !privateSuffix.test(host)
  );
}
export const publicHttpsUrlSchema = z
  .string()
  .max(2048)
  .refine(isPublicHttpsUrl, "Must be a public https URL");

/** Object key: relative, no empty, `.` or `..` segments, portable characters. */
export const storageKeySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, "Invalid object key")
  .refine(
    (key) => key.split("/").every((part) => part !== "." && part !== ".."),
    "Invalid object key",
  );

/** Order-independent JSON text, for comparing request payloads. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
