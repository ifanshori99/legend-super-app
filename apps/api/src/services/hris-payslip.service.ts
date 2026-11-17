// Employee payslips (bead legend-2ap3; PRD v1.7 §3 D.30 "Slip Gaji"; HR-01,
// HR-03). `/api/hris/me/payslips` lists the caller's own history without
// amounts; opening one needs the payslip PIN (services/payslip-pin.service.ts).
//
// Own employee only: someone else's payslip, another tenant's and a missing
// one all answer 404 before any PIN attempt is counted. The idempotency record
// stores only FAILED outcomes (invalid / locked / not_set), so a network retry
// of a miss does not burn a second attempt. A success is never stored: a retry
// runs a fresh PIN check and audit, so a stored success cannot open the salary
// after the PIN was changed or reset.
import { and, desc, eq, or, sql, lt } from "drizzle-orm";
import {
  CoreError,
  encodeCursor,
  idempotencyKeySchema,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  PayrollError,
  listMyPayslips as listMyPayslipsEndpoint,
  payslipCalculationSchema,
  payslipIdSchema,
  payslipSchema,
  type Payslip,
  type PayslipId,
  viewMyPayslip as viewMyPayslipEndpoint,
} from "@starter/shared/hris/payroll";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { hrisIdempotency } from "../db/schema/hris.ts";
import { payrollRuns, payslips } from "../db/schema/payroll.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  hrisFingerprintMatches,
  hrisRequestFingerprint,
} from "../lib/hris-pii.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { recordAudit } from "./core-audit.ts";
import { cursorPair, hrisAuditEntry, notFound } from "./hris-access.ts";
import {
  noHrisFileSigner,
  type HrisFileSigner,
} from "./hris-contract.service.ts";
import {
  PAYSLIP_PIN_AUDIT_SAFE_FIELDS,
  assertPinCheckOk,
  checkPayslipPin,
  lockPayslipPin,
  loadPayslipSelf,
  type PinCheck,
} from "./payslip-pin.service.ts";
import type { Tx } from "./permission-resolver.ts";

type ViewMyPayslipInput = z.infer<typeof viewMyPayslipEndpoint.body>;
type PageQuery = z.infer<typeof listMyPayslipsEndpoint.query>;
type PageResult = z.output<typeof listMyPayslipsEndpoint.response>;
type PayslipRow = typeof payslips.$inferSelect;
type ViewOutcome = PinCheck | { readonly kind: "not_set" };

/** GET /api/hris/me/payslips — own history, no amounts (HR-03). */
export async function listMyPayslips(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PageQuery,
): Promise<PageResult> {
  return withTenant(db, context, async (tx) => {
    const self = await loadPayslipSelf(tx, context, actorUserId);
    const filters = [
      eq(payslips.tenantId, context.tenant.tenantId),
      eq(payslips.employeeId, self.employeeId),
    ];
    if (query.cursor) {
      const [payDate, id] = cursorPair(query.cursor);
      const beforeId = payslipIdSchema.safeParse(id);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate) || !beforeId.success)
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          lt(payrollRuns.payDate, payDate),
          and(
            eq(payrollRuns.payDate, payDate),
            sql`${payslips.id} < ${beforeId.data}`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select({
        id: payslips.id,
        payrollRunId: payslips.payrollRunId,
        periodStart: payrollRuns.periodStart,
        periodEnd: payrollRuns.periodEnd,
        payDate: payrollRuns.payDate,
        viewedAt: payslips.viewedAt,
      })
      .from(payslips)
      .innerJoin(
        payrollRuns,
        and(
          eq(payrollRuns.tenantId, payslips.tenantId),
          eq(payrollRuns.id, payslips.payrollRunId),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(payrollRuns.payDate), desc(payslips.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return listMyPayslipsEndpoint.response.parse({
      data: page.map((row) => ({
        id: row.id,
        payrollRunId: row.payrollRunId,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        payDate: row.payDate,
        viewedAt: row.viewedAt?.toISOString() ?? null,
      })),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.payDate, last.id])
            : null,
      },
    });
  });
}

/** Opens the sealed calculation of one payslip row (no PIN check here). */
export function openPayslipCalculation(
  row: Pick<
    PayslipRow,
    "tenantId" | "id" | "calculationEncrypted" | "piiKeyVersion"
  >,
) {
  return payslipCalculationSchema.parse(
    JSON.parse(
      openPayrollValue(
        row.calculationEncrypted,
        {
          tenantId: row.tenantId,
          table: "payslips",
          rowId: row.id,
          field: "calculation",
        },
        row.piiKeyVersion,
      ),
    ),
  );
}

