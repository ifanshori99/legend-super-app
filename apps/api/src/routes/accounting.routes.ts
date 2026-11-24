// Accounting core HTTP routes (PRD v1.7 §3.19, §6 F; ACC-01/ACC-02; bead
// legend-kwxj). Paths and schemas come from `@starter/shared/accounting` —
// the same objects the FE client and mock mode use. Tenant comes from the
// server-minted context (TEN-02), never from params or bodies; permissions come
// from stored role assignments through requireTenantPermission (TEN-03).

import { Router, type Request } from "express";
import {
  approvePeriodReopen,
  closeFiscalPeriod,
  closeFiscalPeriodOverride,
  createAccount,
  downloadTaxReport,
  exportTaxReport,
  finalizeTaxReport,
  generateTaxReport,
  getBalanceSheet,
  getCashFlow,
  getEquityChanges,
  getJournal,
  getPeriodSnapshot,
  getProfitAndLoss,
  getTrialBalance,
  listAccountMappings,
  listAccounts,
  listFiscalPeriods,
  listJournals,
  listPeriodCloseBlockers,
  listPeriodReopenRequests,
  listTaxReports,
  rejectPeriodReopen,
  replaceAccountMappings,
  requestPeriodReopen,
  reverseJournal,
  updateAccount,
} from "@starter/shared/accounting";
import { userIdSchema } from "@starter/shared/core";
import { HttpError } from "../lib/http-error";
import { sessionMfaVerifiedAt } from "../lib/mfa";
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
import {
  approvePeriodReopen as approvePeriodReopenService,
  closeFiscalPeriod as closeFiscalPeriodService,
  closeFiscalPeriodOverride as closeFiscalPeriodOverrideService,
  getPeriodSnapshot as getPeriodSnapshotService,
  listPeriodCloseBlockers as listPeriodCloseBlockersService,
  listPeriodReopenRequests as listPeriodReopenRequestsService,
  rejectPeriodReopen as rejectPeriodReopenService,
  requestPeriodReopen as requestPeriodReopenService,
} from "../services/accounting-period-close.service";
import { listFiscalPeriods as listFiscalPeriodsService } from "../services/accounting-period.service";
import {
  getBalanceSheet as getBalanceSheetService,
  getCashFlow as getCashFlowService,
  getEquityChanges as getEquityChangesService,
  getProfitAndLoss as getProfitAndLossService,
  getTrialBalance as getTrialBalanceService,
} from "../services/accounting-statements.service";
import {
  downloadTaxReport as downloadTaxReportService,
  exportTaxReport as exportTaxReportService,
  finalizeTaxReport as finalizeTaxReportService,
  generateTaxReport as generateTaxReportService,
  listTaxReports as listTaxReportsService,
} from "../services/accounting-tax-reports.service";
import type { StorageRuntime } from "../services/core-storage-runtime";

export const accountingRouter = Router();

accountingRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

// CoA and journal master data are finance reads/writes; the catalog has one
// view code and one post code for the whole accounting domain (§3.16 F16).
const view = requireTenantPermission("accounting.journal.view");
const post = requireTenantPermission("accounting.journal.post");
// Close and reopen request share one code; approve/reject is a separate code so
// the approver can differ from the requester and closer (ACC-02).
const closePeriod = requireTenantPermission("accounting.period.close");
// Card 1263: closing over incomplete production batches needs this on top of
// the normal close permission, and a verified second factor.
const overrideClose = requireTenantPermission(
  "accounting.period.close_override",
);
const approveReopen = requireTenantPermission(
  "accounting.period_reopen.approve",
);
// Tax reports: reading uses the accounting view code; generate, finalize and
// export are the tax report manager's (PRD §3.19 Pajak).
const manageTaxReport = requireTenantPermission("accounting.tax_report.manage");

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

accountingRouter.post(
  route(closeFiscalPeriod.path),
  closePeriod,
  jsonBody,
  async (req, res) => {
    const { fiscalPeriodId } = closeFiscalPeriod.params.parse(req.params);
    const input = closeFiscalPeriod.body.parse(req.body);
    res.json({
      data: await closeFiscalPeriodService(
        getScopedTenantContext(req),
        fiscalPeriodId,
        input,
        actorId(req),
      ),
    });
  },
);

accountingRouter.get(
  route(listPeriodCloseBlockers.path),
  closePeriod,
  async (req, res) => {
    const { fiscalPeriodId } = listPeriodCloseBlockers.params.parse(req.params);
    res.json({
      data: await listPeriodCloseBlockersService(
        getScopedTenantContext(req),
        fiscalPeriodId,
      ),
    });
  },
);

accountingRouter.post(
  route(closeFiscalPeriodOverride.path),
  closePeriod,
  overrideClose,
  jsonBody,
  async (req, res) => {
    const { fiscalPeriodId } = closeFiscalPeriodOverride.params.parse(
      req.params,
    );
    const input = closeFiscalPeriodOverride.body.parse(req.body);
    res.json({
      data: await closeFiscalPeriodOverrideService(
        getScopedTenantContext(req),
        fiscalPeriodId,
        input,
        actorId(req),
        // An acting cashier never inherits the session owner's second factor.
        {
          mfaVerified:
            !req.actingStaff && (await sessionMfaVerifiedAt(req)) !== null,
        },
      ),
    });
  },
);

