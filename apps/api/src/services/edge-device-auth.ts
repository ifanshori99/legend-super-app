// Device token check of an outlet edge (E2, brief 1269 decision 1). The edge
// has no key that signs or verifies a token: the cloud stores the SHA-256 of
// the whole token (devices.token_hash), copies it on the outlet's own device
// stream, and the edge accepts a token only when the digest matches. A stolen
// edge therefore holds digests and cannot make a token.
//
// The answer of `verifyDeviceToken` (lib/device-token.ts) on an edge is the
// token checked here for the same request, kept in the request context; every
// caller of it stays synchronous and cannot skip this check.
import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  DEVICE_TOKEN_HEADER,
  type DeviceTokenPayload,
} from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { withTenant } from "../db/tenant.ts";
import {
  catalogOverrideNow,
  isCatalogOverrideClockReady,
} from "../edge/catalog-override.ts";
import { isEdgeNode } from "../edge/mode.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { decodeDeviceToken, hashDeviceToken } from "../lib/device-token.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  runWithEdgeDevice,
  setRequestEdgeDevice,
} from "../lib/request-context.ts";

/**
 * `unavailable`: this edge cannot judge the token (no node identity, no trusted
 * clock, device or its newest token not synced yet). Never a verdict about the
 * token itself: the client must keep it.
 */
export type EdgeDeviceCheck =
  | { readonly status: "verified"; readonly payload: DeviceTokenPayload }
  | { readonly status: "refused" }
  | { readonly status: "unavailable" };

const REFUSED: EdgeDeviceCheck = { status: "refused" };
const UNAVAILABLE: EdgeDeviceCheck = { status: "unavailable" };

export async function checkEdgeDeviceToken(
  token: string,
): Promise<EdgeDeviceCheck> {
  const payload = decodeDeviceToken(token);
  if (payload === null) return REFUSED;
  const { edgeMode, identity } = getEdgeRuntimeState();
  if (!edgeMode || !identity || !isCatalogOverrideClockReady())
    return UNAVAILABLE;
  const { tenantId, outletId } = identity.scope;
  if (payload.tenantId.toLowerCase() !== tenantId.toLowerCase()) return REFUSED;
  if (payload.expiresAt * 1000 <= catalogOverrideNow().getTime())
    return REFUSED;
  const [row] = await withTenant(db, identity.context, (tx) =>
    tx
      .select({
        outletId: devices.outletId,
        status: devices.status,
        revokedAt: devices.revokedAt,
        tokenIssuedAt: devices.tokenIssuedAt,
        tokenHash: devices.tokenHash,
      })
      .from(devices)
      .where(
        and(
          eq(devices.tenantId, identity.context.tenant.tenantId),
          eq(devices.id, payload.deviceId),
        ),
      )
      .limit(1),
  );
  if (!row) return UNAVAILABLE;
  if (
    row.outletId.toLowerCase() !== outletId.toLowerCase() ||
    row.status !== "active" ||
    row.revokedAt !== null
  )
    return REFUSED;
  if (row.tokenIssuedAt === null || row.tokenHash === null) return UNAVAILABLE;
  const floor = Math.floor(row.tokenIssuedAt.getTime() / 1000);
  if (payload.issuedAt < floor) return REFUSED;
  if (payload.issuedAt > floor) return UNAVAILABLE;
  return timingSafeEqual(
    Buffer.from(hashDeviceToken(token), "hex"),
    Buffer.from(row.tokenHash, "hex"),
  )
    ? { status: "verified", payload }
    : REFUSED;
}

/** Monitoring reads the health route with or without a token. */
const HEALTH_PATH = /^\/api\/(edge\/)?health(\/|$)/i;

/**
 * Mounted once, before anything that reads a device token. No-op on the cloud.
 * A refused token is left unverified (same as no token); one this edge cannot
 * judge answers 503, so the client keeps its token and retries.
 */
export const edgeDeviceAuth: RequestHandler = async (req, _res, next) => {
  if (!isEdgeNode()) return next();
  const token = req.get(DEVICE_TOKEN_HEADER);
  if (!token || HEALTH_PATH.test(req.path)) return next();
  const check = await checkEdgeDeviceToken(token);
  if (check.status === "unavailable")
    throw new HttpError(
      503,
      "EDGE_DEVICE_NOT_SYNCED",
      "Perangkat belum bisa diverifikasi di server lokal. Coba lagi sebentar lagi.",
    );
  if (check.status === "verified")
    setRequestEdgeDevice({ token, payload: check.payload });
  next();
};

/**
 * The same for a WebSocket upgrade, which never passes through Express: runs
 * `run` with the header's token verified, or unverified when it is refused.
 */
export async function withEdgeDeviceOfHeaders<T>(
  headers: IncomingHttpHeaders,
  run: () => Promise<T>,
): Promise<T> {
  if (!isEdgeNode()) return run();
  const raw = headers[DEVICE_TOKEN_HEADER.toLowerCase()];
  const token = Array.isArray(raw) ? raw[0] : raw;
  const check = token ? await checkEdgeDeviceToken(token) : REFUSED;
  return runWithEdgeDevice(
    token && check.status === "verified"
      ? { token, payload: check.payload }
      : undefined,
    run,
  );
}
