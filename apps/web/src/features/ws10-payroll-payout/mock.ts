// Mock mode for the payout screens (docs/frontend.md "Typed endpoints and mock
// mode"). The `normal` fixture mirrors the approved mockup and is what
// e2e/payout.mock.spec.ts assumes:
// - PT with Duitku off, source account BCA •••• 4821 (manual transfer);
// - run PAY-2026-11-01 "Gaji November" with batch 201 awaiting approval, asked
//   by Rani Wulandari: Alya Putri, Bima Pratama, Citra Lestari, Dimas Saputra,
//   gaji diterima Rp21.500.000, biaya PT Rp5.000 each (Rp20.000), dana
//   disiapkan Rp21.520.000;
// - run PAY-2026-11-02 (no batch yet, "Siapkan");
// - run PAY-2026-10-01 with batch 202 in the status view: one item each
//   waiting, paid by the provider, paid by hand, failed and unknown outcome.
// `?mock=empty` lists no payable run; `?mock=error|offline` fail every call.
// Three payout-only scenarios are read from `?mock=` here (they are not in the
// shared scenario list): `legacy-account` makes the first item of batch 201 a
// legacy item without a locked account (the approval is blocked), and
// `batches-paged` serves the per-PT batch list in three pages (cursors "p2",
// "p3"): batch 201 first, then batch 202 plus an older history batch (older than
// every shown run's lock, so the screen stops loading by itself and "Muat
// lagi" stays), then an empty last page. `batches-paged-open` puts the
// pending-approval batch 201 on page 2 behind batch 202, to prove it is loaded
// without a click.
// `?mock=resolve-proposal` waits for a second person on batch 202: a resolve
// proposal (failed, with a proof key of the batch) on the exported item and a
// return proposal on the manually confirmed one, both by the other known user.
// The second step must send the same proof key (409 *_EVIDENCE_MISMATCH).
// `?mock=two-pending` adds a second pending-approval manual batch (203, its own
// run, same PT and same source account, asked by finance) next to batch 201, so
// a spec can move from one batch to the other with the approval tab still open.
// Recon flags and return-claim withdrawal (legend-o2b4m) are two-person steps.
// `?mock=recon-approve` has a clearance and a withdrawal proposed by the other
// user (the signed-in one can approve), `recon-self` has them proposed by the
// signed-in user (approve refused), `recon-changed` makes the approve answer 409
// PAYOUT_RECON_FLAG_CHANGED / PAYOUT_RETURN_WITHDRAW_REFUSED once, `recon-reopened`
// shows a flag whose old clearance no longer fits. Plain `normal`, `empty`,
// `slow` and `error` work as everywhere. The proposals live in sessionStorage
// (key `payoutReconMock`), so a spec can reload and switch the mock role cookie
// (`finance` / `hr`) to approve as a different person.
// Recon holds (legend-6o7pc) follow the same rules: `?mock=hold-approve` has a
// release proposed by the other user, `hold-self` one proposed by the signed-in
// user (approve refused), `hold-taken-over` answers 409 PAYOUT_RECON_HOLD_TAKEN_OVER
// to the next write (a flag took the hold over). Plain `normal` shows one hold
// of each status; `empty` shows none. Stored in sessionStorage (key
// `payoutReconHoldMock`) like the recon flags.
// Every call of the approve endpoint is also logged in
// `window.__payoutApproveCalls` (batch ids), to prove nothing was sent.
// Bank items carry the locked payee snapshot (name + "****1234"); cash items
// carry none. Resolve and return need two different people: the first call
// only proposes, so a single mock user always gets `proposed: 1`.
//
// Payable runs and employee names come through two mock-only paths
// (/api/mock/payout/*) because the payroll-run and HR mocks seed no locked run
// and no such employees; in a real build api.ts calls the real contracts.
// Server rules the mock repeats on purpose: the requester cannot approve or
// confirm (PAYOUT_SELF_APPROVAL, PAYOUT_CONFIRM_SELF), the bank file downloads
// once, an inactive source account is refused, Duitku is not available.
import { z } from "zod";
import { defineEndpoint } from "@starter/shared/api";
import { cafeLegendPayrollFixtures } from "@starter/shared/hris/payroll";
import {
  approveDisbursementBatch,
  cancelDisbursementBatch,
  confirmDisbursementCash,
  confirmDisbursementItems,
  createDisbursementBatch,
  disownPayoutApproval,
  exportDisbursementBatch,
  getDisbursementBatch,
  getPayoutApprovalLog,
  getPayoutConfig,
  listPayoutBatches,
  listResolutionProposals,
  listRunDisbursementBatches,
  readPayoutEvidence,
  resolveDisbursementItems,
  returnDisbursementItems,
  submitDisbursementBatch,
  unfreezeDisbursementBatch,
  upsertPayoutConfig,
} from "@starter/shared/hris/payroll/payout";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type {
  PayoutReconFlagDto,
  PayoutReconHoldDto,
  PayoutReturnClaimDto,
  PayrollDisbursementBatchDto,
  PayrollDisbursementItemDto,
  PayrollPayoutConfigDto,
} from "@starter/shared/types";
import { ApiError } from "@/lib/api/errors";
import { MOCK_ROLE_COOKIE, parseMockRole } from "@/lib/areas/access";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import {
  approveReconClearanceEndpoint,
  approveReconHoldReleaseEndpoint,
  approveReturnWithdrawalEndpoint,
  listBatchReturnClaimsEndpoint,
  listPayoutReconFlagsEndpoint,
  listPayoutReconHoldsEndpoint,
  proposeReconClearanceEndpoint,
  proposeReconHoldReleaseEndpoint,
  proposeReturnWithdrawalEndpoint,
  type PayableRun,
  type PayoutEmployee,
} from "./api";

const LEGAL_ENTITY_ID = cafeLegendPlatformFixtures.legalEntity.id;
const { userIds } = cafeLegendPayrollFixtures;

/** Deterministic RFC 4122 ids so e2e and demos can name a batch in the URL. */
const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/**
 * Same shape, but the first 8 hex chars differ per `n`: the screens name an id
 * by those chars (`shortId`), so rows must not all read 00000000. Ids that
 * specs name literally (runs, the two pending batches) stay on `uid`.
 */
