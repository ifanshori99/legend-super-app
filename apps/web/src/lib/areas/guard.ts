// Area guard decision (PRD v1.7 §3 F3, AUTH-05, RBAC §3.7). Pure, so it is
// tested without a router. Same order as `authorize()` in
// @starter/shared/access: no session, then second factor, then permission.
import { isMfaGuardedSurface } from "@starter/shared/access";
import type { PermissionCode } from "@starter/shared/access";
import { isSharedDeviceScreenAllowed } from "@starter/shared/access/shared-device-screens";
import type { AreaAccess } from "./access.ts";
import {
  AREA_LIST,
  type AreaDefinition,
  type AreaGuard,
} from "./definitions.ts";

export type AreaGate =
  | { readonly status: "allowed" }
  | { readonly status: "unauthenticated" }
  /** AUTH-05: back office / dashboard need a verified second factor. */
  | { readonly status: "mfa_required" }
  | { readonly status: "forbidden" };

export function holdsAny(
  access: AreaAccess,
  anyOf: readonly PermissionCode[],
): boolean {
  return anyOf.some((code) => access.permissions.includes(code));
}

export function evaluateGuard(guard: AreaGuard, access: AreaAccess): AreaGate {
  if (guard.kind === "none") return { status: "allowed" };
  if (!access.authenticated) return { status: "unauthenticated" };
  if (guard.kind === "session") return { status: "allowed" };
  if (
    isMfaGuardedSurface(guard.surface) &&
    access.mfaRequired &&
    !access.mfaVerified
  )
    return { status: "mfa_required" };
  return holdsAny(access, guard.anyOf)
    ? { status: "allowed" }
    : { status: "forbidden" };
}

export function evaluateArea(
  area: AreaDefinition,
  access: AreaAccess,
): AreaGate {
  return evaluateGuard(area.guard, access);
}

/** Areas a visitor can open, excluding open ones (public, customer). */
export function reachableWorkAreas(access: AreaAccess): AreaDefinition[] {
  return AREA_LIST.filter(
    (area) =>
      area.guard.kind === "permission" &&
      evaluateArea(area, access).status === "allowed" &&
      // Shared tablet (founder Q29): areas whose landing page is closed are hidden.
      !isScreenClosedOnSharedDevice(access, area.indexPath),
  );
}

/**
 * Founder Q29: on a shared tablet (`access.sharedDevice`) every screen outside
 * the allowlist is closed, in every area. The root route answers "not found"
 * for it, on the server and in the browser. Presentation only: the API refuses
 * the matching requests (`SHARED_DEVICE_SCREEN_CLOSED`).
 */
export function isScreenClosedOnSharedDevice(
  access: AreaAccess,
  pathname: string,
): boolean {
  return access.sharedDevice === true && !isSharedDeviceScreenAllowed(pathname);
}
