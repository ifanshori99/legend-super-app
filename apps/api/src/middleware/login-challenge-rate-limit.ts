// HTTP rate limit for the public WhatsApp login-challenge endpoints (bead
// legend-fc0f2; AUTH-01/04). Found while reviewing the login audit trail
// (legend-wq3f): /api/auth/login-challenges is mounted before the public read
// limiter, so nothing bounded how often an anonymous client could call it.
// Every refused AUTH-04 request still opened a DB transaction, and (before the
// audit throttle) could append an audit row.
//
// This limiter runs BEFORE the tenant resolver and the router, so a flood is
// answered with 429 without touching the database. Buckets:
// - per client IP (`req.ip`, honoring TRUST_PROXY like the public limiter).
//   No address is exempt by default: unlike the public reads, the web server
//   never calls these endpoints (only browsers do), and a proxy on the same VM
//   with TRUST_PROXY unset makes every client look like loopback, which would
//   switch the limiter off for cookie-less floods. `internalIps` stays an
//   explicit opt-in for tests and unusual deployments;
// - per browser binding: the signed `login_binding` cookie, verified by
//   readBindingNonce, so a client cannot mint keys. Its key is the keyed digest
//   of the nonce, never the nonce. A request without a valid cookie is charged
//   to its IP only.
// Two classes: issuing a challenge (POST /whatsapp: DB writes, session lookup,
// advisory locks) gets a small budget; polling and cancelling (GET /:id,
// POST /:id/cancel: one read every few seconds per waiting browser) a larger one
// so a venue full of guests behind one NAT is not locked out. The AUTH-04
// rule (5 active challenges per device or IP in 15 minutes) is unchanged and
// stays in the service; this is the coarse per-minute guard in front of it.
//
// The store is in memory like the public limiter's: fixed windows, an LRU cap,
// bounded work per request. Several API instances each hold their own window.

import type { Request, RequestHandler } from "express";
import { clientIpKey } from "../lib/client-ip-key";
import { createFixedWindowCounter } from "../lib/fixed-window-counter";
import { browserBindingDigest } from "../lib/identity-digest";
import { readBindingNonce } from "../lib/login-binding";
import {
  clientIp,
  PUBLIC_RATE_LIMIT_CAPACITY,
  PUBLIC_RATE_LIMIT_WINDOW_MS,
  rejectRateLimited,
} from "./public-rate-limit";

/** Challenge issues (POST /whatsapp) per client IP per minute. */
export const LOGIN_ISSUE_PER_IP = 30;
/** Challenge issues per browser binding per minute (AUTH-04 allows 5 per 15). */
export const LOGIN_ISSUE_PER_BINDING = 10;
/** Polls and cancels per client IP per minute (a NAT full of waiting guests). */
export const LOGIN_POLL_PER_IP = 600;
/** Polls and cancels per browser binding per minute (one poll per 2 s is 30). */
export const LOGIN_POLL_PER_BINDING = 120;

export type LoginChallengeRateLimitOptions = {
  issuePerIp: number;
  issuePerBinding: number;
  pollPerIp: number;
  pollPerBinding: number;
  internalIps?: readonly string[];
  windowMs?: number;
  capacity?: number;
  /** Test seam; production uses the wall clock. */
  now?: () => number;
};

/**
 * Mounted on `/api/auth/login-challenges`, so `req.path` is relative to it.
 * Fails closed: every POST except the cancel route counts as an issue, so a
 * case variant of the path (Express 5 matches routes case-insensitively) or a
 * future issue route (`/email`, endpoints.ts) cannot fall into the larger poll
 * budget.
 */
function isIssue(req: Request): boolean {
  return req.method === "POST" && !/^\/[^/]+\/cancel\/?$/i.test(req.path);
}

export function loginChallengeRateLimit(
  options: Partial<LoginChallengeRateLimitOptions> = {},
): RequestHandler {
  const windowMs = options.windowMs ?? PUBLIC_RATE_LIMIT_WINDOW_MS;
  const capacity = options.capacity ?? PUBLIC_RATE_LIMIT_CAPACITY;
  const clock = options.now ?? Date.now;
  const internalIps = new Set(options.internalIps ?? []);
  const counter = (limit: number) =>
    createFixedWindowCounter({ limit, windowMs, capacity });
  const issueIp = counter(options.issuePerIp ?? LOGIN_ISSUE_PER_IP);
  const issueBinding = counter(
    options.issuePerBinding ?? LOGIN_ISSUE_PER_BINDING,
  );
  const pollIp = counter(options.pollPerIp ?? LOGIN_POLL_PER_IP);
  const pollBinding = counter(options.pollPerBinding ?? LOGIN_POLL_PER_BINDING);

  return (req, res, next) => {
    // Preflights carry no cookie and no side effect; never charge them.
    if (req.method === "OPTIONS") return next();
    const now = clock();
    const issue = isIssue(req);
    const ip = clientIp(req);
    const ipRetry = internalIps.has(ip)
      ? null
      : (issue ? issueIp : pollIp).take(`ip:${clientIpKey(ip)}`, now);
    // Both buckets are charged, so a client rotating cookies still spends its
    // IP bucket and one IP cannot spend another browser's binding bucket.
    const nonce = readBindingNonce(req);
    const bindingRetry =
      nonce === null
        ? null
        : (issue ? issueBinding : pollBinding).take(
            `binding:${browserBindingDigest(nonce)}`,
            now,
          );
    const retry = ipRetry ?? bindingRetry;
    if (retry !== null) rejectRateLimited(res, retry);
    next();
  };
}
