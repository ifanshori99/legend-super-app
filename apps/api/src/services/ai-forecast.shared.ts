// Shared helpers of the AI insight read services (WS-12 wave 3, AI-07/08/13).
import type { ScopedTenantContext } from "@starter/shared/core";
import type { PermissionCode } from "@starter/shared/access";
import { HttpError } from "../lib/http-error.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";

const MS_PER_DAY = 86_400_000;

/**
 * The outlet-scoped context for the first permission the caller holds at
 * `outletId` (the server-minted outlet reach is what RLS sees, TEN-03).
 * Anything else is a 403: an outlet the caller cannot reach reads as denied.
 */
export function requireOutletContext(
  access: AccessSnapshot,
  permissions: readonly PermissionCode[],
  outletId: string,
): ScopedTenantContext {
  for (const permission of permissions) {
    if (!access.allows(permission, { type: "outlet", id: outletId })) continue;
    const context = access.contextFor(permission, {
      type: "outlet",
      id: outletId,
    });
    if (context) return context;
  }
  throw new HttpError(
    403,
    "FORBIDDEN",
    "Your account cannot perform this action at this outlet.",
  );
}

/** Adds whole days to a YYYY-MM-DD date (UTC, so DST-free). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/** 0 = Sunday .. 6 = Saturday of a YYYY-MM-DD date. */
export function weekdayOf(date: string): number {
  return new Date(Date.parse(date)).getUTCDay();
}
