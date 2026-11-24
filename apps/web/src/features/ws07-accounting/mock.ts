// Mock handlers for the accounting back office (`VITE_API_MOCK=true`), so every
// screen works with no API (docs/frontend.md "Typed endpoints and mock mode").
// They serve the Cafe Legend accounting fixtures and run the same contract
// state machines the API will run: ACC-01 balance and reversal guards, the
// manual-journal request/approve flow with AUTH-06 (approver ≠ requester), and
// the recurring-template transitions. Mutations live in a mock store, so the
// screens are clickable and every store re-seeds on resetMocks().
//
// Loaded in Node by tests/ws07-accounting.test.mjs, so every import here is a
// bare package import or a relative `.ts` path (no `@/` alias).
//
// Identity in mock mode: the requester is the fixture's finance user and the
// approver is the owner, because the mock has no session. A real API takes the
// actor from the session (AUTH-06) and refuses an approval by the requester; the
// manual-journal screen says so next to the approval buttons.
import {
  AccountingError,
  approveManualJournal,
  assertJournalBalanced,
  assertPostingAllowed,
  buildReversalLines,
  cafeLegendAccountingFixtures,
  cancelManualJournal,
  chartOfAccountsIssues,
  createAccount,
  createManualJournal,
  createRecurringJournal,
  getJournal,
  getManualJournal,
  journalEntrySchema,
  listAccounts,
  listFiscalPeriods,
  listJournals,
  listManualJournals,
  listRecurringJournals,
  manualJournalSchema,
  recurringJournalSchema,
  rejectManualJournal,
  reverseJournal,
  submitManualJournal,
  transitionManualJournal,
  transitionRecurringJournal,
  transitionRecurringJournalEndpoint,
  updateAccount,
  updateManualJournal,
  withdrawManualJournal,
  accountSchema,
  type Account,
  type JournalEntry,
  type JournalLineInput,
  type JournalSourceType,
  type ManualJournal,
  type ManualJournalAction,
  type RecurringJournal,
  type RecurringJournalAction,
} from "@starter/shared/accounting";
import type { UserId } from "@starter/shared/core";
import {
  cafeLegendPlatformFixtures,
  orgEndpoints,
} from "@starter/shared/platform";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { compareAccountCodes, entryBalance } from "./lib.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

const fixtures = cafeLegendAccountingFixtures;
const tenantId = fixtures.tenantId;
const finance = fixtures.users.finance as UserId;
const owner = fixtures.users.owner as UserId;

type AccountingMockState = {
  accounts: Account[];
  journals: JournalEntry[];
  manualJournals: ManualJournal[];
  recurringJournals: RecurringJournal[];
  /** Fiscal-period ids for months the fixtures do not list (mock-only). */
  periodIds: Map<string, string>;
  /** Idempotency and replay: request key → created id. */
  created: Map<string, string>;
};

const state = createMockStore<AccountingMockState>(() => ({
  accounts: [...fixtures.accounts],
  journals: [...fixtures.journals],
  manualJournals: [...fixtures.manualJournals],
  recurringJournals: [...fixtures.recurringJournals],
  periodIds: new Map(),
  created: new Map(),
}));

function nowIso(): string {
  return new Date().toISOString();
}

function notFound(message: string): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

function invalid(message: string): ApiError {
  return new ApiError(422, "VALIDATION_ERROR", message);
}

// ---- Shared helpers -------------------------------------------------------

function periodIdFor(period: string): string {
  const known = fixtures.fiscalPeriods.find((row) => row.period === period);
  if (known) return known.id;
  const current = state.get();
  const existing = current.periodIds.get(period);
  if (existing) return existing;
  const id = newIdempotencyKey();
  current.periodIds.set(period, id);
  return id;
}

/**
 * ACC-02: a month the fixtures mark closed rejects posting. A month with no
 * period row is treated as open (the fixtures list Sep–Nov 2026 only); the API
 * creates the period row for its legal entity.
 */
function assertOpenMonth(entryDate: string): void {
  const period = fixtures.fiscalPeriods.find(
    (row) => row.period === entryDate.slice(0, 7),
  );
  if (period) assertPostingAllowed(period, entryDate);
}

