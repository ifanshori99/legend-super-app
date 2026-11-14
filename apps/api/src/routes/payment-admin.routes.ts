// WS-05 payment administration (PRD §3 F13). Endpoint paths and schemas are
// shared with the web client; tenant and actor are always server-derived.
import { Router, type Request, type RequestHandler } from "express";
import { idempotencyKeySchema } from "@starter/shared/core";
import type { PermissionCode } from "@starter/shared/access";
import * as contract from "@starter/shared/payment/admin";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { sessionMfaVerifiedAt } from "../lib/mfa.ts";
import * as service from "../services/payment-admin.service.ts";
import * as config from "../services/payment-admin-config.service.ts";
import * as funds from "../services/payment-admin-funds.service.ts";
import * as edcReconciliation from "../services/edc-reconciliation.service.ts";
import * as reconciliation from "../services/payment-admin-reconciliation.service.ts";
import * as settlementImport from "../services/payment-settlement-import.service.ts";
import * as refunds from "../services/payment-refund.service.ts";

export const paymentAdminRouter = Router();
paymentAdminRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

const base = "/api/payments/admin";
const route = (path: string) => path.slice(base.length) || "/";
const actor = (req: Request) => getAuth(req).user.id;
const scope = (req: Request) => getScopedTenantContext(req);
// The contract predates keys on these bodies; a header preserves its strict
// schema while giving every write a caller-supplied retry identity.
const key = (req: Request) =>
  idempotencyKeySchema.parse(req.get("Idempotency-Key"));

/** An explicit outlet narrows the gate; omitted means tenant-wide access. */
function byOutlet(
  permission: PermissionCode,
  outlet: (req: Request) => unknown,
): RequestHandler {
  return (req, res, next) => {
    const id = outlet(req);
    const gate =
      id == null
        ? requireTenantPermission(permission)
        : requireOutletPermission(permission, () => String(id));
    return gate(req, res, next);
  };
}
const edcQuery = byOutlet("payment.edc.manage", (req) => req.query.outletId);
const edcBody = byOutlet("payment.edc.manage", (req) => req.body?.outletId);
// Routing picks the gateway that receives the money: org.settings.manage
// (sub-302 D14), not the EDC permission.
const settingsQuery = byOutlet(
  "org.settings.manage",
  (req) => req.query.outletId,
);
const settingsBody = byOutlet(
  "org.settings.manage",
  (req) => req.body?.outletId,
);
const reconcileQuery = byOutlet(
  "payment.reconcile",
  (req) => req.query.outletId,
);
const reconcileBody = byOutlet(
  "payment.reconcile",
  (req) => req.body?.outletId,
);
const viewQuery = byOutlet(
  "payment.transaction.view",
  (req) => req.query.outletId,
);
// For paths carrying only a record id, the permission-specific reachable
// outlets are installed in RLS; services check the actual row's outlet.
const edcRecord = requireMenuPermission("payment.edc.manage");
const reconcileRecord = requireMenuPermission("payment.reconcile");

