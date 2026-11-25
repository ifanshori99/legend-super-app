// 1268 W2: what the cashier reads and which buttons are locked. Hooks are
// mocked and the panels are rendered on the server (no browser).
vi.hoisted(() => {
  (globalThis as { __WEB_DEV_SERVER__?: boolean }).__WEB_DEV_SERVER__ = false;
});

import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { buttonsOf, mutation, visibleText } from "./pos-payment-936-helpers";

const ORDER = "01JCQ8Z5N0M3X4Y5Z6A7B8C9D0";

const state = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  unresolved: null as unknown,
  print: {} as Record<string, unknown>,
  started: 0,
  methods: [] as unknown[],
  terminals: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => children,
  useNavigate: () => () => undefined,
}));
vi.mock("@/lib/tenant-context", () => ({
  useTenantContext: () => ({ outlet: { id: "o", name: "Legend" } }),
  useOutletClock: () => ({ clock: { timeZone: "Asia/Jakarta" } }),
}));
vi.mock("@/features/ws04-pos-kasir/ticket/hooks", () => ({
  useOrderTickets: () => ({ data: [] }),
}));
vi.mock(
  "@/features/ws04-pos-kasir/components/payment/paid-ticket-card",
  () => ({ PaidTicketCard: () => null }),
);
vi.mock("@/features/ws04-pos-kasir/hooks", () => {
  const idle = () => mutation();
  const start = () => ({
    ...mutation(),
    mutate: () => {
      state.started += 1;
    },
  });
  return {
    isContractPending: () => false,
    usePaymentSession: () => state.session,
    usePaymentMethods: () => ({ data: state.methods, isLoading: false }),
    useEdcTerminals: () => ({ data: state.terminals, isLoading: false }),
    useUnresolvedPayment: () => state.unresolved,
    useCompleteWhenPaid: () => undefined,
    usePrintReceipt: () => state.print,
    useStartPayment: start,
    useReplayPayment: idle,
    useReceiptPdf: idle,
    useCancelAttempt: idle,
    useCheckPaymentStatus: idle,
    useConfirmCash: idle,
    useRemoveVoucher: idle,
    useRecordEdcStandalone: idle,
    useRequestEdcApproval: idle,
    useEdcApprovers: () => ({ data: [], isError: false }),
  };
});

import { PaymentScreen } from "@/features/ws04-pos-kasir/components/payment/payment-screen";
import { QrisPanel } from "@/features/ws04-pos-kasir/components/payment/qris-panel";
import { safeToLeave } from "@/features/ws04-pos-kasir/components/payment/gateway-parts";

const bill = (over: Record<string, unknown> = {}) => ({
  tableLabel: "Meja 7",
  orderNo: "LG-0048",
  itemCount: 1,
  guestCount: 0,
  subtotalIdr: 100_000,
  serviceIdr: 0,
  taxIdr: 0,
  totalIdr: 100_000,
  depositSurplusIdr: 0,
  allocations: [],
  remainingIdr: 100_000,
  paid: false,
  ...over,
});
const paidBill = () =>
  bill({
    paid: true,
    remainingIdr: 0,
    allocations: [
      {
        id: "t1",
        method: "cash",
        label: "Tunai",
        amountIdr: 100_000,
        status: "confirmed",
      },
    ],
  });
const session = (over: Record<string, unknown> = {}) => ({
  bill: bill(),
  activeAttempt: null,
  partialAllowed: false,
  isLoading: false,
  error: null,
  refetch: async () => undefined,
  ...over,
});
const qrisAttempt = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  sequence: 1,
  method: "qris",
  status: "waiting",
  amountIdr: 100_000,
  qrShown: true,
  cancellable: true,
  ...over,
});

const screen = () =>
  renderToString(createElement(PaymentScreen, { orderId: ORDER }));
const qris = () =>
  renderToString(
    createElement(QrisPanel, {
      orderId: ORDER,
      amountIdr: 100_000,
      onChangeMethod: () => undefined,
    }),
  );
