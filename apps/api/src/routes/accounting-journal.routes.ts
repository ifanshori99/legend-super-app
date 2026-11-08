// Manual + recurring journal HTTP routes (PRD v1.7 §3.19 "Jurnal Manual",
// "Jurnal Berulang"; bead legend-vmyg). Paths and schemas come from
// `@starter/shared/accounting`. Tenant comes from the server-minted context
// (TEN-02); permissions come from stored role assignments (TEN-03). The
// requester never approves or rejects their own request (AUTH-06): the
// services enforce it, the routes only pass the verified actor id.

import { Router, type Request } from "express";
import {
  approveManualJournal,
  cancelManualJournal,
  createManualJournal,
  createRecurringJournal,
  getManualJournal,
  listManualJournals,
  listRecurringJournals,
  rejectManualJournal,
  submitManualJournal,
  transitionRecurringJournalEndpoint,
  updateManualJournal,
  withdrawManualJournal,
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
  approveManualJournal as approveManualJournalService,
  cancelManualJournal as cancelManualJournalService,
  createManualJournal as createManualJournalService,
  getManualJournal as getManualJournalService,
  listManualJournals as listManualJournalsService,
  rejectManualJournal as rejectManualJournalService,
  submitManualJournal as submitManualJournalService,
  updateManualJournal as updateManualJournalService,
  withdrawManualJournal as withdrawManualJournalService,
} from "../services/accounting-journal-manual.service";
import {
  createRecurringJournal as createRecurringJournalService,
  listRecurringJournals as listRecurringJournalsService,
  transitionRecurringJournal as transitionRecurringJournalService,
} from "../services/accounting-journal-recurring.service";

export const accountingJournalRouter = Router();

accountingJournalRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

const view = requireTenantPermission("accounting.journal.view");
const post = requireTenantPermission("accounting.journal.post");

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

// ---- Manual journals -------------------------------------------------------

accountingJournalRouter.get(
  route(listManualJournals.path),
  view,
  async (req, res) => {
    const query = listManualJournals.query.parse(req.query);
    res.json(
      await listManualJournalsService(getScopedTenantContext(req), query),
    );
  },
);

accountingJournalRouter.post(
  route(createManualJournal.path),
  post,
  jsonBody,
  async (req, res) => {
    const input = createManualJournal.body.parse(req.body);
    const journal = await createManualJournalService(
      getScopedTenantContext(req),
      actorId(req),
      input,
    );
    res
      .status(201)
      .location(`${BASE}/manual-journals/${journal.id}`)
      .json({ data: journal });
  },
);

accountingJournalRouter.get(
  route(getManualJournal.path),
  view,
  async (req, res) => {
    const { manualJournalId } = getManualJournal.params.parse(req.params);
    res.json({
      data: await getManualJournalService(
        getScopedTenantContext(req),
        manualJournalId,
      ),
    });
  },
);

accountingJournalRouter.patch(
  route(updateManualJournal.path),
  post,
  jsonBody,
  async (req, res) => {
    const { manualJournalId } = updateManualJournal.params.parse(req.params);
    const input = updateManualJournal.body.parse(req.body);
    res.json({
      data: await updateManualJournalService(
        getScopedTenantContext(req),
        actorId(req),
        manualJournalId,
        input,
      ),
    });
  },
);

accountingJournalRouter.post(
  route(submitManualJournal.path),
  post,
  jsonBody,
  async (req, res) => {
    const { manualJournalId } = submitManualJournal.params.parse(req.params);
    submitManualJournal.body.parse(req.body);
    res.json({
      data: await submitManualJournalService(
        getScopedTenantContext(req),
        actorId(req),
        manualJournalId,
      ),
    });
  },
);

accountingJournalRouter.post(
  route(withdrawManualJournal.path),
  post,
  jsonBody,
  async (req, res) => {
    const { manualJournalId } = withdrawManualJournal.params.parse(req.params);
    withdrawManualJournal.body.parse(req.body);
    res.json({
      data: await withdrawManualJournalService(
        getScopedTenantContext(req),
        actorId(req),
        manualJournalId,
      ),
    });
  },
);

accountingJournalRouter.post(
  route(approveManualJournal.path),
  post,
  jsonBody,
  async (req, res) => {
    const { manualJournalId } = approveManualJournal.params.parse(req.params);
    approveManualJournal.body.parse(req.body);
    res.json({
      data: await approveManualJournalService(
        getScopedTenantContext(req),
        actorId(req),
        manualJournalId,
      ),
    });
  },
);

accountingJournalRouter.post(
  route(rejectManualJournal.path),
  post,
  jsonBody,
  async (req, res) => {
    const { manualJournalId } = rejectManualJournal.params.parse(req.params);
    const { reason } = rejectManualJournal.body.parse(req.body);
    res.json({
      data: await rejectManualJournalService(
        getScopedTenantContext(req),
        actorId(req),
        manualJournalId,
        reason,
      ),
    });
  },
);

accountingJournalRouter.post(
  route(cancelManualJournal.path),
  post,
  jsonBody,
  async (req, res) => {
    const { manualJournalId } = cancelManualJournal.params.parse(req.params);
    cancelManualJournal.body.parse(req.body);
    res.json({
      data: await cancelManualJournalService(
        getScopedTenantContext(req),
        actorId(req),
        manualJournalId,
      ),
    });
  },
);

// ---- Recurring journals ----------------------------------------------------

accountingJournalRouter.get(
  route(listRecurringJournals.path),
  view,
  async (req, res) => {
    const { legalEntityId } = listRecurringJournals.query.parse(req.query);
    res.json(
      await listRecurringJournalsService(
        getScopedTenantContext(req),
        legalEntityId,
      ),
    );
  },
);

accountingJournalRouter.post(
  route(createRecurringJournal.path),
  post,
  jsonBody,
  async (req, res) => {
    const input = createRecurringJournal.body.parse(req.body);
    const template = await createRecurringJournalService(
      getScopedTenantContext(req),
      actorId(req),
      input,
    );
    res
      .status(201)
      .location(`${BASE}/recurring-journals/${template.id}`)
      .json({ data: template });
  },
);

accountingJournalRouter.post(
  route(transitionRecurringJournalEndpoint.path),
  post,
  jsonBody,
  async (req, res) => {
    const { recurringJournalId } =
      transitionRecurringJournalEndpoint.params.parse(req.params);
    const body = transitionRecurringJournalEndpoint.body.parse(req.body);
    res.json({
      data: await transitionRecurringJournalService(
        getScopedTenantContext(req),
        actorId(req),
        recurringJournalId,
        body,
      ),
    });
  },
);
