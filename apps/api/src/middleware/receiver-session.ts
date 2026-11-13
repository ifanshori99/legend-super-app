// Guard of the emergency receiver routes (bead legend-bod; design
// docs/design/edge-emergency.md D-03): the `legend_emergency` cookie names a
// live receiver session that still qualifies (device, PIN generation, staff,
// permission, duty). No Better Auth session and no tenant context are needed:
// the tenant comes from the cookie prefix. Mount after `requireTrustedOrigin`
// on every cookie-authenticated write.
import type { Request, RequestHandler } from "express";
import { HttpError } from "../lib/http-error";
import {
  authenticateReceiverSession,
  type ReceiverSession,
} from "../services/panic-receiver-session";

const sessions = new WeakMap<Request, ReceiverSession>();

/** Answers 401 RECEIVER_SESSION_INVALID unless the cookie holds a live, qualifying session. */
export const requireReceiverSession: RequestHandler = async (
  req,
  res,
  next,
) => {
  const session = await authenticateReceiverSession(req.get("cookie"));
  if (session === null)
    throw new HttpError(
      401,
      "RECEIVER_SESSION_INVALID",
      "Sesi darurat tidak berlaku. Masuk dengan PIN lagi.",
    );
  sessions.set(req, session);
  res.setHeader("Cache-Control", "private, no-store");
  next();
};

/** The session `requireReceiverSession` verified for this request. */
export function getReceiverSession(req: Request): ReceiverSession {
  const session = sessions.get(req);
  if (!session)
    throw new Error("getReceiverSession() used without requireReceiverSession");
  return session;
}
