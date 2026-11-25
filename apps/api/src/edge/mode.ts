// EDGE_MODE route split (bead legend-2pi; PRD v1.7 §3 F5 "Server Lokal": the
// edge runs "image Docker yang sama dengan cloud dalam mode edge: API
// operasional, PostgreSQL lokal, WebSocket, dan print agent"; §5 site map
// "Dilayani edge node").
//
// One image, two roles, deny by default on the edge:
//   - On the edge only the operational API prefixes below are served. Every
//     other /api path (platform panel, tenant administration, back office,
//     provider webhooks, public website, payment links) answers 404
//     CLOUD_ONLY_ROUTE: those need the cloud's full data and the internet,
//     and master data is owned by the cloud (§3 F5 "Pembagian Sumber
//     Kebenaran"). Extend EDGE_API_PREFIXES when an operational module
//     (POS, KDS, print, attendance, Wi-Fi, lock agents) lands its routes.
//   - On the cloud the edge-only prefix /api/edge (status, local print and
//     device panels, contract @starter/shared/edge) answers 404
//     EDGE_ONLY_ROUTE. The cloud's edge registry is /api/edge-nodes and the
//     link upgrade is /api/edge-link (WebSocket, link-server.ts); both are
//     cloud only.
//
// Web routes on the edge (PRD gap, decided here): the edge runs the SAME web
// build as the cloud — the TanStack Start server (`apps/web` production
// build) in its own container with EDGE_MODE=true, VITE_API_URL /
// API_INTERNAL_URL pointing at the edge API on the operational VLAN — behind
// the edge's local reverse proxy (Caddy, provisioning bead legend-16s). The
// proxy forwards only EDGE_WEB_PREFIXES (plus the build's static assets
// under /assets and /_build) to the web server and /api/* to the edge API;
// every other path answers 404 on the edge. Nothing is rendered from the
// internet, so /pos, /kds, /expo, /pickup, /fasilitas, /operasional and
// /wifi keep working offline; /wifi is served `no-store` (§5 site map).
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { RequestHandler } from "express";
import { env } from "../config/env.ts";
import { HttpError } from "../lib/http-error.ts";

let readEdgeMode: () => boolean = () => env.EDGE_MODE;

/**
 * Whether this process is an edge node (`env.EDGE_MODE`). Read per call and
 * process wide (API server and worker both get the env), unlike the in-memory
 * edge runtime state which only the API server process installs.
 */
export function isEdgeNode(): boolean {
  return readEdgeMode();
}

/** Test seam: override how edge mode is read (null restores `env.EDGE_MODE`). */
export function setEdgeNodeForTests(fn: (() => boolean) | null): void {
  readEdgeMode = fn ?? (() => env.EDGE_MODE);
}

/** Web paths the edge serves (PRD §5 site map, "Dilayani edge node"). */
export const EDGE_WEB_PREFIXES = [
  "/pos",
  "/kds",
  "/expo",
  "/pickup",
  "/fasilitas",
  "/operasional",
  "/wifi",
] as const;

/**
 * API paths served on the edge. Deny by default for everything else.
 *
 * Each entry matches on whole segments: the path itself or anything below
 * it. A `:name` segment matches exactly one non-empty segment (an id).
 * Entries are as narrow as the edge needs (legend-zinn): a broad prefix such
 * as `/api/auth` or `/api/outlets` would serve Better Auth sign-up, its admin
 * plugin and every outlet back-office router against the LOCAL replica, and
 * writes there never sync to the cloud.
 */
export const EDGE_API_PREFIXES = [
  "/api/health",
  "/api/edge",
  // Staff sign in with a PIN (`/api/edge/staff-session`, E2 brief 1269). Only
  // sign-out, the session read and the caller's identity: password sign-in,
  // sign-up, device sessions, the Better Auth admin plugin (/api/auth/admin/*),
  // magic links, Google, WhatsApp/email login challenges and MFA need the cloud
  // (legend-zinn).
  "/api/auth/sign-out",
  "/api/auth/get-session",
  "/api/auth/me",
  "/api/me",
  "/api/staff-pins",
  "/api/pos-overrides",
  // Floor and table sessions for captain order (§4 Alur F step 3).
  "/api/floor",
  // Only the operational outlet routers: POS orders, the floor plan
  // (legend-zinn), and the kitchen trio (legend-64i1): KDS (tickets, feeds
  // and its realtime WebSocket under /kitchen), expo, and the pickup display
  // with its call/picked-up actions. There is no order-issues router yet; add
  // its subpath here when it lands.
  "/api/outlets/:outletId/pos",
  "/api/outlets/:outletId/floor",
  "/api/outlets/:outletId/kitchen",
  "/api/outlets/:outletId/expo",
  "/api/outlets/:outletId/pickup-display",
  "/api/outlets/:outletId/pickup-calls",
  "/api/tables",
  "/api/table-sessions",
  // Facility boards and access (FAC, offline smart lock via the edge).
  "/api/facility",
] as const;

