// Payroll payout (disbursement): per-legal-entity payout config, batches,
// manual bank export and confirmation, cash handover. Design:
// docs/design/payroll-disbursement.md. Mounted at `/api/hris/payroll`; guards
// sit on each route so every other payroll path falls through untouched.
// Money moves only behind a tenant permission AND a recent second factor
// (`requireTenantStepUpMfa`): config write, approve, export, confirm. Each
// handler is one transaction, so the export state change is committed before
// the file leaves the server (a second download answers 409).

import { Router, type Request } from "express";
import { z } from "zod";
import {
  approveDisbursementBatchInputSchema,
  cancelDisbursementBatchInputSchema,
  confirmCashHandoverInputSchema,
  confirmManualItemsInputSchema,
  createDisbursementBatchInputSchema,
  payoutBatchParamsSchema,
  listPayoutBatchesQuerySchema,
  payoutLegalEntityParamsSchema,
  payoutPostingParamsSchema,
  payoutRunParamsSchema,
  recordPostingSourceInputSchema,
  resolveManualItemsSchema,
  upsertPayoutConfigInputSchema,
  withdrawResolutionSchema,
} from "@starter/shared/validators/payroll-payout";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import {
  requireTenantStepUpMfa,
  requireTenantStepUpPassword,
} from "../middleware/identity.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  listPayoutRecovery,
  repostSkippedFees,
} from "../services/payroll-payout-gl.service.ts";
import { recordPostingSource } from "../services/payroll-payout-source.service.ts";
import { listPayoutBatches } from "../services/payroll-payout-batch-list.service.ts";
import {
  getPayoutConfig,
  upsertPayoutConfig,
} from "../services/payroll-payout-config.service.ts";
import {
  exportManualBatch,
  confirmCashHandover,
  confirmManualItems,
  resolveManualItems,
} from "../services/payroll-payout-manual.service.ts";
import { withdrawResolutionProposal } from "../services/payroll-payout-withdraw.service.ts";
import {
  approveDisbursementBatch,
  cancelDisbursementBatch,
  createDisbursementBatch,
  getDisbursementBatch,
  listDisbursementBatches,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import {
  PAYOUT_STEP_UP_MAX_AGE_MINUTES,
  payoutEvidenceStoreOf,
} from "../services/payroll-payout-evidence.ts";

export const payrollPayoutRouter = Router();

const stepUp = requireTenantStepUpMfa({
  maxAgeMinutes: PAYOUT_STEP_UP_MAX_AGE_MINUTES,
});
// Confirm, resolve and cash handover: the account password again when the
// second factor stamp comes from enrollment alone (legend-658, L5).
const passwordStepUp = requireTenantStepUpPassword();

function actorOf(req: Request) {
  const context = getScopedTenantContext(req);
  return {
    context,
    actor: { tenantId: context.tenant.tenantId, userId: getAuth(req).user.id },
  };
}

payrollPayoutRouter.get(
  "/payout-configs/:legalEntityId",
  requireAuth,
  requireTenantContext,
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const { legalEntityId } = payoutLegalEntityParamsSchema.parse(req.params);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      getPayoutConfig(tx, actor.tenantId, legalEntityId),
    );
    res.json({ data });
  },
);

payrollPayoutRouter.put(
  "/payout-configs/:legalEntityId",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.payout.configure"),
  stepUp,
  jsonBody,
  async (req, res) => {
    const { legalEntityId } = payoutLegalEntityParamsSchema.parse(req.params);
    const input = upsertPayoutConfigInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      upsertPayoutConfig(tx, actor, legalEntityId, input),
    );
    res.json({ data });
  },
);

payrollPayoutRouter.get(
  "/payout-batches",
  requireAuth,
  requireTenantContext,
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const query = listPayoutBatchesQuerySchema.parse(req.query);
    const { context, actor } = actorOf(req);
    const page = await withTenant(db, context, (tx) =>
      listPayoutBatches(tx, actor.tenantId, query),
    );
    res.json({
      data: page.items,
      meta: { limit: query.limit, nextCursor: page.nextCursor },
    });
  },
);

payrollPayoutRouter.get(
  "/runs/:id/disbursement-batches",
  requireAuth,
  requireTenantContext,
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const { id } = payoutRunParamsSchema.parse(req.params);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      listDisbursementBatches(tx, actor.tenantId, id),
    );
    res.json({ data });
  },
);

payrollPayoutRouter.post(
  "/runs/:id/disbursement-batches",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.request"),
  jsonBody,
  async (req, res) => {
    const { id } = payoutRunParamsSchema.parse(req.params);
    const { channel } = createDisbursementBatchInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      createDisbursementBatch(tx, actor, { payrollRunId: id, channel }),
    );
    res.status(201).json({ data });
  },
);