const spreadUid = (n: number) =>
  `${(Math.imul(n, 0x9e3779b1) >>> 0).toString(16).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const MOCK_PAYOUT_IDS = {
  runApproval: uid(101),
  runNew: uid(102),
  runStatus: uid(100),
  batchApproval: uid(201),
  batchStatus: spreadUid(202),
  /** `two-pending` only: a second batch awaiting approval (own run). */
  runTwoPending: uid(103),
  batchTwoPending: uid(203),
  /** A logged step of the signed-in approver, on the status batch. */
  logStatus: uid(301),
} as const;

const ACCOUNTS = [
  {
    id: uid(901),
    label: "BCA · PT Legend Kuliner",
    maskedNumber: "****4821",
    active: true,
  },
  {
    id: uid(902),
    label: "Mandiri · PT Legend Kuliner",
    maskedNumber: "****1177",
    active: true,
  },
  {
    id: uid(903),
    label: "BNI · PT Legend Kuliner",
    maskedNumber: "****9020",
    active: false,
  },
];

const PEOPLE: PayoutEmployee[] = [
  {
    id: uid(301),
    userId: null,
    name: "Alya Putri",
    subtitle: "Kasir · Kemang",
  },
  {
    id: uid(302),
    userId: null,
    name: "Bima Pratama",
    subtitle: "Barista · Kemang",
  },
  {
    id: uid(303),
    userId: null,
    name: "Citra Lestari",
    subtitle: "Dapur · Senopati",
  },
  {
    id: uid(304),
    userId: null,
    name: "Dimas Saputra",
    subtitle: "Pelayan · Senopati",
  },
  {
    id: uid(305),
    userId: null,
    name: "Eka Wijaya",
    subtitle: "Gudang · Kemang",
  },
  {
    id: uid(306),
    userId: null,
    name: "Gita Maharani",
    subtitle: "Kasir · Kemang",
  },
  {
    id: uid(307),
    userId: null,
    name: "Hadi Wibowo",
    subtitle: "Barista · Kemang",
  },
  {
    id: uid(308),
    userId: userIds.hrApprover,
    name: "Rani Wulandari",
    subtitle: "HR · Kantor",
  },
  {
    id: uid(309),
    userId: userIds.financeApprover,
    name: "Sari Kurniawan",
    subtitle: "Finance · Kantor",
  },
];

const RUNS: PayableRun[] = [
  {
    id: MOCK_PAYOUT_IDS.runApproval,
    legalEntityId: LEGAL_ENTITY_ID,
    code: "PAY-2026-11-01",
    runType: "regular",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    lockedAt: "2026-11-14T01:30:00.000Z",
    employeeCount: 4,
    netIdr: 21_500_000,
    bankTransferIdr: 21_500_000,
    bankEmployeeCount: 4,
  },
  {
    id: MOCK_PAYOUT_IDS.runNew,
    legalEntityId: LEGAL_ENTITY_ID,
    code: "PAY-2026-11-02",
    runType: "off_cycle",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    lockedAt: "2026-11-14T01:30:00.000Z",
    employeeCount: 3,
    netIdr: 3_200_000,
    // One employee is paid in cash: the bank batch covers the other two.
    bankTransferIdr: 3_200_000,
    bankEmployeeCount: 2,
  },
  {
    id: MOCK_PAYOUT_IDS.runStatus,
    legalEntityId: LEGAL_ENTITY_ID,
    code: "PAY-2026-10-01",
    runType: "regular",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    lockedAt: "2026-10-30T02:00:00.000Z",
    employeeCount: 5,
    netIdr: 23_500_000,
    bankTransferIdr: 23_500_000,
    bankEmployeeCount: 5,
  },
];

/** What each run pays, by employee (the payslip net). */
const PAYEES: Record<string, { employee: number; amount: number }[]> = {
  [MOCK_PAYOUT_IDS.runApproval]: [
    { employee: 301, amount: 6_500_000 },
    { employee: 302, amount: 5_000_000 },
    { employee: 303, amount: 5_500_000 },
    { employee: 304, amount: 4_500_000 },
  ],
  [MOCK_PAYOUT_IDS.runNew]: [
    { employee: 306, amount: 1_700_000 },
    { employee: 307, amount: 1_500_000 },
  ],
};

const FEE_IDR = 5_000;
const NOW = "2026-11-14T02:15:00.000Z";

function hashOf(items: readonly PayrollDisbursementItemDto[]): string {
  // Not a real SHA-256: a stable 64-hex stand-in over the item ids and amounts.
  const text = items.map((item) => `${item.id}:${item.amountIdr}`).join("|");
  let seed = 5381;
  let out = "";
  for (let i = 0; out.length < 64; i += 1) {
    seed = (seed * 33 + text.charCodeAt(i % text.length) + i) >>> 0;
    out += seed.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

function item(
  n: number,
  batchId: string,
  employee: number,
  amountIdr: number,
  overrides: Partial<PayrollDisbursementItemDto> = {},
): PayrollDisbursementItemDto {
  const channel = overrides.channel ?? "manual_bank";
  const holder = PEOPLE.find((person) => person.id === uid(employee))?.name;
  return {
    id: spreadUid(n),
    batchId,
    payslipId: spreadUid(n + 500),
    employeeId: uid(employee),
    channel,
    attemptNo: 1,
    status: "prepared",
    excludedReason: null,
    amountIdr,
    feeIdr: FEE_IDR,
    bankCode: "014",
    // The locked payee snapshot: bank items have one, cash items do not.
    accountHolderName: channel === "cash" ? null : (holder ?? null),
    maskedAccountNumber: channel === "cash" ? null : "****1234",
    nameMatch: null,
    providerRef: null,
    confirmedBy: null,
    confirmationRef: null,
    settledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function batch(
  id: string,
  runId: string,
  items: PayrollDisbursementItemDto[],
  overrides: Partial<PayrollDisbursementBatchDto>,
): PayrollDisbursementBatchDto {
  return {
    id,
    legalEntityId: LEGAL_ENTITY_ID,
    payrollRunId: runId,
    channel: "manual_bank",
    status: "draft",
    haltReason: null,
    requestedBy: userIds.hrApprover,
    requestedAt: NOW,
    approvedBy: null,
    approvedAt: null,
    approvalExpiresAt: null,
    contentHash: null,
    itemCount: items.length,
    totalIdr: items.reduce((sum, row) => sum + row.amountIdr, 0),
    bankFormat: "generic_csv",
    exportChecksumSha256: null,
    sourceBankAccountId: null,
    exportedBy: null,
    exportedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    freeze: { frozen: false, disputes: [] },
    items,
    ...overrides,
  };
}

const seedConfig = (): PayrollPayoutConfigDto => ({
  id: uid(801),
  legalEntityId: LEGAL_ENTITY_ID,
  method: "manual_bank",
  integrationId: null,
  manualSourceBankAccountId: ACCOUNTS[0].id,
  manualBankFormat: "generic_csv",
  maxPerTransferIdr: 50_000_000,
  dailyCapIdr: 100_000_000,
  feePerTransferIdr: FEE_IDR,
  enabled: true,
  updatedBy: userIds.financeApprover,
  updatedAt: NOW,
  createdAt: NOW,
});

function seedBatches(): PayrollDisbursementBatchDto[] {
  const approvalItems = PAYEES[MOCK_PAYOUT_IDS.runApproval].map((row, index) =>
    item(1000 + index, MOCK_PAYOUT_IDS.batchApproval, row.employee, row.amount),
  );
  const b = MOCK_PAYOUT_IDS.batchStatus;
  const statusItems = [
    item(2001, b, 301, 6_000_000, {
      channel: "duitku",
      status: "succeeded",
      providerRef: "DKU-88410",
      settledAt: NOW,
    }),
    item(2002, b, 302, 4_800_000, {
      attemptNo: 2,
      status: "succeeded",
      confirmedBy: userIds.hrApprover,
      confirmationRef: "TRF-20261031-0042",
      settledAt: NOW,
    }),
    item(2003, b, 303, 5_200_000, { status: "failed" }),
    item(2004, b, 304, 4_000_000, { status: "unknown" }),
    item(2005, b, 305, 3_500_000, { status: "exported" }),
    // Left out at submit: the server sealed its fee, then cancelled the item.
    // It carries a fee but is not payable, so the fee total must skip it.
    item(2006, b, 306, 1_700_000, {
      status: "cancelled",
      excludedReason: "bank_code_missing",
      bankCode: null,
    }),
  ];
  const t = MOCK_PAYOUT_IDS.batchTwoPending;
  const twoItems = [
    item(3001, t, 306, 2_000_000),
    item(3002, t, 307, 1_500_000),
  ];
  return [
    batch(t, MOCK_PAYOUT_IDS.runTwoPending, twoItems, {
      status: "pending_approval",
      // Asked by finance, so the default mock user (HR) may approve it.
      requestedBy: userIds.financeApprover,
      // Older than batch 201, so 201 stays the default batch of the tab.
      requestedAt: "2026-11-14T02:00:00.000Z",
      contentHash: hashOf(twoItems),
      approvalExpiresAt: "2026-11-16T02:15:00.000Z",
    }),
    batch(
      MOCK_PAYOUT_IDS.batchApproval,
      MOCK_PAYOUT_IDS.runApproval,
      approvalItems,
      {
        status: "pending_approval",
        contentHash: hashOf(approvalItems),
        approvalExpiresAt: "2026-11-16T02:15:00.000Z",
      },
    ),
    batch(b, MOCK_PAYOUT_IDS.runStatus, statusItems, {
      status: "exported",
      // Totals cover payable items only (the cancelled item is not paid).
      itemCount: 5,
      totalIdr: 23_500_000,
      // Asked by finance, approved and confirmed by HR (the default mock user),
      // so the default user may resolve or return its items.
      requestedBy: userIds.financeApprover,
      requestedAt: "2026-10-30T03:00:00.000Z",
      approvedBy: userIds.hrApprover,
      approvedAt: "2026-10-30T04:00:00.000Z",
      contentHash: hashOf(statusItems),
      exportedBy: userIds.hrApprover,
      exportedAt: "2026-10-30T04:30:00.000Z",
      exportChecksumSha256: "a".repeat(64),
      // Frozen when it was approved.
      sourceBankAccountId: ACCOUNTS[0].id,
    }),
  ];
}

/** First call of the two-person resolve/return: who proposed what. */
type Proposal = {
  kind: "resolve" | "return";
  outcome: string;
  by: string;
  evidenceKey: string;
  note: string;
  /** Return only: the bank transaction reference, normalized. */
  bankRef?: string;
  at: string;
};
type PayoutMockState = {
  config: PayrollPayoutConfigDto;
  batches: PayrollDisbursementBatchDto[];
  proposals: Record<string, Proposal>;
  /** The `resolve-proposal` scenario puts its proposals in once. */
  proposalsSeeded: boolean;
};
const store = createMockStore<PayoutMockState>(() => ({
  config: seedConfig(),
  batches: seedBatches(),
  proposals: {},
  proposalsSeeded: false,
}));
const state = () => store.get();
let counter = 5000;
const nextId = () => uid((counter += 1));

/** The signed-in mock user (the role cookie picks it); the UI reads it for two-person checks. */
export const mockActorId = () => currentActor();

function currentActor(): string {
  if (typeof document === "undefined") return userIds.hrApprover;
  const raw = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${MOCK_ROLE_COOKIE}=`))
    ?.slice(MOCK_ROLE_COOKIE.length + 1);
  const role = parseMockRole(raw);
  return role === "finance" || role === "owner"
    ? userIds.financeApprover
    : userIds.hrApprover;
}

