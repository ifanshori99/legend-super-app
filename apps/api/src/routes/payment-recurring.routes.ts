// DOIT recurring billing back office (bead legend-6c6). Paths and schemas are
// shared with the web client; tenant and actor are always server-derived.
// Nothing here activates a subscription: only a verified invoice.paid webhook
// does (see payment-recurring.service.ts).
import { Router, type Request, type RequestHandler } from "express";
import { idempotencyKeySchema } from "@starter/shared/core";
import type { PermissionCode } from "@starter/shared/access";
import * as contract from "@starter/shared/payment/recurring";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import type {
  PaymentRecurringPlan,
  PaymentRecurringSubscription,
  SubscriptionInvoice,
} from "../db/schema/payment-recurring.ts";
import { env } from "../config/env.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import * as service from "../services/payment-recurring.service.ts";
import { reprocessParkedRecurringEvents } from "../services/payment-webhook.service.ts";

export const paymentRecurringRouter = Router();
// Kill switch (DOIT_RECURRING_ENABLED, off by default): the adapter paths
// /v1/recurring/* are not the DOIT docs' /v1/billing/*. First in the chain and
// read per request, so an off flag means no auth lookup, no DOIT call, no row.
paymentRecurringRouter.use((_req, _res, next) => {
  if (!env.DOIT_RECURRING_ENABLED)
    throw new HttpError(
      503,
      "RECURRING_BILLING_DISABLED",
      "Penagihan berulang belum diaktifkan.",
    );
  next();
});
paymentRecurringRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

const PERMISSION: PermissionCode = "payment.recurring.manage";
const base = "/api/payments/recurring";
const route = (path: string) => path.slice(base.length) || "/";
const scope = (req: Request) => getScopedTenantContext(req);
const key = (req: Request) =>
  idempotencyKeySchema.parse(req.get("Idempotency-Key"));

/** An explicit outlet narrows the gate; otherwise the caller's reachable
 * outlets for the permission apply (RLS and the service keep rows inside). */