const button = (html: string, label: string) =>
  buttonsOf(html).find((b) => b.label.startsWith(label));

beforeEach(() => {
  state.session = session();
  state.unresolved = null;
  state.print = mutation();
  state.started = 0;
  state.terminals = [];
  state.methods = [
    { code: "qris", label: "QRIS", hint: "", enabled: true },
    {
      code: "va",
      label: "Virtual Account",
      hint: "",
      enabled: false,
      unavailableReason: "not_supported",
    },
    { code: "cash", label: "Tunai", hint: "", enabled: true },
  ];
});

describe("unresolved payment", () => {
  test("locks every method and offers only the same request again", () => {
    state.unresolved = { status: "pending", kind: "cash", mine: true };
    const html = screen();
    expect(visibleText(html)).toContain(
      "Semua cara bayar tagihan ini terkunci",
    );
    expect(button(html, "Kirim ulang permintaan yang sama")?.disabled).toBe(
      false,
    );
    for (const label of [
      "QRIS",
      "Tunai",
      "Lanjutkan",
      "Bayar sebagian",
      "Pakai voucher",
      "Tukar poin",
    ])
      expect(button(html, label)).toBeUndefined();
  });

  test.each([
    [
      { status: "pending", kind: "cash", mine: false },
      "Dikirim oleh kasir lain",
    ],
    [{ status: "corrupt" }, "tidak bisa dibaca"],
  ])("offers no resend for %j", (unresolved, text) => {
    state.unresolved = unresolved;
    const html = screen();
    expect(visibleText(html)).toContain(text);
    expect(button(html, "Kirim ulang")).toBeUndefined();
  });

  test("a screen opened while the request is sent has no way to pay", () => {
    state.unresolved = { status: "sending" };
    const html = screen();
    expect(visibleText(html)).toContain("Pembayaran sedang dikirim");
    for (const label of [
      "QRIS",
      "Tunai",
      "Lanjutkan",
      "Bayar sebagian",
      "Pakai voucher",
      "Tukar poin",
    ])
      expect(button(html, label)).toBeUndefined();
    for (const b of buttonsOf(html)) expect(b.disabled, b.label).toBe(true);
  });

  test("comes before an EDC attempt but not before a paid bill", () => {
    state.unresolved = {
      status: "pending",
      kind: "edc_standalone",
      mine: true,
    };
    state.session = session({
      activeAttempt: { ...qrisAttempt(), method: "edc", status: "declined" },
    });
    expect(button(screen(), "Kirim ulang")).toBeDefined();
    state.session = session({ bill: paidBill(), completion: "done" });
    expect(button(screen(), "Kirim ulang")).toBeUndefined();
  });
});

describe("methods", () => {
  test("unsupported methods are locked and say why; no partial amount", () => {
    const html = screen();
    expect(button(html, "Virtual Account")?.disabled).toBe(true);
    expect(visibleText(html)).toContain("Belum bisa dipakai di kasir");
    expect(button(html, "Bayar sebagian")?.disabled).toBe(true);
    expect(button(html, "Lanjutkan dengan Tunai")?.disabled).toBe(false);
  });
});