function lineInputs(
  lines: readonly {
    accountId: string;
    debitIdr: number;
    creditIdr: number;
    outletId: string | null;
    costCenter: string | null;
  }[],
): JournalLineInput[] {
  return lines.map((line) => ({
    accountId: line.accountId,
    debitIdr: line.debitIdr,
    creditIdr: line.creditIdr,
    outletId: line.outletId,
    costCenter: line.costCenter,
  })) as JournalLineInput[];
}

/** ACC-01: every new entry is balanced and lands in an open period. */
function postEntry(input: {
  entryDate: string;
  sourceType: JournalSourceType;
  sourceId: string | null;
  description: string;
  lines: readonly JournalLineInput[];
  outletId: string | null;
  postedBy: string | null;
  reversalOf: string | null;
}): JournalEntry {
  assertJournalBalanced(input.lines);
  assertOpenMonth(input.entryDate);
  const entry = journalEntrySchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    legalEntityId: fixtures.legalEntity.id,
    outletId: input.outletId,
    entryDate: input.entryDate,
    fiscalPeriodId: periodIdFor(input.entryDate.slice(0, 7)),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    description: input.description,
    reversalOf: input.reversalOf,
    postedBy: input.postedBy,
    postedAt: nowIso(),
    lines: input.lines.map((line) => ({
      id: newIdempotencyKey(),
      ...line,
    })),
  });
  state.get().journals.push(entry);
  return entry;
}

/**
 * System journal for other accounting mocks (depreciation run, legend-m4zn):
 * posts into this store so the journal link of a new run opens a real entry,
 * the way the API books the run's journal in the same transaction.
 */
export function postMockSystemJournal(
  input: Omit<Parameters<typeof postEntry>[0], "postedBy" | "reversalOf">,
): JournalEntry {
  return postEntry({ ...input, postedBy: null, reversalOf: null });
}

function reversedByOf(entryId: string): string | null {
  return (
    state.get().journals.find((entry) => entry.reversalOf === entryId)?.id ??
    null
  );
}

function summaryOf(entry: JournalEntry) {
  const { lines, ...header } = entry;
  return {
    ...header,
    totalIdr: entryBalance(lines).debitIdr,
    lineCount: lines.length,
    reversedBy: reversedByOf(entry.id),
  };
}

function findManual(manualJournalId: string): ManualJournal {
  const found = state
    .get()
    .manualJournals.find((row) => row.id === manualJournalId);
  if (!found) throw notFound("Jurnal manual tidak ditemukan.");
  return found;
}

function findRecurring(recurringJournalId: string): RecurringJournal {
  const found = state
    .get()
    .recurringJournals.find((row) => row.id === recurringJournalId);
  if (!found) throw notFound("Templat jurnal berulang tidak ditemukan.");
  return found;
}

// ---- Legal entities + chart of accounts -----------------------------------

// Reference data stays available under ?mock=empty: the screen's own list
// (accounts, journals, templates) is what the empty state is about.
registerMock(orgEndpoints.listLegalEntities, () => ({
  data: [cafeLegendPlatformFixtures.legalEntity],
}));

// legend-5kop: `?mock=empty` must reach the outlet settings screen's empty
// state, so the scenario goes through to paginateFixture like every other list.
registerMock(orgEndpoints.listOutlets, ({ query, scenario }) =>
  paginateFixture(
    cafeLegendPlatformFixtures.outlets,
    { cursor: query.cursor, limit: query.limit },
    (outlet) => outlet.id,
    scenario,
  ),
);

registerMock(listAccounts, ({ params, scenario }) => {
  if (scenario === "empty") return { data: [] };
  const rows = state
    .get()
    .accounts.filter(
      (account) => account.legalEntityId === params.legalEntityId,
    )
    .sort((a, b) => compareAccountCodes(a.code, b.code));
  return { data: rows };
});

