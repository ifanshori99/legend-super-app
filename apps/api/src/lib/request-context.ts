import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

// Set by the support-session guard (legend-6yfhc) when the request runs on an
// impersonated session under an active support access grant.
export type RequestSupport = {
  tenantId: string;
  grantId: string;
  impersonatorUserId: string;
  impersonatedUserId: string;
  accessMode: "read_only" | "read_write";
  reason: string;
};

// Set by the acting-staff middleware (middleware/acting-staff.ts) when a POS
// request carries a valid X-Acting-Staff token: the staff member who is the
// actor, on the login session of `sessionUserId`.
export type RequestActingStaff = {
  staffUserId: string;
  sessionUserId: string;
  tokenId: string;
};

type RequestContext = {
  reqId: string;
  userId?: string;
  support?: RequestSupport;
  actingStaff?: RequestActingStaff;
};

const storage = new AsyncLocalStorage<RequestContext>();

// Read by the logger's mixin, so every log line written while a request is in
// flight carries its reqId and, once authenticated, its userId. Services can
// log without receiving the request.
export function getRequestContext() {
  return storage.getStore();
}

export function setRequestUser(userId: string) {
  const store = storage.getStore();
  if (store) store.userId = userId;
}

export function setRequestSupport(value: RequestSupport) {
  const store = storage.getStore();
  if (store) store.support = value;
}

// Read by recordAudit so writes made through a support session are attributed
// to the platform admin, not the impersonated tenant user.
export function getRequestSupport() {
  return storage.getStore()?.support;
}

export function setRequestActingStaff(value: RequestActingStaff) {
  const store = storage.getStore();
  if (store) store.actingStaff = value;
}

// Read by recordAudit so a row written as the acting staff member also names
// the login session owner and the token (DECISIONS: kasir aktif per perangkat).
export function getRequestActingStaff() {
  return storage.getStore()?.actingStaff;
}

const SAFE_REQUEST_ID = /^[\w-]{1,128}$/;

// Reuse a well-formed X-Request-Id (the web server forwards its own, so one ID
// traces an SSR render through both servers); otherwise mint a new one.
export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id");
  const reqId =
    incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.id = reqId;
  res.setHeader("X-Request-Id", reqId);
  storage.run({ reqId }, next);
};
