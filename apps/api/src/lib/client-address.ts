// The client address of a raw Node request (a WebSocket upgrade, which never
// passes through Express) resolved exactly like Express's `req.ip`: the app's
// `trust proxy` setting (TRUST_PROXY) decides how much of X-Forwarded-For is
// believed. Behind Caddy/Cloudflare the socket address is the proxy's, so a
// per-address limit keyed on it would put every client in one bucket
// (legend-wg5t review fix).
import type { IncomingMessage } from "node:http";
import type { Express } from "express";

export function expressClientAddress(
  app: Express,
): (request: IncomingMessage) => string {
  return (request) => {
    // A view of the raw request with Express's request prototype (which
    // carries `app`), so the `ip` getter applies the same trust function.
    const view = Object.create(app.request, {
      headers: { value: request.headers },
      socket: { value: request.socket },
      connection: { value: request.socket },
    }) as { ip?: string };
    return view.ip || request.socket.remoteAddress || "unknown";
  };
}
