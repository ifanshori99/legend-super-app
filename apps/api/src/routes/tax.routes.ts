// Tax and service-charge routes (PRD v1.7 §3 item 14 F11/F14, D13; bead
// legend-559). Paths, params, bodies and queries come from the domain contract
// (`@starter/shared/tax` `defineEndpoint` objects), so the API and the web
// client cannot drift.
//
// Tenant comes from the server-minted context, never the request (TEN-02).
// Configuration is tenant administration, so these routes require
// `org.tax_config.manage`; the PBJT report is finance
// (`accounting.tax_report.manage`) and outlet-scoped. The services re-check the
// permission on the row's own target (tenant-wide vs outlet) and the caller's
// outlet reach (TEN-03).

import { Router } from "express";
import {
  archiveTaxRule as archiveTaxRuleEndpoint,
  archiveTaxSettings as archiveTaxSettingsEndpoint,
  createServiceChargeRuleInputSchema,
  createTaxRuleInputSchema,
  createTaxSettingsInputSchema,
  getPbjtMonthlyRecap as getPbjtMonthlyRecapEndpoint,
  listServiceChargeRules as listServiceChargeRulesEndpoint,
  listTaxRuleConflicts as listTaxRuleConflictsEndpoint,
  listTaxRules as listTaxRulesEndpoint,
  listTaxSettings as listTaxSettingsEndpoint,
  previewTaxCalculation as previewTaxCalculationEndpoint,
  publishServiceChargeRule as publishServiceChargeRuleEndpoint,
  publishTaxRule as publishTaxRuleEndpoint,
  publishTaxSettings as publishTaxSettingsEndpoint,
  updateServiceChargeRule as updateServiceChargeRuleEndpoint,
  updateTaxRule as updateTaxRuleEndpoint,
  updateTaxSettings as updateTaxSettingsEndpoint,
} from "@starter/shared/tax";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireOutletPermission,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as tax from "../services/tax.service";

export const taxRouter = Router();

taxRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

/** Configuration writes/reads: tenant administration (§3.7, D13). */
const config = requireTenantPermission("org.tax_config.manage");

// ------------------------------------------------------------------ tax rules