payrollPayoutRouter.get(
  "/disbursement-batches/:id",
  requireAuth,
  requireTenantContext,
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      getDisbursementBatch(tx, actor.tenantId, id),
    );
    res.json({ data });
  },
);

payrollPayoutRouter.post(
  "/disbursement-batches/:id/submit",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.request"),
  jsonBody,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      submitDisbursementBatch(tx, actor, id),
    );
    res.json({ data });
  },
);

payrollPayoutRouter.post(
  "/disbursement-batches/:id/approve",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const { contentHash, sourceBankAccountId } =
      approveDisbursementBatchInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      approveDisbursementBatch(tx, actor, id, {
        contentHash,
        sourceBankAccountId,
      }),
    );
    res.json({ data });
  },
);

payrollPayoutRouter.post(
  "/disbursement-batches/:id/cancel",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.request"),
  jsonBody,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const { reason } = cancelDisbursementBatchInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      cancelDisbursementBatch(tx, actor, id, { reason }),
    );
    res.json({ data });
  },
);

// The download is a POST: it changes state (batch and items become
// `exported`) and works once. The file is never stored, only its checksum.
payrollPayoutRouter.post(
  "/disbursement-batches/:id/export",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.request"),
  stepUp,
  jsonBody,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const { context, actor } = actorOf(req);
    // Respond only after the transaction committed the export state.
    const file = await withTenant(db, context, (tx) =>
      exportManualBatch(tx, actor, id),
    );
    res
      .status(200)
      .setHeader("Content-Type", file.contentType)
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${file.filename.replace(/["\\\r\n]/g, "_")}"`,
      )
      .setHeader("Cache-Control", "no-store")
      .setHeader("X-Content-Checksum-Sha256", file.checksumSha256)
      .send(file.content);
  },
);

payrollPayoutRouter.post(
  "/disbursement-batches/:id/confirm",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const input = confirmManualItemsInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      confirmManualItems(
        tx,
        actor,
        id,
        input,
        payoutEvidenceStoreOf(req, context),
      ),
    );
    res.json({ data });
  },
);

// Two-step: an exported item moves to failed or not_sent only after two
// different non-requesters each call this with the same outcome and evidence.
payrollPayoutRouter.post(
  "/disbursement-batches/:id/resolve",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const input = resolveManualItemsSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      resolveManualItems(
        tx,
        actor,
        id,
        input,
        payoutEvidenceStoreOf(req, context),
      ),
    );
    res.json({ data });
  },
);

// Takes back a step-one resolve proposal (wrong proof). The item stays
// `exported` and its slip stays blocked; only the proposal is cleared.
payrollPayoutRouter.post(
  "/disbursement-batches/:id/withdraw-resolution",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const input = withdrawResolutionSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      withdrawResolutionProposal(tx, actor, id, input),
    );
    res.json({ data });
  },
);

payrollPayoutRouter.post(
  "/disbursement-batches/:id/confirm-cash",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const input = confirmCashHandoverInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      confirmCashHandover(tx, actor, id, input),
    );
    res.json({ data });
  },
);

// Bank fee of a settled group that was not journaled (legend-8codi): finance
// sees the list and re-posts it once the bank charges mapping is back. It only
// books the fee already stored as expense, so no second factor.
// The list also holds settlements still waiting for money to reach the GL
// (legend-pfk3q), each with the `reason` it waits.
payrollPayoutRouter.get(
  "/payout-fee-reposts",
  requireAuth,
  requireTenantContext,
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      listPayoutRecovery(tx, actor.tenantId),
    );
    res.json({ data });
  },
);

payrollPayoutRouter.post(
  "/disbursement-batches/:id/repost-fees",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  jsonBody,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    z.strictObject({}).parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      repostSkippedFees(tx, actor, id),
    );
    res.json({ data });
  },
);

// Source account of a pending/skipped settlement that has none (legend-zlcsd):
// finance names the GL account the money left from, once, and the settlement
// resolves in the same transaction. Same guard as the fee re-post: it credits
// an account, so the disburse permission plus the second factor (same as
// confirm-cash) and an audit row.
payrollPayoutRouter.post(
  "/disbursement-batches/:id/postings/:postingId/source",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  async (req, res) => {
    const { id, postingId } = payoutPostingParamsSchema.parse(req.params);
    const input = recordPostingSourceInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      recordPostingSource(tx, actor, id, postingId, input.glAccountId),
    );
    res.json({ data });
  },
);
