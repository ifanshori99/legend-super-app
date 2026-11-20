// Short-lived member QR token (legend-111j, design §M4). The member PWA shows
// it as a QR code; the cashier scans it to attach the member to an unpaid
// order. It is a bearer for 120 seconds, so it carries the tenant and the
// profile and nothing else:
//   token = base64url(payload).base64url(HMAC-SHA256(key, base64url(payload)))
//   payload = { t: tenantId, p: customerProfileId, e: expiry (Unix seconds),
//               n: random nonce, o?: orderId, a?: points, v?: ledger version }
// `o` and `a` bind a token to one order and one amount (weexf): redeeming
// points at the POS needs both, and spends the nonce once. A token without them
// still attaches a member, but never redeems. `v` (legend-0ne0z) is the
// member's point-ledger version at mint (latest posting_seq): the POS refuses a
// redeem when the ledger moved since, so a quote is never silently adjusted.
// The key is derived from BETTER_AUTH_SECRET with a fixed label (like device
// tokens), so no extra deployment variable is needed. Every failure verifies
// to the same null so the answer is not an oracle.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env";

export const MEMBER_QR_TOKEN_TTL_SECONDS = 120;

const KEY_LABEL = "legend-member-qr-v1";

const payloadSchema = z.strictObject({
  t: z.string().min(1).max(64),
  p: z.string().min(1).max(64),
  e: z.number().int().positive(),
  n: z.string().min(1).max(64),
  o: z.string().min(1).max(64).optional(),
  a: z.number().int().positive().max(1_000_000).optional(),
  v: z.number().int().nonnegative().optional(),
});

let cachedKey: Buffer | undefined;

function key(): Buffer {
  cachedKey ??= createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(KEY_LABEL)
    .digest();
  return cachedKey;
}

function sign(body: string): string {
  return createHmac("sha256", key()).update(body).digest("base64url");
}

export function issueMemberQrToken(
  input: {
    tenantId: string;
    customerProfileId: string;
    /** Bind the token to one order and one amount of points (weexf). */
    orderId?: string;
    points?: number;
    /** Point-ledger version of the member at mint (legend-0ne0z). */
    ledgerVersion?: number;
  },
  now: Date,
): { token: string; expiresAt: string } {
  const expiresAtSeconds =
    Math.floor(now.getTime() / 1000) + MEMBER_QR_TOKEN_TTL_SECONDS;
  const body = Buffer.from(
    JSON.stringify({
      t: input.tenantId,
      p: input.customerProfileId,
      e: expiresAtSeconds,
      n: randomBytes(12).toString("base64url"),
      ...(input.orderId !== undefined && input.points !== undefined
        ? {
            o: input.orderId,
            a: input.points,
            ...(input.ledgerVersion === undefined
              ? {}
              : { v: input.ledgerVersion }),
          }
        : {}),
    }),
    "utf8",
  ).toString("base64url");
  return {
    token: `${body}.${sign(body)}`,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

function parseToken(
  token: string,
  tenantId: string,
  now: Date,
): z.infer<typeof payloadSchema> | null {
  const parts = token.split(".");
  const [body, signature] = parts;
  if (parts.length !== 2 || !body || !signature) return null;
  const expected = Buffer.from(sign(body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;
  let payload: z.infer<typeof payloadSchema>;
  try {
    payload = payloadSchema.parse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
  if (payload.t !== tenantId) return null;
  if (payload.e * 1000 <= now.getTime()) return null;
  return payload;
}

/**
 * The profile named by a valid, unexpired token of this tenant, else null
 * (malformed, bad signature, other tenant, expired).
 */
export function verifyMemberQrToken(
  token: string,
  tenantId: string,
  now: Date,
): { customerProfileId: string } | null {
  const payload = parseToken(token, tenantId, now);
  return payload ? { customerProfileId: payload.p } : null;
}

/**
 * A token for redeeming points (weexf): valid like `verifyMemberQrToken` and
 * bound to an order and an amount. Anything else, including a token without
 * those claims, verifies to null.
 */
export function verifyMemberQrRedeemToken(
  token: string,
  tenantId: string,
  now: Date,
): {
  customerProfileId: string;
  nonce: string;
  orderId: string;
  points: number;
  exp: number;
  /** Null for a token minted without a ledger version: never redeems. */
  ledgerVersion: number | null;
} | null {
  const payload = parseToken(token, tenantId, now);
  if (!payload || payload.o === undefined || payload.a === undefined)
    return null;
  return {
    customerProfileId: payload.p,
    nonce: payload.n,
    orderId: payload.o,
    points: payload.a,
    exp: payload.e,
    ledgerVersion: payload.v ?? null,
  };
}

/**
 * A redeem token judged for the member's status screen (legend-0ne0z): a
 * signed token of this tenant with order and points is `live` or `expired`;
 * anything else is `invalid`. Expiry is reported, not hidden, so the member
 * knows to make a new QR.
 */
export function inspectMemberQrRedeemToken(
  token: string,
  tenantId: string,
  now: Date,
):
  | { state: "invalid" }
  | {
      state: "live" | "expired";
      customerProfileId: string;
      nonce: string;
      orderId: string;
      points: number;
      exp: number;
      ledgerVersion: number | null;
    } {
  // Judge the signature and tenant at the token's own birth, then the clock.
  const payload = parseToken(token, tenantId, new Date(0));
  if (!payload || payload.o === undefined || payload.a === undefined)
    return { state: "invalid" };
  return {
    state: payload.e * 1000 <= now.getTime() ? "expired" : "live",
    customerProfileId: payload.p,
    nonce: payload.n,
    orderId: payload.o,
    points: payload.a,
    exp: payload.e,
    ledgerVersion: payload.v ?? null,
  };
}
