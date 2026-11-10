// Wi-Fi agent contract (bead legend-hsk, plan docs/briefs/sub-ws09-wifi-plan.md).
//
// The edge Wi-Fi agent turns a kmd3 Wi-Fi session into grants at the venue
// controller, through the `WifiProvider` boundary. Quota math stays in kmd3;
// this file only fixes what crosses the agent boundary: the apply input, the
// grant read model (never the raw device id, a MAC is personal data), the
// edge-only endpoints and the pre-auth walled-garden allowlist (FAC-11).
//
// FAC-13: running out of quota throttles a device to base speed, it never cuts
// it. So `wifiEndReasonSchema` has no quota reason.

import {
  z,
  CoreError,
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
} from "../core/index.ts";
import type { ScopedTenantContext } from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { wifiSpeedTierSchema } from "../facility/schemas.ts";

/** Same cap as `wifiRequestSchema.walledGarden`. */
export const WIFI_WALLED_GARDEN_MAX_HOSTS = 100;
const maxKbps = 1_000_000;

/** The id the controller knows the device by (a MAC in practice). Personal
 * data: it lives only on the edge while a grant is live. */
export const controllerDeviceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9:._-]+$/, "Invalid controller device id");

/** Canonical form used for hashing and comparing: trimmed and lowercase. */
export function normalizeControllerDeviceId(id: string): string {
  return controllerDeviceIdSchema.parse(id).toLowerCase();
}

/** Why a grant ended. No quota reason: running out of quota never ends a grant. */
export const wifiEndReasonSchema = z.enum([
  "session_ended",
  "staff_revoked",
  "device_moved",
  "day_closed",
]);
export type WifiEndReason = z.infer<typeof wifiEndReasonSchema>;

export const wifiGrantStatusSchema = z.enum([
  "pending",
  "active",
  "unknown",
  "superseded",
  "revoked",
  "failed",
]);
export type WifiGrantStatus = z.infer<typeof wifiGrantStatusSchema>;

const kbps = z.number().int().min(1).max(maxKbps);

/** kmd3 -> agent. The tenant comes from the context, never from the input. */
export const applyWifiSessionInputSchema = z
  .strictObject({
    outletId: outletIdSchema,
    wifiSessionId: uuidSchema,
    controllerDeviceId: controllerDeviceIdSchema,
    speedTier: wifiSpeedTierSchema,
    fullSpeedKbps: kbps,
    baseSpeedKbps: kbps,
    /** 0 means the quota is spent: grant base speed. */
    remainingSeconds: z.number().int().min(0).max(86_400),
    sessionEndsAt: isoDateTimeSchema,
  })
  .refine((v) => v.fullSpeedKbps > v.baseSpeedKbps, {
    path: ["fullSpeedKbps"],
    message: "Full speed must be higher than base speed",
  });
export type ApplyWifiSessionInput = z.infer<typeof applyWifiSessionInputSchema>;

/** What staff and the portal may see of a grant. `deviceTag` is the first 8 hex
 * of the device hash: enough to tell devices apart, not the MAC. */
export const wifiGrantViewSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  wifiSessionId: uuidSchema,
  deviceTag: z.string().regex(/^[0-9a-f]{8}$/),
  speedTier: wifiSpeedTierSchema,
  bandwidthKbps: kbps,
  status: wifiGrantStatusSchema,
  authorizedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  endedAt: isoDateTimeSchema.nullable(),
  endReason: wifiEndReasonSchema.nullable(),
});
export type WifiGrantView = z.infer<typeof wifiGrantViewSchema>;

export const wifiWalledGardenViewSchema = z.strictObject({
  hosts: z.array(z.string().min(1).max(253)).max(WIFI_WALLED_GARDEN_MAX_HOSTS),
  /** sha256 hex of the sorted host list: changes when the list changes. */
  version: z.string().regex(/^[0-9a-f]{64}$/),
});
export type WifiWalledGardenView = z.infer<typeof wifiWalledGardenViewSchema>;

// ---- Endpoints (edge only; tenant and outlet come from the node identity) ----

const emptyObject = z.strictObject({});
export const edgeWifiSessionParams = z.strictObject({
  wifiSessionId: uuidSchema,
});

