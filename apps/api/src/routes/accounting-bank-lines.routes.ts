// Bank statement line HTTP routes (legend-fnxl.4; PRD v1.7 §3.19 Kas & Bank,
// ACC-04). Paths and schemas are the `@starter/shared/accounting` endpoint
// objects. The tenant comes from the server-minted context (TEN-02), never from
// the body; permissions come from stored role assignments (TEN-03):
//
// - list, summary, gateway settlement recon: `accounting.journal.view`;
// - match, exclude, unmatch: `accounting.reconcile`.
//
// Mounted by the squad lead under /api/accounting next to the core router.

import { Router, type Request } from "express";
import {
  excludeStatementLine,
  getGatewaySettlementRecon,
  getReconciliationSummary,
  listStatementLines,
  matchStatementLine,
  unmatchStatementLine,
} from "@starter/shared/accounting";
import type { PermissionCode } from "@starter/shared/access";
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
  excludeStatementLine as excludeStatementLineService,
  getReconciliationSummary as getReconciliationSummaryService,
  listStatementLines as listStatementLinesService,
  matchStatementLine as matchStatementLineService,
  unmatchStatementLine as unmatchStatementLineService,
} from "../services/accounting-bank-lines.service.ts";
import { getGatewaySettlementReconRows } from "../services/accounting-gateway-recon.service.ts";

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

export function createAccountingBankLinesRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const VIEW: PermissionCode = "accounting.journal.view";
  const RECONCILE: PermissionCode = "accounting.reconcile";

  router.get(
    route(listStatementLines.path),
    requireTenantPermission(VIEW),
    async (req, res) => {
      const { bankAccountId } = listStatementLines.params.parse(req.params);
      const query = listStatementLines.query.parse(req.query);
      const page = await listStatementLinesService(
        getScopedTenantContext(req),
        bankAccountId,
        query,
      );
      res.json(page);
    },
  );

  router.get(
    route(getReconciliationSummary.path),
    requireTenantPermission(VIEW),
    async (req, res) => {
      const { bankAccountId } = getReconciliationSummary.params.parse(
        req.params,
      );
      const query = getReconciliationSummary.query.parse(req.query);
      res.json({
        data: await getReconciliationSummaryService(
          getScopedTenantContext(req),
          bankAccountId,
          query,
        ),
      });
    },
  );

  router.get(
    route(getGatewaySettlementRecon.path),
    requireTenantPermission(VIEW),
    async (req, res) => {
      const query = getGatewaySettlementRecon.query.parse(req.query);
      res.json({
        data: await getGatewaySettlementReconRows(
          getScopedTenantContext(req),
          query,
        ),
      });
    },
  );

  router.post(
    route(matchStatementLine.path),
    requireTenantPermission(RECONCILE),
    jsonBody,
    async (req, res) => {
      const { lineId } = matchStatementLine.params.parse(req.params);
      const input = matchStatementLine.body.parse(req.body);
      res.json({
        data: await matchStatementLineService(
          getScopedTenantContext(req),
          lineId,
          input,
          actorId(req),
        ),
      });
    },
  );

  router.post(
    route(excludeStatementLine.path),
    requireTenantPermission(RECONCILE),
    jsonBody,
    async (req, res) => {
      const { lineId } = excludeStatementLine.params.parse(req.params);
      const input = excludeStatementLine.body.parse(req.body);
      res.json({
        data: await excludeStatementLineService(
          getScopedTenantContext(req),
          lineId,
          input,
          actorId(req),
        ),
      });
    },
  );

  router.post(
    route(unmatchStatementLine.path),
    requireTenantPermission(RECONCILE),
    jsonBody,
    async (req, res) => {
      const { lineId } = unmatchStatementLine.params.parse(req.params);
      const input = unmatchStatementLine.body.parse(req.body);
      res.json({
        data: await unmatchStatementLineService(
          getScopedTenantContext(req),
          lineId,
          input,
          actorId(req),
        ),
      });
    },
  );

  return router;
}