/**
 * Method name that `guardEdgeUpgrades` gives to a WebSocket upgrade, so an
 * upgrade path is allowed on its own and never by a plain GET entry.
 */
const UPGRADE_METHOD = "UPGRADE";

/**
 * Single routes served on the edge, matched by HTTP method AND exact path
 * (case-insensitive path, repeated slashes collapsed, no sub-path; a `:name`
 * segment matches exactly one non-empty segment). Used where a whole prefix
 * would open too much: `/api/hris` and
 * `/api/storage` hold dozens of cloud-only routes (HR master data, QR secret
 * rotation, device binding, signed downloads), and writes there never sync to
 * the cloud (design docs/design/hris-edge-replication.md §9 T8).
 *
 * - `POST /api/hris/attendance/outlet-clock`: the outlet attendance screen
 *   (method `outlet_device`, one-time staff PIN proof, selfie; no session).
 * - `GET /api/hris/attendance/qr`: the outlet screen shows the rotating QR
 *   from the day keys the cloud sent (never the seed).
 * - `POST /api/storage/uploads`: the selfie upload. The `purpose` is in the
 *   body; the edge upload handler rejects every purpose except `selfie`.
 * - The emergency button (legend-bod, design edge-emergency.md D-11): press,
 *   receiver session open and end, acknowledge, the POS fallback read, and the
 *   socket upgrade (pseudo method `UPGRADE`, see UPGRADE_METHOD). Resolve and
 *   the manager list stay cloud only.
 */
export const EDGE_API_EXACT_ROUTES = [
  { method: "POST", path: "/api/hris/attendance/outlet-clock" },
  { method: "GET", path: "/api/hris/attendance/qr" },
  { method: "POST", path: "/api/storage/uploads" },
  { method: "POST", path: "/api/emergency/press" },
  { method: "POST", path: "/api/emergency/sessions" },
  { method: "DELETE", path: "/api/emergency/sessions/current" },
  { method: "POST", path: "/api/emergency/alerts/:alertId/ack" },
  { method: "GET", path: "/api/emergency/fallback" },
  { method: "GET", path: "/api/emergency/open-alerts" },
  { method: UPGRADE_METHOD, path: "/api/emergency/ws" },
] as const;

/** Prefixes served only by the edge node. */
export const EDGE_ONLY_API_PREFIXES = ["/api/edge"] as const;

export type ApiRouteClass = "edge_only" | "edge_and_cloud" | "cloud_only";

function matchesExactPath(path: string, pattern: string): boolean {
  const pathSegments = path.split("/");
  const patternSegments = pattern.split("/");
  return (
    pathSegments.length === patternSegments.length &&
    patternSegments.every((segment, index) => {
      const actual = pathSegments[index] ?? "";
      return segment.startsWith(":") ? actual.length > 0 : actual === segment;
    })
  );
}

function matchesPrefix(path: string, prefix: string): boolean {
  const pathSegments = path.split("/");
  const prefixSegments = prefix.split("/");
  if (pathSegments.length < prefixSegments.length) return false;
  return prefixSegments.every((segment, index) => {
    const actual = pathSegments[index] ?? "";
    return segment.startsWith(":") ? actual.length > 0 : actual === segment;
  });
}

/**
 * Classifies an absolute request path (no query string). `method` is needed
 * only for EDGE_API_EXACT_ROUTES: without it an exact route stays cloud only
 * (fail closed).
 */
export function classifyApiPath(path: string, method?: string): ApiRouteClass {
  const normalized = path.toLowerCase().replace(/\/{2,}/g, "/");
  if (normalized === "/api/edge/devices" && method?.toUpperCase() === "GET")
    return "edge_and_cloud";
  if (
    EDGE_ONLY_API_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix))
  )
    return "edge_only";
  if (EDGE_API_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix)))
    return "edge_and_cloud";
  if (
    method !== undefined &&
    EDGE_API_EXACT_ROUTES.some(
      (route) =>
        route.method === method.toUpperCase() &&
        matchesExactPath(normalized, route.path.toLowerCase()),
    )
  )
    return "edge_and_cloud";
  return "cloud_only";
}

