// Task 916: guest payment links share PaymentPage for order, bill split,
// breakfast and recovery charges. A rejected method switch or code refresh
// must explain the existing payment and keep its instructions on screen.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  paymentLinkQrisPendingFixture,
  paymentLinkVaPendingFixture,
  paymentLinkViewFixture,
  paymentLinkViewSchema,
  type CustomerPaymentIntent,
  type PaymentLinkView,
} from "@starter/shared/payment";
import { createTranslator, messagesId } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

const state = vi.hoisted(() => ({
  view: null as PaymentLinkView | null,
  startError: null as unknown,
  refreshError: null as unknown,
  startData: undefined as CustomerPaymentIntent | undefined,
  refreshData: undefined as CustomerPaymentIntent | undefined,
  startSubmittedAt: 0,
  refreshSubmittedAt: 0,
  refreshPending: false,
  persistentWatermark: false,
  successWatermark: -1,
}));

// SSR ordinarily creates a fresh mount. Opt in to preserving the timestamp
// state (initial -1) between renders, as one mounted page would. React's real
// hook and setter still run, including same-component render adjustments.
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initialValue: unknown) => {
      const preserve = state.persistentWatermark && initialValue === -1;
      const [value, setValue] = react.useState(
        preserve ? state.successWatermark : initialValue,
      );
      return [
        value,
        (next: unknown) => {
          if (preserve && typeof next === "number")
            state.successWatermark = next;
          setValue(next);
        },
      ];
    },
  };
});

vi.mock("@/features/ws05-payment/hooks", () => ({
  usePaymentLink: () => ({
    data: state.view,
    dataUpdatedAt: Date.parse("2026-11-16T00:00:00.000Z"),
    isPending: false,
    isError: false,
    isFetching: false,
  }),
  usePaymentIntent: () => ({ data: undefined, isFetching: false }),
  useStartPayment: () => ({
    data: state.startData,
    error: state.startError,
    submittedAt: state.startSubmittedAt,
    isSuccess: state.startData !== undefined,
    isPending: false,
    mutate: vi.fn(),
  }),
  usePayAtCashier: () => ({ error: null, isPending: false }),
  useCountdown: () => 120_000,
  useSettledIntentSync: () => {},
  useAutoRefreshIntent: () => ({
    data: state.refreshData,
    error: state.refreshError,
    submittedAt: state.refreshSubmittedAt,
    isSuccess: state.refreshData !== undefined,
    isPending: state.refreshPending,
  }),
}));
vi.mock("@/components/ui/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/use-online", () => ({ useOnline: () => true }));

import { PaymentPage } from "@/features/ws05-payment/components/payment-page";

const t = createTranslator(messagesId);
const codes = [
  "ORDER_CODE_ACTIVE",
  "SPLIT_CODE_ACTIVE",
  "QRIS_HOLD_ACTIVE",
  "FUNDS_UNRESOLVED",
] as const;

function renderPage() {
  return renderToString(createElement(PaymentPage, { token: "guest-link" }));
}

function expectRecoveryMessage(html: string, code: (typeof codes)[number]) {
  expect(html).not.toContain(t("payment.actionFailed"));
  expect(html).not.toContain("Provider internal detail");
  if (code === "FUNDS_UNRESOLVED") {
    expect(html).toMatch(/pembayaran[^<]*(diperiksa|dipastikan|belum)/i);
    expect(html).toMatch(/jangan[^<]*(bayar|pembayaran)/i);
    expect(html).not.toContain(t("payment.vaStep1"));
    expect(html).not.toContain(t("payment.continue"));
    expect(html).not.toContain(t("payment.changeMethod"));
    expect(html).not.toContain(t("payment.newCode"));
    expect(html).not.toContain(t("payment.retry"));
  } else {
    expect(html).toMatch(/kode[^<]*masih aktif/i);
    expect(html).toMatch(/selesaikan[^<]*pembayaran/i);
    expect(html).toMatch(/kedaluwarsa/i);
  }
}

beforeEach(() => {
  state.view = paymentLinkViewSchema.parse(paymentLinkVaPendingFixture);
  state.startError = null;
  state.refreshError = null;
  state.startData = undefined;
  state.refreshData = undefined;
  state.startSubmittedAt = 0;
  state.refreshSubmittedAt = 0;
  state.refreshPending = false;
  state.persistentWatermark = false;
  state.successWatermark = -1;
});

