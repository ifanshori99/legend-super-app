// Profit-share distribution HTTP routes (PRD v1.7 §3.37 Siklus Distribusi,
// §4 P; SH-02, SH-04; bead legend-2ljb). Paths and schemas are the
// `@starter/shared/accounting` endpoint objects the FE client uses. Tenant
// comes from the server-minted context (TEN-02), never from params or bodies.
//
// - list / get / create / submit / payment / adjustment:
//   `profit_share.registry.manage` over the tenant;
// - decision (approve or reject a run): `profit_share.distribution.approve`;
// - statement: a manager, or the line's own shareholder (`profit_share.own.view`)
//   once it is paid; any other caller gets 404 so existence does not leak;
// - my-profit-share: `profit_share.own.view`, the caller's own rows only.
//
// Mounted under /api/accounting next to the registry router, which guards only
// its own prefixes; this router guards the paths below.

import { Router, type Request } from "express";
import {
  createAdjustmentDistribution,
  createDistributionRun,
  decideDistributionRun,
  distributionRunSchema,
  distributionStatementSchema,
  getDistributionRun,
  getDistributionStatement,
  getMyProfitShare,
  listDistributionRuns,
  myProfitShareSchema,
  cancelApprovedDistributionRun,
  recordDistributionPayment,
  submitDistributionRun,
} from "@starter/shared/accounting";
import { AccessError } from "@starter/shared/access";
import { userIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  loadRequestAccess,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  createAdjustmentDistributionService,
  createDistributionRunService,
  decideDistributionRunService,
  defaultDistributionDeps,
  getDistributionRunService,
  getDistributionStatementService,
  getMyProfitShareService,
  listDistributionRunsService,
  cancelApprovedDistributionRunService,
  recordDistributionPaymentService,
  submitDistributionRunService,
  type DistributionDeps,
  type StatementViewer,
} from "../services/profit-share-distribution.service";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

/** Manager first, then shareholder; no other caller reads statements. */
async function resolveStatementViewer(req: Request): Promise<{
  context: ScopedTenantContext;
  viewer: StatementViewer;
}> {
  const snapshot = await loadRequestAccess(req);
  const manager = snapshot.contextFor("profit_share.registry.manage", {
    type: "tenant",
  });
  if (manager) return { context: manager, viewer: { kind: "manager" } };
  const shareholder = snapshot.contextFor("profit_share.own.view", {
    type: "tenant",
  });
  if (shareholder)
    return {
      context: shareholder,
      viewer: { kind: "shareholder", userId: getAuth(req).user.id },
    };
  throw new AccessError(
    "PERMISSION_DENIED",
    "Your account cannot perform this action in this tenant.",
  );
}

