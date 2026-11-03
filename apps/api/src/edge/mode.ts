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
import type { RequestHandler } from "express";
import { HttpError } from "../lib/http-error.ts";

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

/** API prefixes served on the edge. Deny by default for everything else. */
export const EDGE_API_PREFIXES = [
  "/api/health",
  "/api/edge",
  // Staff sign-in and device sessions against the local replica (AUTH-06).
  "/api/auth",
  "/api/me",
  "/api/staff-pins",
  "/api/pos-overrides",
  // Floor and table sessions for captain order (§4 Alur F step 3).
  "/api/floor",
  "/api/outlets",
  "/api/tables",
  "/api/table-sessions",
  // Facility boards and access (FAC, offline smart lock via the edge).
  "/api/facility",
] as const;

/** Prefixes served only by the edge node. */
export const EDGE_ONLY_API_PREFIXES = ["/api/edge"] as const;

export type ApiRouteClass = "edge_only" | "edge_and_cloud" | "cloud_only";

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Classifies an absolute request path (no query string). */
export function classifyApiPath(path: string): ApiRouteClass {
  const normalized = path.toLowerCase().replace(/\/{2,}/g, "/");
  if (
    EDGE_ONLY_API_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix))
  )
    return "edge_only";
  if (EDGE_API_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix)))
    return "edge_and_cloud";
  return "cloud_only";
}

/**
 * Mount once, before the API routers (and before Better Auth's catch-all so
 * /api/auth is covered by the same rule). Uses the original URL, so it works
 * at any mount point.
 */
export function edgeRouteGuard(options: { edgeMode: boolean }): RequestHandler {
  return (req, _res, next) => {
    const raw = req.originalUrl ?? req.url;
    // Only origin-form request targets ("/path"). An absolute-form target
    // ("http://host/api/...") would skip the prefix check below while the
    // router still resolves its pathname (review fix: guard bypass).
    if (!raw.startsWith("/"))
      throw new HttpError(
        400,
        "BAD_REQUEST_TARGET",
        "Alamat permintaan tidak valid.",
      );
    const path = raw.split("?", 1)[0] ?? "";
    if (!path.toLowerCase().startsWith("/api")) return next();
    const routeClass = classifyApiPath(path);
    if (options.edgeMode && routeClass === "cloud_only")
      throw new HttpError(
        404,
        "CLOUD_ONLY_ROUTE",
        "Layanan ini hanya tersedia di cloud.",
      );
    if (!options.edgeMode && routeClass === "edge_only")
      throw new HttpError(
        404,
        "EDGE_ONLY_ROUTE",
        "Layanan ini hanya tersedia di edge node outlet.",
      );
    next();
  };
}
