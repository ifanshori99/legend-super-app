// Profit-share recipient reconciliation routes (bead legend-9t04v, Codex 405).
// Paths and schemas are the `@starter/shared/accounting` endpoint objects. The
// permission middleware only mints the tenant context; the real gate is the
// Owner check inside the service (403 for anyone who is not a tenant Owner).
import { Router, type Request } from "express";
import {
  listUnverifiedRecipientLines,
  resolveUnverifiedRecipient,
  resolveUnverifiedRecipientResultSchema,
  unverifiedRecipientLineSchema,
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
  listUnverifiedRecipientLinesService,
  resolveUnverifiedRecipientService,
} from "../services/profit-share-recipient-reconcile.service";

const BASE = "/api/tenant";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

export function createProfitShareRecipientReconcileRouter() {
  const router = Router();
  const manage = requireTenantPermission("profit_share.registry.manage");

  // Scoped to this prefix: the router shares the /tenant mount with others.
  router.use(
    route(listUnverifiedRecipientLines.path),
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
  );

  router.get(
    route(listUnverifiedRecipientLines.path),
    manage,
    async (req, res) => {
      const data = await listUnverifiedRecipientLinesService(
        getScopedTenantContext(req),
        actorId(req),
      );
      res.json({ data: unverifiedRecipientLineSchema.array().parse(data) });
    },
  );

  router.post(
    route(resolveUnverifiedRecipient.path),
    manage,
    jsonBody,
    async (req, res) => {
      const { lineId } = resolveUnverifiedRecipient.params.parse(req.params);
      const body = resolveUnverifiedRecipient.body.parse(req.body);
      const data = await resolveUnverifiedRecipientService(
        getScopedTenantContext(req),
        actorId(req),
        lineId,
        body,
      );
      res.json({ data: resolveUnverifiedRecipientResultSchema.parse(data) });
    },
  );

  return router;
}