function byOutlet(outlet: (req: Request) => unknown): RequestHandler {
  const reach = requireMenuPermission(PERMISSION);
  return (req, res, next) => {
    const id = outlet(req);
    const gate =
      id == null
        ? reach
        : requireOutletPermission(PERMISSION, () => String(id));
    return gate(req, res, next);
  };
}
const outletQuery = byOutlet((req) => req.query.outletId);
const outletBody = byOutlet((req) => req.body?.outletId);
// Always the path outlet: never the caller's other reachable outlets.
const outletParam = byOutlet((req) => req.params.outletId ?? "");
// Record paths carry only an id: the service checks the row's outlet against
// the reachable outlets of this permission.
const record = requireMenuPermission(PERMISSION);

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function planDto(row: PaymentRecurringPlan) {
  return {
    id: row.id,
    outletId: row.outletId,
    name: row.name,
    amountIdr: row.amountIdr,
    interval: row.interval,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function subscriptionDto(row: PaymentRecurringSubscription) {
  return {
    id: row.id,
    outletId: row.outletId,
    planId: row.planId,
    customerProfileId: row.customerProfileId,
    status: row.status,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    nextPeriodStart: row.nextPeriodStart,
    nextPeriodEnd: row.nextPeriodEnd,
    reconcileReason: row.reconcileReason,
    activatedAt: iso(row.activatedAt),
    pausedAt: iso(row.pausedAt),
    cancelledAt: iso(row.cancelledAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function invoiceDto(row: SubscriptionInvoice) {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    amountIdr: row.amountIdr,
    hostedUrl: row.hostedUrl,
    status: row.status,
    paidAt: iso(row.paidAt),
    notifiedAt: iso(row.notifiedAt),
    reviewReason: row.reviewReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

paymentRecurringRouter.get(
  route(contract.listRecurringPlans.path),
  outletQuery,
  async (req, res) => {
    const plans = await service.listRecurringPlans(
      scope(req),
      contract.listRecurringPlans.query.parse(req.query),
    );
    res.json({ data: plans.map(planDto) });
  },
);

paymentRecurringRouter.post(
  route(contract.createRecurringPlan.path),
  jsonBody,
  outletBody,
  async (req, res) => {
    const input = contract.createRecurringPlan.body.parse(req.body);
    const plan = await service.createRecurringPlan(scope(req), {
      ...input,
      idempotencyKey: key(req),
    });
    res
      .status(201)
      .location(`${base}/plans/${plan.id}`)
      .json({ data: planDto(plan) });
  },
);

paymentRecurringRouter.post(
  route(contract.startRecurringSubscription.path),
  jsonBody,
  record,
  async (req, res) => {
    const input = contract.startRecurringSubscription.body.parse(req.body);
    const started = await service.startSubscription(scope(req), {
      ...input,
      idempotencyKey: key(req),
    });
    // Invoice events that arrived before this row existed were parked as
    // unknown; pick them up now. Best effort: the worker retries them anyway.
    const providerSubscriptionId = started.subscription.providerSubscriptionId;
    if (providerSubscriptionId)
      try {
        await reprocessParkedRecurringEvents(scope(req), new Date(), {
          providerSubscriptionId,
        });
      } catch (error) {
        logger.warn(
          {
            subscriptionId: started.subscription.id,
            errName: error instanceof Error ? error.name : "unknown",
          },
          "Reprocessing parked recurring events after start failed",
        );
      }
    res
      .status(201)
      .location(`${base}/subscriptions/${started.subscription.id}`)
      .json({
        data: {
          subscription: subscriptionDto(started.subscription),
          firstInvoiceUrl: started.firstInvoiceUrl,
        },
      });
  },
);

paymentRecurringRouter.get(
  route(contract.getRecurringSubscription.path),
  record,
  async (req, res) => {
    const { subscriptionId } = contract.getRecurringSubscription.params.parse(
      req.params,
    );
    res.json({
      data: subscriptionDto(
        await service.getSubscription(scope(req), subscriptionId),
      ),
    });
  },
);

paymentRecurringRouter.get(
  route(contract.listSubscriptionInvoices.path),
  record,
  async (req, res) => {
    const { subscriptionId } = contract.listSubscriptionInvoices.params.parse(
      req.params,
    );
    const invoices = await service.listSubscriptionInvoices(
      scope(req),
      subscriptionId,
    );
    res.json({ data: invoices.map(invoiceDto) });
  },
);

paymentRecurringRouter.post(
  route(contract.pauseRecurringSubscription.path),
  record,
  async (req, res) => {
    const { subscriptionId } = contract.pauseRecurringSubscription.params.parse(
      req.params,
    );
    res.json({
      data: subscriptionDto(
        await service.pauseSubscription(scope(req), subscriptionId),
      ),
    });
  },
);

paymentRecurringRouter.post(
  route(contract.resumeRecurringSubscription.path),
  record,
  async (req, res) => {
    const { subscriptionId } =
      contract.resumeRecurringSubscription.params.parse(req.params);
    res.json({
      data: subscriptionDto(
        await service.resumeSubscription(scope(req), subscriptionId),
      ),
    });
  },
);

paymentRecurringRouter.post(
  route(contract.cancelRecurringSubscription.path),
  record,
  async (req, res) => {
    const { subscriptionId } =
      contract.cancelRecurringSubscription.params.parse(req.params);
    res.json({
      data: subscriptionDto(
        await service.cancelSubscription(scope(req), subscriptionId),
      ),
    });
  },
);

paymentRecurringRouter.post(
  route(contract.resolveRecurringSubscription.path),
  jsonBody,
  record,
  async (req, res) => {
    const { subscriptionId } =
      contract.resolveRecurringSubscription.params.parse(req.params);
    contract.resolveRecurringSubscription.body.parse(req.body);
    const result = await service.resolveNeedsReconcileSubscription(
      scope(req),
      subscriptionId,
    );
    res.json({
      data: {
        subscription: subscriptionDto(result.subscription),
        resolved: result.resolved,
      },
    });
  },
);

paymentRecurringRouter.post(
  route(contract.reconcileRecurringStartIntent.path),
  jsonBody,
  record,
  async (req, res) => {
    const { subscriptionId } =
      contract.reconcileRecurringStartIntent.params.parse(req.params);
    contract.reconcileRecurringStartIntent.body.parse(req.body);
    const result = await service.reconcileExpiredStartIntent(
      scope(req),
      subscriptionId,
    );
    res.json({
      data: {
        subscription: subscriptionDto(result.subscription),
        resolved: result.resolved,
      },
    });
  },
);

paymentRecurringRouter.get(
  route(contract.getRecurringOutletGrace.path),
  outletParam,
  async (req, res) => {
    const { outletId } = contract.getRecurringOutletGrace.params.parse(
      req.params,
    );
    res.json({
      data: {
        graceDays: await service.getRecurringGraceDays(scope(req), outletId),
      },
    });
  },
);

paymentRecurringRouter.put(
  route(contract.updateRecurringOutletGrace.path),
  jsonBody,
  outletParam,
  async (req, res) => {
    const { outletId } = contract.updateRecurringOutletGrace.params.parse(
      req.params,
    );
    const { graceDays } = contract.updateRecurringOutletGrace.body.parse(
      req.body,
    );
    res.json({
      data: {
        graceDays: await service.setRecurringGraceDays(
          scope(req),
          outletId,
          graceDays,
        ),
      },
    });
  },
);
