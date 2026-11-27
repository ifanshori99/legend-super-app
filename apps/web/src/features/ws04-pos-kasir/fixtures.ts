// Static demo data behind the POS kasir mock (bead legend-mjmm). Numbers follow
// the approved mockups (design/mockups/pos): a Rp248.000 table bill with a
// Rp100.000 reservation deposit, a customer code, a cashier shift that is
// Rp20.000 short and a day that closes at Rp12.480.000. The mock engine
// (./mock-engine.ts) is the only reader.
//
// Plain TypeScript: Node tests load it directly.
import type {
  CashMovement,
  EdcTerminal,
  EngineOrder,
  EngineShift,
  Ewallet,
  PaymentMethodOption,
  RegisteredTerminal,
  SupervisorOption,
  VaBank,
} from "./types.ts";
import {
  DEMO_CODE_ORDER_ID,
  DEMO_ORDER_ID,
  DEMO_SHIFT_ID,
} from "./demo-seed.ts";

/** The demo day, 8 November 2026. WIB is UTC+7, so 07:31Z is 14.31 local. */
export const DEMO_BUSINESS_DATE = "2026-11-08";
export const DEMO_CASHIER_NAME = "Kasir 01";
export const DEMO_TERMINAL_LABEL = "Terminal 01";
export const DEMO_OUTLET_LABEL = "Cafe Legend";

/** The supervisor PIN every mock override accepts. */
export const MOCK_SUPERVISOR_PIN = "123456";
export const MAX_PIN_MISSES = 5;

/** Placeholder users: the pos fixtures name them 503 (supervisor), 504 (cashier). */
export const MOCK_SUPERVISOR_ID = "00000000-0000-4000-8000-000000000503";
export const MOCK_CASHIER_ID = "00000000-0000-4000-8000-000000000504";
export const MOCK_DEVICE_ID = "00000000-0000-4000-8000-000000000610";

export const supervisorOptions: SupervisorOption[] = [
  { userId: MOCK_SUPERVISOR_ID, name: "Supervisor 01" },
];

export const paymentMethods: PaymentMethodOption[] = [
  {
    code: "qris",
    label: "QRIS",
    hint: "QR di customer display",
    enabled: true,
  },
  {
    code: "va",
    label: "Virtual Account",
    hint: "Pilih bank yang tersedia",
    enabled: true,
  },
  {
    code: "ewallet",
    label: "E-wallet",
    hint: "Pilih dompet digital",
    enabled: true,
  },
  {
    code: "card",
    label: "Kartu kredit/debit",
    hint: "Pembayaran online",
    enabled: true,
  },
  {
    code: "cash",
    label: "Tunai",
    hint: "Hitung uang dan kembalian",
    enabled: true,
  },
  {
    code: "edc",
    label: "EDC",
    hint: "Kartu atau QRIS di mesin",
    enabled: true,
  },
];

export const edcTerminals: EdcTerminal[] = [
  {
    id: "edc-01",
    label: "Bank A · EDC 01",
    bank: "Bank A",
    integrated: true,
    status: "ready",
    assignedTo: DEMO_CASHIER_NAME,
  },
  {
    id: "edc-02",
    label: "Bank B · EDC 02",
    bank: "Bank B",
    integrated: true,
    status: "ready",
    assignedTo: DEMO_CASHIER_NAME,
  },
];

export const vaBanks: VaBank[] = [
  { code: "bca", label: "Bank BCA" },
  { code: "mandiri", label: "Bank Mandiri" },
  { code: "bni", label: "Bank BNI" },
];

export const ewallets: Ewallet[] = [
  { code: "gopay", label: "GoPay" },
  { code: "ovo", label: "OVO" },
  { code: "dana", label: "DANA" },
  { code: "shopeepay", label: "ShopeePay" },
];

export const registeredTerminals: RegisteredTerminal[] = [
  {
    id: MOCK_DEVICE_ID,
    label: DEMO_TERMINAL_LABEL,
    outletName: DEMO_OUTLET_LABEL,
    cashierName: DEMO_CASHIER_NAME,
  },
];

/** Time of the first QRIS payment in the "split" demo: 14.31 WIB. */
export const DEMO_QRIS_CONFIRMED_AT = "2026-11-08T07:31:00.000Z";
export const DEMO_VA_DEADLINE = "2026-11-08T07:42:00.000Z";
/** Reference the EDC bank returned in the success and standalone demos. */
export const DEMO_EDC_BANK_REF = "736214805192";
export const DEMO_EDC_APPROVAL = "482731";

/** Table A12 bill: 6 items, 2 guests, Rp248.000, DP RSV-0018 Rp100.000. */
export function demoOrder(): EngineOrder {
  return {
    id: DEMO_ORDER_ID,
    orderNo: "POS-0048",
    tableLabel: "Meja A12",
    guestCount: 2,
    items: [
      { name: "Nasi goreng kampung", qty: 2, amountIdr: 80_000 },
      { name: "Ayam sambal matah", qty: 1, amountIdr: 45_000 },
      { name: "Sate ayam", qty: 1, amountIdr: 35_000 },
      { name: "Kopi susu aren", qty: 2, amountIdr: 60_000 },
    ],
    subtotalIdr: 220_000,
    serviceIdr: 8_000,
    taxIdr: 20_000,
    totalIdr: 248_000,
    deposit: { reference: "RSV-0018", amountIdr: 100_000 },
    tenders: [],
    attempts: [],
    checkOutcome: "confirm",
    receiptNo: null,
    receiptPrints: 0,
    version: 0,
    code: null,
  };
}

/**
 * `?demo=dp-lunas` (legend-p7lx): the same Meja A12 bill, but the reservation
 * DP (RSV-0019) is the whole Rp248.000, so nothing is left to collect. The
 * engine seeds it by merging this over `demoOrder()`.
 */
