// Edge link credential (bead legend-2pi; PRD v1.7 §3 F5 "Server Lokal",
// TEN-02). The cloud mints one credential per registered edge node and shows
// it once; the edge keeps it in EDGE_NODE_CREDENTIAL and presents it as a
// bearer token when it opens the link.
//
//   edg1.<tenantId>.<outletId>.<edgeNodeId>.<secret>
//
// The ids are lookup keys only: the cloud loads the node row under that
// tenant's RLS and accepts the token only when the SHA-256 digest of the
// whole bound string matches the stored `credential_hash` and the node is
// active. A digest copied to another row (other tenant, outlet or node) never
// matches, because the ids are part of the hashed input. The secret is 32
// random bytes, so a fast digest is sufficient (no password stretching).
// Never log the token or the secret.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
  type OutletId,
  type TenantId,
} from "@starter/shared/core";

const PREFIX = "edg1";
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type EdgeCredentialClaims = {
  readonly tenantId: string;
  readonly outletId: string;
  readonly edgeNodeId: string;
};

function digest(claims: EdgeCredentialClaims, secret: string): string {
  return createHash("sha256")
    .update(
      `${PREFIX}.${claims.tenantId}.${claims.outletId}.${claims.edgeNodeId}.${secret}`,
    )
    .digest("hex");
}

/** Server-only: mint a fresh credential. Return the token to the caller once. */
export function mintEdgeCredential(claims: EdgeCredentialClaims): {
  token: string;
  hash: string;
} {
  const normalized = {
    tenantId: tenantIdSchema.parse(claims.tenantId),
    outletId: outletIdSchema.parse(claims.outletId),
    edgeNodeId: uuidSchema.parse(claims.edgeNodeId),
  };
  const secret = randomBytes(32).toString("base64url");
  return {
    token: `${PREFIX}.${normalized.tenantId}.${normalized.outletId}.${normalized.edgeNodeId}.${secret}`,
    hash: digest(normalized, secret),
  };
}

export type ParsedEdgeCredential = {
  readonly tenantId: TenantId;
  readonly outletId: OutletId;
  readonly edgeNodeId: string;
  /** Digest of the presented token, compared with the stored hash. */
  readonly hash: string;
};

/** Parses the token shape; null for anything malformed (no oracle). */
export function parseEdgeCredential(
  token: unknown,
): ParsedEdgeCredential | null {
  if (typeof token !== "string" || token.length > 300) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== PREFIX) return null;
  const tenantId = tenantIdSchema.safeParse(parts[1]);
  const outletId = outletIdSchema.safeParse(parts[2]);
  const edgeNodeId = uuidSchema.safeParse(parts[3]);
  const secret = parts[4] ?? "";
  if (
    !tenantId.success ||
    !outletId.success ||
    !edgeNodeId.success ||
    !SECRET_PATTERN.test(secret)
  )
    return null;
  const claims = {
    tenantId: tenantId.data,
    outletId: outletId.data,
    edgeNodeId: edgeNodeId.data,
  };
  return { ...claims, hash: digest(claims, secret) };
}

/** Constant-time comparison of the presented digest with the stored one. */
export function edgeCredentialMatches(
  presentedHash: string,
  storedHash: string,
): boolean {
  const a = Buffer.from(presentedHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

/** Reads `Authorization: Bearer <token>`; the URL never carries the token. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}
