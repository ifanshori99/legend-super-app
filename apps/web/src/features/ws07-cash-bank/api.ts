// Typed callers for the cash & bank endpoints the two screens use
// (docs/frontend.md "Typed endpoints and mock mode"). Responses are unwrapped
// from their `{ data }` envelope; components never call these directly, they
// use ./hooks.ts which owns cache keys and invalidation.
//
// Every write mints an idempotency key here (createUlid, the same pattern as
// ws07-accounting/api.ts): a retried click replays the first result instead of
// importing the same CSV or opening a second case.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { createUlid } from "@starter/shared/core";
import {
  actOnReconciliationCase as actOnReconciliationCaseEndpoint,
  createBankAccount as createBankAccountEndpoint,
  createCashDeposit as createCashDepositEndpoint,
  excludeStatementLine as excludeStatementLineEndpoint,
  getFinancePolicy as getFinancePolicyEndpoint,
  getJournal as getJournalEndpoint,
  getReconciliationCase as getReconciliationCaseEndpoint,
  getReconciliationSummary as getReconciliationSummaryEndpoint,
  importBankStatement as importBankStatementEndpoint,
  listBankAccounts as listBankAccountsEndpoint,
  listCashDeposits as listCashDepositsEndpoint,
  listJournals as listJournalsEndpoint,
  listReconciliationCases as listReconciliationCasesEndpoint,
  listStatementLines as listStatementLinesEndpoint,
  listUndepositedCashAlerts as listUndepositedCashAlertsEndpoint,
  matchStatementLine as matchStatementLineEndpoint,
  openReconciliationCase as openReconciliationCaseEndpoint,
  unmatchStatementLine as unmatchStatementLineEndpoint,
  type BankCsvMapping,
  type JournalEntry,
} from "@starter/shared/accounting";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

export type CreateBankAccountBody = Body<typeof createBankAccountEndpoint>;
export type CreateCashDepositBody = Omit<
  Body<typeof createCashDepositEndpoint>,
  "idempotencyKey"
>;
export type BankStatementLineQuery = Query<typeof listStatementLinesEndpoint>;
export type ReconciliationSummaryInput = {
  bankAccountId: string;
  from: string;
  to: string;
};
export type CashDepositQuery = Query<typeof listCashDepositsEndpoint>;
export type ReconciliationCaseQuery = Query<
  typeof listReconciliationCasesEndpoint
>;

export type ImportStatementInput = {
  fileName: string;
  csv: string;
  mapping: BankCsvMapping;
};

// ---- Finance policy -------------------------------------------------------

/** Tenant policy: the matching date tolerance and the undeposited-cash limit. */
export async function fetchFinancePolicy(signal?: AbortSignal) {
  const response = await callEndpoint(getFinancePolicyEndpoint, {}, { signal });
  return response.data;
}

// ---- Bank accounts --------------------------------------------------------

export async function fetchBankAccounts(
  legalEntityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listBankAccountsEndpoint,
    {
      params: {
        legalEntityId,
      } as Params<typeof listBankAccountsEndpoint>,
    },
    { signal },
  );
  return response.data;
}

export async function createBankAccount(body: CreateBankAccountBody) {
  const response = await callEndpoint(createBankAccountEndpoint, { body });
  return response.data;
}

// ---- Statement import -----------------------------------------------------

export async function importBankStatement(
  bankAccountId: string,
  input: ImportStatementInput,
) {
  const response = await callEndpoint(importBankStatementEndpoint, {
    params: {
      bankAccountId,
    } as Params<typeof importBankStatementEndpoint>,
    body: { ...input, idempotencyKey: createUlid() },
  });
  return response.data;
}

// ---- Statement lines and matching -----------------------------------------

export async function fetchStatementLines(
  bankAccountId: string,
  query: BankStatementLineQuery,
  signal?: AbortSignal,
) {
  // The account is a path param in the contract, not a query field.
  return callEndpoint(
    listStatementLinesEndpoint,
    {
      params: { bankAccountId } as Params<typeof listStatementLinesEndpoint>,
      query,
    },
    { signal },
  );
}

export async function matchStatementLine(
  lineId: string,
  refs: Body<typeof matchStatementLineEndpoint>["refs"],
) {
  const response = await callEndpoint(matchStatementLineEndpoint, {
    params: { lineId } as Params<typeof matchStatementLineEndpoint>,
    body: { refs },
  });
  return response.data;
}

