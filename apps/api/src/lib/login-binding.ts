// The browser-binding nonce (AUTH-01: a WhatsApp login code is "terikat ke
// browser peminta"). The requesting browser gets a random nonce in an httpOnly
// cookie when it asks for a code; only its keyed digest is stored on the
// challenge. The KirimDev webhook completes the challenge from the phone side,
// so the binding is checked when the polling browser collects the session —
// another browser that learns the code (or the challenge id) gets nothing.
//
// The nonce is signed so a client cannot pin a value it chose: the cookie is
// `<nonce>.<base64url HMAC-SHA-256(nonce)>`, verified in constant time. It is
// deliberately reused for the browser's later attempts instead of rotating per
// challenge, because AUTH-04 counts "5 challenge aktif per perangkat" by it.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { siteConfig } from "@starter/shared/site";
import { env } from "../config/env";
import { browserBindingDigest, identityDigest } from "./identity-digest";

/**
 * legend-lgfru: one browser binding per flow. Each flow has its own cookie
 * name, path and HMAC labels, so a login cookie is never accepted as a
 * pin-reset binding (or the other way round). The login values are the
 * originals, so existing login cookies and stored digests stay valid.
 */
export type BindingCookieSpec = {
  /** Cookie name. */
  readonly name: string;
  /** Cookie path: the browser sends it to these endpoints only. */
  readonly path: string;
  /** Label of the cookie signature HMAC. */
  readonly signLabel: string;
  /** Label of the keyed digest stored on the challenge row. */
  readonly digestLabel: "browser-binding" | "pin-reset-binding";
};

/** `<app id>.login_binding`; scoped to the login endpoints only. */
export const LOGIN_BINDING: BindingCookieSpec = {
  name: `${siteConfig.id}.login_binding`,
  path: "/api/auth/login-challenges",
  signLabel: "login-binding",
  digestLabel: "browser-binding",
};

/** Payslip PIN reset through WhatsApp (design §6.1). */
export const PIN_RESET_BINDING: BindingCookieSpec = {
  name: `${siteConfig.id}.pin_reset_binding`,
  path: "/api/hris/me/payslip-pin/reset-wa",
  signLabel: "pin-reset-binding",
  digestLabel: "pin-reset-binding",
};

export const BINDING_COOKIE = LOGIN_BINDING.name;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function sign(nonce: string, spec: BindingCookieSpec): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`${spec.signLabel}\u0000${nonce}`, "utf8")
    .digest("base64url");
}

/** Reads one cookie value from the raw header; null when absent. */
function readCookie(req: Request, name: string): string | null {
  const header = req.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** The nonce this browser already holds, when the signature verifies. */
export function readBindingNonce(
  req: Request,
  spec: BindingCookieSpec = LOGIN_BINDING,
): string | null {
  const value = readCookie(req, spec.name);
  if (value === null) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const nonce = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!NONCE_PATTERN.test(nonce)) return null;
  const expected = Buffer.from(sign(nonce, spec), "utf8");
  const presented = Buffer.from(signature, "utf8");
  if (presented.length !== expected.length) return null;
  return timingSafeEqual(presented, expected) ? nonce : null;
}

/** Reuses the browser's nonce when present, otherwise mints a fresh one. */
export function ensureBindingNonce(
  req: Request,
  spec: BindingCookieSpec = LOGIN_BINDING,
): string {
  return readBindingNonce(req, spec) ?? randomBytes(32).toString("base64url");
}

/**
 * Sets (or refreshes) the binding cookie. It expires with the challenge plus a
 * minute of slack, so an abandoned attempt leaves nothing behind.
 */
export function setBindingCookie(
  res: Response,
  nonce: string,
  ttlSeconds: number,
  spec: BindingCookieSpec = LOGIN_BINDING,
): void {
  res.cookie(spec.name, `${nonce}.${sign(nonce, spec)}`, {
    httpOnly: true,
    sameSite: "lax",
    // Same rule Better Auth applies to its own cookies: `Secure` follows the
    // public scheme, not NODE_ENV, so a production build served over http in
    // tests still gets a cookie the browser will store.
    secure: new URL(env.BETTER_AUTH_URL).protocol === "https:",
    path: spec.path,
    maxAge: ttlSeconds * 1000,
  });
}

/** The keyed digest stored on the challenge row. */
export function bindingDigestOf(
  nonce: string,
  spec: BindingCookieSpec = LOGIN_BINDING,
): string {
  return spec.digestLabel === "browser-binding"
    ? browserBindingDigest(nonce)
    : identityDigest(spec.digestLabel, nonce);
}
