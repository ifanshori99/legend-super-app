// Brief 936 part D (legend-5w6): an EDC payment the bank or terminal refused
// is its own state, "declined": not a technical failure and not "unknown".
// The cashier sees the title "Pembayaran ditolak", the server's reason and
// code, the amount and the terminal, and may retry or pick another method.
//
// Assumptions: the state comes from usePaymentSession().activeAttempt with
// status "declined" and edc.declineReason / edc.responseCode (shared contract
// in the brief); the screen under test is EdcPanel.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  buttonsOf,
  mutation,
  rupiah,
  visibleText,
} from "./pos-payment-936-helpers";

const state = vi.hoisted(() => ({
  attempt: null as unknown,
}));

vi.mock("@/features/ws04-pos-kasir/hooks", () => ({
  CONTRACT_PENDING: "CONTRACT_PENDING",
  isContractPending: () => false,
  usePaymentSession: () => ({
    bill: {
      tableLabel: "Meja 7",
      orderNo: "LG-0048",
      itemCount: 3,
      guestCount: 2,
      subtotalIdr: 120_000,
      serviceIdr: 6_000,
      taxIdr: 13_860,
      totalIdr: 139_860,
      depositSurplusIdr: 0,
      allocations: [],
      remainingIdr: 139_860,
      paid: false,
    },
    activeAttempt: state.attempt,
    cash: undefined,
    receiptNo: undefined,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: async () => undefined,
  }),
  useEdcTerminals: () => ({
    data: [
      {
        id: "edc-01",
        label: "Bank A · EDC 01",
        bank: "Bank A",
        integrated: true,
        status: "ready",
        assignedTo: "Kasir 01",
      },
    ],
    isLoading: false,
  }),
  useStartPayment: () => mutation(),
  useCancelAttempt: () => mutation(),
  useCheckPaymentStatus: () => mutation(),
  usePrintReceipt: () => mutation(),
  useRecordEdcStandalone: () => mutation(),
}));

import { EdcPanel } from "@/features/ws04-pos-kasir/components/payment/edc-panel";

const ORDER = "01JCQ8Z5N0M3X4Y5Z6A7B8C9D0";

function attempt(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "att-1",
    sequence: 1,
    method: "edc",
    status,
    amountIdr: 139_860,
    posRef: "POS-0048-01",
    edc: {
      terminalId: "edc-01",
      terminalLabel: "Bank A · EDC 01",
      bank: "Bank A",
      mode: "card",
      lockedAmountIdr: 139_860,
      ...extra,
    },
  };
}

function render() {
  return renderToString(
    createElement(EdcPanel, {
      orderId: ORDER,
      amountIdr: 139_860,
      onChangeMethod: () => {},
    }),
  );
}

describe("EDC declined state", () => {
  test("shows the title, the server reason and code, amount and terminal", () => {
    state.attempt = attempt("declined", {
      declineReason: "Saldo tidak cukup",
      responseCode: "51",
    });
    const text = visibleText(render());
    expect(text).toContain("Pembayaran ditolak");
    expect(text).toContain("Saldo tidak cukup");
    expect(text).toContain("51");
    expect(text).toContain(rupiah(139_860));
    expect(text).toContain("Bank A · EDC 01");
    // Declined is not the "machine did not answer" state.
    expect(text).not.toMatch(/Cek status EDC/);
  });

  test("offers retry on the terminal and another method", () => {
    state.attempt = attempt("declined", {
      declineReason: "Saldo tidak cukup",
      responseCode: "51",
    });
    const buttons = buttonsOf(render());
    const retry = buttons.find((b) => b.label === "Coba lagi di terminal");
    const other = buttons.find((b) => b.label === "Pilih metode lain");
    expect(retry?.disabled).toBe(false);
    expect(other?.disabled).toBe(false);
  });

  test("without a reason it still says declined, with no invented reason", () => {
    state.attempt = attempt("declined");
    const text = visibleText(render());
    expect(text).toContain("Pembayaran ditolak");
    expect(text).not.toContain("Saldo tidak cukup");
    expect(text).not.toMatch(/undefined|null/);
  });

  test("a technical failure is not shown as declined", () => {
    state.attempt = attempt("failed");
    expect(visibleText(render())).not.toContain("Pembayaran ditolak");
  });
});
