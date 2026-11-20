// legend-svqew, Q43/Q44: approved back-pay is an immutable salary correction,
// allocated once to a later regular run. Preview never writes or consumes it.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  businessDateSchema,
  createUlid,
  idr,
  type BusinessDate,
  type Idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  allocatePayrollRapelInputSchema,
  approvePayrollRapelInputSchema,
  createPayrollRapelInputSchema,
  FROZEN_PAYROLL_RUN_STATUSES,
  payrollRapelIdSchema,
  payrollRapelSchema,
  payComponentIdSchema,
  payslipCalculationSchema,
  payslipLineSchema,
  type AllocatePayrollRapelInput,
  type ApprovePayrollRapelInput,
  type CreatePayrollRapelInput,
  type PayrollRapel,
  type PayslipLine,
} from "@starter/shared/hris/payroll";
import { eqId, inArrayIds } from "../db/branded-ids.ts";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import {
  employeePayComponents,
  payComponents,
  payrollRuns,
  payslips,
} from "../db/schema/payroll.ts";
import {
  payrollRapels,
  payrollRapelItems,
} from "../db/schema/payroll-rapel.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { payrollGrossEnvelopeSchema } from "../lib/payroll-gross-envelope.ts";
import {
  openPayrollAmount,
  openPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollAmount,
} from "../lib/payroll-sealed.ts";
import { recordAudit } from "./core-audit.ts";
import { notFound, type Tx } from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";

export type Header = typeof payrollRapels.$inferSelect;
type History = typeof employeePayComponents.$inferSelect;
const APPROVED = ["approved", "allocated"];
const dayNumber = (value: string) =>
  Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
const dayAt = (value: number): BusinessDate =>
  businessDateSchema.parse(
    new Date(value * 86_400_000).toISOString().slice(0, 10),
  );
const nextDay = (value: string): BusinessDate => dayAt(dayNumber(value) + 1);
const conflict = (message: string) => new HttpError(409, "CONFLICT", message);
const tenant = (context: ScopedTenantContext) => context.tenant.tenantId;
const positiveIdr = (amount: bigint): Idr => {
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw conflict("Nominal koreksi di luar batas yang dapat dibayar.");
  return idr(Number(amount));
};
const monthlyAmount = (row: Header) =>
  openPayrollAmount(
    row.newAmountEncrypted,
    {
      tenantId: row.tenantId,
      table: "payroll_rapels",
      rowId: row.id,
      field: "amount",
    },
    row.piiKeyVersion,
  );
const historyAmount = (row: History) =>
  openPayrollAmount(
    row.amountEncrypted,
    {
      tenantId: row.tenantId,
      table: "employee_pay_components",
      rowId: row.id,
      field: "amount",
    },
    row.piiKeyVersion,
  );
const itemAmount = (row: typeof payrollRapelItems.$inferSelect) =>
  openPayrollAmount(
    row.amountEncrypted,
    {
      tenantId: row.tenantId,
      table: "payroll_rapel_items",
      rowId: row.id,
      field: "amount",
    },
    row.piiKeyVersion,
  );

function sourceLines(
  context: ScopedTenantContext,
  employeeId: string,
  run: typeof payrollRuns.$inferSelect,
  slip: typeof payslips.$inferSelect,
): PayslipLine[] {
  let value: unknown;
  try {
    value = JSON.parse(
      openPayrollValue(
        slip.calculationEncrypted,
        {
          tenantId: tenant(context),
          table: "payslips",
          rowId: slip.id,
          field: "calculation",
        },
        slip.piiKeyVersion,
      ),
    );
  } catch {
    throw conflict("Slip sumber tidak dapat diverifikasi; pembayaran ditahan.");
  }
  const full = payslipCalculationSchema.safeParse(value);
  if (full.success) {
    if (
      full.data.employeeId !== employeeId ||
      full.data.periodStart !== run.periodStart ||
      full.data.periodEnd !== run.periodEnd
    )
      throw conflict("Slip sumber tidak cocok dengan karyawan dan periode.");
    return full.data.lines;
  }
  const legacy = payrollGrossEnvelopeSchema.safeParse(value);
  if (
    !legacy.success ||
    (legacy.data.payrollRunId !== undefined &&
      legacy.data.payrollRunId !== run.id)
  )
    throw conflict("Format atau identitas slip sumber tidak cocok.");
  return legacy.data.lines;
}

