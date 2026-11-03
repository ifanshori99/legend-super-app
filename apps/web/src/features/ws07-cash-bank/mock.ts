// Mock handlers for the cash & bank screens (`VITE_API_MOCK=true`), so both
// screens work with no API (docs/frontend.md "Typed endpoints and mock mode").
// They serve the Cafe Legend banking fixtures and run the contract's own rules:
// CSV parsing/dedupe, the deterministic matcher, the auto-match rate, FIFO
// undeposited-cash alerts (ACC-05) and the reconciliation-case state machine
// (ACC-04). Mutations live in a mock store, so the screens are clickable and
// every store re-seeds on resetMocks().
//
// Loaded in Node by tests/ws07-cash-bank.test.mjs, so every import here is a
// bare package import or a relative `.ts` path (no `@/` alias).
//
// Identity in mock mode: imports are performed by the fixture's finance user
// and deposits by the outlet manager, because the mock has no session. A real
// API takes the actor from the session.
import {
  AccountingError,
  actOnReconciliationCase,
  addDays,
  assertManualMatch,
  autoMatchRateBp,
  bankAccountSchema,
  bankStatementImportSchema,
  bankStatementLineSchema,
  cafeLegendAccountingFixtures,
  cashDepositSchema,
  createBankAccount,
  createCashDeposit,
  daysBetween,
  excludeStatementLine,
  findStatementMatch,
  getReconciliationCase,
  getReconciliationSummary,
  importBankStatement,
  listBankAccounts,
  listCashDeposits,
  listReconciliationCases,
  listStatementLines,
  listUndepositedCashAlerts,
  maskAccountNumber,
  matchStatementLine,
  openReconciliationCase,
  reconciliationCaseSchema,
  transitionReconciliationCase,
  undepositedCashAlerts,
  unmatchStatementLine,
  type BankAccount,
  type BankStatementImport,
  type BankStatementLine,
  type CashCollection,
  type CashDeposit,
  type MatchCandidate,
  type ReconciliationCase,
  type ReconciliationRef,
} from "@starter/shared/accounting";
import type { OutletId, UserId } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { AnyEndpoint } from "@starter/shared/api";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock, type MockHandler } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import {
  buildImportPreview,
  businessDateToday,
  candidateKey,
  journalBankAmount,
  matchCandidates,
} from "./lib.ts";

const fixtures = cafeLegendAccountingFixtures;
const tenantId = fixtures.tenantId;
const finance = fixtures.users.finance as UserId;
const outletManager = fixtures.users.outletManager as UserId;

/** Extra sample rows so every screen state is reachable in mock mode. */
export const CASH_BANK_MOCK_IDS = {
  unmatchedFee: "b1000000-0000-4000-8000-000000000009",
  depositCandidate: "b1000000-0000-4000-8000-000000000010",
  secondBankAccount: "ba000000-0000-4000-8000-000000000002",
} as const;

type CashBankMockState = {
  bankAccounts: BankAccount[];
  imports: BankStatementImport[];
  statementLines: BankStatementLine[];
  deposits: CashDeposit[];
  cases: ReconciliationCase[];
  collections: CashCollection[];
  /** Idempotency replay: request key → created id. */
  created: Map<string, string>;
};