describe("QRIS panel", () => {
  test("makes nothing by itself and waits for a tap", () => {
    const html = qris();
    expect(state.started).toBe(0);
    expect(button(html, "Buat QRIS")?.disabled).toBe(false);
  });

  test("a waiting QRIS offers status and cancel, never another method", () => {
    state.session = session({ activeAttempt: qrisAttempt() });
    const html = qris();
    expect(visibleText(html)).toContain("QRIS siap dipindai");
    expect(button(html, "Batalkan QRIS")).toBeDefined();
    expect(button(html, "Pilih metode lain")).toBeUndefined();
    expect(button(html, "Buat QRIS")).toBeUndefined();
  });

  test("does not claim a QR is shown when the server gave none", () => {
    state.session = session({ activeAttempt: qrisAttempt({ qrShown: false }) });
    const text = visibleText(qris());
    expect(text).not.toContain("sudah tampil di layar pelanggan");
    expect(text).toContain("Menunggu hasil QRIS");
  });

  test("cancelling stays locked until the provider's proof", () => {
    state.session = session({
      activeAttempt: qrisAttempt({ status: "cancelling", cancellable: false }),
    });
    const html = screen();
    expect(visibleText(html)).toContain("Membatalkan QRIS");
    for (const label of ["Batalkan QRIS", "Buat QRIS", "Pilih metode", "Tunai"])
      expect(button(html, label)).toBeUndefined();
  });

  test("a proven-expired QRIS is renewed by a tap only", () => {
    state.session = session({
      activeAttempt: qrisAttempt({ status: "expired" }),
    });
    const html = qris();
    expect(state.started).toBe(0);
    expect(button(html, "Buat QRIS baru")).toBeDefined();
    expect(button(html, "Pilih metode lain")).toBeDefined();
  });

  test.each([
    ["waiting", false],
    ["cancelling", false],
    ["unknown", false],
    ["confirmed", false],
    ["expired", true],
    ["failed", true],
  ])("safeToLeave(%s) is %s", (status, expected) => {
    const next = session({ activeAttempt: qrisAttempt({ status }) });
    expect(safeToLeave(next as never, "a1")).toBe(expected);
  });
});

describe("EDC", () => {
  test("an unconnected machine takes no amount, only a recorded slip", () => {
    state.session = session({
      activeAttempt: {
        ...qrisAttempt({ status: "failed" }),
        method: "edc",
        edc: {
          terminalId: "t",
          terminalLabel: "BCA",
          bank: "BCA",
          mode: "card",
          lockedAmountIdr: 100_000,
        },
      },
    });
    state.terminals = [
      {
        id: "t",
        label: "BCA · A920",
        bank: "BCA",
        integrated: false,
        status: "ready",
        assignedTo: "•••• 4821",
        modes: ["card"],
      },
    ];
    const html = screen();
    expect(button(html, "Kirim")).toBeUndefined();
    expect(button(html, "Catat standalone")?.disabled).toBe(false);
  });
});

describe("paid bill and receipt", () => {
  const result = (printResult: string | null) => ({
    receiptNo: "R-1",
    printedAt: "2026-11-26T03:00:00.000Z",
    reprint: false,
    receiptId: "r1",
    printResult,
  });

  test("held items: paid, printing locked, says why", () => {
    state.session = session({ bill: paidBill(), completion: "held" });
    const html = screen();
    expect(visibleText(html)).toContain("Lunas, ada item ditahan");
    expect(button(html, "Cetak struk")?.disabled).toBe(true);
  });

  test.each(["not_printed", null])("%s is never called printed", (value) => {
    state.session = session({ bill: paidBill(), completion: "done" });
    state.print = mutation({ data: result(value) });
    const html = screen();
    const text = visibleText(html);
    expect(text).toContain("Struk R-1 tidak tercetak");
    expect(text).toContain("CETAK ULANG");
    expect(text).not.toContain("dikirim ke printer");
    expect(button(html, "Simpan PDF struk")).toBeDefined();
  });

  test("a queued print says it went to the printer", () => {
    state.session = session({ bill: paidBill(), completion: "done" });
    state.print = mutation({ data: result("queued_to_printer") });
    const html = screen();
    expect(visibleText(html)).toContain("Struk R-1 dikirim ke printer");
    expect(button(html, "Simpan PDF struk")).toBeUndefined();
  });

  test("an order that could not be completed offers no skip", () => {
    state.session = session({ bill: paidBill(), completion: "ready" });
    state.print = mutation({
      error: Object.assign(new Error("x"), { code: "ORDER_COMPLETE_FAILED" }),
    });
    const html = screen();
    expect(visibleText(html)).toContain("Pesanan belum bisa diselesaikan");
    expect(button(html, "Lewati cetak")).toBeUndefined();
  });
});