/** Lock actual rows separately: PostgreSQL cannot lock the nullable join side. */
async function loadPayrollEmployeeForShare(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
) {
  const [employee] = await tx
    .select()
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, tenant(context)),
        eq(employees.id, employeeId),
      ),
    )
    .limit(1)
    .for("share");
  if (!employee) throw notFound("Karyawan");
  const [outlet] =
    employee.homeOutletId === null
      ? []
      : await tx
          .select({ legalEntityId: outlets.legalEntityId })
          .from(outlets)
          .where(
            and(
              eq(outlets.tenantId, tenant(context)),
              eq(outlets.id, employee.homeOutletId),
            ),
          )
          .limit(1)
          .for("share");
  return {
    row: employee,
    legalEntityId: employee.legalEntityId ?? outlet?.legalEntityId ?? null,
  };
}

function assertRapelEligibility(
  rows: readonly Header[],
  employee: Awaited<ReturnType<typeof loadPayrollEmployeeForShare>>,
) {
  if (
    rows.some(
      (row) =>
        row.eligibilityJoinDate !== employee.row.joinDate ||
        row.eligibilityEndDate !== employee.row.endDate ||
        row.legalEntityId !== employee.legalEntityId,
    )
  )
    throw conflict(
      "Masa kerja atau badan hukum berubah; rapel ditahan untuk tinjauan dan persetujuan baru.",
    );
}

async function componentLock(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
  componentId: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll:emp-component:${tenant(context)}:${employeeId}:${componentId}`}, 0))`,
  );
}

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  row: Header,
  action: string,
  now: Date,
) {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: tenant(context),
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action,
      objectType: "payroll_rapel",
      objectId: row.id,
      reason: null,
      maskedChanges: {
        before: null,
        after: maskAuditChanges(
          {
            employeeId: row.employeeId,
            componentId: row.componentId,
            status: row.status,
            payrollRunId: row.payrollRunId,
          },
          ["employeeId", "componentId", "status"],
        ),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    ["employeeId", "componentId", "status", "payrollRunId"],
  );
}

async function header(
  tx: Tx,
  context: ScopedTenantContext,
  id: string,
  lock = false,
): Promise<Header> {
  const query = tx
    .select()
    .from(payrollRapels)
    .where(
      and(
        eq(payrollRapels.tenantId, tenant(context)),
        eq(payrollRapels.id, id),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Rapel");
  return row;
}

export async function toDto(
  tx: Tx,
  context: ScopedTenantContext,
  row: Header,
): Promise<PayrollRapel> {
  const items = await tx
    .select({ item: payrollRapelItems, run: payrollRuns })
    .from(payrollRapelItems)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.tenantId, payrollRapelItems.tenantId),
        eq(payrollRuns.id, payrollRapelItems.sourceRunId),
      ),
    )
    .where(
      and(
        eq(payrollRapelItems.tenantId, tenant(context)),
        eq(payrollRapelItems.rapelId, row.id),
      ),
    )
    .orderBy(asc(payrollRuns.periodStart), asc(payrollRapelItems.id));
  const total = items.reduce(
    (sum, { item }) => sum + BigInt(itemAmount(item)),
    0n,
  );
  return payrollRapelSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    componentId: row.componentId,
    effectiveFrom: row.effectiveFrom,
    prospectiveFrom: row.prospectiveFrom,
    newAmountIdr: monthlyAmount(row),
    totalIdr: positiveIdr(total),
    status: row.status,
    requestedBy: row.requestedBy,
    approvedByHr: row.approvedByHr,
    approvedByFinance: row.approvedByFinance,
    payrollRunId: row.payrollRunId,
    reservedPayslipId: row.reservedPayslipId,
    createdAt: row.createdAt.toISOString(),
    items: items.map(({ item, run }) => ({
      sourceRunId: run.id,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      amountIdr: itemAmount(item),
    })),
  });
}