export function createProfitShareDistributionRouter(
  deps: Partial<DistributionDeps> = {},
) {
  const router = Router();
  const resolved: DistributionDeps = { ...defaultDistributionDeps, ...deps };
  const manage = requireTenantPermission("profit_share.registry.manage");
  const approve = requireTenantPermission("profit_share.distribution.approve");
  const own = requireTenantPermission("profit_share.own.view");

  // Scoped to these paths: the router shares the /accounting mount with the
  // registry, core and AP/FA routers, which run their own guards.
  for (const path of [
    "/profit-entities/:profitEntityId/distributions",
    "/distributions",
    route(getMyProfitShare.path),
  ])
    router.use(path, requireAuth, requireTrustedOrigin, requireTenantContext);

  router.get(route(listDistributionRuns.path), manage, async (req, res) => {
    const { profitEntityId } = listDistributionRuns.params.parse(req.params);
    const query = listDistributionRuns.query.parse(req.query);
    res.json(
      await listDistributionRunsService(
        getScopedTenantContext(req),
        profitEntityId,
        query,
      ),
    );
  });

  router.post(
    route(createDistributionRun.path),
    manage,
    jsonBody,
    async (req, res) => {
      const { profitEntityId } = createDistributionRun.params.parse(req.params);
      const body = createDistributionRun.body.parse(req.body);
      const data = await createDistributionRunService(
        getScopedTenantContext(req),
        actorId(req),
        profitEntityId,
        body,
      );
      res.status(201).json({ data: distributionRunSchema.parse(data) });
    },
  );

  router.get(route(getDistributionRun.path), manage, async (req, res) => {
    const { distributionRunId } = getDistributionRun.params.parse(req.params);
    const data = await getDistributionRunService(
      getScopedTenantContext(req),
      distributionRunId,
    );
    res.json({ data: distributionRunSchema.parse(data) });
  });

  router.post(
    route(submitDistributionRun.path),
    manage,
    jsonBody,
    async (req, res) => {
      const { distributionRunId } = submitDistributionRun.params.parse(
        req.params,
      );
      const body = submitDistributionRun.body.parse(req.body);
      const data = await submitDistributionRunService(
        getScopedTenantContext(req),
        actorId(req),
        distributionRunId,
        body,
      );
      res.json({ data: distributionRunSchema.parse(data) });
    },
  );

  router.post(
    route(decideDistributionRun.path),
    approve,
    jsonBody,
    async (req, res) => {
      const { distributionRunId } = decideDistributionRun.params.parse(
        req.params,
      );
      const body = decideDistributionRun.body.parse(req.body);
      const data = await decideDistributionRunService(
        getScopedTenantContext(req),
        actorId(req),
        distributionRunId,
        body,
      );
      res.json({ data: distributionRunSchema.parse(data) });
    },
  );

  router.post(
    route(cancelApprovedDistributionRun.path),
    approve,
    jsonBody,
    async (req, res) => {
      const { distributionRunId } = cancelApprovedDistributionRun.params.parse(
        req.params,
      );
      const body = cancelApprovedDistributionRun.body.parse(req.body);
      const data = await cancelApprovedDistributionRunService(
        getScopedTenantContext(req),
        actorId(req),
        distributionRunId,
        body,
      );
      res.json({ data: distributionRunSchema.parse(data) });
    },
  );

  router.post(
    route(recordDistributionPayment.path),
    manage,
    jsonBody,
    async (req, res) => {
      const { distributionRunId, distributionLineId } =
        recordDistributionPayment.params.parse(req.params);
      const body = recordDistributionPayment.body.parse(req.body);
      const data = await recordDistributionPaymentService(
        getScopedTenantContext(req),
        actorId(req),
        distributionRunId,
        distributionLineId,
        body,
        resolved,
      );
      res.json({ data: distributionRunSchema.parse(data) });
    },
  );

  router.post(
    route(createAdjustmentDistribution.path),
    manage,
    jsonBody,
    async (req, res) => {
      const { distributionRunId } = createAdjustmentDistribution.params.parse(
        req.params,
      );
      const body = createAdjustmentDistribution.body.parse(req.body);
      const data = await createAdjustmentDistributionService(
        getScopedTenantContext(req),
        actorId(req),
        distributionRunId,
        body,
      );
      res.status(201).json({ data: distributionRunSchema.parse(data) });
    },
  );

  router.get(route(getDistributionStatement.path), async (req, res) => {
    // Permission before validation: a caller without access gets 403, not 422.
    const { context, viewer } = await resolveStatementViewer(req);
    const { distributionRunId, distributionLineId } =
      getDistributionStatement.params.parse(req.params);
    res.setHeader("Cache-Control", "private, no-store");
    const data = await getDistributionStatementService(
      context,
      viewer,
      distributionRunId,
      distributionLineId,
    );
    res.json({ data: distributionStatementSchema.parse(data) });
  });

  router.get(route(getMyProfitShare.path), own, async (req, res) => {
    const data = await getMyProfitShareService(
      getScopedTenantContext(req),
      getAuth(req).user.id,
    );
    res.json({ data: myProfitShareSchema.parse(data) });
  });

  return router;
}