function seedState(): CashBankMockState {
  const bankAccounts = [
    fixtures.bankAccount,
    bankAccountSchema.parse({
      id: CASH_BANK_MOCK_IDS.secondBankAccount,
      tenantId,
      legalEntityId: fixtures.legalEntity.id,
      bank: "Mandiri",
      accountName: "PT Sultan Solusi Nusantara",
      accountNumberMasked: "****7702",
      // The sample chart has one bank GL account; a second one is tenant data.
      glAccountId: fixtures.accountByCode("1103").id,
      isActive: true,
    }),
  ];
  const statementLines = [
    ...fixtures.statementLines,
    bankStatementLineSchema.parse({
      id: CASH_BANK_MOCK_IDS.unmatchedFee,
      tenantId,
      bankAccountId: fixtures.bankAccount.id,
      importId: fixtures.statementImport.id,
      postedOn: "2026-11-04",
      amountIdr: -23_500,
      description: "BIAYA MATERAI KARTU",
      externalRef: null,
      dedupeKey: "mock|unmatched-fee",
      matchStatus: "unmatched",
      matchedRefs: [],
      reconciliationCaseId: null,
      excludedReason: null,
    }),
    bankStatementLineSchema.parse({
      id: CASH_BANK_MOCK_IDS.depositCandidate,
      tenantId,
      bankAccountId: fixtures.bankAccount.id,
      importId: fixtures.statementImport.id,
      postedOn: "2026-11-03",
      amountIdr: 250_000,
      description: "SETORAN TUNAI BDG-02",
      externalRef: "SLIP-0311-02",
      dedupeKey: "mock|deposit-candidate",
      matchStatus: "unmatched",
      matchedRefs: [],
      reconciliationCaseId: null,
      excludedReason: null,
    }),
  ];
  const collections: CashCollection[] = [
    // Sample data for the ACC-05 warning: the 30 October cash of this outlet
    // has no deposit yet, so it passes the two-day policy once it is a few
    // days old. The contract helper allocates deposits FIFO per outlet.
    {
      outletId: fixtures.outletId as OutletId,
      businessDate: "2026-10-30",
      cashIdr: 500_000 as CashCollection["cashIdr"],
    },
    ...fixtures.cashCollections,
  ];
  return {
    bankAccounts,
    imports: [fixtures.statementImport],
    statementLines,
    deposits: [...fixtures.cashDeposits],
    cases: [...fixtures.reconciliationCases],
    collections,
    created: new Map(),
  };
}

const state = createMockStore<CashBankMockState>(seedState);

/**
 * Registers a handler and maps the contract's own errors the way the API does:
 * `AccountingError` carries `code` and `status`, but the mock runtime only
 * knows `ApiError`/`CoreError`, so a refusal would surface as INTERNAL_ERROR.
 */
