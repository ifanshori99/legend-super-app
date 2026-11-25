// Signed outlet device credentials (TEN-02). The server is the only party that
// mints a device token, and the resolver is the only party that reads one:
//   - signature: HMAC-SHA256 over `dv1.<payload>` with a key derived from
//     BETTER_AUTH_SECRET and a fixed label, so the token secret is never the
//     session secret itself and needs no extra deployment variable;
//   - expiry: `expiresAt` (Unix seconds) is inside the signed payload;
//   - tenant status: checked by the caller against `tenants` (fail closed).
//
// The signed payload also carries `issuedAt` (Unix seconds). A valid signature
// is only half of acceptance: the device registry (services/device.service.ts
// mints, services/device-registry-check.ts reads) must still list the device as
// active with `token_issued_at <= issuedAt`, so revocation and reissue take
// effect even though a token cannot be recalled.
//
// An outlet edge (E2, brief 1269) never uses the key: it accepts a token by the
// SHA-256 the cloud stored (devices.token_hash), checked before the handlers by
// services/edge-device-auth.ts; `verifyDeviceToken` answers from that check.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  deviceTokenPayloadSchema,
  deviceTokenSchema,
  type DeviceTokenPayload,
} from "@starter/shared/platform";
import { env } from "../config/env";
import { isEdgeNode } from "../edge/mode.ts";
import { getRequestEdgeDevice } from "./request-context.ts";

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

/** SHA-256 (hex) of the whole token: what the registry stores (devices.token_hash). */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The payload of a well-formed token, WITHOUT any check. Only
 * services/edge-device-auth.ts may use it, to look up the stored digest.
 */
export function decodeDeviceToken(token: string): DeviceTokenPayload | null {
  if (!deviceTokenSchema.safeParse(token).success) return null;
  const [prefix, body, signature, extra] = token.split(".");
  if (prefix !== PREFIX || !body || !signature || extra !== undefined)
    return null;
  try {
    return deviceTokenPayloadSchema.parse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}

/**
 * Verifies an opaque token and returns its payload, or null. Every failure
 * (malformed, bad signature, expired) is the same null so a caller cannot use
 * the answer as an oracle. On an edge: the payload of the token verified for
 * this very request, else null; the signing key is never used.
 */
export function verifyDeviceToken(
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): DeviceTokenPayload | null {
  if (isEdgeNode()) {
    const verified = getRequestEdgeDevice();
    return verified !== undefined && verified.token === token
      ? verified.payload
      : null;
  }
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