accountingRouter.get(route(getPeriodSnapshot.path), view, async (req, res) => {
  const { fiscalPeriodId } = getPeriodSnapshot.params.parse(req.params);
  res.json({
    data: await getPeriodSnapshotService(
      getScopedTenantContext(req),
      fiscalPeriodId,
    ),
  });
});

accountingRouter.post(
  route(requestPeriodReopen.path),
  closePeriod,
  jsonBody,
  async (req, res) => {
    const { fiscalPeriodId } = requestPeriodReopen.params.parse(req.params);
    const input = requestPeriodReopen.body.parse(req.body);
    res.status(201).json({
      data: await requestPeriodReopenService(
        getScopedTenantContext(req),
        fiscalPeriodId,
        input,
        actorId(req),
      ),
    });
  },
);

accountingRouter.get(
  route(listPeriodReopenRequests.path),
  view,
  async (req, res) => {
    const { legalEntityId } = listPeriodReopenRequests.params.parse(req.params);
    res.json(
      await listPeriodReopenRequestsService(
        getScopedTenantContext(req),
        legalEntityId,
      ),
    );
  },
);

accountingRouter.post(
  route(approvePeriodReopen.path),
  approveReopen,
  jsonBody,
  async (req, res) => {
    const { requestId } = approvePeriodReopen.params.parse(req.params);
    const input = approvePeriodReopen.body.parse(req.body);
    res.json({
      data: await approvePeriodReopenService(
        getScopedTenantContext(req),
        requestId,
        input,
        actorId(req),
      ),
    });
  },
);

accountingRouter.post(
  route(rejectPeriodReopen.path),
  approveReopen,
  jsonBody,
  async (req, res) => {
    const { requestId } = rejectPeriodReopen.params.parse(req.params);
    const input = rejectPeriodReopen.body.parse(req.body);
    res.json({
      data: await rejectPeriodReopenService(
        getScopedTenantContext(req),
        requestId,
        input,
        actorId(req),
      ),
    });
  },
);

accountingRouter.get(route(getTrialBalance.path), view, async (req, res) => {
  const query = getTrialBalance.query.parse(req.query);
  res.json({
    data: await getTrialBalanceService(getScopedTenantContext(req), query),
  });
});

accountingRouter.get(route(getBalanceSheet.path), view, async (req, res) => {
  const query = getBalanceSheet.query.parse(req.query);
  res.json({
    data: await getBalanceSheetService(getScopedTenantContext(req), query),
  });
});

accountingRouter.get(route(getProfitAndLoss.path), view, async (req, res) => {
  const query = getProfitAndLoss.query.parse(req.query);
  res.json({
    data: await getProfitAndLossService(getScopedTenantContext(req), query),
  });
});

accountingRouter.get(route(getCashFlow.path), view, async (req, res) => {
  const query = getCashFlow.query.parse(req.query);
  res.json({
    data: await getCashFlowService(getScopedTenantContext(req), query),
  });
});

accountingRouter.get(route(getEquityChanges.path), view, async (req, res) => {
  const query = getEquityChanges.query.parse(req.query);
  res.json({
    data: await getEquityChangesService(getScopedTenantContext(req), query),
  });
});

accountingRouter.get(route(listTaxReports.path), view, async (req, res) => {
  const query = listTaxReports.query.parse(req.query);
  res.json(await listTaxReportsService(getScopedTenantContext(req), query));
});

accountingRouter.post(
  route(generateTaxReport.path),
  manageTaxReport,
  jsonBody,
  async (req, res) => {
    const input = generateTaxReport.body.parse(req.body);
    const report = await generateTaxReportService(
      getScopedTenantContext(req),
      actorId(req),
      input,
    );
    res
      .status(201)
      .location(`${BASE}/tax-reports/${report.id}`)
      .json({ data: report });
  },
);

accountingRouter.post(
  route(finalizeTaxReport.path),
  manageTaxReport,
  jsonBody,
  async (req, res) => {
    const { taxReportId } = finalizeTaxReport.params.parse(req.params);
    const body = finalizeTaxReport.body.parse(req.body);
    res.json({
      data: await finalizeTaxReportService(
        getScopedTenantContext(req),
        actorId(req),
        taxReportId,
        body,
      ),
    });
  },
);

/**
 * Tax report files (export and download) need the object storage, which only
 * createApp knows. Mounted at `/api/accounting` by createStorageApiRouter, next
 * to the attendance routers; without a runtime both answer 503.
 */
export function createAccountingTaxFileRouter(options: {
  runtime: StorageRuntime | null;
}): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);
  const runtime = () => {
    if (!options.runtime)
      throw new HttpError(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan berkas belum tersedia.",
      );
    return options.runtime;
  };

  router.post(
    route(exportTaxReport.path),
    manageTaxReport,
    jsonBody,
    async (req, res) => {
      const { taxReportId } = exportTaxReport.params.parse(req.params);
      exportTaxReport.body.parse(req.body);
      res.json({
        data: await exportTaxReportService(
          getScopedTenantContext(req),
          actorId(req),
          taxReportId,
          runtime(),
        ),
      });
    },
  );

  router.get(route(downloadTaxReport.path), view, async (req, res) => {
    const { taxReportId } = downloadTaxReport.params.parse(req.params);
    res.json({
      data: await downloadTaxReportService(
        getScopedTenantContext(req),
        taxReportId,
        runtime(),
      ),
    });
  });
  return router;
}