export async function excludeStatementLine(lineId: string, reason: string) {
  const response = await callEndpoint(excludeStatementLineEndpoint, {
    params: { lineId } as Params<typeof excludeStatementLineEndpoint>,
    body: { reason },
  });
  return response.data;
}

/**
 * Clears a match — and, because the contract has no un-exclude command, also
 * returns an excluded line to `unmatched` (the wizard/mock does the same).
 */
export async function unmatchStatementLine(lineId: string) {
  const response = await callEndpoint(unmatchStatementLineEndpoint, {
    params: { lineId } as Params<typeof unmatchStatementLineEndpoint>,
    body: { idempotencyKey: createUlid() },
  });
  return response.data;
}

// ---- Reconciliation summary ----------------------------------------------

export async function fetchReconciliationSummary(
  input: ReconciliationSummaryInput,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getReconciliationSummaryEndpoint,
    {
      params: {
        bankAccountId: input.bankAccountId,
      } as Params<typeof getReconciliationSummaryEndpoint>,
      query: { from: input.from, to: input.to },
    },
    { signal },
  );
  return response.data;
}

// ---- Cash deposits --------------------------------------------------------

export async function fetchCashDeposits(
  query: CashDepositQuery,
  signal?: AbortSignal,
) {
  return callEndpoint(listCashDepositsEndpoint, { query }, { signal });
}

export async function createCashDeposit(body: CreateCashDepositBody) {
  const response = await callEndpoint(createCashDepositEndpoint, {
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function fetchUndepositedCashAlerts(
  legalEntityId: string,
  asOf: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listUndepositedCashAlertsEndpoint,
    {
      query: {
        legalEntityId,
        asOf,
      } as Query<typeof listUndepositedCashAlertsEndpoint>,
    },
    { signal },
  );
  return response.data;
}

// ---- Reconciliation cases -------------------------------------------------

export async function fetchReconciliationCases(
  query: ReconciliationCaseQuery,
  signal?: AbortSignal,
) {
  return callEndpoint(listReconciliationCasesEndpoint, { query }, { signal });
}

export async function fetchReconciliationCase(
  caseId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getReconciliationCaseEndpoint,
    {
      params: {
        caseId,
      } as Params<typeof getReconciliationCaseEndpoint>,
    },
    { signal },
  );
  return response.data;
}

export async function openReconciliationCase(
  body: Omit<Body<typeof openReconciliationCaseEndpoint>, "idempotencyKey">,
) {
  const response = await callEndpoint(openReconciliationCaseEndpoint, {
    body: { ...body, idempotencyKey: createUlid() },
  });
  return response.data;
}

export async function actOnReconciliationCase(
  caseId: string,
  action: Body<typeof actOnReconciliationCaseEndpoint>,
) {
  const response = await callEndpoint(actOnReconciliationCaseEndpoint, {
    params: { caseId } as Params<typeof actOnReconciliationCaseEndpoint>,
    body: action,
  });
  return response.data;
}

// ---- Journal documents for matching and gateway recon ---------------------

async function fetchJournalEntry(journalEntryId: string, signal?: AbortSignal) {
  const response = await callEndpoint(
    getJournalEndpoint,
    {
      params: {
        journalEntryId,
      } as Params<typeof getJournalEndpoint>,
    },
    { signal },
  );
  return response.data.entry;
}

async function fetchJournalEntries(
  query: Query<typeof listJournalsEndpoint>,
  signal?: AbortSignal,
): Promise<JournalEntry[]> {
  const page = await callEndpoint(listJournalsEndpoint, { query }, { signal });
  return Promise.all(page.data.map((row) => fetchJournalEntry(row.id, signal)));
}

/**
 * Journals that can match a statement line. The list endpoint returns
 * summaries without account lines, so each candidate is read in full; the
 * page is capped at 30 newest entries of the period.
 */
export async function fetchMatchJournals(
  legalEntityId: string,
  from: string,
  to: string,
  signal?: AbortSignal,
) {
  return fetchJournalEntries({ legalEntityId, from, to, limit: 30 }, signal);
}

/** Gateway settlements of the period, with their fee and bank lines. */
export async function fetchGatewaySettlements(
  legalEntityId: string,
  from: string,
  to: string,
  signal?: AbortSignal,
) {
  return fetchJournalEntries(
    { legalEntityId, from, to, sourceType: "gateway_settlement", limit: 100 },
    signal,
  );
}
