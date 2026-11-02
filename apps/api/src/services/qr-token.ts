// Signed permanent table QR (PRD v1.7 §3 F10 "Keamanan Sesi", §6 C
// tables.qr_token_hash; ORD-04).
//
// Token format: `v1.<base64url payload>.<base64url HMAC-SHA256>`, matching
// signedQrTokenSchema/qrTokenPayloadSchema in @starter/shared/qr-order. The
// signature key is derived per tenant, so a token minted for one tenant cannot
// be replayed against another even if its payload is edited. The master key is
// a domain-separated scrypt of the deployment secrets already present
// (DATA_ENCRYPTION_KEY when set, otherwise BETTER_AUTH_SECRET); production
// should provision a dedicated secret with the rest of the deployment keys.
//
// The database never stores the raw token by hash only: `tables.qr_token_hash`
// is the scan lookup key and `tables.qr_token_sealed` holds the AES-GCM
// envelope so a reprint does not rotate a sticker already on a table. Rotating
// ("Ganti QR") issues a new payload, so the old sticker's hash no longer
// resolves (assertQrTokenMatchesTable refuses it, ORD-04).

import {
  createHash,
  createHmac,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { CoreError, toIsoDateTime } from "@starter/shared/core";
import {
  qrTokenPayloadSchema,
  signedQrTokenSchema,
  type QrTokenPayload,
} from "@starter/shared/qr-order";
import { env } from "../config/env";

const TOKEN_VERSION = "v1";
const KEY_VERSION = "v1";
const KEY_CONTEXT = "legend:qr-signing:v1";

let cachedMaster: Buffer | undefined;

function masterKey(): Buffer {
  if (cachedMaster) return cachedMaster;
  const material = env.DATA_ENCRYPTION_KEY ?? env.BETTER_AUTH_SECRET;
  cachedMaster = scryptSync(material, KEY_CONTEXT, 32);
  return cachedMaster;
}

/** Per-tenant signing key; changing the deployment secret rotates every table. */
function tenantKey(tenantId: string): Buffer {
  return createHmac("sha256", masterKey())
    .update(`tenant\u0000${tenantId}`, "utf8")
    .digest();
}

/** SHA-256 hex of the full token: the only form stored for QR lookup. */
export function qrTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Mints a signed permanent table QR. Deterministic for the same payload, so a
 * re-issue after a lost seal still reproduces the printed sticker.
 */
export function signTableQrToken(input: {
  tenantId: string;
  outletId: string;
  tableId: string;
  issuedAt?: Date;
}): string {
  const payload = qrTokenPayloadSchema.parse({
    version: 1,
    tenantId: input.tenantId,
    outletId: input.outletId,
    tableId: input.tableId,
    keyId: KEY_VERSION,
    issuedAt: toIsoDateTime(input.issuedAt ?? new Date()),
  });
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", tenantKey(payload.tenantId))
    .update(`${TOKEN_VERSION}.${encoded}`, "utf8")
    .digest("base64url");
  return signedQrTokenSchema.parse(`${TOKEN_VERSION}.${encoded}.${signature}`);
}

/** Same NOT_FOUND for every failure, so the endpoint is not a valid-id oracle. */
function unknownQr(): CoreError {
  return new CoreError("NOT_FOUND", "QR meja tidak dikenali");
}

function decodePayload(encoded: string): QrTokenPayload {
  try {
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    return qrTokenPayloadSchema.parse(decoded);
  } catch {
    throw unknownQr();
  }
}

function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies the token signature against the tenant resolved from the request
 * host (TEN-02) and returns its payload. The caller still loads the table by
 * `qrTokenHash(token)` and calls `assertQrTokenMatchesTable`, so a rotated
 * token, an inactive table or a copied payload is refused there.
 */
export function verifyTableQrToken(input: {
  token: unknown;
  resolvedTenantId: string;
}): { payload: QrTokenPayload; token: string; hash: string } {
  const parsed = signedQrTokenSchema.safeParse(input.token);
  if (!parsed.success) throw unknownQr();
  const token = parsed.data;
  const [version, encoded, signature] = token.split(".");
  if (version !== TOKEN_VERSION) throw unknownQr();
  const payload = decodePayload(encoded);
  // TEN-02/ORD-04: the request tenant is resolved independently (host); a
  // token carrying another tenant's id is refused even before the table load.
  if (payload.tenantId !== input.resolvedTenantId) throw unknownQr();
  if (payload.keyId !== KEY_VERSION) throw unknownQr();
  const expected = createHmac("sha256", tenantKey(payload.tenantId))
    .update(`${version}.${encoded}`, "utf8")
    .digest("base64url");
  if (!signatureMatches(expected, signature)) throw unknownQr();
  return { payload, token, hash: qrTokenHash(token) };
}
