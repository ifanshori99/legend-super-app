import type { AuthSession } from "../lib/auth";

declare global {
  namespace Express {
    interface Request {
      // Set by requireAuth after an authoritative Better Auth session lookup.
      auth?: AuthSession;
      // Visitor address from the authenticated SSR server (middleware/
      // ssr-visitor-ip.ts); never taken from a client-supplied header.
      ssrVisitorIp?: string;
    }
  }
}

export {};