// ---- Payout-only scenarios ------------------------------------------------------

const RECON_SCENARIOS = [
  "recon-approve",
  "recon-self",
  "recon-changed",
  "recon-reopened",
] as const;
type ReconScenario = (typeof RECON_SCENARIOS)[number];
const isReconScenario = (value: string | null): value is ReconScenario =>
  (RECON_SCENARIOS as readonly (string | null)[]).includes(value);

const HOLD_SCENARIOS = [
  "hold-approve",
  "hold-self",
  "hold-taken-over",
] as const;
type HoldScenario = (typeof HOLD_SCENARIOS)[number];
const isHoldScenario = (value: string | null): value is HoldScenario =>
  (HOLD_SCENARIOS as readonly (string | null)[]).includes(value);

type PayoutScenario =
  | "legacy-account"
  | "batches-paged"
  | "batches-paged-open"
  | "resolve-proposal"
  | "two-pending"
  | ReconScenario
  | HoldScenario;
let rememberedScenario: PayoutScenario | null = null;

/**
 * `?mock=legacy-account|batches-paged|batches-paged-open|resolve-proposal|two-pending`. The shared scenario list does not know
 * them, so they are read from the URL here and kept for the page's lifetime.
 */
function payoutScenario(): PayoutScenario | null {
  if (typeof window !== "undefined") {
    const value = new URLSearchParams(window.location.search).get("mock");
    if (
      value === "legacy-account" ||
      value === "batches-paged" ||
      value === "batches-paged-open" ||
      value === "resolve-proposal" ||
      value === "two-pending" ||
      isReconScenario(value) ||
      isHoldScenario(value)
    )
      rememberedScenario = value;
    else if (value !== null) rememberedScenario = null;
  }
  return rememberedScenario;
}

/** Batch 203 is seeded always but only exists in the `two-pending` scenario. */
const visible = (row: PayrollDisbursementBatchDto) =>
  row.id !== MOCK_PAYOUT_IDS.batchTwoPending ||
  payoutScenario() === "two-pending";

/** What the screens read: `legacy-account` strips one locked account. */
function view(row: PayrollDisbursementBatchDto): PayrollDisbursementBatchDto {
  if (
    payoutScenario() !== "legacy-account" ||
    row.id !== MOCK_PAYOUT_IDS.batchApproval
  )
    return row;
  return {
    ...row,
    items: row.items.map((entry, index) =>
      index === 0
        ? { ...entry, accountHolderName: null, maskedAccountNumber: null }
        : entry,
    ),
  };
}

/** Proof key the scenario's proposals carry: it belongs to batch 202. */
const MOCK_PROPOSAL_EVIDENCE_KEY = `tenants/mock/payroll-payout/${MOCK_PAYOUT_IDS.batchStatus}/evidence/proposal.png`;

/** Puts the scenario's first steps in, once per store (a reset re-arms it). */
function seedScenarioProposals() {
  if (payoutScenario() !== "resolve-proposal" || state().proposalsSeeded)
    return;
  store.set({
    ...state(),
    proposalsSeeded: true,
    proposals: {
      ...state().proposals,
      [`resolve:${spreadUid(2005)}`]: {
        kind: "resolve",
        outcome: "failed",
        by: userIds.financeApprover,
        evidenceKey: MOCK_PROPOSAL_EVIDENCE_KEY,
        note: "Bank menolak transfer, saldo tujuan tidak aktif.",
        at: "2026-10-31T03:20:00.000Z",
      },
      [`return:${spreadUid(2002)}`]: {
        kind: "return",
        outcome: "returned",
        by: userIds.financeApprover,
        evidenceKey: MOCK_PROPOSAL_EVIDENCE_KEY,
        note: "Dana kembali dari bank penerima.",
        bankRef: "RTN20261031001",
        at: "2026-10-31T04:10:00.000Z",
      },
    },
  });
}

const BATCH_PAGE_TWO = "p2";
const BATCH_PAGE_THREE = "p3";

/** A finished batch from before every shown run was locked (older history). */
function historyBatch(): PayrollDisbursementBatchDto {
  return batch(uid(901), uid(902), [], {
    status: "completed",
    createdAt: "2026-09-30T03:00:00.000Z",
    updatedAt: "2026-09-30T03:00:00.000Z",
  });
}

const refuse = (status: number, code: string, message: string) =>
  new ApiError(status, code, message);

// ---- Password step-up emulation ---------------------------------------------------

/** `sessionStorage.payoutMockStepUp = "password"` turns the emulation on. */
const STEP_UP_KEY = "payoutMockStepUp";
const MOCK_RIGHT_PASSWORD = "benar-123";
const MOCK_WRONG_LIMIT = 5;
let wrongPasswordStreak = 0;

type PayoutMockAction = "approve" | "export" | "config" | "recon";
type PayoutMockCalls = Record<PayoutMockAction, number>;

declare global {
  interface Window {
    /** Handler runs that got past the step-up (double-submit proof). */
    __payoutMockCalls?: PayoutMockCalls;
  }
}

/**
 * Mirrors the server's stepUp + passwordStepUp for the three money actions.
 * Off by default: only `payoutMockStepUp === "password"` changes behaviour.
 */
function passwordStepUp(
  action: PayoutMockAction,
  password: string | undefined,
) {
  if (typeof window === "undefined") return;
  let enabled = false;
  try {
    enabled = window.sessionStorage.getItem(STEP_UP_KEY) === "password";
  } catch {
    // Storage blocked: treat as off.
  }
  if (enabled) {
    // Once locked, even the right password is refused (server lockout).
    if (wrongPasswordStreak > MOCK_WRONG_LIMIT)
      throw refuse(
        429,
        "REAUTH_PASSWORD_LOCKED",
        "Terlalu banyak percobaan password. Coba lagi nanti.",
      );
    if (password === undefined || password === "")
      throw refuse(
        401,
        "REAUTH_REQUIRED",
        "Verifikasi ulang diperlukan untuk tindakan ini.",
      );
    if (password !== MOCK_RIGHT_PASSWORD) {
      wrongPasswordStreak += 1;
      if (wrongPasswordStreak > MOCK_WRONG_LIMIT)
        throw refuse(
          429,
          "REAUTH_PASSWORD_LOCKED",
          "Terlalu banyak percobaan password. Coba lagi nanti.",
        );
      throw refuse(
        403,
        "REAUTH_PASSWORD_INVALID",
        "Password salah. Periksa lalu coba lagi.",
      );
    }
    wrongPasswordStreak = 0;
  }
  const calls = (window.__payoutMockCalls ??= {
    approve: 0,
    export: 0,
    config: 0,
    recon: 0,
  });
  calls[action] += 1;
}

