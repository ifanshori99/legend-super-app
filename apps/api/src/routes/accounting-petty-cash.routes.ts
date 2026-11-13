// Petty cash fund HTTP routes (legend-4961; PRD v1.7 §3.19 Kas & Bank). Paths
// and schemas are the `@starter/shared/accounting` endpoint objects. The tenant
// comes from the server-minted context (TEN-02); the permission is
// `accounting.petty_cash.manage` from stored role assignments (TEN-03).
//
// - All routes use `requireMenuPermission` (the caller's reachable scope). Fund
//   money moves through bank accounts, which live on the legal entity, so the
//   writes (movement, retry post) also need tenant scope: the service refuses
//   an outlet-scoped caller with OUTLET_OUT_OF_SCOPE. Reads narrow the rows to
//   the caller's outlets.

import { Router, type Request } from "express";
import {
  createPettyCashMovement,
  listPettyCashEntries,
  listPettyCashFunds,
  postPettyCashEntry,
} from "@starter/shared/accounting";
import type { PermissionCode } from "@starter/shared/access";
import { userIdSchema } from "@starter/shared/core";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import {
  createPettyCashMovement as createPettyCashMovementService,
  listPettyCashEntries as listPettyCashEntriesService,
  listPettyCashFunds as listPettyCashFundsService,
  postPettyCashEntry as postPettyCashEntryService,
} from "../services/accounting-petty-cash.service.ts";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

export function createAccountingPettyCashRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const MANAGE: PermissionCode = "accounting.petty_cash.manage";

  router.get(
    route(listPettyCashFunds.path),
    requireMenuPermission(MANAGE),
    async (req, res) => {
      const query = listPettyCashFunds.query.parse(req.query);
      res.json({
        data: await listPettyCashFundsService(
          getScopedTenantContext(req),
          query,
        ),
      });
    },
  );

  router.get(
    route(listPettyCashEntries.path),
    requireMenuPermission(MANAGE),
    async (req, res) => {
      const query = listPettyCashEntries.query.parse(req.query);
      res.json(
        await listPettyCashEntriesService(getScopedTenantContext(req), query),
      );
    },
  );

  router.post(
    route(createPettyCashMovement.path),
    jsonBody,
    requireMenuPermission(MANAGE),
    async (req, res) => {
      const input = createPettyCashMovement.body.parse(req.body);
      res.status(201).json({
        data: await createPettyCashMovementService(
          getScopedTenantContext(req),
          input,
          actorId(req),
        ),
      });
    },
  );

  router.post(
    route(postPettyCashEntry.path),
    jsonBody,
    requireMenuPermission(MANAGE),
    async (req, res) => {
      const { entryId } = postPettyCashEntry.params.parse(req.params);
      postPettyCashEntry.body.parse(req.body);
      res.json({
        data: await postPettyCashEntryService(
          getScopedTenantContext(req),
          entryId,
          actorId(req),
        ),
      });
    },
  );

  return router;
}