registerMock(createAccount, ({ params, body }) => {
  const current = state.get();
  const siblings = current.accounts.filter(
    (account) => account.legalEntityId === params.legalEntityId,
  );
  if (siblings.some((account) => account.code === body.code))
    throw new AccountingError("ACCOUNT_CODE_TAKEN");
  if (body.parentId !== null) {
    const parent = siblings.find((account) => account.id === body.parentId);
    if (!parent)
      throw invalid("Akun induk tidak ditemukan di badan usaha yang sama.");
    if (parent.type !== body.type)
      throw invalid("Tipe akun harus sama dengan tipe akun induknya.");
  }
  const account = accountSchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    legalEntityId: params.legalEntityId,
    code: body.code,
    name: body.name,
    type: body.type,
    reportGroup: body.reportGroup,
    parentId: body.parentId,
    isActive: true,
  });
  const issues = chartOfAccountsIssues([...siblings, account]);
  if (issues.length > 0) throw invalid(issues[0] ?? "Bagan akun tidak valid.");
  current.accounts.push(account);
  return { data: account };
});

registerMock(updateAccount, ({ params, body }) => {
  const current = state.get();
  const index = current.accounts.findIndex(
    (account) => account.id === params.accountId,
  );
  if (index === -1) throw notFound("Akun tidak ditemukan.");
  const before = current.accounts[index];
  const siblings = current.accounts.filter(
    (account) =>
      account.legalEntityId === before.legalEntityId &&
      account.id !== before.id,
  );
  const parentId =
    body.parentId === undefined
      ? before.parentId
      : (body.parentId as typeof before.parentId);
  if (parentId !== null) {
    const parent = siblings.find((account) => account.id === parentId);
    if (!parent)
      throw invalid("Akun induk tidak ditemukan di badan usaha yang sama.");
    if (parent.type !== before.type)
      throw invalid("Tipe akun induk harus sama dengan tipe akun ini.");
  }
  const next = accountSchema.parse({
    ...before,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.reportGroup !== undefined
      ? { reportGroup: body.reportGroup }
      : {}),
    ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    parentId,
  });
  const issues = chartOfAccountsIssues([...siblings, next]);
  if (issues.length > 0) throw invalid(issues[0] ?? "Bagan akun tidak valid.");
  current.accounts[index] = next;
  return { data: next };
});

// ---- Posted journals ------------------------------------------------------

registerMock(listFiscalPeriods, ({ params }) => {
  const rows = fixtures.fiscalPeriods.filter(
    (row) => row.legalEntityId === params.legalEntityId,
  );
  return { data: rows };
});

registerMock(listJournals, ({ query, scenario }) => {
  const rows = state
    .get()
    .journals.filter((entry) => entry.legalEntityId === query.legalEntityId)
    .filter(
      (entry) => entry.entryDate >= query.from && entry.entryDate <= query.to,
    )
    .filter((entry) => !query.outletId || entry.outletId === query.outletId)
    .filter(
      (entry) => !query.sourceType || entry.sourceType === query.sourceType,
    )
    .filter(
      (entry) =>
        !query.accountId ||
        entry.lines.some((line) => line.accountId === query.accountId),
    )
    // Newest first, the order a controller reads: date, then posting time.
    .sort(
      (a, b) =>
        b.entryDate.localeCompare(a.entryDate) ||
        b.postedAt.localeCompare(a.postedAt) ||
        a.id.localeCompare(b.id),
    )
    .map(summaryOf);
  return paginateFixture(
    rows,
    { cursor: query.cursor, limit: query.limit },
    (row) => row.id,
    scenario,
  );
});

registerMock(getJournal, ({ params, scenario }) => {
  if (scenario === "empty") throw notFound("Jurnal tidak ditemukan.");
  const entry = state
    .get()
    .journals.find((row) => row.id === params.journalEntryId);
  if (!entry) throw notFound("Jurnal tidak ditemukan.");
  return { data: { entry, reversedBy: reversedByOf(entry.id) } };
});