/** All relevant run rows are locked, including mutable candidates that could freeze. */
async function correctionContext(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
  componentId: string,
  effectiveFrom: string,
) {
  const parsedComponentId = payComponentIdSchema.parse(componentId);
  const employee = await loadPayrollEmployeeForShare(tx, context, employeeId);
  const currentEntity = employee.legalEntityId;
  const runs = await tx
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, tenant(context)),
        or(
          ...(currentEntity
            ? [eq(payrollRuns.legalEntityId, currentEntity)]
            : []),
          sql`EXISTS (SELECT 1 FROM ${payslips} p WHERE p.tenant_id = ${payrollRuns.tenantId} AND p.payroll_run_id = ${payrollRuns.id} AND p.employee_id = ${employeeId})`,
        ),
      ),
    )
    .orderBy(asc(payrollRuns.id))
    .for("share");
  const frozen = runs.filter((r) =>
    FROZEN_PAYROLL_RUN_STATUSES.some((s) => s === r.status),
  );
  const frozenUntil = frozen.reduce<string | null>(
    (end, r) => (end === null || r.periodEnd > end ? r.periodEnd : end),
    null,
  );
  if (!frozenUntil || effectiveFrom > frozenUntil)
    throw conflict(
      "Rapel hanya untuk kenaikan yang berlaku pada periode beku.",
    );
  const prospectiveFrom = nextDay(frozenUntil);
  const history = await tx
    .select()
    .from(employeePayComponents)
    .where(
      and(
        eq(employeePayComponents.tenantId, tenant(context)),
        eq(employeePayComponents.employeeId, employeeId),
        eq(employeePayComponents.componentId, parsedComponentId),
      ),
    );
  const anchors = history.filter(
    (h) =>
      h.effectiveFrom <= prospectiveFrom &&
      (h.effectiveTo === null || h.effectiveTo >= prospectiveFrom),
  );
  if (anchors.length !== 1)
    throw conflict(
      "Riwayat gaji prospektif tidak lengkap; tinjau manual sebelum rapel.",
    );
  const slips = await tx
    .select()
    .from(payslips)
    .where(
      and(
        eq(payslips.tenantId, tenant(context)),
        eq(payslips.employeeId, employeeId),
      ),
    );
  const byRun = new Map(slips.map((s) => [s.payrollRunId as string, s]));
  const sources = frozen
    .filter(
      (r) =>
        r.runType === "regular" &&
        (r.status === "locked" || r.status === "paid") &&
        r.periodEnd >= effectiveFrom &&
        byRun.has(r.id),
    )
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  if (sources.length === 0 || sources.length > 120)
    throw conflict(
      "Tidak ada slip gaji beku yang dapat dikoreksi secara aman.",
    );
  if (sources.some((r) => r.legalEntityId !== sources[0]!.legalEntityId))
    throw conflict("Rapel lintas badan hukum harus ditinjau terpisah.");
  if (currentEntity !== sources[0]!.legalEntityId)
    throw conflict(
      "Badan hukum karyawan berbeda dari sumber; rapel perlu tinjauan manual.",
    );
  for (let i = 0; i < sources.length; i += 1) {
    if (
      dayNumber(sources[i]!.periodEnd) - dayNumber(sources[i]!.periodStart) >
        366 ||
      (i > 0 && sources[i]!.periodStart <= sources[i - 1]!.periodEnd)
    )
      throw conflict("Periode sumber bertumpuk atau di luar batas rapel.");
  }
  return {
    employee: employee.row,
    legalEntityId: currentEntity,
    history,
    sources,
    slips: byRun,
    prospectiveFrom,
    anchor: anchors[0]!,
  };
}