paymentAdminRouter.get(
  route(contract.getPaymentRouting.path),
  settingsQuery,
  async (req, res) => {
    res.json({
      data: await config.getPaymentRouting(
        scope(req),
        actor(req),
        contract.getPaymentRouting.query.parse(req.query),
      ),
    });
  },
);
paymentAdminRouter.put(
  route(contract.updatePaymentRoute.path),
  jsonBody,
  settingsBody,
  async (req, res) => {
    res.json({
      data: await config.updatePaymentRoute(
        scope(req),
        actor(req),
        contract.updatePaymentRoute.params.parse(req.params),
        contract.updatePaymentRoute.body.parse(req.body),
        key(req),
      ),
    });
  },
);
paymentAdminRouter.get(
  route(contract.listEdcTerminals.path),
  edcQuery,
  async (req, res) => {
    res.json(
      await config.listEdcTerminals(
        scope(req),
        actor(req),
        contract.listEdcTerminals.query.parse(req.query),
      ),
    );
  },
);
paymentAdminRouter.post(
  route(contract.createEdcTerminal.path),
  jsonBody,
  edcBody,
  async (req, res) => {
    const terminal = await config.createEdcTerminal(
      scope(req),
      actor(req),
      contract.createEdcTerminal.body.parse(req.body),
      key(req),
    );
    res
      .status(201)
      .location(`${base}/edc/terminals/${terminal.id}`)
      .json({ data: terminal });
  },
);
paymentAdminRouter.patch(
  route(contract.updateEdcTerminal.path),
  jsonBody,
  edcRecord,
  async (req, res) => {
    res.json({
      data: await config.updateEdcTerminal(
        scope(req),
        actor(req),
        contract.updateEdcTerminal.params.parse(req.params),
        contract.updateEdcTerminal.body.parse(req.body),
        key(req),
      ),
    });
  },
);
paymentAdminRouter.get(
  route(contract.getEdcCashierDefaults.path),
  edcQuery,
  async (req, res) => {
    res.json({
      data: await config.getEdcCashierDefaults(
        scope(req),
        actor(req),
        contract.getEdcCashierDefaults.query.parse(req.query),
      ),
    });
  },
);
paymentAdminRouter.put(
  route(contract.updateEdcCashierDefault.path),
  jsonBody,
  edcBody,
  async (req, res) => {
    res.json({
      data: await config.updateEdcCashierDefault(
        scope(req),
        actor(req),
        contract.updateEdcCashierDefault.params.parse(req.params),
        contract.updateEdcCashierDefault.body.parse(req.body),
        key(req),
      ),
    });
  },
);
paymentAdminRouter.get(
  route(contract.listRefundablePayments.path),
  viewQuery,
  async (req, res) => {
    res.json({
      data: await service.listRefundablePayments(
        scope(req),
        actor(req),
        contract.listRefundablePayments.query.parse(req.query),
      ),
    });
  },
);
// EDC reconciliation (legend-x9zmq): clears a flagged ECR sale after a person
// checked the terminal. The service re-checks payment.reconcile at the outlet.
paymentAdminRouter.post(
  "/edc/transactions/:id/reconciliation",
  jsonBody,
  reconcileRecord,
  async (req, res) => {
    res.json({
      data: await edcReconciliation.resolveEdcReconciliationForActor(
        scope(req),
        actor(req),
        req.params,
        req.body,
        { mfaVerified: (await sessionMfaVerifiedAt(req)) !== null },
      ),
    });
  },
);
paymentAdminRouter.get(
  route(contract.listRefunds.path),
  viewQuery,
  async (req, res) => {
    res.json(
      await service.listRefunds(
        scope(req),
        actor(req),
        contract.listRefunds.query.parse(req.query),
      ),
    );
  },
);
paymentAdminRouter.post(
  route(contract.createRefund.path),
  jsonBody,
  reconcileRecord,
  async (req, res) => {
    const input = contract.createRefund.body.parse(req.body);
    const refund = await service.createRefund(
      scope(req),
      actor(req),
      input,
      input.idempotencyKey,
    );
    res
      .status(201)
      .location(`${base}/refunds/${refund.id}`)
      .json({ data: refund });
  },
);
paymentAdminRouter.post(
  route(contract.approveRefund.path),
  jsonBody,
  reconcileRecord,
  async (req, res) => {
    const input = contract.approveRefund.body.parse(req.body);
    res.json({
      data: await service.approveRefund(
        scope(req),
        actor(req),
        contract.approveRefund.params.parse(req.params),
        input,
        input.idempotencyKey,
        { mfaVerified: (await sessionMfaVerifiedAt(req)) !== null },
      ),
    });
  },
);
paymentAdminRouter.post(
  route(contract.rejectRefund.path),
  jsonBody,
  reconcileRecord,
  async (req, res) => {
    const input = contract.rejectRefund.body.parse(req.body);
    res.json({
      data: await refunds.rejectRefund(
        scope(req),
        actor(req),
        contract.rejectRefund.params.parse(req.params),
        input,
        input.idempotencyKey,
        { mfaVerified: (await sessionMfaVerifiedAt(req)) !== null },
      ),
    });
  },
);
paymentAdminRouter.post(
  route(contract.retryRefundPayout.path),
  jsonBody,
  reconcileRecord,
  async (req, res) => {
    const input = contract.retryRefundPayout.body.parse(req.body);
    res.json({
      data: await refunds.retryRefundPayout(
        scope(req),
        actor(req),
        {
          ...contract.retryRefundPayout.params.parse(req.params),
          sourceEvidenceId: input.sourceEvidenceId,
        },
        input.idempotencyKey,
      ),
    });
  },
);
for (const [endpoint, run] of [
  [contract.releaseQuarantinedRefund, refunds.releaseQuarantinedRefund],
  [contract.reopenQuarantinedRefund, refunds.reopenQuarantinedRefund],
] as const)
  paymentAdminRouter.post(
    route(endpoint.path),
    jsonBody,
    reconcileRecord,
    async (req, res) => {
      const input = endpoint.body.parse(req.body);
      res.json({
        data: await run(
          scope(req),
          actor(req),
          endpoint.params.parse(req.params),
          input,
          input.idempotencyKey,
          { mfaVerified: (await sessionMfaVerifiedAt(req)) !== null },
        ),
      });
    },
  );
