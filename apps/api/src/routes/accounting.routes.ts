// Accounting core HTTP routes (PRD v1.7 §3.19, §6 F; ACC-01/ACC-02; bead
// legend-kwxj). Paths and schemas come from `@starter/shared/accounting` —
// the same objects the FE client and mock mode use. Tenant comes from the
// server-minted context (TEN-02), never from params or bodies; permissions come
// from stored role assignments through requireTenantPermission (TEN-03).

import { Router, type Request } from "express";
import {
  createAccount,
  getJournal,
  listAccountMappings,
  listAccounts,
  listFiscalPeriods,
  listJournals,
  replaceAccountMappings,
  reverseJournal,
  updateAccount,
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
  createAccount as createAccountService,
  listAccountMappings as listAccountMappingsService,
  listAccounts as listAccountsService,
  replaceAccountMappingsForEntity,
  updateAccount as updateAccountService,
} from "../services/accounting-accounts.service";
import {
  getJournal as getJournalService,
  listJournals as listJournalsService,
  reverseJournal as reverseJournalService,
} from "../services/accounting-journal.service";
import { listFiscalPeriods as listFiscalPeriodsService } from "../services/accounting-period.service";

export const accountingRouter = Router();

accountingRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

// CoA and journal master data are finance reads/writes; the catalog has one
// view code and one post code for the whole accounting domain (§3.16 F16).
const view = requireTenantPermission("accounting.journal.view");
const post = requireTenantPermission("accounting.journal.post");

const BASE = "/api/accounting";
const route = (path: string) => path.slice(BASE.length) || "/";
const actorId = (req: Request) => userIdSchema.parse(getAuth(req).user.id);

accountingRouter.get(route(listAccounts.path), view, async (req, res) => {
  const { legalEntityId } = listAccounts.params.parse(req.params);
  res.json(
    await listAccountsService(getScopedTenantContext(req), legalEntityId),
  );
});

accountingRouter.post(
  route(createAccount.path),
  post,
  jsonBody,
  async (req, res) => {
    const { legalEntityId } = createAccount.params.parse(req.params);
    const input = createAccount.body.parse(req.body);
    const account = await createAccountService(
      getScopedTenantContext(req),
      legalEntityId,
      input,
      actorId(req),
    );
    res
      .status(201)
      .location(`${BASE}/accounts/${account.id}`)
      .json({ data: account });
  },
);

accountingRouter.patch(
  route(updateAccount.path),
  post,
  jsonBody,
  async (req, res) => {
    const { accountId } = updateAccount.params.parse(req.params);
    const input = updateAccount.body.parse(req.body);
    res.json({
      data: await updateAccountService(
        getScopedTenantContext(req),
        accountId,
        input,
        actorId(req),
      ),
    });
  },
);

accountingRouter.get(
  route(listAccountMappings.path),
  view,
  async (req, res) => {
    const { legalEntityId } = listAccountMappings.params.parse(req.params);
    res.json(
      await listAccountMappingsService(
        getScopedTenantContext(req),
        legalEntityId,
      ),
    );
  },
);

accountingRouter.put(
  route(replaceAccountMappings.path),
  post,
  jsonBody,
  async (req, res) => {
    const { legalEntityId } = replaceAccountMappings.params.parse(req.params);
    const input = replaceAccountMappings.body.parse(req.body);
    res.json(
      await replaceAccountMappingsForEntity(
        getScopedTenantContext(req),
        legalEntityId,
        input,
        actorId(req),
      ),
    );
  },
);

accountingRouter.get(route(listJournals.path), view, async (req, res) => {
  const query = listJournals.query.parse(req.query);
  res.json(await listJournalsService(getScopedTenantContext(req), query));
});

accountingRouter.get(route(getJournal.path), view, async (req, res) => {
  const { journalEntryId } = getJournal.params.parse(req.params);
  res.json({
    data: await getJournalService(getScopedTenantContext(req), journalEntryId),
  });
});

accountingRouter.post(
  route(reverseJournal.path),
  post,
  jsonBody,
  async (req, res) => {
    const { journalEntryId } = reverseJournal.params.parse(req.params);
    const input = reverseJournal.body.parse(req.body);
    const entry = await reverseJournalService(
      getScopedTenantContext(req),
      journalEntryId,
      input,
      actorId(req),
    );
    res
      .status(201)
      .location(`${BASE}/journals/${entry.id}`)
      .json({ data: entry });
  },
);

accountingRouter.get(route(listFiscalPeriods.path), view, async (req, res) => {
  const { legalEntityId } = listFiscalPeriods.params.parse(req.params);
  res.json(
    await listFiscalPeriodsService(getScopedTenantContext(req), legalEntityId),
  );
});

// Close/reopen with snapshot and approval is bead legend-xm30; this bead owns
// the fiscal period table, its list endpoint and the posting guard (ACC-02).
