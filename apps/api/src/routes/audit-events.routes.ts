// Audit log viewer route (PRD v1.7 §3 F36; bead legend-zbzr). Path and schemas
// are the `listAuditEventsEndpoint` contract the FE already calls. Tenant comes
// from the server-minted context (TEN-02); the caller needs `audit.log.view`.
// Read only: audit rows are append-only and written by the services that own
// the audited operation.
//
// Mounted in app.ts at /api/audit.

import { Router } from "express";
import { listAuditEventsEndpoint } from "@starter/shared/audit";
import { getAuth, requireAuth } from "../middleware/auth";
import { noStore } from "../middleware/no-store";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import { listAuditEvents } from "../services/audit-events.service";

const BASE = "/api/audit";

export const auditEventsRouter = Router();

// Mounted outside apiRouter (app.ts), so it applies apiRouter's no-store itself.
auditEventsRouter.use(noStore);

auditEventsRouter.get(
  listAuditEventsEndpoint.path.slice(BASE.length),
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("audit.log.view"),
  async (req, res) => {
    const query = listAuditEventsEndpoint.query.parse(req.query);
    res.json(
      await listAuditEvents(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  },
);
