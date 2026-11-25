import { z } from "zod";

// Safe for the browser bundle. VITE_API_URL is inlined at build time, so a
// production image must be built with the API's public origin.
//
// Edge hosts (1269 E8) serve the web app and the API from one origin, so one
// build serves every outlet: build with VITE_API_URL=same-origin. The browser
// then calls the origin it was served from; the web server (SSR) calls
// API_INTERNAL_URL (loopback on the edge host).
export const SAME_ORIGIN = "same-origin";

const configured = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

function sameOriginApiUrl(): string {
  if (typeof window !== "undefined") return window.location.origin;
  const internal = globalThis.process?.env?.API_INTERNAL_URL;
  return z
    .url("Set API_INTERNAL_URL when VITE_API_URL is same-origin.")
    .parse(internal);
}

const apiUrl =
  configured === SAME_ORIGIN
    ? sameOriginApiUrl()
    : z
        .url(
          "Set VITE_API_URL to the API's origin, e.g. http://localhost:4000.",
        )
        .parse(configured);

// The API origin the browser calls (Better Auth + application routes).
export const API_URL = new URL(apiUrl).origin;

// A URL that is written into server-rendered HTML for the browser to follow.
// In a same-origin build SSR's API_URL is the loopback address of this server,
// which the browser must never see: the path stays relative to the page origin.
export function publicApiUrl(path: string): string {
  return configured === SAME_ORIGIN ? path : `${API_URL}${path}`;
}