export type SalaryOverlay = {
  componentId: string;
  anchorHistoryRowId: string;
  prospectiveFrom: BusinessDate;
  newAmountIdr: Idr;
};
/** No pending correction can change ordinary salary or overtime. */
export async function loadApprovedSalaryOverlays(
  tx: Tx,
  context: ScopedTenantContext,
  employeeId: string,
): Promise<SalaryOverlay[]> {
  const employee = await loadPayrollEmployeeForShare(tx, context, employeeId);
  const rows = await tx
    .select()
    .from(payrollRapels)
    .where(
      and(
        eq(payrollRapels.tenantId, tenant(context)),
        eq(payrollRapels.employeeId, employeeId),
        inArray(payrollRapels.status, APPROVED),
      ),
    );
  // A foreign entity must not pay the former entity's approved salary overlay.
  // The caller resolves only exact history rows that overlap its gross days;
  // superseded/paid corrections never block unrelated future ordinary salary.
  return rows
    .filter((r) => r.legalEntityId === employee.legalEntityId)
    .map((r) => ({
      componentId: r.componentId,
      anchorHistoryRowId: r.anchorHistoryRowId,
      prospectiveFrom: businessDateSchema.parse(r.prospectiveFrom),
      newAmountIdr: monthlyAmount(r),
    }));
}
export function resolveRapelMonthlyAmount(
  overlays: readonly SalaryOverlay[],
  historyRowId: string,
  componentId: string,
  date: string,
  baseIdr: Idr,
): Idr {
  let amount = baseIdr;
  for (const overlay of overlays)
    if (
      overlay.componentId === componentId &&
      overlay.anchorHistoryRowId === historyRowId &&
      overlay.prospectiveFrom <= date
    )
      amount = idr(Math.max(amount, overlay.newAmountIdr));
  return amount;
}

