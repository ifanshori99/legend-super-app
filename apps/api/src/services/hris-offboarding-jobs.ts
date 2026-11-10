// Scheduled exit clearance (bead legend-arj.6, tier K access): the worker relay
// sweep calls `runScheduledExitClearance` every minute per active tenant, and
// it revokes access of every open offboarding whose last working day has
// passed, without an HR user pressing the button (PRD F24). Decisions:
// docs/DECISIONS.md "WS-10 lifecycle" §2.
//
// - Due rule: the employee's home outlet local day is AFTER `last_working_date`
//   (same rule as the HTTP route; the route re-checks it under the tenant lock,
//   so a race answers EXIT_NOT_DUE and lands in `skipped`).
// - Each employee runs in its own transaction as the system actor
//   (`revokeOffboardingAccessAsSystem`, `canAssignRoles=false`): an Owner or a
//   leaver with a tenant-scoped role rolls back, is reported in `failed` and
//   stays open for HR. One failing employee never stops the others.
// - No day marker: an exit can become due at any time of day (HR files an exit
//   whose last day is already past, moves the last day earlier, or the outlet
//   is in a zone west of Jakarta), so every tick rescans. The scan is one
//   cheap query and revoking is idempotent by itself.
// - A blocked exit (Owner, tenant-scoped role) is retried at most once per
//   Jakarta day per process, so it neither logs nor takes the tenant role lock
//   every minute until HR acts.
// - Logs carry the offboarding id and the error code only (no PII).

import { and, asc, eq, isNull } from "drizzle-orm";
import {
  DEFAULT_TIME_ZONE,
  localDateOf,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import { hrisOffboardings } from "../db/schema/hris-lifecycle.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { revokeOffboardingAccessAsSystem } from "./hris-offboarding.service.ts";

export type ScheduledExitClearanceResult = {
  ran: boolean;
  date: string;
  revoked: string[];
  skipped: { offboardingId: string; code: string }[];
  failed: { offboardingId: string; code: string }[];
};

/** Blocked exits already tried today: `tenant:offboarding` -> Jakarta day. */
const blockedToday = new Map<string, string>();
const BLOCKED_CODES = new Set(["OFFBOARDING_OWNER", "OFFBOARDING_ADMIN_ROLE"]);

/** Open, not yet revoked offboardings whose last working day has passed. */
async function dueOffboardingIds(
  context: ScopedTenantContext,
  now: Date,
): Promise<string[]> {
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({
        id: hrisOffboardings.id,
        lastWorkingDate: hrisOffboardings.lastWorkingDate,
        timeZone: outlets.timezone,
      })
      .from(hrisOffboardings)
      .innerJoin(
        employees,
        and(
          eq(employees.tenantId, hrisOffboardings.tenantId),
          eq(employees.id, hrisOffboardings.employeeId),
        ),
      )
      .leftJoin(
        outlets,
        and(
          eq(outlets.tenantId, employees.tenantId),
          eq(outlets.id, employees.homeOutletId),
        ),
      )
      .where(
        and(
          eq(hrisOffboardings.tenantId, context.tenant.tenantId),
          eq(hrisOffboardings.status, "open"),
          isNull(hrisOffboardings.accessRevokedAt),
        ),
      )
      .orderBy(asc(hrisOffboardings.id)),
  );
  return rows
    .filter(
      (row) =>
        row.lastWorkingDate <
        localDateOf(now, row.timeZone ?? DEFAULT_TIME_ZONE),
    )
    .map((row) => row.id);
}

export async function runScheduledExitClearance(
  context: ScopedTenantContext,
  now = new Date(),
): Promise<ScheduledExitClearanceResult> {
  const today = localDateOf(now, DEFAULT_TIME_ZONE);
  const result: ScheduledExitClearanceResult = {
    ran: false,
    date: today,
    revoked: [],
    skipped: [],
    failed: [],
  };
  result.ran = true;

  for (const offboardingId of await dueOffboardingIds(context, now)) {
    const blockedKey = `${context.tenant.tenantId}:${offboardingId}`;
    if (blockedToday.get(blockedKey) === today) continue;
    try {
      await revokeOffboardingAccessAsSystem(context, offboardingId);
      blockedToday.delete(blockedKey);
      result.revoked.push(offboardingId);
    } catch (error) {
      const code = error instanceof HttpError ? error.code : "UNEXPECTED";
      if (code === "EXIT_NOT_DUE") {
        result.skipped.push({ offboardingId, code });
      } else {
        result.failed.push({ offboardingId, code });
        if (BLOCKED_CODES.has(code)) blockedToday.set(blockedKey, today);
        logger.warn({ offboardingId, code }, "scheduled exit clearance failed");
      }
    }
  }
  return result;
}
