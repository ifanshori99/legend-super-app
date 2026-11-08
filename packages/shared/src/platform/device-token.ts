// Signed outlet device credential (TEN-02: the tenant comes from a domain or a
// token, never from a client parameter). A POS, KDS or edge device carries an
// opaque token signed by the server; the API learns tenant and brand from it
// only after signature, expiry and tenant-status checks.
//
// Device registration, issuance, rotation and revocation are WS-02 (bead
// legend-165); this file fixes the wire format so the issuing and verifying
// sides cannot drift. `dv1.<payload>.<signature>`, base64url parts, like the
// signed table QR in `qr-order/schemas.ts`. Payload and signature are only
// built and read by the server; clients treat the token as opaque.

import { brandIdSchema, tenantIdSchema, uuidSchema, z } from "../core/index.ts";

/** Header a registered device sends its token in (`X-Device-Token`). */
export const DEVICE_TOKEN_HEADER = "x-device-token";

export const deviceTokenPayloadSchema = z.strictObject({
  version: z.literal(1),
  tenantId: tenantIdSchema,
  /** Brand the device is pinned to; null = the tenant's default brand. */
  brandId: brandIdSchema.nullable(),
  deviceId: uuidSchema,
  /**
   * Unix seconds the token was minted. Accepted only if not older than the
   * device's `token_issued_at` floor: a reissue rotates older tokens out.
   */
  issuedAt: z.number().int().positive(),
  /** Unix seconds; an expired token is refused. */
  expiresAt: z.number().int().positive(),
});
export type DeviceTokenPayload = z.infer<typeof deviceTokenPayloadSchema>;

/** Opaque device credential. The server builds it; clients never parse it. */
export const deviceTokenSchema = z
  .string()
  .min(32)
  .max(1024)
  .regex(
    /^dv1\.[A-Za-z0-9_-]{10,900}\.[A-Za-z0-9_-]{20,120}$/,
    "Expected a dv1 signed device token",
  );