export async function createPayrollRapel(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePayrollRapelInput,
  now = new Date(),
): Promise<PayrollRapel> {
  const { idempotencyKey, ...body } =
    createPayrollRapelInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      "payroll.run",
    );
    const result = await idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.rapel.create",
      { actor, body },
      async () => {
        await componentLock(tx, context, body.employeeId, body.componentId);
        const [component] = await tx
          .select()
          .from(payComponents)
          .where(
            and(
              eq(payComponents.tenantId, tenant(context)),
              eq(payComponents.id, body.componentId),
            ),
          )
          .limit(1);
        if (!component) throw notFound("Komponen gaji");
        if (
          !component.isActive ||
          component.kind !== "earning" ||
          component.recurrence !== "fixed"
        )
          throw conflict("Rapel hanya untuk komponen penghasilan tetap aktif.");
        const prior = await tx
          .select()
          .from(payrollRapels)
          .where(
            and(
              eq(payrollRapels.tenantId, tenant(context)),
              eq(payrollRapels.employeeId, body.employeeId),
              eq(payrollRapels.componentId, body.componentId),
            ),
          );
        if (
          prior.some(
            (r) => r.status === "pending" || r.status === "hr_approved",
          )
        )
          throw conflict(
            "Selesaikan atau batalkan permintaan rapel sebelumnya.",
          );
        const state = await correctionContext(
          tx,
          context,
          body.employeeId,
          body.componentId,
          body.effectiveFrom,
        );
        const previous = prior.filter((r) => APPROVED.includes(r.status));
        const previousItems = previous.length
          ? await tx
              .select()
              .from(payrollRapelItems)
              .where(
                and(
                  eq(payrollRapelItems.tenantId, tenant(context)),
                  inArray(
                    payrollRapelItems.rapelId,
                    previous.map((r) => r.id),
                  ),
                ),
              )
          : [];
        const overlays = previous.map((r) => ({
          componentId: r.componentId,
          anchorHistoryRowId: r.anchorHistoryRowId,
          prospectiveFrom: businessDateSchema.parse(r.prospectiveFrom),
          newAmountIdr: monthlyAmount(r),
        }));
        const items: { sourceRunId: string; amountIdr: Idr }[] = [];
        for (const source of state.sources) {
          const slip = state.slips.get(source.id)!;
          const lines = sourceLines(context, body.employeeId, source, slip);
          const periodDays = BigInt(
            dayNumber(source.periodEnd) - dayNumber(source.periodStart) + 1,
          );
          let incremental = 0n;
          const targetByHistory = new Map<string, bigint>();
          for (
            let day = dayNumber(source.periodStart);
            day <= dayNumber(source.periodEnd);
            day += 1
          ) {
            const date = dayAt(day);
            if (
              date < state.employee.joinDate ||
              (state.employee.endDate !== null && date > state.employee.endDate)
            )
              continue;
            const rows = state.history.filter(
              (h) =>
                h.effectiveFrom <= date &&
                (h.effectiveTo === null || h.effectiveTo >= date),
            );
            if (rows.length !== 1)
              throw conflict(
                "Celah riwayat gaji sumber memerlukan tinjauan manual.",
              );
            const h = rows[0]!;
            const original = resolveRapelMonthlyAmount(
              overlays,
              h.id,
              body.componentId,
              date,
              historyAmount(h),
            );
            if (original < 0)
              throw conflict("Nominal sumber tidak dapat dikoreksi otomatis.");
            let baseline = original;
            for (const priorRow of previous) {
              if (
                date >= priorRow.effectiveFrom &&
                date < priorRow.prospectiveFrom &&
                previousItems.some(
                  (item) =>
                    item.rapelId === priorRow.id &&
                    item.sourceRunId === source.id,
                )
              )
                baseline = idr(Math.max(baseline, monthlyAmount(priorRow)));
            }
            if (date < body.effectiveFrom) {
              targetByHistory.set(
                h.id,
                (targetByHistory.get(h.id) ?? 0n) + BigInt(baseline),
              );
              continue;
            }
            if (body.newAmountIdr < baseline)
              throw conflict(
                "Penurunan gaji backdate perlu persetujuan manual; tidak dibuat potongan otomatis.",
              );
            incremental += BigInt(body.newAmountIdr - baseline);
            targetByHistory.set(
              h.id,
              (targetByHistory.get(h.id) ?? 0n) + BigInt(body.newAmountIdr),
            );
          }
          // The immutable paid slip is a second cap. Already paid salary and
          // every prior approved/reserved credit are never paid a second time.
          const paid = lines
            .filter(
              (line) =>
                line.kind === "earning" &&
                line.componentCode === component.code,
            )
            .reduce((sum, line) => sum + BigInt(line.amountIdr), 0n);
          const reserved = previousItems
            .filter((item) => item.sourceRunId === source.id)
            .reduce((sum, item) => sum + BigInt(itemAmount(item)), 0n);
          // Match the ordinary gross engine: floor each original history row
          // before summing. Rounding across rows could pay an extra rupiah.
          const target = [...targetByHistory.values()].reduce(
            (sum, numerator) => sum + numerator / periodDays,
            0n,
          );
          const remaining = target - paid - reserved;
          const delta = incremental / periodDays;
          const payable = remaining < delta ? remaining : delta;
          if (payable > 0n)
            items.push({
              sourceRunId: source.id,
              amountIdr: positiveIdr(payable),
            });
        }
        if (items.length === 0)
          throw conflict(
            "Kenaikan ini sudah dicatat atau tidak menghasilkan rapel positif.",
          );
        const id = randomUUID();
        const [created] = await tx
          .insert(payrollRapels)
          .values({
            id,
            tenantId: tenant(context),
            employeeId: body.employeeId,
            componentId: body.componentId,
            legalEntityId: state.sources[0]!.legalEntityId,
            anchorHistoryRowId: state.anchor.id,
            effectiveFrom: body.effectiveFrom,
            prospectiveFrom: state.prospectiveFrom,
            eligibilityJoinDate: state.employee.joinDate,
            eligibilityEndDate: state.employee.endDate,
            newAmountEncrypted: sealPayrollAmount(body.newAmountIdr, {
              tenantId: tenant(context),
              table: "payroll_rapels",
              rowId: id,
              field: "amount",
            }),
            piiKeyVersion: PAYROLL_SEAL_KEY_VERSION,
            status: "pending",
            requestedBy: actor,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        for (const item of items) {
          const itemId = randomUUID();
          await tx.insert(payrollRapelItems).values({
            id: itemId,
            tenantId: tenant(context),
            rapelId: id,
            sourceRunId: item.sourceRunId,
            amountEncrypted: sealPayrollAmount(item.amountIdr, {
              tenantId: tenant(context),
              table: "payroll_rapel_items",
              rowId: itemId,
              field: "amount",
            }),
            piiKeyVersion: PAYROLL_SEAL_KEY_VERSION,
            createdAt: now,
          });
        }
        await audit(tx, context, actor, created!, "payroll.rapel.created", now);
        return { id };
      },
    );
    return toDto(tx, context, await header(tx, context, result.id));
  });
}