/** Live grants of the node's outlet. */
export const listEdgeWifiGrants = defineEndpoint({
  method: "GET",
  path: "/api/edge/wifi/grants",
  query: emptyObject,
  response: dataResponseSchema(z.array(wifiGrantViewSchema).max(500)),
});

/** Staff cut a session; answers the grants of that session. */
export const revokeEdgeWifiSession = defineEndpoint({
  method: "POST",
  path: "/api/edge/wifi/sessions/:wifiSessionId/revoke",
  params: edgeWifiSessionParams,
  body: emptyObject,
  response: dataResponseSchema(z.array(wifiGrantViewSchema).max(500)),
});

/** For manual controller provisioning when the vendor has no API. */
export const getEdgeWifiWalledGarden = defineEndpoint({
  method: "GET",
  path: "/api/edge/wifi/walled-garden",
  response: dataResponseSchema(wifiWalledGardenViewSchema),
});

// ---- Walled garden (FAC-11) --------------------------------------------------

/** Payment hosts a guest must reach before Wi-Fi login. The dpc field test
 * confirms extra hosts (QRIS image, bank 3DS pages). */
export const PAYMENT_WALLED_GARDEN_HOSTS = {
  doit: ["pay.doit.id"],
} as const satisfies Record<string, readonly string[]>;

export type WifiWalledGardenErrorReason =
  "WIFI_WALLED_GARDEN_TOO_LARGE" | "WIFI_WALLED_GARDEN_HOST_INVALID";

export class WifiWalledGardenError extends CoreError {
  readonly reason: WifiWalledGardenErrorReason;
  constructor(reason: WifiWalledGardenErrorReason, message: string) {
    super("VALIDATION_ERROR", message);
    this.name = "WifiWalledGardenError";
    this.reason = reason;
  }
}

const hostLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const hostPattern = new RegExp(`^(?:\\*\\.)?${hostLabel}(?:\\.${hostLabel})*$`);

/** Lowercase, drop one trailing dot, then accept only a bare host (or `*.` +
 * host). A scheme, port, path, userinfo, query or space is refused. */
export function normalizeWalledGardenHost(raw: string): string {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host.length > 253 || !hostPattern.test(host))
    throw new WifiWalledGardenError(
      "WIFI_WALLED_GARDEN_HOST_INVALID",
      "Host walled garden tidak valid.",
    );
  return host;
}

export type WalledGardenSources = {
  orderingHosts?: readonly string[];
  paymentHosts?: readonly string[];
  portalHosts?: readonly string[];
  extraHosts?: readonly string[];
};

/** The pre-auth allowlist: every source merged, normalized, deduplicated and
 * sorted. Throws above 100 hosts (the `wifiRequestSchema` cap). */
export function buildWalledGarden(sources: WalledGardenSources): string[] {
  const hosts = new Set<string>();
  for (const list of [
    sources.orderingHosts,
    sources.paymentHosts,
    sources.portalHosts,
    sources.extraHosts,
  ])
    for (const raw of list ?? []) hosts.add(normalizeWalledGardenHost(raw));
  if (hosts.size > WIFI_WALLED_GARDEN_MAX_HOSTS)
    throw new WifiWalledGardenError(
      "WIFI_WALLED_GARDEN_TOO_LARGE",
      "Daftar walled garden melebihi 100 host.",
    );
  return [...hosts].sort();
}

/** Optional capability: adapters that can set the pre-auth allowlist at the
 * controller. Others rely on manual provisioning from the walled-garden
 * endpoint. */
export type WifiWalledGardenSync = {
  syncWalledGarden(
    context: ScopedTenantContext,
    hosts: readonly string[],
  ): Promise<void>;
};

export function supportsWalledGardenSync<T extends object>(
  provider: T,
): provider is T & WifiWalledGardenSync {
  return (
    "syncWalledGarden" in provider &&
    typeof (provider as { syncWalledGarden: unknown }).syncWalledGarden ===
      "function"
  );
}

/** The controller did not answer (transport failure). The agent records the
 * grant as `unknown`, never as failed: it may or may not have been applied. */
export class WifiProviderError extends Error {
  readonly code: "WIFI_PROVIDER_TIMEOUT" | "WIFI_PROVIDER_UNAVAILABLE";
  constructor(code: WifiProviderError["code"], message?: string) {
    super(message ?? code);
    this.name = "WifiProviderError";
    this.code = code;
  }
}