describe("guest payment: rejected replacement keeps the existing code", () => {
  for (const source of ["start", "refresh"] as const) {
    test.each(codes)(
      `${source} 409 %s explains recovery and retains the old VA`,
      (code) => {
        const error = new ApiError(409, code, "Provider internal detail");
        if (source === "start") state.startError = error;
        else state.refreshError = error;

        const html = renderPage();

        expectRecoveryMessage(html, code);
        // The old code remains available; an error never creates a new intent
        // or claims that the bill was paid.
        expect(html).toContain("8808123456789012");
        expect(html).not.toContain(t("payment.paidTitle"));
        expect(html).not.toContain(t("payment.newCode"));
        expect(html).not.toContain(t("payment.retry"));
      },
    );
  }

  test.each(codes)(
    "start 409 %s explains recovery when no old code is available",
    (code) => {
      state.view = paymentLinkViewSchema.parse(paymentLinkViewFixture);
      state.startError = new ApiError(409, code, "Provider internal detail");

      const html = renderPage();

      expectRecoveryMessage(html, code);
      expect(html).not.toContain("8808123456789012");
    },
  );

  for (const status of ["expired", "failed"] as const) {
    test.each(codes)(
      `${status} old intent with 409 %s still shows the existing instructions`,
      (code) => {
        const view = paymentLinkViewSchema.parse(paymentLinkVaPendingFixture);
        state.view = {
          ...view,
          activeIntent: { ...view.activeIntent!, status },
        };
        state.startError = new ApiError(409, code, "Provider internal detail");

        const html = renderPage();

        expectRecoveryMessage(html, code);
        expect(html).toContain("8808123456789012");
        expect(html).not.toContain(t("payment.paidTitle"));
      },
    );
  }

  test.each(codes)("refresh 409 %s retains the previous QRIS", (code) => {
    state.view = paymentLinkViewSchema.parse(paymentLinkQrisPendingFixture);
    state.refreshError = new ApiError(409, code, "Provider internal detail");

    const html = renderPage();

    expectRecoveryMessage(html, code);
    expect(html).toContain(`<title>${t("payment.qrisTitle")}</title>`);
    expect(html).not.toContain("8808123456789012");
  });

  test("refresh 409 FEE_CHANGED stops on the new price: picker shown, old code not shown or opened (1272 re-review P2)", () => {
    state.view = paymentLinkViewSchema.parse(paymentLinkVaPendingFixture);
    state.refreshError = new ApiError(
      409,
      "FEE_CHANGED",
      "Provider internal detail",
    );
    state.refreshSubmittedAt = 100;

    const html = renderPage();

    expect(html).toContain(t("payment.redirect.fee.changed"));
    expect(html).toContain(t("payment.chooseTitle"));
    expect(html).toContain(t("payment.continue"));
    expect(html).not.toContain("8808123456789012");
    expect(html).not.toContain(t("payment.vaStep1"));
  });

  test.each(codes)("settled payment hides stale 409 %s guidance", (code) => {
    const view = paymentLinkViewSchema.parse(paymentLinkVaPendingFixture);
    state.view = {
      ...view,
      activeIntent: {
        ...view.activeIntent!,
        status: "paid",
        paidAt: "2026-11-16T00:00:00.000Z",
      },
    };
    state.startError = new ApiError(409, code, "Provider internal detail");
    state.refreshError = state.startError;

    const html = renderPage();

    expect(html).toContain(t("payment.paidTitle"));
    expect(html).not.toMatch(/kode[^<]*masih aktif/i);
    expect(html).not.toMatch(/jangan[^<]*bayar lagi/i);
    expect(html).not.toContain("8808123456789012");
  });

  for (const successfulSource of ["start", "refresh"] as const) {
    test.each(codes)(
      `newer ${successfulSource} success clears the other mutation's stale %s guidance`,
      (code) => {
        const view = paymentLinkViewSchema.parse(paymentLinkVaPendingFixture);
        const oldIntent = view.activeIntent!;
        if (oldIntent.instructions.method !== "va")
          throw new Error("VA fixture required");
        const newIntent: CustomerPaymentIntent = {
          ...oldIntent,
          instructions: {
            ...oldIntent.instructions,
            virtualAccountNumber: "8808999999999999",
          },
        };
        state.view = { ...view, activeIntent: newIntent };
        const error = new ApiError(409, code, "Provider internal detail");
        if (successfulSource === "start") {
          state.refreshError = error;
          state.refreshSubmittedAt = 100;
          state.startSubmittedAt = 200;
          state.startData = newIntent;
        } else {
          state.startError = error;
          state.startSubmittedAt = 100;
          state.refreshSubmittedAt = 200;
          state.refreshData = newIntent;
        }

        const html = renderPage();

        expect(html).toContain("8808999999999999");
        expect(html).toContain(t("payment.vaStep1"));
        expect(html).toContain(t("payment.changeMethod"));
        expect(html).not.toMatch(/kode[^<]*masih aktif/i);
        expect(html).not.toMatch(/jangan[^<]*bayar lagi/i);
        expect(html).not.toContain(t("payment.previousCodeReference"));
      },
    );

    test.each(codes)(
      `a newer %s refusal remains visible after an older ${successfulSource} success`,
      (code) => {
        const intent = state.view!.activeIntent!;
        const error = new ApiError(409, code, "Provider internal detail");
        if (successfulSource === "start") {
          state.startData = intent;
          state.startSubmittedAt = 100;
          state.refreshError = error;
          state.refreshSubmittedAt = 200;
        } else {
          state.refreshData = intent;
          state.refreshSubmittedAt = 100;
          state.startError = error;
          state.startSubmittedAt = 200;
        }

        const html = renderPage();

        expectRecoveryMessage(html, code);
        expect(html).toContain("8808123456789012");
      },
    );
  }

  for (const thirdStatus of ["pending", "failed"] as const) {
    test(`resolved funds refusal stays resolved when a subsequent refresh is ${thirdStatus}`, () => {
      state.persistentWatermark = true;
      state.startError = new ApiError(
        409,
        "FUNDS_UNRESOLVED",
        "Provider internal detail",
      );
      state.startSubmittedAt = 100;
      expectRecoveryMessage(renderPage(), "FUNDS_UNRESOLVED");

      // The server subsequently confirms a usable code; the earlier refusal
      // is resolved for this mounted page, even after mutation state changes.
      state.refreshData = state.view!.activeIntent!;
      state.refreshSubmittedAt = 200;
      expect(renderPage()).toContain(t("payment.vaStep1"));

      state.refreshData = undefined;
      state.refreshSubmittedAt = 300;
      state.refreshPending = thirdStatus === "pending";
      state.refreshError =
        thirdStatus === "failed"
          ? new ApiError(503, "SERVICE_UNAVAILABLE", "Provider unavailable")
          : null;

      const html = renderPage();

      expect(html).not.toMatch(/jangan[^<]*bayar lagi/i);
      expect(html).not.toContain(t("payment.previousCodeReference"));
      expect(html).toContain(t("payment.vaStep1"));
      expect(html).toContain("8808123456789012");
    });
  }
});
