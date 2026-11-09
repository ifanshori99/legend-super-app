// HRIS onboarding/offboarding checklist routes (PRD v1.7 F24; brief 299
// slice A; bead legend-ovxw): templates per position, onboarding start, task
// list, task actions and the action trail. Paths, params, queries and bodies
// come from the WS-10 contract (`@starter/shared/hris` defineEndpoint
// objects); mounted at `/api/hris`, so each handler path is the contract path
// without that prefix.
//
// Every gate is per route (no router-level gate): this router shares the
// `/api/hris` prefix with the other HRIS routers and must not swallow their
// paths. `requireHrisLearning` is the shared "may this caller use the route at
// all" gate (it mints the narrowest context, TEN-03); the service re-checks
// outlet reach, ownership and the per-action right inside the tenant
// transaction (someone else's row answers 404). Manager routes run behind the
// back-office surface (AUTH-05); the task list and the task action accept the
// employee PWA surface too, because an employee completes their own
// onboarding documents and training there.

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { PermissionCode } from "@starter/shared/access";
import {
  actOnChecklistTask as actOnChecklistTaskEndpoint,
  createChecklistTemplate as createChecklistTemplateEndpoint,
  listChecklistTaskActions as listChecklistTaskActionsEndpoint,
  listChecklistTasks as listChecklistTasksEndpoint,
  listChecklistTemplates as listChecklistTemplatesEndpoint,
  startEmployeeOnboarding as startOnboardingEndpoint,
  updateChecklistTemplate as updateChecklistTemplateEndpoint,
} from "@starter/shared/hris";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  hrisLearningActor,
  hrisLearningContext,
  requireBackOfficeSurface,
  requireHrisLearning,
  requireHrisLearningSurface,
} from "./hris-sop-gate.ts";
import * as checklistService from "../services/hris-checklist.service.ts";

const READ: PermissionCode[] = [
  "hr.employee.view",
  "hr.employee.manage",
  "payroll.view",
];
const READ_OR_SELF: PermissionCode[] = [...READ, "self.profile.view"];
const MANAGE: PermissionCode[] = ["hr.employee.manage"];
const MANAGE_OR_SELF: PermissionCode[] = [...MANAGE, "self.profile.view"];

function run(
  handler: RequestHandler,
  req: Request,
  res: Response,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const next: NextFunction = (error?: unknown) =>
      error ? reject(error) : resolve();
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

export function createHrisChecklistRouter(): Router {
  const router = Router();
  const common = [requireAuth, requireTrustedOrigin, requireTenantContext];

  const backOffice = requireBackOfficeSurface();
  const employee = requireHrisLearningSurface();
  /** Back office first; the `hris` employee surface otherwise. */
  const eitherSurface: RequestHandler = async (req, res, next) => {
    try {
      await run(backOffice, req, res);
    } catch {
      await run(employee, req, res);
    }
    next();
  };

  router.get(
    "/checklist-templates",
    ...common,
    backOffice,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const query = listChecklistTemplatesEndpoint.query.parse(req.query);
      res.json(
        await checklistService.listChecklistTemplates(
          hrisLearningContext(req),
          hrisLearningActor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/checklist-templates",
    ...common,
    backOffice,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const body = createChecklistTemplateEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await checklistService.createChecklistTemplate(
          hrisLearningContext(req),
          hrisLearningActor(req),
          body,
        ),
      });
    },
  );

  router.patch(
    "/checklist-templates/:templateId",
    ...common,
    backOffice,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { templateId } = updateChecklistTemplateEndpoint.params.parse(
        req.params,
      );
      const body = updateChecklistTemplateEndpoint.body.parse(req.body);
      res.json({
        data: await checklistService.updateChecklistTemplate(
          hrisLearningContext(req),
          hrisLearningActor(req),
          templateId,
          body,
        ),
      });
    },
  );

  router.post(
    "/employees/:employeeId/onboarding",
    ...common,
    backOffice,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { employeeId } = startOnboardingEndpoint.params.parse(req.params);
      startOnboardingEndpoint.body.parse(req.body ?? {});
      const result = await checklistService.startOnboarding(
        hrisLearningContext(req),
        hrisLearningActor(req),
        employeeId,
      );
      res.status(result.created ? 201 : 200).json({ data: result.tasks });
    },
  );

  router.get(
    "/employees/:employeeId/checklist-tasks",
    ...common,
    eitherSurface,
    requireHrisLearning(READ_OR_SELF),
    async (req, res) => {
      const { employeeId } = listChecklistTasksEndpoint.params.parse(
        req.params,
      );
      const query = listChecklistTasksEndpoint.query.parse(req.query);
      res.json(
        await checklistService.listChecklistTasks(
          hrisLearningContext(req),
          hrisLearningActor(req),
          employeeId,
          query,
        ),
      );
    },
  );

  router.post(
    "/checklist-tasks/:taskId/actions",
    ...common,
    eitherSurface,
    jsonBody,
    requireHrisLearning(MANAGE_OR_SELF),
    async (req, res) => {
      const { taskId } = actOnChecklistTaskEndpoint.params.parse(req.params);
      const body = actOnChecklistTaskEndpoint.body.parse(req.body);
      res.json({
        data: await checklistService.applyChecklistTaskAction(
          hrisLearningContext(req),
          hrisLearningActor(req),
          taskId,
          body,
        ),
      });
    },
  );

  router.get(
    "/checklist-tasks/:taskId/actions",
    ...common,
    backOffice,
    requireHrisLearning(READ),
    async (req, res) => {
      const { taskId } = listChecklistTaskActionsEndpoint.params.parse(
        req.params,
      );
      const query = listChecklistTaskActionsEndpoint.query.parse(req.query);
      res.json(
        await checklistService.listChecklistTaskActions(
          hrisLearningContext(req),
          hrisLearningActor(req),
          taskId,
          query,
        ),
      );
    },
  );

  return router;
}

/** Mount at `/api/hris` (routes/index.ts). */
export const hrisChecklistRouter = createHrisChecklistRouter();
