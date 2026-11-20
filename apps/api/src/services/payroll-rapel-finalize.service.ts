// Trusted run-writer boundary, not a public payroll lifecycle API. The caller
// owns the complete employee/payment plan and its surrounding transaction.
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  z,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  payrollConfigSnapshotSchema,
  payrollRunIdSchema,
  payrollRunTotalsSchema,
  payslipIdSchema,
  payslipPaymentMethodSchema,
  type PayrollRunId,
  type PayrollRunTotals,
  type PayslipId,
} from "@starter/shared/hris/payroll";
import { employeeIdSchema } from "@starter/shared/hris";
import { employees } from "../db/schema/hris.ts";
import {
  employeePayComponents,
  payrollRuns,
  payslips,
} from "../db/schema/payroll.ts";
import {
  payrollRapelFinalizations,
  payrollRapels,
} from "../db/schema/payroll-rapel.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { HttpError } from "../lib/http-error.ts";
import { openPayrollValue } from "../lib/payroll-sealed.ts";
import { recordAudit } from "./core-audit.ts";
import { notFound, type Tx } from "./hris-access.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import { lockPayrollRunMonth } from "./payroll-run-pph21.service.ts";
import { supersedeTaxExportsInTransaction } from "./payroll-tax-export-supersede.ts";
import { snapshotPayeeBankForLock } from "./payroll-bank-snapshot.service.ts";
import {
  computeEmployeeGrossInTransaction,
  type EmployeeGross,
} from "./payroll-components.service.ts";
import {
  payrollGrossEnvelopeSchema,
  PAYROLL_ALLOCATION_REVISION_MAX,
} from "../lib/payroll-gross-envelope.ts";

const inputSchema = z.strictObject({
  payrollRunId: payrollRunIdSchema,
  employeePlan: z
    .array(
      z.strictObject({
        employeeId: employeeIdSchema,
        payslipId: payslipIdSchema,
        paymentMethod: payslipPaymentMethodSchema,
      }),
    )
    .min(1)
    .max(100_000),
  expectedAllocationRevisions: z
    .record(
      z.string().uuid(),
      z.number().int().min(0).max(PAYROLL_ALLOCATION_REVISION_MAX),
    )
    .optional(),
});
export type PayrollRapelFinalizationInput = z.input<typeof inputSchema>;
type GrossEnvelope = z.infer<typeof payrollGrossEnvelopeSchema>;
type Plan = z.infer<typeof inputSchema>["employeePlan"][number];
const conflict = (message: string) => new HttpError(409, "CONFLICT", message);
const digest = (calculation: Buffer) =>
  createHash("sha256").update(calculation).digest("hex");
const unsupportedFields = [
  "bpjsEmployeeIdr",
  "bpjsCompanyIdr",
  "pph21Idr",
  "pph21WithheldIdr",
  "pph21EmployerBorneIdr",
  "pph21RefundIdr",
  "pph21EmployerRefundIdr",
  "pph21EmployerAllowanceRefundIdr",
  "loanRepaymentIdr",
  "pph21ReceivableIdr",
  "pph21ReceivableCollectedIdr",
  "serviceChargeIdr",
  "reimbursementIdr",
] as const;
const unsupportedCategories = new Set([
  "bpjs_employee",
  "pph21",
  "pph21_receivable",
  "pph21_refund",
  "tax_allowance",
  "loan_installment",
  "service_charge",
  "reimbursement",
]);

