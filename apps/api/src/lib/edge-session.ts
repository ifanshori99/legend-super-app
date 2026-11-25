// Which sessions this process accepts (E2, brief 1269). The cloud refuses an
// `edge_staff_pin` session; an edge node accepts nothing else, and only on a
// request that carries the verified token of the device the session is bound
// to (services/edge-device-auth.ts), judged by the edge's trusted clock.
// Everything that resolves a session for a request asks here.
import { EDGE_STAFF_SESSION_PERMISSIONS } from "@starter/shared/edge";
import {
  catalogOverrideNow,
  isCatalogOverrideClockReady,
} from "../edge/catalog-override.ts";
import { isEdgeNode } from "../edge/mode.ts";
import {
  EDGE_STAFF_PIN,
  getRequestEdgeDevice,
  type RequestEdgeDevice,
} from "./request-context.ts";

export type SessionOrigin = {
  readonly authMethod?: string | null;
  readonly edgeDeviceId?: string | null;
  readonly expiresAt: Date;
};

/**
 * The session may be read here: right kind for this process and, on an edge,
 * not past its end by the trusted clock. Not an authorization: see
 * `sessionAcceptedHere`.
 */
export function sessionReadableHere(session: SessionOrigin): boolean {
  const edgePin = session.authMethod === EDGE_STAFF_PIN;
  if (!isEdgeNode()) return !edgePin;
  return (
    edgePin &&
    isCatalogOverrideClockReady() &&
    session.expiresAt.getTime() > catalogOverrideNow().getTime()
  );
}

/** The session may authenticate a request that carries `device`'s verified token. */
export function sessionAcceptedHere(
  session: SessionOrigin,
  device: RequestEdgeDevice | undefined = getRequestEdgeDevice(),
): boolean {
  if (!sessionReadableHere(session)) return false;
  if (!isEdgeNode()) return true;
  return (
    typeof session.edgeDeviceId === "string" &&
    device !== undefined &&
    session.edgeDeviceId.toLowerCase() === device.payload.deviceId.toLowerCase()
  );
}

const edgePermissions: ReadonlySet<string> = new Set(
  EDGE_STAFF_SESSION_PERMISSIONS,
);

/** Deny by default: only the listed operational codes survive. */
export function edgeSessionPermissions<T extends string>(
  permissions: readonly T[],
): T[] {
  return permissions.filter((code) => edgePermissions.has(code));
}
