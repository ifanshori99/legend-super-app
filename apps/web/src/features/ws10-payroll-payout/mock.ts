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
  exportDisbursementBatch,
  getDisbursementBatch,
  getPayoutConfig,
  listRunDisbursementBatches,
  resolveDisbursementItems,
  submitDisbursementBatch,
  upsertPayoutConfig,
} from "@starter/shared/hris/payroll/payout";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type {
  PayrollDisbursementBatchDto,
  PayrollDisbursementItemDto,
  PayrollPayoutConfigDto,
} from "@starter/shared/types";
import { ApiError } from "@/lib/api/errors";
import { MOCK_ROLE_COOKIE, parseMockRole } from "@/lib/areas/access";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import type { PayableRun, PayoutEmployee } from "./api";

const LEGAL_ENTITY_ID = cafeLegendPlatformFixtures.legalEntity.id;
const { userIds } = cafeLegendPayrollFixtures;

/** Deterministic RFC 4122 ids so e2e and demos can name a batch in the URL. */
const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const MOCK_PAYOUT_IDS = {
  runApproval: uid(101),
  runNew: uid(102),
  runStatus: uid(100),
  batchApproval: uid(201),
  batchStatus: uid(202),
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
    bankLabel: "BCA •••• 2210",
  },
  {
    id: uid(302),
    userId: null,
    name: "Bima Pratama",
    subtitle: "Barista · Kemang",
    bankLabel: "Mandiri •••• 0873",
  },
  {
    id: uid(303),
    userId: null,
    name: "Citra Lestari",
    subtitle: "Dapur · Senopati",
    bankLabel: "BNI •••• 5541",
  },
  {
    id: uid(304),
    userId: null,
    name: "Dimas Saputra",
    subtitle: "Pelayan · Senopati",
    bankLabel: "BCA •••• 7712",
  },
  {
    id: uid(305),
    userId: null,
    name: "Eka Wijaya",
    subtitle: "Gudang · Kemang",
    bankLabel: "BCA •••• 3308",
  },
  {
    id: uid(306),
    userId: null,
    name: "Gita Maharani",
    subtitle: "Kasir · Kemang",
    bankLabel: "Mandiri •••• 6125",
  },
  {
    id: uid(307),
    userId: null,
    name: "Hadi Wibowo",
    subtitle: "Barista · Kemang",
    bankLabel: "BCA •••• 9084",
  },
  {
    id: uid(308),
    userId: userIds.hrApprover,
    name: "Rani Wulandari",
    subtitle: "HR · Kantor",
    bankLabel: null,
  },
  {
    id: uid(309),
    userId: userIds.financeApprover,
    name: "Sari Kurniawan",
    subtitle: "Finance · Kantor",
    bankLabel: null,
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
  return {
    id: uid(n),
    batchId,
    payslipId: uid(n + 500),
    employeeId: uid(employee),
    channel: "manual_bank",
    attemptNo: 1,
    status: "prepared",
    excludedReason: null,
    amountIdr,
    feeIdr: FEE_IDR,
    bankCode: "014",
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
    exportedBy: null,
    exportedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: NOW,
    updatedAt: NOW,
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
      confirmedBy: userIds.financeApprover,
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
  return [
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
      requestedAt: "2026-10-30T03:00:00.000Z",
      approvedBy: userIds.financeApprover,
      approvedAt: "2026-10-30T04:00:00.000Z",
      contentHash: hashOf(statusItems),
      exportedBy: userIds.hrApprover,
      exportedAt: "2026-10-30T04:30:00.000Z",
      exportChecksumSha256: "a".repeat(64),
    }),
  ];
}

type PayoutMockState = {
  config: PayrollPayoutConfigDto;
  batches: PayrollDisbursementBatchDto[];
};
const store = createMockStore<PayoutMockState>(() => ({
  config: seedConfig(),
  batches: seedBatches(),
}));
const state = () => store.get();
let counter = 5000;
const nextId = () => uid((counter += 1));

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

const refuse = (status: number, code: string, message: string) =>
  new ApiError(status, code, message);

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
      : state().batches.filter((row) => row.payrollRunId === params.id),
}));

registerMock(getDisbursementBatch, ({ params }) => ({
  data: find(params.id),
}));

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

registerMock(exportDisbursementBatch, ({ params }) => {
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

registerMock(resolveDisbursementItems, ({ params, body }) => {
  const current = find(params.id);
  if (current.requestedBy === currentActor())
    throw refuse(
      403,
      "PAYOUT_CONFIRM_SELF",
      "Pembuat pengajuan tidak boleh menyelesaikan transfernya sendiri.",
    );
  const next = settle(
    current,
    mapItems(current.items, body.itemIds, {
      status: body.outcome === "failed" ? "failed" : "not_sent",
    }),
  );
  return {
    data: {
      batchStatus: next.status,
      resolved: body.itemIds.length,
      proposed: 0,
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