function find(batchId: string): PayrollDisbursementBatchDto {
  const found = state().batches.find((row) => row.id === batchId);
  if (!found)
    throw refuse(404, "NOT_FOUND", "Batch pencairan tidak ditemukan.");
  return found;
}

function save(next: PayrollDisbursementBatchDto) {
  store.set({
    ...state(),
    batches: state().batches.map((row) => (row.id === next.id ? next : row)),
  });
  return next;
}

/** Batch status after items moved: done when no item still waits. */
function settle(
  current: PayrollDisbursementBatchDto,
  items: PayrollDisbursementItemDto[],
): PayrollDisbursementBatchDto {
  const open = items.some((row) =>
    ["prepared", "approved", "sending", "exported", "unknown"].includes(
      row.status,
    ),
  );
  const status = open
    ? current.status
    : items.every((row) => ["succeeded", "cancelled"].includes(row.status))
      ? "completed"
      : "partially_failed";
  return save({
    ...current,
    items,
    status,
    updatedAt: new Date().toISOString(),
  });
}

function mapItems(
  items: PayrollDisbursementItemDto[],
  ids: readonly string[],
  patch: Partial<PayrollDisbursementItemDto>,
) {
  return items.map((row) =>
    ids.includes(row.id)
      ? { ...row, ...patch, updatedAt: new Date().toISOString() }
      : row,
  );
}

// ---- Mock-only reference paths ----------------------------------------------

const referenceQuery = z.object({ legalEntityId: z.string() });
const payableRunsPath = defineEndpoint({
  method: "GET",
  path: "/api/mock/payout/payable-runs",
  query: referenceQuery,
  response: z.object({ data: z.array(z.any()) }),
});
const sourceAccountsPath = defineEndpoint({
  method: "GET",
  path: "/api/mock/payout/source-accounts",
  query: referenceQuery,
  response: z.object({ data: z.array(z.any()) }),
});
const employeesPath = defineEndpoint({
  method: "GET",
  path: "/api/mock/payout/employees",
  response: z.object({ data: z.array(z.any()) }),
});

registerMock(payableRunsPath, ({ query, scenario }) => ({
  data:
    scenario === "empty"
      ? []
      : RUNS.filter((run) => run.legalEntityId === query.legalEntityId),
}));
registerMock(sourceAccountsPath, () => ({ data: ACCOUNTS }));
registerMock(employeesPath, () => ({ data: PEOPLE }));

// ---- Config ------------------------------------------------------------------

registerMock(getPayoutConfig, ({ params }) => ({
  data:
    params.legalEntityId === state().config.legalEntityId
      ? state().config
      : null,
}));

registerMock(upsertPayoutConfig, ({ params, body }) => {
  passwordStepUp("config", body.password);
  if (body.method === "duitku")
    throw refuse(
      409,
      "PAYOUT_CHANNEL_NOT_AVAILABLE",
      "Duitku belum aktif untuk PT ini. Gunakan transfer manual.",
    );
  const account = ACCOUNTS.find(
    (row) => row.id === body.manualSourceBankAccountId,
  );
  if (!account?.active)
    throw refuse(
      422,
      "PAYOUT_SOURCE_ACCOUNT_INVALID",
      "Rekening sumber tidak aktif. Pilih rekening aktif milik PT ini.",
    );
  const next: PayrollPayoutConfigDto = {
    ...state().config,
    legalEntityId: params.legalEntityId,
    method: body.method,
    integrationId: body.integrationId,
    manualSourceBankAccountId: body.manualSourceBankAccountId,
    manualBankFormat: body.manualBankFormat,
    maxPerTransferIdr: body.maxPerTransferIdr,
    dailyCapIdr: body.dailyCapIdr,
    feePerTransferIdr: body.feePerTransferIdr,
    enabled: body.enabled,
    updatedBy: currentActor(),
    updatedAt: new Date().toISOString(),
  };
  store.set({ ...state(), config: next });
  return { data: next };
});

// ---- Batches -----------------------------------------------------------------

registerMock(listRunDisbursementBatches, ({ params, scenario }) => ({
  data:
    scenario === "empty"
      ? []
      : state()
          .batches.filter(
            (row) => row.payrollRunId === params.id && visible(row),
          )
          .map(view),
}));

registerMock(listPayoutBatches, ({ query, scenario }) => {
  if (scenario === "empty")
    return { data: [], meta: { limit: query.limit, nextCursor: null } };
  const rows = state()
    .batches.filter(
      (row) =>
        visible(row) &&
        (query.legalEntityId === undefined ||
          row.legalEntityId === query.legalEntityId) &&
        (query.status === undefined || row.status === query.status),
    )
    .map(view);
  const paged = payoutScenario();
  const isPaged = paged === "batches-paged" || paged === "batches-paged-open";
  if (
    query.cursor !== undefined &&
    !(isPaged && [BATCH_PAGE_TWO, BATCH_PAGE_THREE].includes(query.cursor))
  )
    throw refuse(422, "VALIDATION_ERROR", "Kursor tidak valid.");
  if (isPaged) {
    const pick = (id: string) => rows.filter((row) => row.id === id);
    const pageOne = pick(
      paged === "batches-paged"
        ? MOCK_PAYOUT_IDS.batchApproval
        : MOCK_PAYOUT_IDS.batchStatus,
    );
    const pageTwo =
      paged === "batches-paged"
        ? [...pick(MOCK_PAYOUT_IDS.batchStatus), historyBatch()]
        : pick(MOCK_PAYOUT_IDS.batchApproval);
    // `batches-paged-open` ends on page 2; `batches-paged` has a third page.
    if (query.cursor === BATCH_PAGE_THREE)
      return { data: [], meta: { limit: query.limit, nextCursor: null } };
    if (query.cursor === BATCH_PAGE_TWO)
      return {
        data: pageTwo,
        meta: {
          limit: query.limit,
          nextCursor: paged === "batches-paged" ? BATCH_PAGE_THREE : null,
        },
      };
    return {
      data: pageOne,
      meta: { limit: query.limit, nextCursor: BATCH_PAGE_TWO },
    };
  }
  return {
    data: rows.slice(0, query.limit),
    meta: { limit: query.limit, nextCursor: null },
  };
});

registerMock(getDisbursementBatch, ({ params }) => {
  const found = find(params.id);
  if (!visible(found))
    throw refuse(404, "NOT_FOUND", "Batch pencairan tidak ditemukan.");
  return { data: view(found) };
});

registerMock(createDisbursementBatch, ({ params, body }) => {
  if (body.channel === "duitku")
    throw refuse(
      409,
      "PAYOUT_CHANNEL_NOT_AVAILABLE",
      "Duitku belum aktif untuk PT ini. Gunakan transfer manual.",
    );
  const payees = PAYEES[params.id];
  if (!RUNS.some((run) => run.id === params.id) || !payees)
    throw refuse(
      409,
      "PAYOUT_RUN_NOT_PAYABLE",
      "Run ini belum bisa dicairkan.",
    );
  if (
    state().batches.some(
      (row) =>
        row.payrollRunId === params.id &&
        !["completed", "partially_failed", "cancelled"].includes(row.status),
    )
  )
    throw refuse(
      409,
      "PAYOUT_BATCH_ALREADY_OPEN",
      "Run ini sudah punya batch pencairan.",
    );
  const id = nextId();
  const created = batch(
    id,
    params.id,
    payees.map((row, index) =>
      item(counter + 10 + index, id, row.employee, row.amount),
    ),
    {
      channel: body.channel,
      requestedBy: currentActor(),
      requestedAt: new Date().toISOString(),
    },
  );
  counter += 20;
  store.set({ ...state(), batches: [...state().batches, created] });
  return { data: created };
});

registerMock(submitDisbursementBatch, ({ params }) => {
  const current = find(params.id);
  if (current.status !== "draft")
    throw refuse(409, "PAYOUT_BATCH_STATE", "Batch ini sudah diajukan.");
  const next = save({
    ...current,
    status: "pending_approval",
    contentHash: hashOf(current.items),
    approvalExpiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
  });
  return { data: { batch: next, excluded: [] } };
});

