// KirimDev inbound webhook verification (owner-approved replacement for Meta's
// X-Hub-Signature-256 in PRD AUTH-02; see docs/plan/providers.md).
// Scheme, per https://docs.kirimdev.com/webhooks/signing/ (checked 1 Nov 2026):
//   X-Kirim-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]
//   v1 = HMAC-SHA256(secret, "<t>." + <raw request bytes>), hex
//   reject if |now - t| > 300 s; one v1 per active secret during rotation;
//   X-Kirim-Event-Id is the dedupe key (wamid for Meta events).
// Verify the exact bytes received (use express.raw), never re-serialized JSON.
import { CoreError, z } from "../core/index.ts";
import {
  concatBytes,
  fromHex,
  hmacSha256,
  hmacSha256Verify,
  toHex,
  utf8,
} from "./hmac.ts";

export const KIRIM_SIGNATURE_HEADER = "X-Kirim-Signature";
export const KIRIM_EVENT_ID_HEADER = "X-Kirim-Event-Id";
export const KIRIM_DELIVERY_ID_HEADER = "X-Kirim-Delivery-Id";
export const KIRIM_TOLERANCE_SECONDS = 300;
const MAX_HEADER_LENGTH = 1024;
const MAX_SIGNATURES = 8;

/** Node `req.headers`, a fetch `Headers`, or any `{ get }`. */
export type HeaderBag =
  | { get(name: string): string | null | undefined }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export const verifiedWebhookSchema = z.strictObject({
  /** Provider message id: the idempotency key for processing. */
  eventId: z.string().min(1).max(255),
  deliveryId: z.string().min(1).max(255).nullable(),
  signedAt: z.number().int().nonnegative().safe(),
});
export type VerifiedWebhook = z.infer<typeof verifiedWebhookSchema>;

export type WebhookVerificationInput = {
  /** Exact request bytes (or the text decoded from them without changes). */
  rawBody: string | Uint8Array;
  headers: HeaderBag;
  /** Active signing secrets: more than one while rotating. */
  secrets: readonly string[];
  /** Test clock, Unix seconds. */
  nowSeconds?: number;
  toleranceSeconds?: number;
};

const unauthorized = () =>
  new CoreError("UNAUTHORIZED", "Tanda tangan webhook tidak valid.");

/** One value, or null when absent or ambiguous (repeated header). */
function readHeader(headers: HeaderBag, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === "function")
    return (
      (headers as { get(n: string): string | null | undefined }).get(name) ??
      null
    );
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(
    headers as Record<string, string | readonly string[] | undefined>,
  )) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    if (typeof value === "string") return value;
    return value.length === 1 ? (value[0] ?? null) : null;
  }
  return null;
}

/** Strict parse; `null` for anything that is not a well-formed header. */
export function parseKirimSignatureHeader(
  value: string,
): { timestamp: string; signatures: Uint8Array[] } | null {
  if (value.length === 0 || value.length > MAX_HEADER_LENGTH) return null;
  let timestamp: string | null = null;
  const signatures: Uint8Array[] = [];
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) return null;
    const key = part.slice(0, separator);
    const entry = part.slice(separator + 1);
    if (key === "t") {
      if (timestamp !== null || !/^[0-9]{1,12}$/.test(entry)) return null;
      timestamp = entry;
    } else if (key === "v1") {
      const bytes = fromHex(entry, 32);
      if (!bytes || signatures.length >= MAX_SIGNATURES) return null;
      signatures.push(bytes);
    } // Unknown schemes (v2...) are ignored; they cannot satisfy verification.
  }
  return timestamp === null || signatures.length === 0
    ? null
    : { timestamp, signatures };
}

/** Throws `CoreError` UNAUTHORIZED (same message for every failure, so the
 * response is no oracle) when the signature is missing, malformed, stale or
 * wrong; VALIDATION_ERROR when a signed delivery lacks its event id. Other
 * misuse (no secrets) is a `TypeError`: a configuration bug, not a bad request.
 *
 * Only `timestamp.body` is signed: the event id and delivery id headers are
 * not, so whoever holds a captured body can replay it with other header values.
 * Never use `eventId` as a dedupe key; dedupe on an id inside the signed body. */
export async function verifyKirimWebhook(
  input: WebhookVerificationInput,
): Promise<VerifiedWebhook> {
  if (input.secrets.length === 0 || input.secrets.some((s) => s.length === 0))
    throw new TypeError("At least one non-empty webhook secret is required");
  const header = readHeader(input.headers, KIRIM_SIGNATURE_HEADER);
  const parsed = header === null ? null : parseKirimSignatureHeader(header);
  if (!parsed) throw unauthorized();
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? KIRIM_TOLERANCE_SECONDS;
  const signedAt = Number(parsed.timestamp);
  if (Math.abs(now - signedAt) > tolerance) throw unauthorized();

  const body =
    typeof input.rawBody === "string" ? utf8(input.rawBody) : input.rawBody;
  const signed = concatBytes(utf8(`${parsed.timestamp}.`), body);
  let valid = false;
  // Check every pair (no early exit) so timing does not reveal which matched.
  for (const secret of input.secrets)
    for (const signature of parsed.signatures)
      valid = (await hmacSha256Verify(secret, signature, signed)) || valid;
  if (!valid) throw unauthorized();

  const result = verifiedWebhookSchema.safeParse({
    eventId: readHeader(input.headers, KIRIM_EVENT_ID_HEADER) ?? "",
    deliveryId: readHeader(input.headers, KIRIM_DELIVERY_ID_HEADER) || null,
    signedAt,
  });
  if (!result.success)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Webhook tidak memiliki ID event yang valid.",
    );
  return result.data;
}

/** Produces a valid `X-Kirim-Signature` value, for fakes and route tests. */
export async function signKirimWebhook(input: {
  rawBody: string | Uint8Array;
  secret: string;
  timestamp?: number;
}): Promise<string> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const body =
    typeof input.rawBody === "string" ? utf8(input.rawBody) : input.rawBody;
  const tag = await hmacSha256(
    input.secret,
    concatBytes(utf8(`${timestamp}.`), body),
  );
  return `t=${timestamp},v1=${toHex(tag)}`;
}
