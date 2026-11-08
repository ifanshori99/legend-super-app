// TEN-09 config export / template / import routes (PRD v1.7 §3 F4). Platform
// admin only, same chain as platform.routes.ts: the registry check runs before
// the MFA gate, so a non-admin learns nothing about the MFA requirement. The
// target tenant of /tenants/:tenantId is a path parameter chosen by the admin,
// never the caller's tenant context (platform/endpoints.ts).

import { Router, type Response } from "express";
import { apiErrorBody } from "@starter/shared/core";
import {
  createConfigTemplateInputSchema,
  importConfigInputSchema,
  platformEndpoints,
} from "@starter/shared/platform";
import { getAuth, requireAuth } from "../middleware/auth";
import { requireSessionMfa } from "../middleware/identity";
import { requirePlatformAdmin } from "../middleware/platform-admin";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  checkConfigReadiness,
  ConfigDetailedError,
  createConfigTemplate,
  exportTenantConfig,
  getConfigTemplate,
  importConfig,
  listConfigTemplates,
} from "../services/tenant-config.service.ts";

export const platformConfigRouter = Router();

platformConfigRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requirePlatformAdmin,
  requireSessionMfa(),
);

const {
  listConfigTemplates: listEndpoint,
  getConfigTemplate: getTemplateEndpoint,
  createConfigTemplate: createEndpoint,
  importConfig: importEndpoint,
  exportConfig: exportEndpoint,
  getConfigReadiness: readinessEndpoint,
} = platformEndpoints;

/** The shared error handler drops `details`; these errors carry them. */
function sendDetailed(res: Response, error: ConfigDetailedError): void {
  res.status(error.status).json(
    apiErrorBody(error.code, error.message, {
      details: error.details,
      ...(typeof res.req.id === "string" ? { requestId: res.req.id } : {}),
    }),
  );
}

platformConfigRouter.get("/config-templates", async (req, res) => {
  const query = listEndpoint.query.parse(req.query);
  res.json(await listConfigTemplates(query));
});

platformConfigRouter.get("/config-templates/:templateId", async (req, res) => {
  const { templateId } = getTemplateEndpoint.params.parse(req.params);
  res.json({ data: await getConfigTemplate(templateId) });
});

platformConfigRouter.post(
  "/tenants/:tenantId/config-templates",
  jsonBody,
  async (req, res) => {
    const { tenantId } = createEndpoint.params.parse(req.params);
    const input = createConfigTemplateInputSchema.parse(req.body);
    try {
      const template = await createConfigTemplate(
        tenantId,
        input,
        getAuth(req).user.id,
      );
      res
        .status(201)
        .location(`/api/platform/config-templates/${template.id}`)
        .json({ data: template });
    } catch (error) {
      if (error instanceof ConfigDetailedError) return sendDetailed(res, error);
      throw error;
    }
  },
);

platformConfigRouter.get(
  "/tenants/:tenantId/config-export",
  async (req, res) => {
    const { tenantId } = exportEndpoint.params.parse(req.params);
    try {
      res.json({ data: await exportTenantConfig(tenantId) });
    } catch (error) {
      if (error instanceof ConfigDetailedError) return sendDetailed(res, error);
      throw error;
    }
  },
);

platformConfigRouter.post(
  "/tenants/:tenantId/config-import",
  jsonBody,
  async (req, res) => {
    const { tenantId } = importEndpoint.params.parse(req.params);
    const input = importConfigInputSchema.parse(req.body);
    try {
      res.json({
        data: await importConfig(tenantId, input, getAuth(req).user.id),
      });
    } catch (error) {
      if (error instanceof ConfigDetailedError) return sendDetailed(res, error);
      throw error;
    }
  },
);

platformConfigRouter.get(
  "/tenants/:tenantId/config-readiness",
  async (req, res) => {
    const { tenantId } = readinessEndpoint.params.parse(req.params);
    res.json({ data: await checkConfigReadiness(tenantId) });
  },
);