registerMock(reverseJournal, ({ params, body }) => {
  const current = state.get();
  const replayKey = `reversal:${params.journalEntryId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const entry = current.journals.find((row) => row.id === replayed);
    if (entry) return { data: entry };
  }
  const original = current.journals.find(
    (row) => row.id === params.journalEntryId,
  );
  if (!original) throw notFound("Jurnal tidak ditemukan.");
  // ACC-01: mirrors every line, refuses a second reversal and a reversal of a
  // reversal (buildReversalLines → assertReversible).
  const lines = buildReversalLines(original, reversedByOf(original.id));
  const entry = postEntry({
    entryDate: body.entryDate,
    sourceType: "reversal",
    sourceId: original.id,
    description: body.reason,
    lines,
    outletId: original.outletId,
    postedBy: finance,
    reversalOf: original.id,
  });
  current.created.set(replayKey, entry.id);
  return { data: entry };
});

// ---- Manual journals ------------------------------------------------------

registerMock(listManualJournals, ({ query, scenario }) => {
  const rows = state
    .get()
    .manualJournals.filter((row) => row.legalEntityId === query.legalEntityId)
    .filter((row) => !query.status || row.status === query.status)
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
  return paginateFixture(
    rows,
    { cursor: query.cursor, limit: query.limit },
    (row) => row.id,
    // Card 1263: the blocked-close scenarios show a period whose journals are
    // all finished, so the only thing stopping the close is the parked stock.
    scenario.startsWith("period-close-blocked") ? "empty" : scenario,
  );
});

registerMock(getManualJournal, ({ params, scenario }) => {
  if (scenario === "empty") throw notFound("Jurnal manual tidak ditemukan.");
  return { data: findManual(params.manualJournalId) };
});

registerMock(createManualJournal, ({ body }) => {
  const current = state.get();
  const replayKey = `manual:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) return { data: findManual(replayed) };
  const journal = manualJournalSchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    legalEntityId: body.legalEntityId,
    outletId: body.outletId,
    entryDate: body.entryDate,
    kind: body.kind,
    description: body.description,
    lines: body.lines,
    status: "draft",
    requestedBy: finance,
    createdAt: nowIso(),
    submittedAt: null,
    decidedBy: null,
    decidedAt: null,
    rejectionReason: null,
    postedEntryId: null,
    recurringJournalId: null,
  });
  current.manualJournals.unshift(journal);
  current.created.set(replayKey, journal.id);
  return { data: journal };
});

registerMock(updateManualJournal, ({ params, body }) => {
  const current = state.get();
  const index = current.manualJournals.findIndex(
    (row) => row.id === params.manualJournalId,
  );
  if (index === -1) throw notFound("Jurnal manual tidak ditemukan.");
  const before = current.manualJournals[index];
  // The contract decides who may edit and from which status (draft/rejected).
  transitionManualJournal(before, { type: "edit", actorId: finance });
  const next = manualJournalSchema.parse({
    ...before,
    ...(body.outletId !== undefined ? { outletId: body.outletId } : {}),
    ...(body.entryDate !== undefined ? { entryDate: body.entryDate } : {}),
    ...(body.kind !== undefined ? { kind: body.kind } : {}),
    ...(body.description !== undefined
      ? { description: body.description }
      : {}),
    ...(body.lines !== undefined ? { lines: body.lines } : {}),
    status: "draft",
    rejectionReason: null,
    decidedBy: null,
    decidedAt: null,
  });
  current.manualJournals[index] = next;
  return { data: next };
});

/**
 * One manual-journal transition. Approve also posts the entry in the same
 * operation (the contract's rule); the owner is the approver because the mock
 * has no session, and the contract refuses an approval by the requester.
 */
function applyManualAction(input: {
  manualJournalId: string;
  action: "submit" | "withdraw" | "approve" | "cancel" | "reject";
  reason?: string;
}): ManualJournal {
  const current = state.get();
  const index = current.manualJournals.findIndex(
    (row) => row.id === input.manualJournalId,
  );
  if (index === -1) throw notFound("Jurnal manual tidak ditemukan.");
  const journal = current.manualJournals[index];
  const decides = input.action === "approve" || input.action === "reject";
  const actor = decides ? owner : finance;
  const transition: ManualJournalAction =
    input.action === "reject"
      ? { type: "reject", actorId: actor, reason: input.reason ?? "" }
      : { type: input.action, actorId: actor };
  const status = transitionManualJournal(journal, transition);
  const decided = status === "posted" || status === "rejected";
  const postedEntryId =
    status === "posted"
      ? postEntry({
          entryDate: journal.entryDate,
          sourceType: "manual",
          sourceId: journal.id,
          description: journal.description,
          lines: lineInputs(journal.lines),
          outletId: journal.outletId,
          postedBy: actor,
          reversalOf: null,
        }).id
      : journal.postedEntryId;
  const next = manualJournalSchema.parse({
    ...journal,
    status,
    submittedAt:
      status === "pending_approval"
        ? (journal.submittedAt ?? nowIso())
        : status === "draft"
          ? null
          : journal.submittedAt,
    decidedBy: decided ? actor : null,
    decidedAt: decided ? nowIso() : null,
    rejectionReason: status === "rejected" ? (input.reason ?? "") : null,
    postedEntryId,
  });
  current.manualJournals[index] = next;
  return next;
}