export async function getPayrollRapel(
  context: ScopedTenantContext,
  actorUserId: string,
  id: string,
): Promise<PayrollRapel> {
  const parsed = payrollRapelIdSchema.parse(id);
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, "payroll.view");
    return toDto(tx, context, await header(tx, context, parsed));
  });
}

export async function approvePayrollRapel(
  context: ScopedTenantContext,
  actorUserId: string,
  id: string,
  stage: "hr" | "finance",
  input: ApprovePayrollRapelInput,
  now = new Date(),
): Promise<PayrollRapel> {
  const parsed = payrollRapelIdSchema.parse(id);
  const { idempotencyKey } = approvePayrollRapelInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      "payroll.approve",
    );
    if (stage === "finance")
      await assertPayrollTenantCan(tx, context, actorUserId, "payroll.lock");
    await idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      `payroll.rapel.approve_${stage}`,
      { actor, id: parsed },
      async () => {
        const row = await header(tx, context, parsed, true);
        await componentLock(tx, context, row.employeeId, row.componentId);
        if (
          row.requestedBy === actor ||
          (stage === "finance" && row.approvedByHr === actor)
        )
          throw conflict("Pembuat, HR, dan Finance harus tiga orang berbeda.");
        if (row.status !== (stage === "hr" ? "pending" : "hr_approved"))
          throw conflict("Urutan persetujuan rapel tidak sesuai.");
        const state = await correctionContext(
          tx,
          context,
          row.employeeId,
          row.componentId,
          row.effectiveFrom,
        );
        const items = await tx
          .select()
          .from(payrollRapelItems)
          .where(
            and(
              eq(payrollRapelItems.tenantId, tenant(context)),
              eq(payrollRapelItems.rapelId, row.id),
            ),
          );
        if (
          state.employee.joinDate !== row.eligibilityJoinDate ||
          state.employee.endDate !== row.eligibilityEndDate ||
          state.legalEntityId !== row.legalEntityId ||
          state.prospectiveFrom !== row.prospectiveFrom ||
          state.anchor.id !== row.anchorHistoryRowId ||
          items.some(
            (item) =>
              !state.sources.some((source) => source.id === item.sourceRunId),
          )
        )
          throw conflict(
            "Periode atau sumber berubah. Batalkan dan ajukan ulang untuk persetujuan baru.",
          );
        const [updated] = await tx
          .update(payrollRapels)
          .set(
            stage === "hr"
              ? {
                  status: "hr_approved",
                  approvedByHr: actor,
                  approvedByHrAt: now,
                  updatedAt: now,
                }
              : {
                  status: "approved",
                  approvedByFinance: actor,
                  approvedByFinanceAt: now,
                  updatedAt: now,
                },
          )
          .where(
            and(
              eq(payrollRapels.tenantId, tenant(context)),
              eq(payrollRapels.id, row.id),
            ),
          )
          .returning();
        await audit(
          tx,
          context,
          actor,
          updated!,
          `payroll.rapel.approved_${stage}`,
          now,
        );
        return { id: row.id };
      },
    );
    return toDto(tx, context, await header(tx, context, parsed));
  });
}

export async function cancelPayrollRapel(
  context: ScopedTenantContext,
  actorUserId: string,
  id: string,
  input: ApprovePayrollRapelInput,
  now = new Date(),
): Promise<PayrollRapel> {
  const parsed = payrollRapelIdSchema.parse(id);
  const { idempotencyKey } = approvePayrollRapelInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      "payroll.run",
    );
    await idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.rapel.cancel",
      { actor, id: parsed },
      async () => {
        const row = await header(tx, context, parsed, true);
        if (row.status !== "pending" && row.status !== "hr_approved")
          throw conflict(
            "Rapel yang disetujui atau dialokasikan tidak boleh dibatalkan otomatis.",
          );
        const [updated] = await tx
          .update(payrollRapels)
          .set({ status: "cancelled", updatedAt: now })
          .where(
            and(
              eq(payrollRapels.tenantId, tenant(context)),
              eq(payrollRapels.id, row.id),
            ),
          )
          .returning();
        await audit(
          tx,
          context,
          actor,
          updated!,
          "payroll.rapel.cancelled",
          now,
        );
        return { id: row.id };
      },
    );
    return toDto(tx, context, await header(tx, context, parsed));
  });
}

