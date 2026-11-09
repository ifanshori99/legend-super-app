// Generic delivery platform webhook verification (bead legend-5bn3 D3; PRD v1.7
// §3.23). GoFood, GrabFood and ShopeeFood have no public signing spec we may
// rely on before a partner approves the integration (legend-im8n), so every
// platform shares one scheme, the same shape as the KirimDev one (webhook.ts)
// and reusing its HMAC helpers:
//   X-Delivery-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]
//   v1 = HMAC-SHA256(secret, "<t>." + <raw request bytes>), hex
//   reject if |now - t| > 300 s; one v1 per active secret during rotation.
// A real adapter whose platform signs differently replaces this per platform;
// the route only depends on `verifyDeliveryWebhook`.
// Verify the exact bytes received (express.raw), never re-serialized JSON.
import { CoreError, z } from "../core/index.ts";
import {
  concatBytes,
  fromHex,
  hmacSha256,
  hmacSha256Verify,
  toHex,
  utf8,
} from "./hmac.ts";
import type { HeaderBag } from "./webhook.ts";

export const DELIVERY_SIGNATURE_HEADER = "X-Delivery-Signature";
export const DELIVERY_TOLERANCE_SECONDS = 300;
const MAX_HEADER_LENGTH = 1024;
const MAX_SIGNATURES = 8;

function unauthorized(): CoreError {
  return new CoreError("UNAUTHORIZED", "Tanda tangan webhook tidak valid.");
}

/** One header value (case-insensitive); null when absent or repeated. */
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
export function parseDeliverySignatureHeader(
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
    } // Unknown schemes are ignored; they cannot satisfy verification.
  }
  return timestamp === null || signatures.length === 0
    ? null
    : { timestamp, signatures };
}

/**
 * Throws `CoreError` UNAUTHORIZED (one message for every failure, so the
 * response is no oracle) for a missing, malformed, stale or wrong signature.
 * No secrets is a `TypeError`: a configuration bug, not a bad request.
 * Returns the signed instant (unix seconds).
 */
export async function verifyDeliveryWebhook(input: {
  rawBody: string | Uint8Array;
  headers: HeaderBag;
  secrets: readonly string[];
  nowSeconds?: number;
  toleranceSeconds?: number;
}): Promise<{ signedAt: number }> {
  if (input.secrets.length === 0 || input.secrets.some((s) => s.length === 0))
    throw new TypeError("At least one non-empty webhook secret is required");
  const header = readHeader(input.headers, DELIVERY_SIGNATURE_HEADER);
  const parsed = header === null ? null : parseDeliverySignatureHeader(header);
  if (!parsed) throw unauthorized();
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DELIVERY_TOLERANCE_SECONDS;
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
  return { signedAt };
}

/** Produces a valid `X-Delivery-Signature` value, for fakes and route tests. */
export async function signDeliveryWebhook(input: {
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

// ---- Inbound payload --------------------------------------------------------

const wholeRupiah = z.number().int().min(0).max(1_000_000_000);

/**
 * The normalised order the webhook route accepts for every platform (a real
 * adapter, legend-im8n, maps its platform's JSON onto this before it posts, or
 * replaces the parse). `sync_menu` sends OUR menu item id as the platform's
 * item id, so `itemId` of a line is a menu item id of the tenant; an id that is
 * unknown or inactive is a line that needs staff review (`unmatched`).
 * Money is as the platform reports it, whole rupiah. Unknown keys are ignored:
 * the signature and `payloadHash` cover the raw bytes.
 */
export const deliveryWebhookPayloadSchema = z.object({
  /** The platform's merchant/store id: resolves tenant and outlet. */
  storeId: z.string().min(1).max(100),
  /** The platform's order id, unique per platform. */
  orderId: z.string().min(1).max(100),
  /** `order.cancelled` closes the order through the delivery state machine. */
  event: z
    .enum(["order.created", "order.updated", "order.cancelled"])
    .default("order.created"),
  /** Cancel reason as the platform states it. */
  reason: z.string().max(300).nullable().optional(),
  grossIdr: wholeRupiah,
  /** Absent: the outlet channel's commission rate applies. */
  commissionIdr: wholeRupiah.nullable().optional(),
  customerNote: z.string().max(300).nullable().optional(),
  items: z
    .array(
      z.object({
        itemId: z.string().min(1).max(100),
        name: z.string().min(1).max(200),
        quantity: z.number().int().min(1).max(99),
        unitPriceIdr: wholeRupiah,
        variantId: z.string().min(1).max(100).nullable().optional(),
        modifiers: z
          .array(
            z.object({
              name: z.string().min(1).max(100),
              priceIdr: wholeRupiah,
            }),
          )
          .max(20)
          .default([]),
        note: z.string().max(200).nullable().optional(),
      }),
    )
    .max(200)
    .default([]),
});
export type DeliveryWebhookPayload = z.infer<
  typeof deliveryWebhookPayloadSchema
>;