type ManualCommandContext = {
  params: { manualJournalId: string };
  body: { idempotencyKey: string };
};

function manualCommandHandler(
  action: "submit" | "withdraw" | "approve" | "cancel",
) {
  return (context: ManualCommandContext) => {
    const current = state.get();
    const replayKey = `manual-command:${action}:${context.params.manualJournalId}:${context.body.idempotencyKey}`;
    const replayed = current.created.get(replayKey);
    if (replayed) return { data: findManual(replayed) };
    const journal = applyManualAction({
      manualJournalId: context.params.manualJournalId,
      action,
    });
    current.created.set(replayKey, journal.id);
    return { data: journal };
  };
}

registerMock(submitManualJournal, manualCommandHandler("submit"));
registerMock(withdrawManualJournal, manualCommandHandler("withdraw"));
registerMock(approveManualJournal, manualCommandHandler("approve"));
registerMock(cancelManualJournal, manualCommandHandler("cancel"));

registerMock(rejectManualJournal, ({ params, body }) => {
  // Reject carries the reason instead of an idempotency key; rejecting twice
  // cannot double-post (the transition only leaves pending_approval once).
  const journal = applyManualAction({
    manualJournalId: params.manualJournalId,
    action: "reject",
    reason: body.reason,
  });
  return { data: journal };
});

// ---- Recurring journals ---------------------------------------------------

registerMock(listRecurringJournals, ({ query, scenario }) => {
  if (scenario === "empty") return { data: [] };
  const rows = state
    .get()
    .recurringJournals.filter(
      (row) => row.legalEntityId === query.legalEntityId,
    );
  return { data: rows };
});

registerMock(createRecurringJournal, ({ body }) => {
  const current = state.get();
  const replayKey = `recurring:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) return { data: findRecurring(replayed) };
  const template = recurringJournalSchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    legalEntityId: body.legalEntityId,
    outletId: body.outletId,
    description: body.description,
    lines: body.lines,
    frequency: "monthly",
    dayOfMonth: body.dayOfMonth,
    startPeriod: body.startPeriod,
    endPeriod: body.endPeriod,
    status: "draft",
    requestedBy: finance,
    approvedBy: null,
    approvedAt: null,
    lastGeneratedPeriod: null,
  });
  current.recurringJournals.unshift(template);
  current.created.set(replayKey, template.id);
  return { data: template };
});

registerMock(transitionRecurringJournalEndpoint, ({ params, body }) => {
  const current = state.get();
  const index = current.recurringJournals.findIndex(
    (row) => row.id === params.recurringJournalId,
  );
  if (index === -1) throw notFound("Templat jurnal berulang tidak ditemukan.");
  const template = current.recurringJournals[index];
  const action: RecurringJournalAction =
    body.type === "reject"
      ? { type: "reject", actorId: owner, reason: body.reason }
      : body.type === "approve"
        ? { type: "approve", actorId: owner }
        : { type: body.type, actorId: finance };
  const status = transitionRecurringJournal(template, action);
  const approved =
    status === "active" || status === "paused" || status === "ended";
  const next = recurringJournalSchema.parse({
    ...template,
    status,
    approvedBy: approved ? (template.approvedBy ?? owner) : null,
    approvedAt: approved ? (template.approvedAt ?? nowIso()) : null,
  });
  current.recurringJournals[index] = next;
  return { data: next };
});
