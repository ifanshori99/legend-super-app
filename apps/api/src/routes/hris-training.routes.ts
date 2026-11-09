// HRIS training routes (PRD v1.7 §3 F32; bead legend-7df1). Contract:
// `@starter/shared/hris` (endpoints.ts listTrainings / completeTraining,
// learning.ts the manager side). Mounted at `/api/hris`, so each handler path
// is the contract path without that prefix.
//
// Every gate is per route (no router-level gate): this router shares the
// `/api/hris` prefix with the other HRIS routers and must not swallow their
// paths. The manager routes run behind the back-office surface, the employee
// PWA routes behind the `hris` surface; reads that both audiences use accept
// either.

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  completeTraining as completeTrainingEndpoint,
  createTraining as createTrainingEndpoint,
  enrollTraining as enrollTrainingEndpoint,
  listTrainingCertificates as listTrainingCertificatesEndpoint,
  listTrainingEnrollments as listTrainingEnrollmentsEndpoint,
  listTrainings as listTrainingsEndpoint,
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
import * as trainingService from "../services/hris-training.service.ts";

const MANAGE = ["hr.training.manage"] as const;
const SELF = ["self.sop.read"] as const;

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

export function createHrisTrainingRouter(): Router {
  const router = Router();
  const common = [requireAuth, requireTrustedOrigin, requireTenantContext];

  const backOffice = requireBackOfficeSurface();
  const employee = requireHrisLearningSurface();
  /** Employee PWA first; a manager's back-office session is the fallback. */
  const eitherSurface: RequestHandler = async (req, res, next) => {
    try {
      await run(employee, req, res);
    } catch {
      await run(backOffice, req, res);
    }
    next();
  };

  router.get(
    "/trainings",
    ...common,
    eitherSurface,
    requireHrisLearning([...SELF, ...MANAGE]),
    async (req, res) => {
      const query = listTrainingsEndpoint.query.parse(req.query);
      res.json(
        await trainingService.listTrainings(
          hrisLearningContext(req),
          hrisLearningActor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/trainings",
    ...common,
    backOffice,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const body = createTrainingEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await trainingService.createTraining(
          hrisLearningContext(req),
          hrisLearningActor(req),
          body,
        ),
      });
    },
  );

  router.post(
    "/trainings/:trainingId/completions",
    ...common,
    employee,
    jsonBody,
    requireHrisLearning(SELF),
    async (req, res) => {
      const { trainingId } = completeTrainingEndpoint.params.parse(req.params);
      const body = completeTrainingEndpoint.body.parse(req.body);
      res.json({
        data: await trainingService.completeTraining(
          hrisLearningContext(req),
          hrisLearningActor(req),
          trainingId,
          body,
        ),
      });
    },
  );

  router.post(
    "/trainings/:trainingId/enrollments",
    ...common,
    backOffice,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { trainingId } = enrollTrainingEndpoint.params.parse(req.params);
      const body = enrollTrainingEndpoint.body.parse(req.body);
      res.json({
        data: await trainingService.enrollTraining(
          hrisLearningContext(req),
          hrisLearningActor(req),
          trainingId,
          body,
        ),
      });
    },
  );

  router.get(
    "/trainings/:trainingId/enrollments",
    ...common,
    backOffice,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { trainingId } = listTrainingEnrollmentsEndpoint.params.parse(
        req.params,
      );
      const query = listTrainingEnrollmentsEndpoint.query.parse(req.query);
      res.json(
        await trainingService.listTrainingEnrollments(
          hrisLearningContext(req),
          hrisLearningActor(req),
          trainingId,
          query,
        ),
      );
    },
  );

  router.get(
    "/training-certificates",
    ...common,
    eitherSurface,
    requireHrisLearning([...SELF, ...MANAGE]),
    async (req, res) => {
      const query = listTrainingCertificatesEndpoint.query.parse(req.query);
      res.json(
        await trainingService.listTrainingCertificates(
          hrisLearningContext(req),
          hrisLearningActor(req),
          query,
        ),
      );
    },
  );

  return router;
}

/** Mount at `/api/hris` (routes/index.ts). */
export const hrisTrainingRouter = createHrisTrainingRouter();
