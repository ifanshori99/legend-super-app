// Scheduled leave jobs (bead legend-arj.1, follow-up of legend-hggk): the
// worker relay sweep calls `runScheduledLeaveJobs` every minute per active
// tenant, and it does the monthly accrual, the year-end carry-over and the
// carry-over expiry without an HR user pressing a button (PRD F27).
//
// - Business date: the Asia/Jakarta local day (D-CORE-6), so a run at 00:30 WIB
//   belongs to the new day even though the UTC date is still the old one.
// - Order: collective-leave deductions run FIRST, so a collective day on 31 Dec
//   is already in the old year's `used` before carry-over computes `available`,
//   and a collective day before the carry-over expiry date counts as consumed
//   before expiry forfeits.
// - Marker: one `hris_idempotency` row keyed `leave-jobs/YYYY-MM-DD` per tenant
//   and local day, written in its own transaction only after all steps
//   succeeded. The `/` keeps it outside the user Idempotency-Key alphabet
//   (`[A-Za-z0-9._:-]`), so no user write can pre-claim a day's marker. It only stops the minute-by-minute rescan: the steps themselves
//   are idempotent through the `leave_accruals` ledger, so two workers racing,
//   or a retry after a partial failure, never grant twice. A failed step leaves
//   no marker and the next tick retries.
// - The steps run as the system actor (audit actorType system, ledger
//   createdBy null); the HTTP routes keep their HR permission check.

import { and, eq } from "drizzle-orm";
import {
  DEFAULT_TIME_ZONE,
  localDateOf,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { LeaveAccrualRunResult } from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { hrisIdempotency } from "../db/schema/hris.ts";
import { withTenant } from "../db/tenant.ts";
import { hrisRequestFingerprint } from "../lib/hris-pii.ts";
import {
  accrueLeave,
  carryOverLeave,
  expireCarryOverLeave,
} from "./hris-leave.service.ts";
import { applyCollectiveLeaveDeductions } from "./hris-leave-collective.service.ts";

const OPERATION = "leave_jobs.daily";
const SYSTEM = { type: "system" } as const;

export type ScheduledLeaveJobsResult =
  | { ran: false; date: string }
  | {
      ran: true;
      date: string;
      accrual: LeaveAccrualRunResult;
      carryOver: LeaveAccrualRunResult;
      expiry: LeaveAccrualRunResult;
      collective: LeaveAccrualRunResult;
    };

const markerKey = (date: string) => `leave-jobs/${date}`;

async function hasMarker(
  context: ScopedTenantContext,
  date: string,
): Promise<boolean> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ key: hrisIdempotency.key })
      .from(hrisIdempotency)
      .where(
        and(
          eq(hrisIdempotency.tenantId, context.tenant.tenantId),
          eq(hrisIdempotency.key, markerKey(date)),
        ),
      )
      .limit(1);
    return row !== undefined;
  });
}

export async function runScheduledLeaveJobs(
  context: ScopedTenantContext,
  now = new Date(),
): Promise<ScheduledLeaveJobsResult> {
  const today = localDateOf(now, DEFAULT_TIME_ZONE);
  if (await hasMarker(context, today)) return { ran: false, date: today };

  // Collective leave ("cuti bersama", founder decision Q7): past collective
  // holidays deduct the annual balance; idempotent through the same ledger.
  // First, so carry-over and expiry see those days as already used.
  const collective = await applyCollectiveLeaveDeductions(context, now, SYSTEM);
  const accrual = await accrueLeave(
    context,
    SYSTEM,
    { period: today.slice(0, 7) },
    now,
  );
  const carryOver = await carryOverLeave(
    context,
    SYSTEM,
    { fromYear: Number(today.slice(0, 4)) - 1 },
    now,
  );
  const expiry = await expireCarryOverLeave(
    context,
    SYSTEM,
    { asOf: today },
    now,
  );
  // Written last: any error above leaves no marker. A racing worker may
  // insert it first; that is fine (DO NOTHING), the steps were idempotent.
  await withTenant(db, context, (tx) =>
    tx
      .insert(hrisIdempotency)
      .values({
        tenantId: context.tenant.tenantId,
        key: markerKey(today),
        operation: OPERATION,
        fingerprint: hrisRequestFingerprint(context.tenant.tenantId, {
          operation: OPERATION,
          request: { date: today },
        }),
        response: { date: today, accrual, carryOver, expiry, collective },
      })
      .onConflictDoNothing({
        target: [hrisIdempotency.tenantId, hrisIdempotency.key],
      }),
  );
  return { ran: true, date: today, accrual, carryOver, expiry, collective };
}