paymentAdminRouter.post(
  route(contract.settleRefundManually.path),
  jsonBody,
  reconcileRecord,
  async (req, res) => {
    const input = contract.settleRefundManually.body.parse(req.body);
    res.json({
      data: await refunds.settleRefundManually(
        scope(req),
        actor(req),
        contract.settleRefundManually.params.parse(req.params),
        input,
        input.idempotencyKey,
        { mfaVerified: (await sessionMfaVerifiedAt(req)) !== null },
      ),
    });
  },
);
paymentAdminRouter.get(
  route(contract.listUnallocatedFunds.path),
  reconcileQuery,
  async (req, res) => {
    res.json(
      await funds.listUnallocatedFunds(
        scope(req),
        actor(req),
        contract.listUnallocatedFunds.query.parse(req.query),
      ),
    );
  },
);
paymentAdminRouter.post(
  route(contract.resolveUnallocatedFund.path),
  jsonBody,
  reconcileRecord,
  async (req, res) => {
    const input = contract.resolveUnallocatedFund.body.parse(req.body);
    res.json({
      data: await funds.resolveUnallocatedFund(
        scope(req),
        actor(req),
        contract.resolveUnallocatedFund.params.parse(req.params),
        input,
        input.idempotencyKey,
      ),
    });
  },
);
paymentAdminRouter.get(
  route(contract.listReconciliationCases.path),
  reconcileQuery,
  async (req, res) => {
    res.json(
      await reconciliation.listReconciliationCases(
        scope(req),
        actor(req),
        contract.listReconciliationCases.query.parse(req.query),
      ),
    );
  },
);
paymentAdminRouter.get(
  route(contract.getReconciliationSummary.path),
  reconcileQuery,
  async (req, res) => {
    res.json({
      data: await reconciliation.getReconciliationSummary(
        scope(req),
        actor(req),
        contract.getReconciliationSummary.query.parse(req.query),
      ),
    });
  },
);
paymentAdminRouter.post(
  route(contract.importSettlement.path),
  jsonBody,
  reconcileBody,
  async (req, res) => {
    res.json({
      data: await settlementImport.importSettlement(
        scope(req),
        actor(req),
        contract.importSettlement.body.parse(req.body),
        key(req),
      ),
    });
  },
);
paymentAdminRouter.post(
  route(contract.resolveReconciliationCase.path),
  jsonBody,
  reconcileRecord,
  async (req, res) => {
    res.json({
      data: await reconciliation.resolveReconciliationCase(
        scope(req),
        actor(req),
        contract.resolveReconciliationCase.params.parse(req.params),
        contract.resolveReconciliationCase.body.parse(req.body),
        key(req),
      ),
    });
  },
);
