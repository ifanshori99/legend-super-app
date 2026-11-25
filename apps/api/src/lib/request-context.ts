import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { DeviceTokenPayload } from "@starter/shared/platform";
import { isEdgeNode } from "../edge/mode.ts";

// Set by the support-session guard (legend-6yfhc) when the request runs on an
// impersonated session under an active support access grant.
export type RequestSupport = {
  tenantId: string;
  grantId: string;
  impersonatorUserId: string;
  impersonatedUserId: string;
  accessMode: "read_only" | "read_write";
  reason: string;
  // legend-hqjde: true when the request method can change data. withTenant
  // then locks and re-checks the grant inside the mutation's own transaction,
  // so a revoke answered 200 is never followed by a late support write.
  mutation?: boolean;
};

// Set by the acting-staff middleware (middleware/acting-staff.ts) when a POS
// request carries a valid X-Acting-Staff token: the staff member who is the
// actor, on the login session of `sessionUserId`.
export type RequestActingStaff = {
  staffUserId: string;
  sessionUserId: string;
  tokenId: string;
};

/** `session.auth_method` of a staff PIN login on an outlet edge (E2, brief 1269). */
export const EDGE_STAFF_PIN = "edge_staff_pin";

// Set on an edge once the request's device token matched its stored digest
// (services/edge-device-auth.ts); lib/device-token.ts answers from it.
export type RequestEdgeDevice = {
  readonly token: string;
  readonly payload: DeviceTokenPayload;
};

type RequestContext = {
  reqId: string;
  userId?: string;
  support?: RequestSupport;
  // legend-k2l: how the authenticated session signed in (session.auth_method).
  authMethod?: string;
  actingStaff?: RequestActingStaff;
  edgeDevice?: RequestEdgeDevice;
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

// legend-k2l (design ws08 M2 "Sign-in method gate"): recorded by requireAuth.
export function setRequestAuthMethod(authMethod: string) {
  const store = storage.getStore();
  if (store) store.authMethod = authMethod;
}

export function setRequestEdgeDevice(value: RequestEdgeDevice) {
  const store = storage.getStore();
  if (store) store.edgeDevice = value;
}

export function getRequestEdgeDevice(): RequestEdgeDevice | undefined {
  return storage.getStore()?.edgeDevice;
}

/** Runs `run` with this device verified (WebSocket upgrades have no request context). */
export function runWithEdgeDevice<T>(
  value: RequestEdgeDevice | undefined,
  run: () => T,
): T {
  const store = storage.getStore();
  return storage.run(
    { ...(store ?? { reqId: randomUUID() }), edgeDevice: value },
    run,
  );
}

/**
 * E2 (brief 1269): true when `userId` acts on this request through an
 * `edge_staff_pin` session: the session's user, or the acting cashier on it.
 * Their role permissions are then cut to the edge list (permission-resolver).
 */
export function requestIsEdgeStaffPin(userId: string): boolean {
  const store = storage.getStore();
  if (store?.authMethod !== EDGE_STAFF_PIN) return false;
  const id = userId.toLowerCase();
  return (
    store.userId?.toLowerCase() === id ||
    store.actingStaff?.staffUserId.toLowerCase() === id
  );
}

/**
 * legend-k2l: may this request act on `userId`'s staff role assignments?
 * Only a password sign-in may (design ws08 M2). A session opened by WhatsApp,
 * an email magic link, Google or a pre-0204 `legacy` session is customer-only,
 * so a staff person using the member app never carries staff access. Applies
 * only to the authenticated caller's own access on an HTTP request: workers
 * (no request context) and lookups of another user's access are unchanged.
 * On an edge node an `edge_staff_pin` session may as well (E2, brief 1269).
 */
export function requestMayUseStaffRoles(userId: string): boolean {
  const store = storage.getStore();
  if (!store || store.userId !== userId || store.authMethod === undefined)
    return true;
  return (
    store.authMethod === "password" ||
    (store.authMethod === EDGE_STAFF_PIN && isEdgeNode())
  );
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

/**
 * legend-hqjde: runs `run` with the grant lock in withTenant switched off for
 * this request. Only for the audit row of a refused support request
 * (platform-access-audit.service.ts): it records a denial, not a support
 * write, and may name another tenant than the grant's. The support attribution
 * stays, so recordAudit still names the real actor.
 */
export function withoutSupportGrantLock<T>(run: () => T): T {
  const store = storage.getStore();
  if (!store?.support?.mutation) return run();
  return storage.run(
    { ...store, support: { ...store.support, mutation: false } },
    run,
  );
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