export type RouteRefusal = {
  readonly status: 400 | 404;
  readonly code: "BAD_REQUEST_TARGET" | "CLOUD_ONLY_ROUTE" | "EDGE_ONLY_ROUTE";
  readonly message: string;
};

/**
 * The route split for one raw request target (`req.originalUrl` or an
 * upgrade request's `url`): null to serve it, otherwise the refusal. Shared
 * by the HTTP guard and the WebSocket upgrade guard, so both apply the same
 * rule (legend-zinn).
 */
export function edgeRouteRefusal(
  raw: string,
  options: { edgeMode: boolean; method?: string },
): RouteRefusal | null {
  // Only origin-form request targets ("/path"). An absolute-form target
  // ("http://host/api/...") would skip the prefix check below while the
  // router still resolves its pathname (review fix: guard bypass).
  if (!raw.startsWith("/"))
    return {
      status: 400,
      code: "BAD_REQUEST_TARGET",
      message: "Alamat permintaan tidak valid.",
    };
  const path = raw.split("?", 1)[0] ?? "";
  // Dot segments ("/../", "%2e%2e") and backslashes are resolved by WHATWG
  // URL parsing, which Better Auth (and ws upgrade handlers) apply to the
  // target, while the prefix check below reads it raw: an allowed prefix
  // followed by "/../admin" would reach a cloud-only route. A target that
  // URL parsing would rewrite is refused outright (legend-zinn).
  if (!isCanonicalPath(path))
    return {
      status: 400,
      code: "BAD_REQUEST_TARGET",
      message: "Alamat permintaan tidak valid.",
    };
  if (!path.toLowerCase().startsWith("/api")) return null;
  const routeClass = classifyApiPath(path, options.method);
  if (options.edgeMode && routeClass === "cloud_only")
    return {
      status: 404,
      code: "CLOUD_ONLY_ROUTE",
      message: "Layanan ini hanya tersedia di cloud.",
    };
  if (!options.edgeMode && routeClass === "edge_only")
    return {
      status: 404,
      code: "EDGE_ONLY_ROUTE",
      message: "Layanan ini hanya tersedia di edge node outlet.",
    };
  return null;
}

function isCanonicalPath(path: string): boolean {
  if (path.includes("\\")) return false;
  try {
    return new URL(path, "http://route-split.invalid").pathname === path;
  } catch {
    return false;
  }
}

/**
 * Mount once, before the API routers (and before Better Auth's catch-all so
 * /api/auth is covered by the same rule). Uses the original URL, so it works
 * at any mount point.
 */
export function edgeRouteGuard(options: { edgeMode: boolean }): RequestHandler {
  return (req, _res, next) => {
    const refusal = edgeRouteRefusal(req.originalUrl ?? req.url, {
      ...options,
      method: req.method,
    });
    if (refusal)
      throw new HttpError(refusal.status, refusal.code, refusal.message);
    next();
  };
}

const STATUS_TEXT = { 400: "Bad Request", 404: "Not Found" } as const;

/**
 * WebSocket upgrades never pass through Express, so edgeRouteGuard does not
 * see them: on the edge the notification stream (/api/notifications, cloud
 * only over HTTP) would still upgrade (legend-zinn). This applies the same
 * route split to every `upgrade` event of the server, whatever listener
 * handles it and whenever it was attached: a refused upgrade is answered and
 * destroyed before any listener runs.
 */
export function guardEdgeUpgrades(
  server: Server,
  options: { edgeMode: boolean },
): () => void {
  const emit = server.emit;
  const guarded = function (
    this: Server,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event === "upgrade") {
      const [request, socket] = args as [IncomingMessage, Duplex];
      const refusal = edgeRouteRefusal(request.url ?? "", {
        ...options,
        method: UPGRADE_METHOD,
      });
      if (refusal) {
        if (!socket.destroyed) {
          // Destroy once the refusal is flushed (as ws abortHandshake does).
          socket.once("finish", () => socket.destroy());
          socket.end(
            `HTTP/1.1 ${refusal.status} ${STATUS_TEXT[refusal.status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
        }
        return true;
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  } as Server["emit"];
  server.emit = guarded;
  return () => {
    if (server.emit === guarded) server.emit = emit;
  };
}