registerMock(approveDisbursementBatch, ({ params, body }) => {
  if (typeof window !== "undefined") {
    const log = window as unknown as { __payoutApproveCalls?: string[] };
    log.__payoutApproveCalls = [...(log.__payoutApproveCalls ?? []), params.id];
  }
  passwordStepUp("approve", body.password);
  const current = find(params.id);
  if (current.status !== "pending_approval")
    throw refuse(
      409,
      "PAYOUT_BATCH_STATE",
      "Batch ini tidak menunggu persetujuan.",
    );
  if (current.requestedBy === currentActor())
    throw refuse(
      403,
      "PAYOUT_SELF_APPROVAL",
      "Pembuat pengajuan tidak boleh menyetujui pencairannya sendiri.",
    );
  if (body.contentHash !== current.contentHash)
    throw refuse(
      409,
      "PAYOUT_HASH_MISMATCH",
      "Isi batch berubah. Muat ulang lalu periksa lagi.",
    );
  const source = ACCOUNTS.find(
    (row) => row.id === state().config.manualSourceBankAccountId,
  );
  // The approver's screen must show the account the server will freeze.
  if (
    current.channel === "manual_bank" &&
    body.sourceBankAccountId !== source?.id
  )
    throw refuse(
      409,
      "PAYOUT_SOURCE_MISMATCH",
      "Rekening sumber berubah sejak layar dibuka. Muat ulang lalu periksa lagi.",
    );
  if (current.channel === "manual_bank" && !source?.active)
    throw refuse(
      422,
      "PAYOUT_SOURCE_ACCOUNT_INVALID",
      "Rekening sumber tidak aktif. Pilih rekening aktif milik PT ini.",
    );
  return {
    data: save({
      ...current,
      status: "approved",
      approvedBy: currentActor(),
      approvedAt: new Date().toISOString(),
      sourceBankAccountId:
        current.channel === "manual_bank" ? (source?.id ?? null) : null,
      items: current.items.map((row) => ({
        ...row,
        status: "approved" as const,
      })),
    }),
  };
});

registerMock(cancelDisbursementBatch, ({ params, body }) => {
  const current = find(params.id);
  if (!["draft", "pending_approval", "approved"].includes(current.status))
    throw refuse(
      409,
      "PAYOUT_BATCH_STATE",
      "Batch ini tidak bisa dibatalkan lagi.",
    );
  return {
    data: save({
      ...current,
      status: "cancelled",
      cancelledBy: currentActor(),
      cancelledAt: new Date().toISOString(),
      cancelReason: body.reason,
      items: current.items.map((row) => ({
        ...row,
        status: "cancelled" as const,
      })),
    }),
  };
});

registerMock(exportDisbursementBatch, ({ params, body }) => {
  passwordStepUp("export", body.password);
  const current = find(params.id);
  if (current.status === "exported" && current.exportedAt !== null)
    throw refuse(
      409,
      "PAYOUT_EXPORT_ALREADY_DOWNLOADED",
      "Berkas transfer batch ini sudah diunduh dan tidak bisa diunduh lagi.",
    );
  if (current.status !== "approved")
    throw refuse(409, "PAYOUT_BATCH_STATE", "Batch ini belum disetujui.");
  const stamp = new Date().toISOString();
  save({
    ...current,
    status: "exported",
    exportedBy: currentActor(),
    exportedAt: stamp,
    exportChecksumSha256: "b".repeat(64),
    items: current.items.map((row) => ({
      ...row,
      status: "exported" as const,
    })),
  });
  const lines = current.items.map(
    (row) => `${row.employeeId},${row.bankCode ?? ""},${row.amountIdr}`,
  );
  return {
    data: {
      filename: `pencairan-${current.id.slice(-4)}.csv`,
      contentType: "text/csv",
      content: ["employee,bank,amount", ...lines].join("\n"),
      checksumSha256: "b".repeat(64),
    },
  };
});

registerMock(confirmDisbursementItems, ({ params, body }) => {
  const current = find(params.id);
  if (current.requestedBy === currentActor())
    throw refuse(
      403,
      "PAYOUT_CONFIRM_SELF",
      "Pembuat pengajuan tidak boleh mengonfirmasi transfernya sendiri.",
    );
  if (current.status !== "exported")
    throw refuse(
      409,
      "PAYOUT_BATCH_NOT_EXPORTED",
      "Berkas transfer belum diunduh.",
    );
  let items = current.items;
  for (const result of body.results)
    items = mapItems(items, [result.itemId], {
      status: "succeeded",
      confirmedBy: currentActor(),
      confirmationRef: result.bankRef,
      settledAt: new Date().toISOString(),
    });
  const next = settle(current, items);
  return {
    data: {
      batchStatus: next.status,
      runPaid: next.status === "completed",
      confirmed: body.results.length,
    },
  };
});

/** The server trims, upper-cases and drops inner spaces before comparing. */
const normalizeBankRef = (value: string | undefined) =>
  (value ?? "").replace(/\s+/g, "").toUpperCase();

/**
 * The two-person rule of resolve and return: the first call records a proposal
 * (nothing moves), a second call by someone else with the same outcome applies
 * it. Returns the ids this call applied.
 */
function propose(
  kind: Proposal["kind"],
  outcome: string,
  itemIds: readonly string[],
  proof: { evidenceKey: string; note: string; bankRef?: string },
) {
  const bankRef = normalizeBankRef(proof.bankRef);
  if (kind === "return" && bankRef === "")
    throw refuse(
      422,
      "VALIDATION_ERROR",
      "Nomor referensi transaksi bank wajib diisi.",
    );
  seedScenarioProposals();
  const actor = currentActor();
  const proposals = { ...state().proposals };
  const applied: string[] = [];
  for (const id of itemIds) {
    const key = `${kind}:${id}`;
    const earlier = proposals[key];
    if (!earlier) {
      proposals[key] = {
        kind,
        outcome,
        by: actor,
        evidenceKey: proof.evidenceKey,
        note: proof.note,
        ...(kind === "return" ? { bankRef } : {}),
        at: new Date().toISOString(),
      };
      continue;
    }
    if (earlier.by === actor)
      throw refuse(
        409,
        "PAYOUT_RESOLVE_SAME_PERSON",
        "Orang yang sama tidak bisa menyetujui usulannya sendiri.",
      );
    if (earlier.outcome !== outcome)
      throw refuse(
        409,
        "PAYOUT_RESOLVE_OUTCOME_MISMATCH",
        "Hasil yang dipilih berbeda dari usulan sebelumnya.",
      );
    if (earlier.evidenceKey !== proof.evidenceKey)
      throw kind === "resolve"
        ? refuse(
            409,
            "PAYOUT_RESOLVE_EVIDENCE_MISMATCH",
            "Bukti berbeda dari usulan orang pertama.",
          )
        : refuse(
            409,
            "PAYOUT_RETURN_EVIDENCE_MISMATCH",
            "Bukti berbeda dari usulan orang pertama.",
          );
    if (kind === "return" && earlier.bankRef !== bankRef)
      throw refuse(
        409,
        "PAYOUT_RETURN_BANK_REF_MISMATCH",
        "Nomor referensi bank berbeda dari catatan orang pertama.",
      );
    delete proposals[key];
    applied.push(id);
  }
  store.set({ ...state(), proposals });
  return applied;
}

registerMock(listResolutionProposals, ({ params }) => {
  const current = find(params.id);
  seedScenarioProposals();
  const byItem = new Map(current.items.map((row) => [row.id, row] as const));
  return {
    data: Object.entries(state().proposals).flatMap(([key, proposal]) => {
      const target = byItem.get(key.slice(key.indexOf(":") + 1));
      if (!target) return [];
      return [
        {
          itemId: target.id,
          employeeId: target.employeeId,
          groupItemIds: [target.id],
          kind: proposal.kind,
          outcome:
            proposal.kind === "return"
              ? null
              : proposal.outcome === "not_sent"
                ? ("not_sent" as const)
                : ("failed" as const),
          evidenceKey: proposal.evidenceKey,
          note: proposal.note,
          proposedBy: proposal.by,
          // Same tenant only: a person without a name here reads as null.
          proposedByName:
            PEOPLE.find((person) => person.userId === proposal.by)?.name ??
            null,
          proposedAt: proposal.at,
        },
      ];
    }),
  };
});