async function lockSources(
  tx: Tx,
  context: ScopedTenantContext,
  rows: Header[],
) {
  if (!rows.length) return;
  const items = await tx
    .select()
    .from(payrollRapelItems)
    .where(
      and(
        eq(payrollRapelItems.tenantId, tenant(context)),
        inArray(
          payrollRapelItems.rapelId,
          rows.map((r) => r.id),
        ),
      ),
    );
  const ids = [...new Set(items.map((i) => i.sourceRunId))];
  const sources = ids.length
    ? await tx
        .select()
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.tenantId, tenant(context)),
            inArrayIds(payrollRuns.id, ids),
          ),
        )
        .orderBy(asc(payrollRuns.id))
        .for("share")
    : [];
  if (
    !ids.length ||
    sources.length !== ids.length ||
    sources.some(
      (r) =>
        r.runType !== "regular" ||
        (r.status !== "locked" && r.status !== "paid"),
    )
  )
    throw conflict("Sumber rapel berubah atau dibatalkan; pembayaran ditahan.");
}

export async function allocatePayrollRapel(
  context: ScopedTenantContext,
  actorUserId: string,
  id: string,
  input: AllocatePayrollRapelInput,
  now = new Date(),
): Promise<PayrollRapel> {
  const parsed = payrollRapelIdSchema.parse(id);
  const { idempotencyKey, payrollRunId } =
    allocatePayrollRapelInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      "payroll.run",
    );
    await idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.rapel.allocate",
      { actor, id: parsed, payrollRunId },
      async () => {
        const row = await header(tx, context, parsed, true);
        if (row.status === "allocated") {
          if (row.payrollRunId !== payrollRunId)
            throw conflict("Rapel sudah dialokasikan ke run lain.");
          return { id: row.id };
        }
        if (row.status !== "approved")
          throw conflict("Rapel memerlukan persetujuan HR dan Finance.");
        await componentLock(tx, context, row.employeeId, row.componentId);
        const employee = await loadPayrollEmployeeForShare(
          tx,
          context,
          row.employeeId,
        );
        assertRapelEligibility([row], employee);
        const [target] = await tx
          .select()
          .from(payrollRuns)
          .where(
            and(
              eq(payrollRuns.tenantId, tenant(context)),
              eq(payrollRuns.id, payrollRunId),
            ),
          )
          .limit(1)
          .for("update");
        if (!target) throw notFound("Run payroll");
        if (
          target.runType !== "regular" ||
          target.status !== "draft" ||
          target.legalEntityId !== row.legalEntityId ||
          target.periodStart < row.prospectiveFrom
        )
          throw conflict(
            "Rapel hanya dialokasikan ke run regular draft berikutnya pada badan hukum sumber.",
          );
        // The run leaves out someone who ended in an earlier year than its pay
        // date (legend-1220): a rapel allocated there would stay unpaid.
        const endDate = employee.row.endDate;
        if (
          endDate !== null &&
          endDate.slice(0, 4) < target.payDate.slice(0, 4)
        )
          throw new HttpError(
            409,
            "PAYROLL_RAPEL_EMPLOYEE_EXCLUDED",
            `Karyawan ${employee.row.fullName} (${employee.row.employeeNo}) berhenti pada ${endDate}, di tahun sebelum tanggal bayar run ini (${target.payDate}), jadi dia tidak ikut run ini. Rapelnya tidak bisa dialokasikan ke run ini: bayar di luar run.`,
          );
        const [earliest] = await tx
          .select({ id: payrollRuns.id })
          .from(payrollRuns)
          .where(
            and(
              eq(payrollRuns.tenantId, tenant(context)),
              eq(payrollRuns.legalEntityId, row.legalEntityId),
              eq(payrollRuns.runType, "regular"),
              inArray(payrollRuns.status, ["draft", "simulated"]),
              sql`${payrollRuns.periodStart} >= ${row.prospectiveFrom}::date`,
            ),
          )
          .orderBy(asc(payrollRuns.periodStart), asc(payrollRuns.id))
          .limit(1);
        if (earliest?.id !== target.id)
          throw conflict(
            "Pilih run berikutnya sebelum periode yang lebih jauh.",
          );
        await lockSources(tx, context, [row]);
        const [existing] = await tx
          .select({ payslipId: payrollRapels.reservedPayslipId })
          .from(payrollRapels)
          .where(
            and(
              eq(payrollRapels.tenantId, tenant(context)),
              eq(payrollRapels.employeeId, row.employeeId),
              eq(payrollRapels.payrollRunId, target.id),
              eq(payrollRapels.status, "allocated"),
            ),
          )
          .limit(1);
        const [persisted] = await tx
          .select({ id: payslips.id })
          .from(payslips)
          .where(
            and(
              eq(payslips.tenantId, tenant(context)),
              eq(payslips.employeeId, row.employeeId),
              eq(payslips.payrollRunId, target.id),
            ),
          )
          .limit(1);
        if (persisted)
          throw conflict(
            "Run telah mempunyai slip final; rapel tidak ditambahkan setelah finalisasi.",
          );
        const [updated] = await tx
          .update(payrollRapels)
          .set({
            status: "allocated",
            payrollRunId: target.id,
            reservedPayslipId: existing?.payslipId ?? randomUUID(),
            updatedAt: now,
          })
          .where(
            and(
              eq(payrollRapels.tenantId, tenant(context)),
              eq(payrollRapels.id, row.id),
            ),
          )
          .returning();
        await audit(
          tx,
          context,
          actor,
          updated!,
          "payroll.rapel.allocated",
          now,
        );
        return { id: row.id };
      },
    );
    return toDto(tx, context, await header(tx, context, parsed));
  });
}