taxRouter.get("/rules", config, async (req, res) => {
  const query = listTaxRulesEndpoint.query.parse(req.query);
  res.json(
    await tax.listTaxRules(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

// Before any `/rules/:taxRuleId` route, so "conflicts" is never read as an id.
taxRouter.get("/rules/conflicts", config, async (req, res) => {
  const query = listTaxRuleConflictsEndpoint.query.parse(req.query);
  res.json(
    await tax.listTaxRuleConflicts(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

taxRouter.post("/rules", config, jsonBody, async (req, res) => {
  const input = createTaxRuleInputSchema.parse(req.body);
  const rule = await tax.createTaxRule(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res.status(201).location(`/api/tax/rules/${rule.id}`).json({ data: rule });
});

taxRouter.patch("/rules/:taxRuleId", config, jsonBody, async (req, res) => {
  const { taxRuleId } = updateTaxRuleEndpoint.params.parse(req.params);
  const input = updateTaxRuleEndpoint.body.parse(req.body);
  res.json({
    data: await tax.updateTaxRule(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      taxRuleId,
      input,
    ),
  });
});

taxRouter.post(
  "/rules/:taxRuleId/publish",
  config,
  jsonBody,
  async (req, res) => {
    const { taxRuleId } = publishTaxRuleEndpoint.params.parse(req.params);
    const { idempotencyKey } = publishTaxRuleEndpoint.body.parse(req.body);
    res.json({
      data: await tax.publishTaxRule(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        taxRuleId,
        idempotencyKey,
      ),
    });
  },
);

taxRouter.post(
  "/rules/:taxRuleId/archive",
  config,
  jsonBody,
  async (req, res) => {
    const { taxRuleId } = archiveTaxRuleEndpoint.params.parse(req.params);
    archiveTaxRuleEndpoint.body.parse(req.body);
    res.json({
      data: await tax.archiveTaxRule(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        taxRuleId,
      ),
    });
  },
);

// --------------------------------------------------- service-charge rules

taxRouter.get("/service-charge-rules", config, async (req, res) => {
  const query = listServiceChargeRulesEndpoint.query.parse(req.query);
  res.json(
    await tax.listServiceChargeRules(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

taxRouter.post("/service-charge-rules", config, jsonBody, async (req, res) => {
  const input = createServiceChargeRuleInputSchema.parse(req.body);
  const rule = await tax.createServiceChargeRule(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res
    .status(201)
    .location(`/api/tax/service-charge-rules/${rule.id}`)
    .json({ data: rule });
});

taxRouter.patch(
  "/service-charge-rules/:serviceChargeRuleId",
  config,
  jsonBody,
  async (req, res) => {
    const { serviceChargeRuleId } =
      updateServiceChargeRuleEndpoint.params.parse(req.params);
    const input = updateServiceChargeRuleEndpoint.body.parse(req.body);
    res.json({
      data: await tax.updateServiceChargeRule(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        serviceChargeRuleId,
        input,
      ),
    });
  },
);

taxRouter.post(
  "/service-charge-rules/:serviceChargeRuleId/publish",
  config,
  jsonBody,
  async (req, res) => {
    const { serviceChargeRuleId } =
      publishServiceChargeRuleEndpoint.params.parse(req.params);
    const { idempotencyKey } = publishServiceChargeRuleEndpoint.body.parse(
      req.body,
    );
    res.json({
      data: await tax.publishServiceChargeRule(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        serviceChargeRuleId,
        idempotencyKey,
      ),
    });
  },
);

// -------------------------------------------------------------- tax settings

taxRouter.get("/settings", config, async (req, res) => {
  const query = listTaxSettingsEndpoint.query.parse(req.query);
  res.json(
    await tax.listTaxSettings(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

taxRouter.post("/settings", config, jsonBody, async (req, res) => {
  const input = createTaxSettingsInputSchema.parse(req.body);
  const settings = await tax.createTaxSettings(
    getScopedTenantContext(req),
    getAuth(req).user.id,
    input,
  );
  res
    .status(201)
    .location(`/api/tax/settings/${settings.id}`)
    .json({ data: settings });
});

taxRouter.patch(
  "/settings/:taxSettingsId",
  config,
  jsonBody,
  async (req, res) => {
    const { taxSettingsId } = updateTaxSettingsEndpoint.params.parse(
      req.params,
    );
    const input = updateTaxSettingsEndpoint.body.parse(req.body);
    res.json({
      data: await tax.updateTaxSettings(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        taxSettingsId,
        input,
      ),
    });
  },
);

taxRouter.post(
  "/settings/:taxSettingsId/archive",
  config,
  jsonBody,
  async (req, res) => {
    const { taxSettingsId } = archiveTaxSettingsEndpoint.params.parse(
      req.params,
    );
    archiveTaxSettingsEndpoint.body.parse(req.body);
    res.json({
      data: await tax.archiveTaxSettings(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        taxSettingsId,
      ),
    });
  },
);

taxRouter.post(
  "/settings/:taxSettingsId/publish",
  config,
  jsonBody,
  async (req, res) => {
    const { taxSettingsId } = publishTaxSettingsEndpoint.params.parse(
      req.params,
    );
    const { idempotencyKey } = publishTaxSettingsEndpoint.body.parse(req.body);
    res.json({
      data: await tax.publishTaxSettings(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        taxSettingsId,
        idempotencyKey,
      ),
    });
  },
);

// ------------------------------------------------- preview + PBJT report

/** ORD-03: the preview's numbers are the server's, never the client's. The
 * outlet in the body decides the scope, so an outlet-only grant can preview
 * its own bill and nothing else. */
taxRouter.post(
  "/preview",
  jsonBody,
  requireOutletPermission("org.tax_config.manage", (req) =>
    String(req.body?.outletId ?? ""),
  ),
  async (req, res) => {
    const input = previewTaxCalculationEndpoint.body.parse(req.body);
    res.json({
      data: await tax.previewTaxCalculation(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      ),
    });
  },
);

/** Monthly PBJT recap per outlet (§3.14 "Laporan Pajak"); finance permission. */
taxRouter.get(
  "/reports/pbjt",
  requireOutletPermission("accounting.tax_report.manage", (req) =>
    String(req.query.outletId ?? ""),
  ),
  async (req, res) => {
    const query = getPbjtMonthlyRecapEndpoint.query.parse(req.query);
    res.json({
      data: await tax.getPbjtMonthlyRecap(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    });
  },
);
