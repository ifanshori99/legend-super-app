// Payroll outbox emission (PRD v1.7 §3 D.30 "Jurnal Payroll", D.31; PAYR-04,
// PAYR-05; bead legend-4n3r). The payroll run service (legend-07eg) calls this
// inside its domain transaction when a run is locked, paid or reversed, and
// the kasbon / reimbursement services when they pay out; the GL consumer
// (`payroll-gl-consumer.ts`) posts the journals from the `cloud-sync` stream.
//
// Payroll belongs to the legal entity, not to an outlet, so the envelope
// carries `outletId: null`. The aggregate is the payroll run for `payroll.*`
// and `payslip.created`, the loan for `employee_loan.disbursed` and the
// reimbursement for `reimbursement.paid` (aggregate types come from the
// catalog). The sequence and the envelope come from `emitOperationsEvent`.

import type { z } from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { payrollDomainEvents } from "@starter/shared/hris/payroll";
import {
  emitOperationsEvent,
  type OperationsEventActor,
} from "./operations-events.ts";
import type { OperationsTx } from "./operations-idempotency.ts";

export type PayrollEventDefinition = (typeof payrollDomainEvents)[number];

/** Append one payroll event inside the caller's domain transaction. */
export async function emitPayrollEvent<D extends PayrollEventDefinition>(
  tx: OperationsTx,
  context: ScopedTenantContext,
  definition: D,
  input: {
    /** Payroll run id for `payroll.*`; loan / reimbursement id otherwise. */
    aggregateId: string;
    actor: OperationsEventActor;
    payload: z.input<D["payloadSchema"]>;
    now?: Date;
  },
): Promise<void> {
  await emitOperationsEvent(tx, context, definition, {
    aggregateId: input.aggregateId,
    outletId: null,
    actor: input.actor,
    payload: input.payload as Record<string, unknown>,
    now: input.now,
  });
}