function aggregate(
  calculated: readonly {
    plan: Plan;
    gross: Pick<
      EmployeeGross,
      "grossIdr" | "deductionsIdr" | "netIdr" | "lines"
    >;
  }[],
): PayrollRunTotals {
  if (
    calculated.some(({ gross }) =>
      gross.lines.some((line) => unsupportedCategories.has(line.category)),
    )
  )
    throw conflict(
      "Finalisasi gross rapel menahan komponen pajak, statutory, pinjaman, reimbursement, dan service charge untuk lifecycle payroll lengkap.",
    );
  const total = (select: (entry: (typeof calculated)[number]) => number) =>
    idr(calculated.reduce((sum, entry) => sum + select(entry), 0));
  return payrollRunTotalsSchema.parse({
    ...Object.fromEntries(unsupportedFields.map((field) => [field, 0])),
    employeeCount: calculated.length,
    grossIdr: total(({ gross }) => gross.grossIdr),
    deductionsIdr: total(({ gross }) => gross.deductionsIdr),
    netIdr: total(({ gross }) => gross.netIdr),
    otherDeductionsIdr: total(({ gross }) => gross.deductionsIdr),
    customDeductionsIdr: total(({ gross }) =>
      gross.lines
        .filter(
          (line) =>
            line.kind === "deduction" && line.category === "custom_deduction",
        )
        .reduce((sum, line) => sum + line.amountIdr, 0),
    ),
    bankTransferIdr: total(({ plan, gross }) =>
      plan.paymentMethod === "bank_transfer" ? gross.netIdr : 0,
    ),
    cashIdr: total(({ plan, gross }) =>
      plan.paymentMethod === "cash" ? gross.netIdr : 0,
    ),
  });
}
function assertTotals(
  expected: PayrollRunTotals,
  calculated: PayrollRunTotals,
) {
  if (
    Object.keys(expected).some(
      (key) =>
        expected[key as keyof PayrollRunTotals] !==
        calculated[key as keyof PayrollRunTotals],
    )
  )
    throw conflict(
      "Hasil terkini tidak sama dengan total run yang telah disetujui; finalisasi ditahan untuk persetujuan ulang.",
    );
}
/**
 * Opens a rapel-finalized payslip and proves it is the sealed envelope this
 * run's finalization receipt vouches for: same run, same employee, same
 * allocation revision, and (while the key version is unchanged) the same
 * ciphertext digest. Shared by the finalize replay and the bank transfer
 * export, so both accept exactly the same slips. Throws 409 on any mismatch.
 */
export function openRapelFinalizedPayslip(
  slip: {
    id: PayslipId;
    tenantId: TenantId;
    employeeId: string;
    calculationEncrypted: Buffer;
    piiKeyVersion: number;
  },
  receipt: typeof payrollRapelFinalizations.$inferSelect | undefined,
  runId: PayrollRunId,
): GrossEnvelope {
  if (
    !receipt ||
    receipt.payrollRunId !== runId ||
    receipt.payslipId !== slip.id ||
    receipt.employeeId !== slip.employeeId ||
    slip.piiKeyVersion < receipt.piiKeyVersion ||
    (slip.piiKeyVersion === receipt.piiKeyVersion &&
      digest(slip.calculationEncrypted) !== receipt.calculationSha256)
  )
    throw conflict(
      "Batch finalisasi tersimpan tidak cocok dengan rencana run.",
    );
  let gross: GrossEnvelope;
  try {
    gross = payrollGrossEnvelopeSchema.parse(
      JSON.parse(
        openPayrollValue(
          slip.calculationEncrypted,
          {
            tenantId: slip.tenantId,
            table: "payslips",
            rowId: slip.id,
            field: "calculation",
          },
          slip.piiKeyVersion,
        ),
      ),
    );
  } catch {
    throw conflict("Slip final tidak dapat diverifikasi; pembayaran ditahan.");
  }
  if (
    gross.payrollRunId?.toLowerCase() !== runId.toLowerCase() ||
    gross.rapelAllocationRevision === undefined ||
    gross.rapelAllocationRevision !== receipt.allocationRevision
  )
    throw conflict("Seal final tidak cocok dengan revisi alokasi tersimpan.");
  return gross;
}

/**
 * Recompute every employee in a complete, trusted run plan inside the caller's
 * tenant transaction. It never locks a run lifecycle, alters approvals/totals,
 * creates a bank file, or performs the unsupported statutory side effects.
 */
export async function finalizePayrollRapelRunInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  input: PayrollRapelFinalizationInput,
  now = new Date(),
) {
  const body = inputSchema.parse(input);
  const actor = await assertPayrollTenantCan(
    tx,
    context,
    actorUserId,
    "payroll.lock",
  );
  await assertPayrollTenantCan(tx, context, actorUserId, "payroll.run");
  const tenantId = context.tenant.tenantId;
  const plan = [...body.employeePlan].sort((a, b) =>
    a.employeeId.localeCompare(b.employeeId),
  );
  const employeeIds = plan.map((entry) => entry.employeeId);
  if (
    new Set(employeeIds).size !== plan.length ||
    new Set(plan.map((entry) => entry.payslipId)).size !== plan.length
  )
    throw conflict(
      "Rencana finalisasi harus memuat tepat satu slip untuk setiap karyawan.",
    );
  if (
    Object.keys(body.expectedAllocationRevisions ?? {}).some(
      (id) => !employeeIds.includes(id as never),
    )
  )
    throw conflict("Revisi alokasi harus termasuk rencana finalisasi run.");

  // Global lock order (design 0.4): the month advisory lock comes first, so
  // finalize cannot interleave with a general lock of the same tax month.
  await lockPayrollRunMonth(tx, tenantId, body.payrollRunId);

  // The same component locks serialize setter, Finance overlays and allocation.
  // Acquire all of them before employee/outlet/run rows; do not lock headers
  // afterwards, because approval/allocation holds a header before its advisory.
  const components = await tx
    .selectDistinct({
      employeeId: employeePayComponents.employeeId,
      componentId: employeePayComponents.componentId,
    })
    .from(employeePayComponents)
    .where(
      and(
        eq(employeePayComponents.tenantId, tenantId),
        inArray(employeePayComponents.employeeId, employeeIds),
      ),
    )
    .orderBy(
      asc(employeePayComponents.employeeId),
      asc(employeePayComponents.componentId),
    );
  for (const component of components)
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll:emp-component:${tenantId}:${component.employeeId}:${component.componentId}`}, 0))`,
    );
  const lockedEmployees = await tx
    .select({ id: employees.id, homeOutletId: employees.homeOutletId })
    .from(employees)
    .where(
      and(eq(employees.tenantId, tenantId), inArray(employees.id, employeeIds)),
    )
    .orderBy(asc(employees.id))
    .for("share");
  if (lockedEmployees.length !== plan.length) throw notFound("Karyawan");
  const outletIds = [
    ...new Set(lockedEmployees.map((entry) => entry.homeOutletId)),
  ].sort();
  if (outletIds.length)
    await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(eq(outlets.tenantId, tenantId), inArray(outlets.id, outletIds)),
      )
      .orderBy(asc(outlets.id))
      .for("share");
  const [run] = await tx
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.id, body.payrollRunId),
      ),
    )
    .limit(1)
    .for("update");
  if (!run) throw notFound("Run payroll");
  if (run.runType !== "regular" || run.status !== "locked")
    throw conflict(
      "Finalisasi rapel memerlukan run regular yang telah dikunci oleh lifecycle payroll.",
    );
  const parsedTotals = payrollRunTotalsSchema.safeParse(run.totals);
  const parsedConfig = payrollConfigSnapshotSchema.safeParse(
    run.configSnapshot,
  );
  if (
    !parsedTotals.success ||
    !parsedConfig.success ||
    parsedConfig.data.policy.id !== run.payrollPolicyId
  )
    throw conflict("Snapshot atau total run beku tidak dapat diverifikasi.");
  const totals = parsedTotals.data;
  if (
    totals.employeeCount !== plan.length ||
    unsupportedFields.some((field) => totals[field] !== 0)
  )
    throw conflict(
      "Rencana run tidak lengkap atau memerlukan perhitungan statutory di luar finalisasi gross rapel.",
    );
  const allocations = await tx
    .select()
    .from(payrollRapels)
    .where(
      and(
        eq(payrollRapels.tenantId, tenantId),
        eq(payrollRapels.payrollRunId, run.id),
        eq(payrollRapels.status, "allocated"),
      ),
    );
  if (!allocations.length)
    throw conflict("Run tidak memiliki alokasi rapel untuk difinalisasi.");
  const revisions = new Map<string, number>(employeeIds.map((id) => [id, 0]));
  for (const allocation of allocations) {
    const entry = plan.find(
      (candidate) => candidate.employeeId === allocation.employeeId,
    );
    if (!entry || entry.payslipId !== allocation.reservedPayslipId)
      throw conflict(
        "Rencana harus mencakup setiap alokasi pada identitas slip yang dipesan.",
      );
    revisions.set(
      allocation.employeeId,
      (revisions.get(allocation.employeeId) ?? 0) + 1,
    );
  }
  if (
    Object.entries(body.expectedAllocationRevisions ?? {}).some(
      ([id, revision]) => revisions.get(id) !== revision,
    )
  )
    throw conflict("Preview rapel telah kedaluwarsa; revisi alokasi berubah.");
  const existing = await tx
    .select()
    .from(payslips)
    .where(
      and(eq(payslips.tenantId, tenantId), eq(payslips.payrollRunId, run.id)),
    );
  const receipts = await tx
    .select()
    .from(payrollRapelFinalizations)
    .where(
      and(
        eq(payrollRapelFinalizations.tenantId, tenantId),
        eq(payrollRapelFinalizations.payrollRunId, run.id),
      ),
    );
  if (existing.length || receipts.length) {
    if (existing.length !== plan.length || receipts.length !== plan.length)
      throw conflict(
        "Run memiliki batch finalisasi parsial; pembayaran ditahan untuk review.",
      );
    const replay = plan.map((entry) => {
      const slip = existing.find(
        (candidate) => candidate.employeeId === entry.employeeId,
      );
      const receipt = receipts.find(
        (candidate) => candidate.employeeId === entry.employeeId,
      );
      if (
        !slip ||
        !receipt ||
        slip.id !== entry.payslipId ||
        slip.paymentMethod !== entry.paymentMethod ||
        receipt.allocationRevision !== revisions.get(entry.employeeId)
      )
        throw conflict(
          "Batch finalisasi tersimpan tidak cocok dengan rencana run.",
        );
      const gross = openRapelFinalizedPayslip(slip, receipt, run.id);
      return { plan: entry, gross };
    });
    assertTotals(totals, aggregate(replay));
    return result(run.id, replay, revisions);
  }

  const calculated: { plan: Plan; gross: EmployeeGross }[] = [];
  for (const entry of plan) {
    const gross = await computeEmployeeGrossInTransaction(
      tx,
      context,
      actorUserId,
      {
        employeeId: entry.employeeId,
        payslipId: entry.payslipId,
        payrollRunId: run.id,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
      },
      "finalize",
    );
    if (gross.rapelAllocationRevision !== revisions.get(entry.employeeId))
      throw conflict(
        "Revisi alokasi berubah selama finalisasi; pembayaran ditahan.",
      );
    calculated.push({ plan: entry, gross });
  }
  // All plan, eligibility, source, revision and frozen-budget checks precede
  // the first receipt or payslip INSERT. The caller commits the whole batch.
  assertTotals(totals, aggregate(calculated));
  for (const { plan: entry, gross } of calculated) {
    await tx.insert(payrollRapelFinalizations).values({
      tenantId,
      payslipId: entry.payslipId,
      employeeId: entry.employeeId,
      payrollRunId: run.id,
      allocationRevision: revisions.get(entry.employeeId)!,
      calculationSha256: digest(gross.sealed.calculation),
      piiKeyVersion: gross.sealed.keyVersion,
      createdBy: actor,
      createdAt: now,
    });
    await tx.insert(payslips).values({
      tenantId,
      id: entry.payslipId,
      employeeId: entry.employeeId,
      payrollRunId: run.id,
      paymentMethod: entry.paymentMethod,
      calculationEncrypted: gross.sealed.calculation,
      piiKeyVersion: gross.sealed.keyVersion,
      createdAt: now,
    });
  }
  // legend-89cl7: freeze the payee bank details of every bank transfer that
  // carries money, in this same lock transaction (the bank export reads only
  // this snapshot). A payee without a readable account refuses the batch.
  await snapshotPayeeBankForLock(
    tx,
    tenantId,
    run.id,
    calculated
      .filter(
        ({ plan: entry, gross }) =>
          entry.paymentMethod === "bank_transfer" && gross.netIdr > 0,
      )
      .map(({ plan: entry }) => ({
        payslipId: entry.payslipId,
        employeeId: entry.employeeId,
      })),
  );
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId,
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: "payroll.rapel.finalized",
      objectType: "payroll_run",
      objectId: run.id,
      reason: null,
      maskedChanges: { before: null, after: { employeeCount: plan.length } },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    ["employeeCount"],
  );
  // legend 1229: the new rapel slips leave an export of the month stale.
  await supersedeTaxExportsInTransaction(
    tx,
    context,
    actor,
    {
      payrollRunId: run.id,
      legalEntityId: run.legalEntityId,
      payDate: run.payDate,
      reason: "run_locked",
    },
    now,
  );
  return result(run.id, calculated, revisions);
}
function result(
  payrollRunId: string,
  calculated: readonly {
    plan: Plan;
    gross: Pick<EmployeeGross, "grossIdr" | "deductionsIdr" | "netIdr">;
  }[],
  revisions: ReadonlyMap<string, number>,
) {
  return {
    payrollRunId,
    payslips: calculated.map(({ plan, gross }) => ({
      payslipId: plan.payslipId,
      employeeId: plan.employeeId,
      allocationRevision: revisions.get(plan.employeeId)!,
      grossIdr: gross.grossIdr,
      deductionsIdr: gross.deductionsIdr,
      netIdr: gross.netIdr,
    })),
  };
}