function register<E extends AnyEndpoint>(
  endpoint: E,
  handler: MockHandler<E>,
): void {
  registerMock(endpoint, (context) => {
    try {
      return handler(context);
    } catch (error) {
      if (error instanceof AccountingError)
        throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function notFound(message: string): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

function invalid(message: string): ApiError {
  return new ApiError(422, "VALIDATION_ERROR", message);
}

function conflict(message: string): ApiError {
  return new ApiError(409, "INVALID_TRANSITION", message);
}

// ---- Shared helpers -------------------------------------------------------

function findAccount(bankAccountId: string): BankAccount {
  const account = state
    .get()
    .bankAccounts.find((row) => row.id === bankAccountId);
  if (!account) throw notFound("Rekening bank tidak ditemukan.");
  return account;
}

function findLine(lineId: string): BankStatementLine {
  const line = state.get().statementLines.find((row) => row.id === lineId);
  if (!line) throw notFound("Baris mutasi tidak ditemukan.");
  return line;
}

function replaceLine(next: BankStatementLine): void {
  const lines = state.get().statementLines;
  const index = lines.findIndex((row) => row.id === next.id);
  if (index === -1) throw notFound("Baris mutasi tidak ditemukan.");
  lines[index] = next;
}

function replaceCase(next: ReconciliationCase): void {
  const cases = state.get().cases;
  const index = cases.findIndex((row) => row.id === next.id);
  if (index === -1) throw notFound("Kasus rekonsiliasi tidak ditemukan.");
  cases[index] = next;
}

function occupiedKeys(bankAccountId: string, exceptLineId?: string) {
  const occupied = new Set<string>();
  for (const line of state.get().statementLines) {
    if (line.bankAccountId !== bankAccountId) continue;
    if (line.id === exceptLineId) continue;
    for (const ref of line.matchedRefs) occupied.add(candidateKey(ref));
  }
  return occupied;
}

function candidatesFor(
  account: BankAccount,
  exceptLineId?: string,
): MatchCandidate[] {
  return matchCandidates(
    fixtures.journals,
    state.get().deposits.filter((row) => row.bankAccountId === account.id),
    account.id,
    account.glAccountId,
    occupiedKeys(account.id, exceptLineId),
  );
}

function autoMatchLine(
  line: BankStatementLine,
  account: BankAccount,
): BankStatementLine {
  const outcome = findStatementMatch(
    line,
    candidatesFor(account, line.id),
    fixtures.matchingPolicy,
  );
  if (outcome.kind !== "auto") return line;
  return bankStatementLineSchema.parse({
    ...line,
    matchStatus: "auto_matched",
    matchedRefs: [outcome.ref],
  });
}

/** The signed bank movement a referenced document carries. */
function documentAmount(ref: ReconciliationRef, account: BankAccount): number {
  switch (ref.type) {
    case "journal_entry": {
      const entry = fixtures.journals.find((row) => row.id === ref.id);
      if (!entry) throw notFound("Jurnal tidak ditemukan.");
      const amount = journalBankAmount(entry, account.glAccountId);
      if (amount === null)
        throw notFound("Jurnal ini tidak menyentuh rekening yang dipilih.");
      return amount;
    }
    case "cash_deposit": {
      const deposit = state.get().deposits.find((row) => row.id === ref.id);
      if (!deposit) throw notFound("Setoran kas tidak ditemukan.");
      return deposit.amountIdr;
    }
    case "bank_statement_line": {
      const line = state.get().statementLines.find((row) => row.id === ref.id);
      if (!line) throw notFound("Baris mutasi tidak ditemukan.");
      return line.amountIdr;
    }
    case "gateway_settlement":
    case "edc_settlement":
    case "supplier_payment": {
      const entry = fixtures.journals.find((row) => row.sourceId === ref.id);
      if (!entry) throw notFound("Dokumen settlement tidak ditemukan.");
      const amount = journalBankAmount(entry, account.glAccountId);
      if (amount === null)
        throw notFound("Dokumen ini tidak menyentuh rekening yang dipilih.");
      return amount;
    }
  }
}

function refExists(ref: ReconciliationRef): boolean {
  switch (ref.type) {
    case "journal_entry":
      return fixtures.journals.some((row) => row.id === ref.id);
    case "cash_deposit":
      return state.get().deposits.some((row) => row.id === ref.id);
    case "bank_statement_line":
      return state.get().statementLines.some((row) => row.id === ref.id);
    case "gateway_settlement":
    case "edc_settlement":
    case "supplier_payment":
      return fixtures.journals.some((row) => row.sourceId === ref.id);
  }
}

/** A matched statement line marks its cash deposits as matched (ACC-05). */
function syncDepositsForLine(line: BankStatementLine): void {
  const depositIds = new Set(
    line.matchedRefs
      .filter((ref) => ref.type === "cash_deposit")
      .map((ref) => ref.id),
  );
  if (depositIds.size === 0) return;
  const deposits = state.get().deposits;
  for (let index = 0; index < deposits.length; index += 1) {
    const deposit = deposits[index];
    if (!depositIds.has(deposit.id)) continue;
    deposits[index] = cashDepositSchema.parse({
      ...deposit,
      status: "matched",
      bankStatementLineId: line.id,
    });
  }
}

function releaseDepositsForLine(line: BankStatementLine): void {
  const deposits = state.get().deposits;
  for (let index = 0; index < deposits.length; index += 1) {
    const deposit = deposits[index];
    if (deposit.bankStatementLineId !== line.id) continue;
    deposits[index] = cashDepositSchema.parse({
      ...deposit,
      status: "recorded",
      bankStatementLineId: null,
    });
  }
}

// ---- Bank accounts --------------------------------------------------------

register(listBankAccounts, ({ params, scenario }) => {
  if (scenario === "empty") return { data: [] };
  const rows = state
    .get()
    .bankAccounts.filter(
      (account) => account.legalEntityId === params.legalEntityId,
    )
    .sort(
      (a, b) =>
        a.bank.localeCompare(b.bank, "id-ID") || a.id.localeCompare(b.id),
    );
  return { data: rows };
});

register(createBankAccount, ({ body }) => {
  const current = state.get();
  const masked = maskAccountNumber(body.accountNumber);
  const siblings = current.bankAccounts.filter(
    (account) => account.legalEntityId === body.legalEntityId,
  );
  if (siblings.some((account) => account.accountNumberMasked === masked))
    throw new ApiError(
      409,
      "CONFLICT",
      "Nomor rekening ini sudah terdaftar di badan usaha yang sama.",
    );
  const glAccount = fixtures.accounts.find(
    (account) =>
      account.id === body.glAccountId &&
      account.legalEntityId === body.legalEntityId,
  );
  if (!glAccount)
    throw invalid(
      "Akun buku besar tidak ditemukan di badan usaha yang dipilih.",
    );
  const account = bankAccountSchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    legalEntityId: body.legalEntityId,
    bank: body.bank,
    accountName: body.accountName,
    accountNumberMasked: masked,
    glAccountId: body.glAccountId,
    isActive: true,
  });
  current.bankAccounts.push(account);
  return { data: account };
});

// ---- Statement import -----------------------------------------------------

register(importBankStatement, ({ params, body }) => {
  const account = findAccount(params.bankAccountId);
  const current = state.get();
  const replayKey = `import:${account.id}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const existing = current.imports.find((row) => row.id === replayed);
    if (existing) return { data: existing };
  }
  const existingKeys = current.statementLines
    .filter((line) => line.bankAccountId === account.id)
    .map((line) => line.dedupeKey);
  const preview = buildImportPreview(body.csv, body.mapping, existingKeys);
  if (preview.rows.length === 0)
    throw invalid("Tidak ada baris data yang bisa dibaca dari CSV ini.");
  const firstError = preview.rows.find((row) => row.status === "error");
  if (firstError)
    throw new ApiError(
      422,
      "STATEMENT_VALUE_INVALID",
      `Baris ${firstError.rowNumber} tidak bisa dibaca. Perbaiki berkas lalu unggah ulang.`,
    );

  const importId = newIdempotencyKey();
  let autoMatchedCount = 0;
  const postedDates: string[] = [];
  for (const row of preview.rows) {
    if (
      row.status !== "ready" ||
      row.postedOn === null ||
      row.amountIdr === null ||
      row.dedupeKey === null
    )
      continue;
    postedDates.push(row.postedOn);
    let line = bankStatementLineSchema.parse({
      id: newIdempotencyKey(),
      tenantId,
      bankAccountId: account.id,
      importId,
      postedOn: row.postedOn,
      amountIdr: row.amountIdr,
      description: row.description,
      externalRef: row.externalRef,
      dedupeKey: row.dedupeKey,
      matchStatus: "unmatched",
      matchedRefs: [],
      reconciliationCaseId: null,
      excludedReason: null,
    });
    line = autoMatchLine(line, account);
    if (line.matchStatus === "auto_matched") autoMatchedCount += 1;
    current.statementLines.push(line);
  }
  postedDates.sort();
  const record = bankStatementImportSchema.parse({
    id: importId,
    tenantId,
    bankAccountId: account.id,
    fileName: body.fileName,
    importedBy: finance,
    importedAt: nowIso(),
    lineCount: preview.rows.length,
    duplicateCount: preview.duplicateCount,
    autoMatchedCount,
    postedFrom: postedDates[0] ?? null,
    postedTo: postedDates.at(-1) ?? null,
  });
  current.imports.push(record);
  current.created.set(replayKey, record.id);
  return { data: record };
});

// ---- Statement lines and matching -----------------------------------------

register(listStatementLines, ({ params, query, scenario }) => {
  const rows = state
    .get()
    .statementLines.filter(
      (line) => line.bankAccountId === params.bankAccountId,
    )
    .filter((line) => line.postedOn >= query.from && line.postedOn <= query.to)
    .filter(
      (line) => !query.matchStatus || line.matchStatus === query.matchStatus,
    )
    .sort(
      (a, b) =>
        b.postedOn.localeCompare(a.postedOn) || b.id.localeCompare(a.id),
    );
  return paginateFixture(
    rows,
    { cursor: query.cursor, limit: query.limit },
    (row) => row.id,
    scenario,
  );
});

register(matchStatementLine, ({ params, body }) => {
  const line = findLine(params.lineId);
  const account = findAccount(line.bankAccountId);
  if (line.matchStatus === "excluded")
    throw conflict("Batalkan pengecualian baris ini sebelum mencocokkan.");
  if (line.matchStatus === "in_case")
    throw conflict("Selesaikan kasus baris ini sebelum mencocokkan.");
  const documents = body.refs.map((ref) => ({
    amountIdr: documentAmount(ref, account),
  }));
  assertManualMatch(line, documents);
  const next = bankStatementLineSchema.parse({
    ...line,
    matchStatus: "manually_matched",
    matchedRefs: body.refs,
    reconciliationCaseId: null,
    excludedReason: null,
  });
  replaceLine(next);
  syncDepositsForLine(next);
  return { data: next };
});

register(excludeStatementLine, ({ params, body }) => {
  const line = findLine(params.lineId);
  if (
    line.matchStatus === "auto_matched" ||
    line.matchStatus === "manually_matched"
  )
    throw conflict("Lepas pencocokan baris ini sebelum mengecualikannya.");
  if (line.matchStatus === "in_case")
    throw conflict("Selesaikan kasus baris ini sebelum mengecualikannya.");
  const next = bankStatementLineSchema.parse({
    ...line,
    matchStatus: "excluded",
    matchedRefs: [],
    reconciliationCaseId: null,
    excludedReason: body.reason,
  });
  replaceLine(next);
  return { data: next };
});

register(unmatchStatementLine, ({ params, body }) => {
  const current = state.get();
  const replayKey = `unmatch:${params.lineId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) return { data: findLine(replayed) };
  const line = findLine(params.lineId);
  if (
    line.matchStatus !== "auto_matched" &&
    line.matchStatus !== "manually_matched" &&
    line.matchStatus !== "excluded"
  )
    throw conflict("Baris ini tidak bisa dilepas dari statusnya sekarang.");
  // The contract has no un-exclude command; unmatch also restores an excluded
  // line (reported as a contract gap, see the bead report).
  const next = bankStatementLineSchema.parse({
    ...line,
    matchStatus: "unmatched",
    matchedRefs: [],
    reconciliationCaseId: null,
    excludedReason: null,
  });
  replaceLine(next);
  releaseDepositsForLine(next);
  current.created.set(replayKey, next.id);
  return { data: next };
});

// ---- Reconciliation summary ----------------------------------------------

register(getReconciliationSummary, ({ params, query }) => {
  const account = findAccount(params.bankAccountId);
  const lines = state
    .get()
    .statementLines.filter(
      (line) =>
        line.bankAccountId === account.id &&
        line.postedOn >= query.from &&
        line.postedOn <= query.to,
    );
  const count = (status: BankStatementLine["matchStatus"]) =>
    lines.filter((line) => line.matchStatus === status).length;
  return {
    data: {
      bankAccountId: account.id,
      from: query.from,
      to: query.to,
      lineCount: lines.length,
      autoMatchedCount: count("auto_matched"),
      manuallyMatchedCount: count("manually_matched"),
      unmatchedCount: count("unmatched"),
      inCaseCount: count("in_case"),
      excludedCount: count("excluded"),
      autoMatchRateBp: autoMatchRateBp(lines),
    },
  };
});

// ---- Cash deposits (ACC-05) ----------------------------------------------

register(listCashDeposits, ({ query, scenario }) => {
  const rows = state
    .get()
    .deposits.filter(
      (deposit) =>
        deposit.legalEntityId === query.legalEntityId &&
        (!query.outletId || deposit.outletId === query.outletId) &&
        deposit.depositedAt.slice(0, 10) >= query.from &&
        deposit.depositedAt.slice(0, 10) <= query.to,
    )
    .sort(
      (a, b) =>
        b.depositedAt.localeCompare(a.depositedAt) || a.id.localeCompare(b.id),
    );
  return paginateFixture(
    rows,
    { cursor: query.cursor, limit: query.limit },
    (row) => row.id,
    scenario,
  );
});

register(createCashDeposit, ({ body }) => {
  const account = findAccount(body.bankAccountId);
  const current = state.get();
  const replayKey = `deposit:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const existing = current.deposits.find((row) => row.id === replayed);
    if (existing) return { data: existing };
  }
  const outlet = cafeLegendPlatformFixtures.outlets.find(
    (row) => row.id === body.outletId,
  );
  if (!outlet) throw invalid("Outlet tidak ditemukan.");
  let deposit = cashDepositSchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    legalEntityId: fixtures.legalEntity.id,
    outletId: body.outletId,
    bankAccountId: body.bankAccountId,
    amountIdr: body.amountIdr,
    coversFrom: body.coversFrom,
    coversTo: body.coversTo,
    depositedAt: body.depositedAt,
    depositedBy: outletManager,
    slipReference: body.slipReference,
    bankStatementLineId: null,
    reconciliationCaseId: null,
    journalEntryId: null,
    status: "recorded",
  });
  // ACC-05: exactly one unmatched line of the same amount in the tolerance
  // window becomes the deposit's proof. Several candidates stay a person's
  // decision in the match workspace.
  const candidates = current.statementLines.filter(
    (line) =>
      line.bankAccountId === account.id &&
      line.matchStatus === "unmatched" &&
      line.amountIdr === deposit.amountIdr &&
      Math.abs(daysBetween(deposit.coversTo, line.postedOn)) <=
        fixtures.matchingPolicy.dateToleranceDays,
  );
  if (candidates.length === 1) {
    const line = candidates[0];
    deposit = cashDepositSchema.parse({
      ...deposit,
      status: "matched",
      bankStatementLineId: line.id,
    });
    const nextLine = bankStatementLineSchema.parse({
      ...line,
      matchStatus: "auto_matched",
      matchedRefs: [{ type: "cash_deposit", id: deposit.id }],
    });
    replaceLine(nextLine);
  }
  current.deposits.push(deposit);
  current.created.set(replayKey, deposit.id);
  return { data: deposit };
});

register(listUndepositedCashAlerts, ({ query, scenario }) => {
  if (scenario === "empty") return { data: [] };
  return {
    data: undepositedCashAlerts(
      state.get().collections,
      state.get().deposits,
      query.asOf,
      fixtures.cashDepositPolicy,
    ),
  };
});

// ---- Reconciliation cases (ACC-04) ---------------------------------------

register(listReconciliationCases, ({ query, scenario }) => {
  const rows = state
    .get()
    .cases.filter((row) => row.legalEntityId === query.legalEntityId)
    .filter((row) => !query.status || row.status === query.status)
    .filter((row) => !query.outletId || row.outletId === query.outletId)
    .sort(
      (a, b) =>
        b.openedAt.localeCompare(a.openedAt) || a.id.localeCompare(b.id),
    );
  return paginateFixture(
    rows,
    { cursor: query.cursor, limit: query.limit },
    (row) => row.id,
    scenario,
  );
});

register(openReconciliationCase, ({ body }) => {
  if (body.legalEntityId !== fixtures.legalEntity.id)
    throw invalid("Badan usaha tidak ditemukan.");
  for (const ref of body.refs)
    if (!refExists(ref)) throw notFound("Dokumen kasus tidak ditemukan.");
  const linkedLines = body.refs
    .filter((ref) => ref.type === "bank_statement_line")
    .map((ref) => findLine(ref.id));
  for (const line of linkedLines) {
    if (
      line.matchStatus === "auto_matched" ||
      line.matchStatus === "manually_matched"
    )
      throw conflict(
        "Baris mutasi ini sudah cocok; lepas dulu sebelum jadi kasus.",
      );
    if (line.matchStatus === "in_case")
      throw conflict("Baris mutasi ini sudah berada di kasus lain.");
  }
  const row = reconciliationCaseSchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    legalEntityId: body.legalEntityId,
    outletId: body.outletId,
    type: body.type,
    differenceIdr: body.differenceIdr,
    ownerId: body.ownerId,
    status: "open",
    dueAt: `${addDays(businessDateToday(), fixtures.reconciliationPolicy.caseDueDays)}T10:00:00.000Z`,
    refs: body.refs,
    openedAt: nowIso(),
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    adjustmentJournalEntryId: null,
  });
  state.get().cases.push(row);
  for (const line of linkedLines) {
    replaceLine(
      bankStatementLineSchema.parse({
        ...line,
        matchStatus: "in_case",
        matchedRefs: [],
        reconciliationCaseId: row.id,
        excludedReason: null,
      }),
    );
  }
  return { data: row };
});

register(getReconciliationCase, ({ params, scenario }) => {
  if (scenario === "empty")
    throw notFound("Kasus rekonsiliasi tidak ditemukan.");
  const row = state.get().cases.find((item) => item.id === params.caseId);
  if (!row) throw notFound("Kasus rekonsiliasi tidak ditemukan.");
  return { data: row };
});

register(actOnReconciliationCase, ({ params, body }) => {
  const current = state.get().cases.find((row) => row.id === params.caseId);
  if (!current) throw notFound("Kasus rekonsiliasi tidak ditemukan.");
  const action =
    body.type === "reassign"
      ? {
          type: "reassign" as const,
          actorId: finance,
          ownerId: body.ownerId,
        }
      : body.type === "resolve"
        ? { type: "resolve" as const, actorId: finance, note: body.note }
        : body.type === "write_off"
          ? {
              type: "write_off" as const,
              actorId: finance,
              note: body.note,
              adjustmentJournalEntryId: body.adjustmentJournalEntryId,
            }
          : { type: "start" as const, actorId: finance };
  const status = transitionReconciliationCase(current, action);
  const done = status === "resolved" || status === "written_off";
  const next = reconciliationCaseSchema.parse({
    ...current,
    status,
    ownerId: action.type === "reassign" ? action.ownerId : current.ownerId,
    resolvedBy: done ? finance : null,
    resolvedAt: done ? nowIso() : null,
    resolutionNote:
      action.type === "resolve" || action.type === "write_off"
        ? action.note
        : null,
    adjustmentJournalEntryId:
      action.type === "write_off" ? action.adjustmentJournalEntryId : null,
  });
  replaceCase(next);
  if (done) {
    // Closing the case releases its statement lines: a resolved difference can
    // be re-matched, a written-off one is excluded with the resolution note.
    for (const line of state.get().statementLines) {
      if (line.reconciliationCaseId !== current.id) continue;
      replaceLine(
        bankStatementLineSchema.parse({
          ...line,
          matchStatus: action.type === "write_off" ? "excluded" : "unmatched",
          matchedRefs: [],
          reconciliationCaseId: null,
          excludedReason: action.type === "write_off" ? action.note : null,
        }),
      );
    }
  }
  return { data: next };
});