registerMock(readPayoutEvidence, ({ params, query }) => {
  find(params.id);
  if (!query.key.includes(`/${params.id}/`))
    throw refuse(422, "VALIDATION_ERROR", "Kunci bukti bukan milik batch ini.");
  return {
    data: {
      evidenceKey: query.key,
      // Nothing to show in mock mode; a blank tab proves the link opened.
      url: "about:blank",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
});

registerMock(resolveDisbursementItems, ({ params, body }) => {
  const current = find(params.id);
  if (current.requestedBy === currentActor())
    throw refuse(
      403,
      "PAYOUT_CONFIRM_SELF",
      "Pembuat pengajuan tidak boleh menyelesaikan transfernya sendiri.",
    );
  const applied = propose("resolve", body.outcome, body.itemIds, body);
  const next =
    applied.length === 0
      ? current
      : settle(
          current,
          mapItems(current.items, applied, {
            status: body.outcome === "failed" ? "failed" : "not_sent",
          }),
        );
  return {
    data: {
      batchStatus: next.status,
      resolved: applied.length,
      proposed: body.itemIds.length - applied.length,
    },
  };
});

registerMock(returnDisbursementItems, ({ params, body }) => {
  const current = find(params.id);
  if (current.requestedBy === currentActor())
    throw refuse(
      403,
      "PAYOUT_CONFIRM_SELF",
      "Pembuat pengajuan tidak boleh mengembalikan dana transfernya sendiri.",
    );
  if (current.channel !== "manual_bank")
    throw refuse(
      409,
      "PAYOUT_CHANNEL_MISMATCH",
      "Pengembalian dana hanya untuk transfer bank manual.",
    );
  for (const id of body.itemIds) {
    const target = current.items.find((entry) => entry.id === id);
    if (!target)
      throw refuse(404, "NOT_FOUND", "Item pencairan tidak ditemukan.");
    if (target.status !== "succeeded")
      throw refuse(
        409,
        "PAYOUT_ITEM_STATE",
        "Hanya transfer yang berhasil bisa dikembalikan.",
      );
  }
  const applied = propose("return", "returned", body.itemIds, body);
  const next =
    applied.length === 0
      ? current
      : save({
          ...current,
          items: mapItems(current.items, applied, { status: "returned" }),
          updatedAt: new Date().toISOString(),
        });
  return {
    data: {
      batchStatus: next.status,
      returned: applied.length,
      proposed: body.itemIds.length - applied.length,
    },
  };
});

registerMock(confirmDisbursementCash, ({ params, body }) => {
  const current = find(params.id);
  if (current.requestedBy === currentActor())
    throw refuse(
      403,
      "PAYOUT_CONFIRM_SELF",
      "Pembuat pengajuan tidak boleh mengonfirmasi serah terima tunai sendiri.",
    );
  const next = settle(
    current,
    mapItems(current.items, body.itemIds, {
      channel: "cash",
      status: "succeeded",
      confirmedBy: currentActor(),
      settledAt: new Date().toISOString(),
    }),
  );
  return {
    data: { batchStatus: next.status, runPaid: next.status === "completed" },
  };
});

// ---- "Not me" and unfreeze (legend-l2zru) -------------------------------------

registerMock(getPayoutApprovalLog, ({ params }) => {
  if (params.logId !== MOCK_PAYOUT_IDS.logStatus)
    throw refuse(404, "NOT_FOUND", "Langkah ini tidak ditemukan.");
  const found = find(MOCK_PAYOUT_IDS.batchStatus);
  return {
    data: {
      id: params.logId,
      batchId: found.id,
      kind: "bank_confirm" as const,
      step: "confirm" as const,
      itemCount: found.items.length,
      period: "1 sampai 30 November 2026",
      loggedAt: found.updatedAt,
      disowned: found.freeze.disputes.some((row) => row.logId === params.logId),
      batchFrozen: found.freeze.frozen,
    },
  };
});

registerMock(disownPayoutApproval, ({ params, body }) => {
  if (params.logId !== MOCK_PAYOUT_IDS.logStatus)
    throw refuse(404, "NOT_FOUND", "Langkah ini tidak ditemukan.");
  const current = find(MOCK_PAYOUT_IDS.batchStatus);
  const existing = current.freeze.disputes.find(
    (row) => row.logId === params.logId,
  );
  if (existing)
    return { data: { disputeId: existing.id, batchId: current.id } };
  const disputeId = uid(401 + current.freeze.disputes.length);
  save({
    ...current,
    freeze: {
      frozen: true,
      disputes: [
        ...current.freeze.disputes,
        {
          id: disputeId,
          batchId: current.id,
          logId: params.logId,
          createdAt: new Date().toISOString(),
          batchStatusAt: current.status,
          reason: body.reason ?? null,
          mine: true,
        },
      ],
    },
  });
  return { data: { disputeId, batchId: current.id } };
});

registerMock(unfreezeDisbursementBatch, ({ params }) => {
  const current = find(params.id);
  if (!current.freeze.frozen)
    throw refuse(
      409,
      "PAYOUT_UNFREEZE_REFUSED",
      "Tidak ada pembekuan yang perlu dibuka.",
    );
  const released = current.freeze.disputes.length;
  save({ ...current, freeze: { frozen: false, disputes: [] } });
  return { data: { released } };
});

// ---- Recon flags and return-claim withdrawal ---------------------------------------

type ReconClearance = NonNullable<PayoutReconFlagDto["clearance"]>;
type ReconMockState = {
  /** Scenario the state was seeded for; another scenario re-seeds it. */
  seededFor: string;
  flags: PayoutReconFlagDto[];
  claims: PayoutReturnClaimDto[];
};

const RECON_STORAGE_KEY = "payoutReconMock";
const reconId = (n: number) => spreadUid(7000 + n);
export const MOCK_RECON_IDS = {
  flagOpen: reconId(1),
  flagProposed: reconId(2),
  flagApproved: reconId(3),
  flagReopened: reconId(4),
  claimOpen: reconId(21),
  claimWithdrawProposed: reconId(22),
  claimConsumed: reconId(23),
  claimWithdrawn: reconId(24),
} as const;

/** The mock "other person": whoever the signed-in mock user is not. */
const otherUser = () =>
  currentActor() === userIds.financeApprover
    ? userIds.hrApprover
    : userIds.financeApprover;

function seedRecon(scenario: string, seededFor: string): ReconMockState {
  const other = otherUser();
  // `recon-self` puts every proposal under the signed-in user.
  const proposer = scenario === "recon-self" ? currentActor() : other;
  const flag = (
    n: number,
    itemNo: number,
    reason: string,
    clearance: ReconClearance | null,
    reopened = false,
  ): PayoutReconFlagDto => ({
    id: reconId(n),
    kind: n === 4 ? "return_withdraw" : n === 3 ? "posting_source" : "return",
    itemId: spreadUid(2000 + itemNo),
    payslipId: spreadUid(6000 + itemNo),
    batchId: MOCK_PAYOUT_IDS.batchStatus,
    reason,
    flaggedAt: `2026-11-1${n}T03:15:00.000Z`,
    reopened,
    clearance,
  });
  const proposed = (n: number, reason: string): ReconClearance => ({
    id: reconId(10 + n),
    status: "proposed",
    reason,
    proposedBy: proposer,
    proposedAt: "2026-11-16T08:40:00.000Z",
    approvedBy: null,
    approvedAt: null,
  });
  const claim = (
    n: number,
    patch: Partial<PayoutReturnClaimDto>,
  ): PayoutReturnClaimDto => ({
    id: reconId(20 + n),
    status: "open",
    bankRef: `RTN2026110${n}`,
    itemCount: 1,
    createdBy: other,
    createdAt: `2026-11-0${n}T04:00:00.000Z`,
    withdrawal: null,
    ...patch,
  });
  const claims = [
    claim(1, {}),
    claim(2, {
      itemCount: 2,
      withdrawal: {
        id: reconId(30),
        reason: "Dana kembali dicatat ke item yang salah, perlu dicatat ulang.",
        proposedBy: proposer,
        proposedAt: "2026-11-16T09:05:00.000Z",
      },
    }),
    claim(3, { status: "consumed" }),
    claim(4, { status: "withdrawn" }),
  ];
  if (scenario === "empty") return { seededFor, flags: [], claims: [] };
  if (scenario === "recon-reopened")
    return {
      seededFor,
      flags: [
        flag(
          4,
          4,
          "Data pengembalian berubah setelah clearance disetujui.",
          null,
          true,
        ),
      ],
      claims,
    };
  if (
    scenario === "recon-approve" ||
    scenario === "recon-self" ||
    scenario === "recon-changed"
  )
    return {
      seededFor,
      flags: [
        flag(
          2,
          2,
          "Dana kembali dicatat tanpa jurnal yang cocok.",
          proposed(2, "Selisih sudah dicocokkan dengan mutasi bank."),
        ),
      ],
      claims,
    };
  return {
    seededFor,
    flags: [
      flag(1, 1, "Biaya PT tidak cocok dengan jurnal biaya.", null),
      flag(
        2,
        2,
        "Dana kembali dicatat tanpa jurnal yang cocok.",
        proposed(2, "Selisih sudah dicocokkan dengan mutasi bank."),
      ),
      flag(3, 3, "Sumber dana jurnal berbeda dari rekening batch.", {
        id: reconId(13),
        status: "approved",
        reason: "Rekening sumber sudah diperiksa dan sesuai.",
        proposedBy: userIds.financeApprover,
        proposedAt: "2026-11-15T08:00:00.000Z",
        approvedBy: userIds.hrApprover,
        approvedAt: "2026-11-15T09:30:00.000Z",
      }),
      flag(4, 4, "Data pengembalian berubah setelah clearance.", null, true),
    ],
    claims,
  };
}

const reconStore = createMockStore<ReconMockState | null>(() => null);

/**
 * Proposals survive a reload (sessionStorage), so a spec can approve as another
 * user after the proposer's page is gone. A different scenario re-seeds. The
 * server render holds the seed in memory only.
 */
function reconState(scenario: string): ReconMockState {
  // Only `empty` and the recon scenarios change the data; `slow` and `error`
  // act in the transport and must not wipe a stored proposal.
  const effective = isReconScenario(payoutScenario())
    ? (payoutScenario() as string)
    : scenario === "empty"
      ? "empty"
      : "normal";
  const stored = (() => {
    if (typeof window === "undefined") return reconStore.get();
    try {
      const raw = window.sessionStorage.getItem(RECON_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as ReconMockState) : null;
    } catch {
      return reconStore.get();
    }
  })();
  // The proposer is picked relative to the signed-in user at seed time only;
  // a changed user keeps the stored state, which is what a two-person spec needs.
  if (stored?.seededFor === effective) return stored;
  const seeded = seedRecon(effective, effective);
  saveRecon(seeded);
  return seeded;
}

function saveRecon(next: ReconMockState) {
  reconStore.set(next);
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(RECON_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the in-memory copy still serves this page.
  }
}

registerMock(listPayoutReconFlagsEndpoint, ({ scenario }) => ({
  data: reconState(scenario).flags,
}));

registerMock(proposeReconClearanceEndpoint, ({ params, body, scenario }) => {
  passwordStepUp("recon", body.password);
  const current = reconState(scenario);
  const found = current.flags.find((row) => row.id === params.flagId);
  if (!found)
    throw refuse(
      404,
      "PAYOUT_RECON_FLAG_NOT_FOUND",
      "Flag rekonsiliasi tidak ditemukan.",
    );
  // The same proposal again answers the same id; the first reason stays.
  if (found.clearance?.status === "proposed")
    return { data: { clearanceId: found.clearance.id } };
  if (found.clearance?.status === "approved")
    throw refuse(
      409,
      "PAYOUT_RECON_CLEAR_STATE",
      "Penutupan flag ini sudah disetujui.",
    );
  const clearanceId = nextId();
  saveRecon({
    ...current,
    flags: current.flags.map((row) =>
      row.id === found.id
        ? {
            ...row,
            clearance: {
              id: clearanceId,
              status: "proposed" as const,
              reason: body.reason,
              proposedBy: currentActor(),
              proposedAt: new Date().toISOString(),
              approvedBy: null,
              approvedAt: null,
            },
          }
        : row,
    ),
  });
  return { data: { clearanceId } };
});

registerMock(approveReconClearanceEndpoint, ({ params, body, scenario }) => {
  passwordStepUp("recon", body.password);
  const current = reconState(scenario);
  const found = current.flags.find(
    (row) => row.clearance?.id === params.clearanceId,
  );
  const clearance = found?.clearance;
  if (!found || !clearance)
    throw refuse(
      404,
      "PAYOUT_RECON_CLEARANCE_NOT_FOUND",
      "Usulan penutupan flag tidak ditemukan.",
    );
  if (clearance.status === "approved")
    throw refuse(
      409,
      "PAYOUT_RECON_CLEAR_STATE",
      "Penutupan flag ini sudah disetujui.",
    );
  if (clearance.proposedBy === currentActor())
    throw refuse(
      403,
      "PAYOUT_RECON_CLEAR_SELF_APPROVAL",
      "Pengusul penutupan flag tidak boleh menyetujuinya sendiri.",
    );
  if (payoutScenario() === "recon-changed") {
    // The flagged data changed after the proposal: it falls away, flag reopens.
    saveRecon({
      ...current,
      flags: current.flags.map((row) =>
        row.id === found.id ? { ...row, clearance: null } : row,
      ),
    });
    throw refuse(
      409,
      "PAYOUT_RECON_FLAG_CHANGED",
      "Data yang ditandai berubah sejak penutupan flag diusulkan. Ajukan usulan penutupan baru.",
    );
  }
  saveRecon({
    ...current,
    flags: current.flags.map((row) =>
      row.id === found.id
        ? {
            ...row,
            reopened: false,
            clearance: {
              ...clearance,
              status: "approved" as const,
              approvedBy: currentActor(),
              approvedAt: new Date().toISOString(),
            },
          }
        : row,
    ),
  });
  return { data: { clearanceId: clearance.id } };
});

registerMock(listBatchReturnClaimsEndpoint, ({ params, scenario }) => {
  find(params.id);
  return {
    data:
      params.id === MOCK_PAYOUT_IDS.batchStatus
        ? reconState(scenario).claims
        : [],
  };
});

registerMock(proposeReturnWithdrawalEndpoint, ({ params, body, scenario }) => {
  passwordStepUp("recon", body.password);
  const current = reconState(scenario);
  const found = current.claims.find((row) => row.id === params.claimId);
  if (!found)
    throw refuse(
      404,
      "PAYOUT_RETURN_CLAIM_NOT_FOUND",
      "Klaim pengembalian tidak ditemukan.",
    );
  if (found.withdrawal) return { data: { withdrawalId: found.withdrawal.id } };
  if (found.status !== "open")
    throw refuse(
      409,
      "PAYOUT_RETURN_WITHDRAW_REFUSED",
      "Klaim pengembalian ini tidak dapat ditarik (sudah dikonfirmasi, berubah, atau sudah ditarik).",
    );
  const withdrawalId = nextId();
  saveRecon({
    ...current,
    claims: current.claims.map((row) =>
      row.id === found.id
        ? {
            ...row,
            withdrawal: {
              id: withdrawalId,
              reason: body.reason,
              proposedBy: currentActor(),
              proposedAt: new Date().toISOString(),
            },
          }
        : row,
    ),
  });
  return { data: { withdrawalId } };
});

registerMock(approveReturnWithdrawalEndpoint, ({ params, body, scenario }) => {
  passwordStepUp("recon", body.password);
  const current = reconState(scenario);
  const found = current.claims.find(
    (row) => row.withdrawal?.id === params.withdrawalId,
  );
  const withdrawal = found?.withdrawal;
  if (!found || !withdrawal)
    throw refuse(
      404,
      "PAYOUT_RETURN_WITHDRAWAL_NOT_FOUND",
      "Usulan penarikan klaim tidak ditemukan.",
    );
  if (withdrawal.proposedBy === currentActor())
    throw refuse(
      403,
      "PAYOUT_RETURN_WITHDRAW_SELF_APPROVAL",
      "Pengusul penarikan klaim tidak boleh menyetujuinya sendiri.",
    );
  if (payoutScenario() === "recon-changed") {
    // The claim moved on after the proposal: it can no longer be withdrawn.
    saveRecon({
      ...current,
      claims: current.claims.map((row) =>
        row.id === found.id
          ? { ...row, status: "consumed" as const, withdrawal: null }
          : row,
      ),
    });
    throw refuse(
      409,
      "PAYOUT_RETURN_WITHDRAW_REFUSED",
      "Klaim pengembalian ini tidak dapat ditarik (sudah dikonfirmasi, berubah, atau sudah ditarik).",
    );
  }
  saveRecon({
    ...current,
    claims: current.claims.map((row) =>
      row.id === found.id
        ? { ...row, status: "withdrawn" as const, withdrawal: null }
        : row,
    ),
  });
  return {
    data: { withdrawalId: withdrawal.id, restoredItems: found.itemCount },
  };
});

// ---- Recon holds (legend-6o7pc) -----------------------------------------------------

type HoldRelease = NonNullable<PayoutReconHoldDto["release"]>;
type HoldMockState = {
  /** Scenario the state was seeded for; another scenario re-seeds it. */
  seededFor: string;
  holds: PayoutReconHoldDto[];
};

const HOLD_STORAGE_KEY = "payoutReconHoldMock";
const holdId = (n: number) => spreadUid(8000 + n);
export const MOCK_HOLD_IDS = {
  held: holdId(1),
  notClean: holdId(2),
  proposed: holdId(3),
  released: holdId(4),
  takenOver: holdId(5),
} as const;

function seedHolds(scenario: string): HoldMockState {
  const other = otherUser();
  const proposer = scenario === "hold-self" ? currentActor() : other;
  const hold = (
    n: number,
    patch: Partial<PayoutReconHoldDto> = {},
  ): PayoutReconHoldDto => ({
    id: holdId(n),
    kind: "return",
    itemId: spreadUid(2000 + n),
    payslipId: spreadUid(6000 + n),
    batchId: MOCK_PAYOUT_IDS.batchStatus,
    reason: "evidence_read_locked",
    heldAt: `2026-11-1${n}T03:15:00.000Z`,
    takenOver: false,
    releasable: true,
    release: null,
    ...patch,
  });
  const proposed = (n: number): HoldRelease => ({
    id: holdId(10 + n),
    status: "proposed",
    reason: "Bukti bank terbaca bersih pada pemeriksaan malam berikutnya.",
    proposedBy: proposer,
    proposedAt: "2026-11-16T08:40:00.000Z",
    approvedBy: null,
    approvedAt: null,
  });
  if (scenario === "empty") return { seededFor: scenario, holds: [] };
  if (scenario === "hold-approve" || scenario === "hold-self")
    return {
      seededFor: scenario,
      holds: [hold(3, { release: proposed(3) })],
    };
  if (scenario === "hold-taken-over")
    return {
      seededFor: scenario,
      holds: [hold(1), hold(3, { release: proposed(3) })],
    };
  return {
    seededFor: scenario,
    holds: [
      hold(1),
      hold(2, { releasable: false }),
      hold(3, { release: proposed(3) }),
      hold(4, {
        release: {
          ...proposed(4),
          status: "approved",
          proposedBy: userIds.financeApprover,
          approvedBy: userIds.hrApprover,
          approvedAt: "2026-11-15T09:30:00.000Z",
        },
      }),
      hold(5, { takenOver: true, releasable: false }),
    ],
  };
}

const holdStore = createMockStore<HoldMockState | null>(() => null);

function holdState(scenario: string): HoldMockState {
  // Only `empty` and the hold scenarios change the data; `slow` and `error`
  // act in the transport and must not wipe a stored proposal.
  const effective = isHoldScenario(payoutScenario())
    ? (payoutScenario() as string)
    : scenario === "empty"
      ? "empty"
      : "normal";
  const stored = (() => {
    if (typeof window === "undefined") return holdStore.get();
    try {
      const raw = window.sessionStorage.getItem(HOLD_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as HoldMockState) : null;
    } catch {
      return holdStore.get();
    }
  })();
  // The proposer is picked relative to the signed-in user at seed time only;
  // a changed user keeps the stored state, which is what a two-person spec needs.
  if (stored?.seededFor === effective) return stored;
  const seeded = seedHolds(effective);
  saveHolds(seeded);
  return seeded;
}

function saveHolds(next: HoldMockState) {
  holdStore.set(next);
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the in-memory copy still serves this page.
  }
}

/** A flag took the hold over: the release is moot, the flag and its clearance decide. */
function takeOverHold(current: HoldMockState, id: string): never {
  saveHolds({
    ...current,
    holds: current.holds.map((row) =>
      row.id === id ? { ...row, takenOver: true, releasable: false } : row,
    ),
  });
  throw refuse(
    409,
    "PAYOUT_RECON_HOLD_TAKEN_OVER",
    "Hold sudah diambil alih flag.",
  );
}

registerMock(listPayoutReconHoldsEndpoint, ({ scenario }) => ({
  data: holdState(scenario).holds,
}));

registerMock(proposeReconHoldReleaseEndpoint, ({ params, body, scenario }) => {
  passwordStepUp("recon", body.password);
  const current = holdState(scenario);
  const found = current.holds.find((row) => row.id === params.holdId);
  if (!found)
    throw refuse(
      404,
      "PAYOUT_RECON_HOLD_NOT_FOUND",
      "Hold slip tidak ditemukan.",
    );
  // The same proposal again answers the same id; the first reason stays.
  if (found.release) return { data: { releaseId: found.release.id } };
  if (found.takenOver || payoutScenario() === "hold-taken-over")
    takeOverHold(current, found.id);
  if (!found.releasable)
    throw refuse(
      409,
      "PAYOUT_RECON_HOLD_EVIDENCE_NOT_CLEAN",
      "Bukti rekonsiliasi belum bersih.",
    );
  const releaseId = nextId();
  saveHolds({
    ...current,
    holds: current.holds.map((row) =>
      row.id === found.id
        ? {
            ...row,
            release: {
              id: releaseId,
              status: "proposed" as const,
              reason: body.reason,
              proposedBy: currentActor(),
              proposedAt: new Date().toISOString(),
              approvedBy: null,
              approvedAt: null,
            },
          }
        : row,
    ),
  });
  return { data: { releaseId } };
});

registerMock(approveReconHoldReleaseEndpoint, ({ params, body, scenario }) => {
  passwordStepUp("recon", body.password);
  const current = holdState(scenario);
  const found = current.holds.find(
    (row) => row.release?.id === params.releaseId,
  );
  const release = found?.release;
  if (!found || !release)
    throw refuse(
      404,
      "PAYOUT_RECON_HOLD_NOT_FOUND",
      "Usulan pelepasan hold tidak ditemukan.",
    );
  if (release.status === "approved")
    throw refuse(
      409,
      "PAYOUT_RECON_CLEAR_STATE",
      "Penutupan flag ini sudah disetujui.",
    );
  if (release.proposedBy === currentActor())
    throw refuse(
      403,
      "PAYOUT_RECON_CLEAR_SELF_APPROVAL",
      "Pengusul penutupan flag tidak boleh menyetujuinya sendiri.",
    );
  if (found.takenOver || payoutScenario() === "hold-taken-over")
    takeOverHold(current, found.id);
  saveHolds({
    ...current,
    holds: current.holds.map((row) =>
      row.id === found.id
        ? {
            ...row,
            release: {
              ...release,
              status: "approved" as const,
              approvedBy: currentActor(),
              approvedAt: new Date().toISOString(),
            },
          }
        : row,
    ),
  });
  return { data: { releaseId: release.id } };
});
