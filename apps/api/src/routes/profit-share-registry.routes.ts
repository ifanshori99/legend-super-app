// Profit-share registry HTTP routes (PRD v1.7 §3.37; SH-03; bead legend-2ljb):
// profit entities + policy, the shareholder register and versioned share
// allocations. Paths and schemas are the `@starter/shared/accounting` endpoint
// objects the FE client uses. The tenant comes from the server-minted context
// (TEN-02), never from params or bodies.
//
// - everything but the decision: `profit_share.registry.manage`;
// - approve/reject a version: `profit_share.distribution.approve` (four-eyes is
//   enforced by the contract state machine).
//
// Mounted under /api/accounting before the accounting core router; the guards
// are scoped to this resource's prefixes because the router shares the mount
// with other routers that run their own guards.

import { Router, type Request } from "express";
import {
  createProfitEntity,
  createShareAllocationVersion,
  createShareholder,
  decideShareAllocationVersion,
  getShareAllocationVersion,
  listProfitEntities,
  listShareAllocationVersions,
  listShareholders,
  profitEntitySchema,
  shareAllocationVersionSchema,
  shareholderSchema,
  submitShareAllocationVersion,
  updateProfitEntity,
  updateShareAllocationVersion,
  updateShareholder,
} from "@starter/shared/accounting";
import { userIdSchema } from "@starter/shared/core";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  createProfitEntityService,
  createShareAllocationVersionService,
  createShareholderService,
  decideShareAllocationVersionService,
  getShareAllocationVersionService,
  listProfitEntitiesService,
  listShareAllocationVersionsService,
  listShareholdersService,
  submitShareAllocationVersionService,
  updateProfitEntityService,
  updateShareAllocationVersionService,
  updateShareholderService,
} from "../services/profit-share-registry.service";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

export function createProfitShareRegistryRouter() {
  const router = Router();
  router.use(
    [route(listProfitEntities.path), route(listShareholders.path)],
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
  );

  const manage = requireTenantPermission("profit_share.registry.manage");
  const approve = requireTenantPermission("profit_share.distribution.approve");

  // ---- profit entities ----------------------------------------------------

  router.get(route(listProfitEntities.path), manage, async (req, res) => {
    res.json({
      data: (await listProfitEntitiesService(getScopedTenantContext(req))).map(
        (row) => profitEntitySchema.parse(row),
      ),
    });
  });

  router.post(
    route(createProfitEntity.path),
    manage,
    jsonBody,
    async (req, res) => {
      const input = createProfitEntity.body.parse(req.body);
      const data = await createProfitEntityService(
        getScopedTenantContext(req),
        actorId(req),
        input,
      );
      res.status(201).json({ data: profitEntitySchema.parse(data) });
    },
  );

  router.patch(
    route(updateProfitEntity.path),
    manage,
    jsonBody,
    async (req, res) => {
      const { profitEntityId } = updateProfitEntity.params.parse(req.params);
      const input = updateProfitEntity.body.parse(req.body);
      const data = await updateProfitEntityService(
        getScopedTenantContext(req),
        actorId(req),
        profitEntityId,
        input,
      );
      res.json({ data: profitEntitySchema.parse(data) });
    },
  );

  // ---- shareholders -------------------------------------------------------

  router.get(route(listShareholders.path), manage, async (req, res) => {
    res.json({
      data: (await listShareholdersService(getScopedTenantContext(req))).map(
        (row) => shareholderSchema.parse(row),
      ),
    });
  });

  router.post(
    route(createShareholder.path),
    manage,
    jsonBody,
    async (req, res) => {
      const input = createShareholder.body.parse(req.body);
      const data = await createShareholderService(
        getScopedTenantContext(req),
        actorId(req),
        input,
      );
      res.status(201).json({ data: shareholderSchema.parse(data) });
    },
  );

  router.patch(
    route(updateShareholder.path),
    manage,
    jsonBody,
    async (req, res) => {
      const { shareholderId } = updateShareholder.params.parse(req.params);
      const input = updateShareholder.body.parse(req.body);
      const data = await updateShareholderService(
        getScopedTenantContext(req),
        actorId(req),
        shareholderId,
        input,
      );
      res.json({ data: shareholderSchema.parse(data) });
    },
  );

  // ---- share allocation versions -----------------------------------------

  router.get(
    route(listShareAllocationVersions.path),
    manage,
    async (req, res) => {
      const { profitEntityId } = listShareAllocationVersions.params.parse(
        req.params,
      );
      const query = listShareAllocationVersions.query.parse(req.query);
      const data = await listShareAllocationVersionsService(
        getScopedTenantContext(req),
        profitEntityId,
        query,
      );
      res.json({
        data: data.map((row) => shareAllocationVersionSchema.parse(row)),
      });
    },
  );

  router.get(
    route(getShareAllocationVersion.path),
    manage,
    async (req, res) => {
      const { profitEntityId, version } =
        getShareAllocationVersion.params.parse(req.params);
      const data = await getShareAllocationVersionService(
        getScopedTenantContext(req),
        profitEntityId,
        version,
      );
      res.json({ data: shareAllocationVersionSchema.parse(data) });
    },
  );

  router.post(
    route(createShareAllocationVersion.path),
    manage,
    jsonBody,
    async (req, res) => {
      const { profitEntityId } = createShareAllocationVersion.params.parse(
        req.params,
      );
      const input = createShareAllocationVersion.body.parse(req.body);
      const data = await createShareAllocationVersionService(
        getScopedTenantContext(req),
        actorId(req),
        profitEntityId,
        input,
      );
      res.status(201).json({ data: shareAllocationVersionSchema.parse(data) });
    },
  );

  router.patch(
    route(updateShareAllocationVersion.path),
    manage,
    jsonBody,
    async (req, res) => {
      const { profitEntityId, version } =
        updateShareAllocationVersion.params.parse(req.params);
      const input = updateShareAllocationVersion.body.parse(req.body);
      const data = await updateShareAllocationVersionService(
        getScopedTenantContext(req),
        actorId(req),
        profitEntityId,
        version,
        input,
      );
      res.json({ data: shareAllocationVersionSchema.parse(data) });
    },
  );

  router.post(
    route(submitShareAllocationVersion.path),
    manage,
    jsonBody,
    async (req, res) => {
      const { profitEntityId, version } =
        submitShareAllocationVersion.params.parse(req.params);
      const input = submitShareAllocationVersion.body.parse(req.body);
      const data = await submitShareAllocationVersionService(
        getScopedTenantContext(req),
        actorId(req),
        profitEntityId,
        version,
        input,
      );
      res.json({ data: shareAllocationVersionSchema.parse(data) });
    },
  );

  router.post(
    route(decideShareAllocationVersion.path),
    approve,
    jsonBody,
    async (req, res) => {
      const { profitEntityId, version } =
        decideShareAllocationVersion.params.parse(req.params);
      const input = decideShareAllocationVersion.body.parse(req.body);
      const data = await decideShareAllocationVersionService(
        getScopedTenantContext(req),
        actorId(req),
        profitEntityId,
        version,
        input,
      );
      res.json({ data: shareAllocationVersionSchema.parse(data) });
    },
  );

  return router;
}