/** Read-only consumption: the allocation stays bound to one run and payslip. */
export async function loadAllocatedRapelLines(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    employeeId: string;
    payrollRunId: string;
    payslipId: string;
    periodStart: BusinessDate;
    periodEnd: BusinessDate;
    finalizing?: boolean;
  },
): Promise<PayslipLine[]> {
  const employee = await loadPayrollEmployeeForShare(
    tx,
    context,
    input.employeeId,
  );
  const [run] = await tx
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, tenant(context)),
        eqId(payrollRuns.id, input.payrollRunId),
      ),
    )
    .limit(1)
    .for("share");
  if (!run) throw notFound("Run payroll");
  if (
    run.runType !== "regular" ||
    !(input.finalizing ? ["locked"] : ["draft", "simulated"]).includes(
      run.status,
    ) ||
    run.periodStart !== input.periodStart ||
    run.periodEnd !== input.periodEnd
  )
    throw conflict(
      "Periode/run tidak cocok atau telah beku; gunakan slip final yang tersimpan.",
    );
  const rows = await tx
    .select()
    .from(payrollRapels)
    .where(
      and(
        eq(payrollRapels.tenantId, tenant(context)),
        eq(payrollRapels.employeeId, input.employeeId),
        eq(payrollRapels.payrollRunId, run.id),
        eq(payrollRapels.status, "allocated"),
      ),
    )
    .orderBy(asc(payrollRapels.id));
  if (
    rows.some(
      (r) =>
        r.reservedPayslipId !== input.payslipId ||
        r.legalEntityId !== run.legalEntityId,
    )
  )
    throw conflict(
      "Identitas slip atau badan hukum tidak cocok dengan alokasi rapel.",
    );
  if (employee.legalEntityId !== run.legalEntityId)
    throw conflict("Karyawan tidak termasuk badan hukum run.");
  assertRapelEligibility(rows, employee);
  await lockSources(tx, context, rows);
  const lines: PayslipLine[] = [];
  for (const row of rows) {
    const dto = await toDto(tx, context, row);
    lines.push(
      payslipLineSchema.parse({
        componentCode: "RAPEL",
        name: "Rapel kenaikan gaji",
        category: "custom_earning",
        kind: "earning",
        amountIdr: dto.totalIdr,
        taxable: true,
        quantity: null,
        sourceId: row.id,
      }),
    );
  }
  return lines;
}
