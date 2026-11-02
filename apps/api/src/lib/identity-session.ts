// Handing a real Better Auth session to the browser that completed a WhatsApp
// challenge (PRD v1.7 §3 F6 "Pelanggan — WhatsApp Reverse OTP": "browser masuk
// otomatis"; AUTH-01 single use).
//
// Why not a Better Auth plugin endpoint: the sign-in routes of this bead sit
// under `/api/auth/login-challenges/*` next to Better Auth's own catch-all, but
// they need the Legend tenant context, the Legend error envelope
// (`{ error: { code, message } }`) and the same typed `{ data }` responses the
// web client already parses. Better Auth is still what mints and verifies the
// session: `auth.$context.internalAdapter.createSession` writes the row, and the
// cookie below is Better Auth's own signed-cookie format —
// `encodeURIComponent(token + "." + base64(HMAC-SHA256(secret, token)))` under
// the name and attributes `getCookies()` reports (better-call
// `serializeSignedCookie`). `identity-login.test.ts` proves the round trip by
// calling `GET /api/auth/get-session` with the cookie, so a format change in a
// future Better Auth upgrade fails that test instead of silently breaking login.

import { createHmac } from "node:crypto";
import type { Response } from "express";
import { getCookies } from "better-auth/cookies";
import { CUSTOMER_SESSION_DAYS, DAY_MS } from "@starter/shared/identity";
import { env } from "../config/env";
import { auth } from "./auth";

export type IssuedSession = {
  id: string;
  token: string;
  expiresAt: Date;
};

/**
 * Creates the server-side session §3 F6 asks for ("Sesi disimpan di server dan
 * dapat dicabut per perangkat"): a customer session lasts 90 days.
 *
 * `overrideAll` is true so the contract's TTL wins over Better Auth's default
 * session lifetime; nothing else is overridden.
 */
export async function createCustomerSession(input: {
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  now?: Date;
}): Promise<IssuedSession> {
  const context = await auth.$context;
  const expiresAt = new Date(
    (input.now ?? new Date()).getTime() + CUSTOMER_SESSION_DAYS * DAY_MS,
  );
  const session = await context.internalAdapter.createSession(
    input.userId,
    false,
    {
      expiresAt,
      ipAddress: input.ipAddress ?? "",
      userAgent: input.userAgent ?? "",
    },
    true,
  );
  if (!session) throw new Error("Better Auth refused to create a session");
  return {
    id: session.id,
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

/** Better Auth's signed session cookie, set on the response. */
export function setCustomerSessionCookie(
  res: Response,
  session: IssuedSession,
): void {
  const cookie = getCookies(auth.options).sessionToken;
  const signature = createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(session.token, "utf8")
    .digest("base64");
  // better-auth types sameSite capitalised and Express wants lowercase.
  const sameSite = cookie.attributes.sameSite.toLowerCase() as
    "lax" | "strict" | "none";
  res.cookie(cookie.name, `${session.token}.${signature}`, {
    httpOnly: cookie.attributes.httpOnly,
    sameSite,
    secure: cookie.attributes.secure,
    path: cookie.attributes.path,
    ...(cookie.attributes.domain ? { domain: cookie.attributes.domain } : {}),
    maxAge: Math.max(0, session.expiresAt.getTime() - new Date().getTime()),
  });
}