export function dpLunasOrderPatch(): Pick<EngineOrder, "orderNo" | "deposit"> {
  return {
    orderNo: "POS-0049",
    deposit: { reference: "RSV-0019", amountIdr: 248_000 },
  };
}

/** Customer code LG-0044: Meja A01, one iced espresso, Rp26.600 with tax. */
export function codeOrder(): EngineOrder {
  return {
    id: DEMO_CODE_ORDER_ID,
    orderNo: "LG-0044",
    tableLabel: "Meja A01",
    guestCount: 1,
    items: [{ name: "Espresso dingin", qty: 1, amountIdr: 26_600 }],
    subtotalIdr: 23_000,
    serviceIdr: 1_150,
    taxIdr: 2_450,
    totalIdr: 26_600,
    deposit: null,
    tenders: [],
    attempts: [],
    checkOutcome: "confirm",
    receiptNo: null,
    receiptPrints: 0,
    version: 0,
    code: "LG-0044",
  };
}

/** Shift S-008 as the supervisor mockup shows it: Rp20.000 short once counted. */
export function demoShift(status: EngineShift["status"] = "open"): EngineShift {
  return {
    id: DEMO_SHIFT_ID,
    shiftNo: "S-008",
    status,
    cashierName: DEMO_CASHIER_NAME,
    terminalLabel: DEMO_TERMINAL_LABEL,
    businessDate: DEMO_BUSINESS_DATE,
    openedAt: "2026-11-08T00:00:00.000Z",
    openingFloatIdr: 500_000,
    cashSalesIdr: 1_850_000,
    cashRefundsIdr: 50_000,
    cashInIdr: 100_000,
    cashOutIdr: 150_000,
    cashDropIdr: 0,
    count: null,
    closed: null,
  };
}

/** The count of the supervisor mockup: Rp2.230.000 in notes. */
export const demoBlindCount = {
  countedIdr: 2_230_000,
  counts: [
    { denominationIdr: 100_000, quantity: 18 },
    { denominationIdr: 50_000, quantity: 6 },
    { denominationIdr: 20_000, quantity: 5 },
    { denominationIdr: 10_000, quantity: 2 },
    { denominationIdr: 5_000, quantity: 2 },
  ],
  otherAmountIdr: 0,
};

export function demoMovements(): (CashMovement & { shiftId: string })[] {
  return [
    {
      id: "0d0d0001-0000-4000-8000-000000000001",
      shiftId: DEMO_SHIFT_ID,
      type: "cash_in",
      amountIdr: 100_000,
      reasonNote: "Tambahan uang kembalian",
      recordedAt: "2026-11-08T02:40:00.000Z",
    },
    {
      id: "0d0d0001-0000-4000-8000-000000000002",
      shiftId: DEMO_SHIFT_ID,
      type: "cash_out",
      amountIdr: 100_000,
      reasonNote: "Kebutuhan dapur",
      recordedAt: "2026-11-08T04:15:00.000Z",
    },
    {
      id: "0d0d0001-0000-4000-8000-000000000003",
      shiftId: DEMO_SHIFT_ID,
      type: "cash_out",
      amountIdr: 50_000,
      reasonNote: "Parkir dan kebersihan",
      recordedAt: "2026-11-08T05:05:00.000Z",
    },
  ];
}

/** Day 8 Nov 2026: 3 shifts on 2 terminals, Rp12.480.000 in sales. */
export const dayFixture = {
  businessDate: DEMO_BUSINESS_DATE,
  cutoffTime: "04:00",
  totalSalesIdr: 12_480_000,
  refundIdr: 0,
  voidIdr: 0,
  channels: [
    { code: "dine_in", label: "Dine-in", amountIdr: 8_250_000 },
    { code: "takeaway", label: "Takeaway", amountIdr: 2_730_000 },
    { code: "delivery", label: "Ojek online", amountIdr: 1_500_000 },
  ],
  shifts: { total: 3, closed: 3, terminals: 2, cashVarianceIdr: -20_000 },
  netPayments: [
    { code: "cash", label: "Tunai", netIdr: 4_230_000 },
    { code: "qris", label: "QRIS", netIdr: 4_650_000 },
    { code: "edc", label: "EDC", netIdr: 2_400_000 },
    { code: "va", label: "Virtual Account", netIdr: 850_000 },
    { code: "ewallet", label: "E-wallet", netIdr: 250_000 },
    { code: "card", label: "Kartu kredit/debit", netIdr: 100_000 },
  ],
  totalNetIdr: 12_480_000,
  settlement: [
    { bank: "BCA", amountIdr: 1_600_000 },
    { bank: "Mandiri", amountIdr: 800_000 },
  ],
  // X2-UI: per terminal against the bank file. BCA's file is in (one sale not
  // confirmed yet); Mandiri's has not arrived.
  edcTerminals: [
    {
      terminalId: "00000000-0000-4000-8000-0000000000b1",
      terminalCode: "EDC-SNP-01",
      bank: "bca",
      receiptIdr: 1_600_000,
      receiptCount: 4,
      settledIdr: 1_200_000,
      settledCount: 3,
      flaggedCount: 1,
      mismatchCount: 0,
    },
    {
      terminalId: "00000000-0000-4000-8000-0000000000b2",
      terminalCode: "EDC-SNP-02",
      bank: "mandiri",
      receiptIdr: 800_000,
      receiptCount: 2,
      settledIdr: 0,
      settledCount: 0,
      flaggedCount: 0,
      mismatchCount: 0,
    },
  ],
  standaloneUnmatched: 1,
  stockDeductionAvailable: true,
  managerName: "Manajer outlet",
} as const;