async function toPayslip(
  tx: Tx,
  context: ScopedTenantContext,
  row: PayslipRow,
  signer: HrisFileSigner,
): Promise<Payslip> {
  const calculation = openPayslipCalculation(row);
  // The PDF is a private storage object when its key is the object id; any
  // other key (not yet rendered / legacy path) yields no URL.
  const objectId = uuidSchema.safeParse(row.pdfObjectKey);
  const fileUrl = objectId.success
    ? await signer(context, objectId.data, tx)
    : null;
  return payslipSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    payrollRunId: row.payrollRunId,
    ...calculation,
    fileUrl,
    viewedAt: row.viewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Idempotent write that records only failed outcomes. A replay of a stored
 * failure answers it again without a new attempt; a success is returned
 * without a record, so the next call with the same key checks the PIN afresh.
 *
 * The guessed PIN is NOT part of the fingerprint (`request` carries none): a
 * replay compared on it would answer "stored outcome" for one guess and 409 for
 * any other, an oracle that costs no attempt (also while locked). A replay only
 * returns the stored outcome; every fresh key runs `run`, which counts the
 * attempt under the PIN row lock.
 */
async function idempotentFailureWrite(
  tx: Tx,
  context: ScopedTenantContext,
  key: string,
  operation: string,
  request: Record<string, unknown>,
  run: () => Promise<ViewOutcome>,
): Promise<ViewOutcome> {
  const parsedKey = idempotencyKeySchema.parse(key);
  const fingerprint = hrisRequestFingerprint(context.tenant.tenantId, {
    operation,
    request,
  });
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:idem:${context.tenant.tenantId}:${parsedKey}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(hrisIdempotency)
    .where(
      and(
        eq(hrisIdempotency.tenantId, context.tenant.tenantId),
        eq(hrisIdempotency.key, parsedKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.operation !== operation ||
      !hrisFingerprintMatches(
        context.tenant.tenantId,
        { operation, request },
        existing.fingerprint,
      )
    )
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key already used for a different request.",
      );
    return existing.response as ViewOutcome;
  }
  const outcome = await run();
  if (outcome.kind !== "ok")
    await tx.insert(hrisIdempotency).values({
      tenantId: context.tenant.tenantId,
      key: parsedKey,
      operation,
      fingerprint,
      response: outcome as object,
    });
  return outcome;
}

/**
 * POST /api/hris/me/payslips/:payslipId/view — opens one own payslip with the
 * PIN. A miss is counted and committed before the error is thrown.
 */
export async function viewMyPayslip(
  context: ScopedTenantContext,
  actorUserId: string,
  payslipId: PayslipId,
  input: ViewMyPayslipInput,
  signer: HrisFileSigner = noHrisFileSigner,
  nowOverride?: Date,
): Promise<Payslip> {
  const { idempotencyKey, pin } = input;
  const result = await withTenant(db, context, async (tx) => {
    const self = await loadPayslipSelf(
      tx,
      context,
      actorUserId,
      nowOverride ?? new Date(),
    );
    const [row] = await tx
      .select()
      .from(payslips)
      .where(
        and(
          eq(payslips.tenantId, context.tenant.tenantId),
          eq(payslips.id, payslipId),
          eq(payslips.employeeId, self.employeeId),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Slip gaji");
    const outcome = await idempotentFailureWrite(
      tx,
      context,
      idempotencyKey,
      "payslip.view",
      {
        actor: self.actor,
        employeeId: self.employeeId,
        payslipId: row.id,
      },
      async () => {
        const pinRow = await lockPayslipPin(
          tx,
          context.tenant.tenantId,
          self.employeeId,
        );
        // Clock read AFTER the lock (lock expiry, counters, viewedAt, audit).
        const now = nowOverride ?? new Date();
        if (!pinRow) return { kind: "not_set" };
        const check = await checkPayslipPin(
          tx,
          context,
          self,
          pinRow,
          pin,
          now,
        );
        if (check.kind !== "ok") return check;
        if (row.viewedAt === null)
          await tx
            .update(payslips)
            .set({ viewedAt: now })
            .where(
              and(
                eq(payslips.tenantId, context.tenant.tenantId),
                eq(payslips.id, row.id),
              ),
            );
        await recordAudit(
          tx,
          context,
          hrisAuditEntry(context, self.actor, now, {
            outletId: self.homeOutletId,
            action: "payslip.viewed",
            objectType: "payslip",
            objectId: row.id,
            // `payrollRunId` would be redacted (deny list: "payroll"); `runId` is the
            // same id under a name the audit masking keeps.
            after: { payslipId: row.id, runId: row.payrollRunId },
            sensitiveReason: "Karyawan membuka slip gaji sendiri (PIN benar).",
          }),
          PAYSLIP_PIN_AUDIT_SAFE_FIELDS,
        );
        return { kind: "ok" };
      },
    );
    if (outcome.kind !== "ok") return outcome;
    const [fresh] = await tx
      .select()
      .from(payslips)
      .where(
        and(
          eq(payslips.tenantId, context.tenant.tenantId),
          eq(payslips.id, row.id),
        ),
      )
      .limit(1);
    if (!fresh) throw notFound("Slip gaji");
    return {
      kind: "ok" as const,
      payslip: await toPayslip(tx, context, fresh, signer),
    };
  });
  if (result.kind !== "ok") {
    assertPinCheckOk(result);
    throw new PayrollError("PAYSLIP_PIN_INVALID");
  }
  return result.payslip;
}
