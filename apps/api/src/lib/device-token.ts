// Signed outlet device credentials (TEN-02). The server is the only party that
// mints a device token, and the resolver is the only party that reads one:
//   - signature: HMAC-SHA256 over `dv1.<payload>` with a key derived from
//     BETTER_AUTH_SECRET and a fixed label, so the token secret is never the
//     session secret itself and needs no extra deployment variable;
//   - expiry: `expiresAt` (Unix seconds) is inside the signed payload;
//   - tenant status: checked by the caller against `tenants` (fail closed).
//
// Device registration, issuance and revocation live in WS-02 (legend-165).
// Until then nothing in the product issues a token, so this verifier cannot be
// reached with a token the server did not sign.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  deviceTokenPayloadSchema,
  deviceTokenSchema,
  type DeviceTokenPayload,
} from "@starter/shared/platform";
import { env } from "../config/env";

const PREFIX = "dv1";
/** Devices are provisioned once and run for a long time; rotation replaces. */
export const DEVICE_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

function signingKey(): Buffer {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update("legend.device-token.v1")
    .digest();
}

function sign(signingInput: string): string {
  return createHmac("sha256", signingKey())
    .update(signingInput)
    .digest("base64url");
}

/** Mints a token for one device. Server-only: never call from a request handler. */
export function signDeviceToken(
  payload: Omit<DeviceTokenPayload, "expiresAt" | "tenantId" | "brandId"> & {
    tenantId: string;
    brandId: string | null;
  },
  expiresAt = Math.floor(Date.now() / 1000) + DEVICE_TOKEN_TTL_SECONDS,
): string {
  const signed = deviceTokenPayloadSchema.parse({ ...payload, expiresAt });
  const body = Buffer.from(JSON.stringify(signed), "utf8").toString(
    "base64url",
  );
  const signingInput = `${PREFIX}.${body}`;
  return `${signingInput}.${sign(signingInput)}`;
}

/**
 * Verifies an opaque token and returns its payload, or null. Every failure
 * (malformed, bad signature, expired) is the same null so a caller cannot use
 * the answer as an oracle.
 */
export function verifyDeviceToken(
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): DeviceTokenPayload | null {
  if (!deviceTokenSchema.safeParse(token).success) return null;
  const [prefix, body, signature, extra] = token.split(".");
  if (prefix !== PREFIX || !body || !signature || extra !== undefined)
    return null;
  const expected = Buffer.from(sign(`${PREFIX}.${body}`), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;
  let payload: DeviceTokenPayload;
  try {
    payload = deviceTokenPayloadSchema.parse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
  if (payload.expiresAt <= nowSeconds) return null;
  return payload;
}
