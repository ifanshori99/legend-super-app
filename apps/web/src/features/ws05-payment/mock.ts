// Mock handlers for the customer payment endpoints (VITE_API_MOCK=true).
// The screen therefore works end to end without a backend: the fixtures come
// from @starter/shared/payment and every response is validated by the runtime
// against the same schema the API will use.
//
// Demo links (token → state), all from the shared fixtures:
//   pl_pending_…       choose a method
//   pl_qris_…          pending QRIS code
//   pl_va_…            pending Virtual Account
//   pl_transfer_…      pending bank transfer with unique code
//   pl_paid_…          paid after expiry
//   pl_expired_…       expired code
//   pl_failed_…        failed payment
//   pl_down_…          gateway down → pay at cashier
//   pl_settled_…       nothing left to pay
import {
  bankTransferPendingIntentFixture,
  createPaymentIntent,
  getPaymentIntent,
  getPaymentLink,
  paymentLinkBankTransferFixture,
  paymentLinkExpiredFixture,
  paymentLinkFailedFixture,
  paymentLinkGatewayDownFixture,
  paymentLinkPaidFixture,
  paymentLinkQrisPendingFixture,
  paymentLinkSettledFixture,
  paymentLinkVaPendingFixture,
  paymentLinkViewFixture,
  paymentLinkViewSchema,
  qrisPendingIntentFixture,
  refreshPaymentIntent,
  requestPayAtCashier,
  type CustomerPaymentIntent,
  type PaymentLinkView,
} from "@starter/shared/payment";
import { idr } from "@starter/shared/core";
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";

/** QRIS codes live about 10 minutes (PRD §3.13 "QRIS Dinamis"). */
const CODE_LIFETIME_MS = 10 * 60 * 1000;

type LinkState = {
  view: PaymentLinkView;
  intents: Map<string, CustomerPaymentIntent>;
  /** idempotency key → intent id, so a retried create returns the first one */
  idempotency: Map<string, string>;
};

const now = () => Date.now();
const at = (offsetMs: number) => new Date(now() + offsetMs).toISOString();

/** Fixtures carry fixed timestamps; shift them so a demo always has a live code. */
function withLiveClock(
  view: PaymentLinkView,
  codeExpiresInMs: number,
  paidAgoMs?: number,
): PaymentLinkView {
  const intent = view.activeIntent;
  const serverTime = new Date(now()).toISOString();
  if (!intent) return { ...view, serverTime };
  const liveIntent: CustomerPaymentIntent = {
    ...intent,
    expiresAt: at(codeExpiresInMs),
    paidAt: intent.paidAt ? at(-(paidAgoMs ?? 60_000)) : null,
  };
  return { ...view, activeIntent: liveIntent, serverTime };
}

function seedLink(
  fixture: unknown,
  codeExpiresInMs: number,
  paidAgoMs?: number,
): LinkState {
  const view = withLiveClock(
    paymentLinkViewSchema.parse(fixture),
    codeExpiresInMs,
    paidAgoMs,
  );
  const intents = new Map<string, CustomerPaymentIntent>();
  if (view.activeIntent) intents.set(view.activeIntent.id, view.activeIntent);
  return { view, intents, idempotency: new Map() };
}

const seed = () => {
  const links = new Map<string, LinkState>();
  const add = (state: LinkState) => links.set(state.view.token, state);
  // Live codes have 9 minutes left so screenshots show a counting timer.
  add(seedLink(paymentLinkViewFixture, CODE_LIFETIME_MS));
  add(seedLink(paymentLinkQrisPendingFixture, 9 * 60 * 1000));
  add(seedLink(paymentLinkVaPendingFixture, 9 * 60 * 1000));
  add(seedLink(paymentLinkBankTransferFixture, 9 * 60 * 1000));
  add(seedLink(paymentLinkPaidFixture, -21 * 60 * 1000, 8 * 60 * 1000));
  add(seedLink(paymentLinkExpiredFixture, -2 * 60 * 1000));
  add(seedLink(paymentLinkFailedFixture, -2 * 60 * 1000));
  add(seedLink(paymentLinkGatewayDownFixture, CODE_LIFETIME_MS));
  add(seedLink(paymentLinkSettledFixture, CODE_LIFETIME_MS));
  return links;
};
const links = createMockStore<Map<string, LinkState>>(seed);

function requireLink(token: string): LinkState {
  const link = links.get().get(token);
  if (!link)
    throw new ApiError(
      404,
      "NOT_FOUND",
      "Tautan pembayaran tidak ditemukan atau sudah kedaluwarsa. Minta tautan baru dari kasir.",
    );
  return link;
}

function requireIntent(
  link: LinkState,
  intentId: string,
): CustomerPaymentIntent {
  const intent = link.intents.get(intentId);
  if (!intent)
    throw new ApiError(
      404,
      "NOT_FOUND",
      "Kode pembayaran tidak ditemukan. Muat ulang halaman ini.",
    );
  return intent;
}

function channelOf(intent: CustomerPaymentIntent): string | null {
  return intent.instructions.method === "qris"
    ? null
    : intent.instructions.channelCode;
}

/** Builds the code the guest sees, the way the provider would for this method. */
function mintIntent(
  link: LinkState,
  method: CustomerPaymentIntent["method"],
  channelCode: string | null,
  amountIdr: CustomerPaymentIntent["amountIdr"],
): CustomerPaymentIntent {
  const serial = link.intents.size + 1;
  const option = link.view.methods.find((item) => item.method === method);
  const channel = option?.channels.find((item) => item.code === channelCode);
  if (method !== "qris" && !channel)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Bank yang dipilih belum tersedia. Pilih bank lain.",
    );

  const instructions: CustomerPaymentIntent["instructions"] =
    method === "qris"
      ? qrisPendingIntentFixture.instructions
      : method === "va"
        ? {
            method: "va",
            channelCode: channel!.code,
            channelName: channel!.name,
            virtualAccountNumber: String(8808000000000000 + serial),
          }
        : {
            ...bankTransferPendingIntentFixture.instructions,
            channelCode: channel!.code,
            channelName: channel!.name,
            uniqueCode: String(347 + serial),
            transferTotalIdr: idr(amountIdr + 347 + serial),
          };

  return {
    id: crypto.randomUUID(),
    method,
    status: "pending",
    amountIdr,
    expiresAt: at(CODE_LIFETIME_MS),
    paidAt: null,
    paidAfterExpiry: false,
    instructions,
  };
}

registerMock(getPaymentLink, ({ params, scenario }) => {
  const state = requireLink(params.token);
  if (scenario === "empty") {
    // The screen's honest empty state: a settled bill, nothing to pay.
    const totals = state.view.bill.totals;
    return {
      data: {
        ...state.view,
        methods: [],
        activeIntent: null,
        bill: {
          ...state.view.bill,
          totals: {
            ...totals,
            paidIdr: totals.totalIdr,
            outstandingIdr: 0,
          },
        },
        serverTime: new Date(now()).toISOString(),
      },
    };
  }
  return { data: state.view };
});

registerMock(createPaymentIntent, ({ params, body }) => {
  const link = requireLink(params.token);
  if (link.view.gateway.status === "down")
    throw new ApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "Pembayaran online sedang gangguan. Bayar di kasir: tunai, kartu, atau QRIS lewat EDC.",
    );
  if (link.view.bill.totals.outstandingIdr === 0)
    throw new ApiError(409, "CONFLICT", "Tagihan ini sudah lunas.");

  // contracts.md "Idempotent mutations": the same key returns the first
  // result; the same key with a different request is refused (fakes enforce).
  const seen = link.idempotency.get(body.idempotencyKey);
  if (seen) {
    const first = requireIntent(link, seen);
    if (first.method !== body.method || channelOf(first) !== body.channelCode)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Permintaan pembayaran ini sudah dipakai untuk metode lain.",
      );
    return { data: first };
  }

  const option = link.view.methods.find(
    (method) => method.method === body.method,
  );
  if (!option?.enabled)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Metode pembayaran ini sedang tidak tersedia. Pilih metode lain.",
    );

  const intent = mintIntent(
    link,
    body.method,
    body.channelCode,
    link.view.bill.totals.outstandingIdr,
  );
  // A new intent supersedes the link's previous pending one so the guest is
  // never shown two live codes for one bill. A late payment on the old code is
  // still accepted and flagged by the API (PRD §3.13 "Siklus Pembayaran").
  const previous = link.view.activeIntent;
  if (previous?.status === "pending")
    link.intents.set(previous.id, { ...previous, status: "expired" });
  link.intents.set(intent.id, intent);
  link.idempotency.set(body.idempotencyKey, intent.id);
  link.view = { ...link.view, activeIntent: intent };
  return { data: intent };
});

registerMock(getPaymentIntent, ({ params }) => {
  const link = requireLink(params.token);
  return { data: requireIntent(link, params.intentId) };
});

registerMock(refreshPaymentIntent, ({ params }) => {
  const link = requireLink(params.token);
  const intent = requireIntent(link, params.intentId);
  if (intent.status === "paid" || intent.status === "refunded")
    return { data: intent };

  if (intent.status === "pending") {
    // Same intent, new code and a new 10-minute window.
    const next: CustomerPaymentIntent = {
      ...intent,
      expiresAt: at(CODE_LIFETIME_MS),
    };
    link.intents.set(next.id, next);
    link.view = { ...link.view, activeIntent: next };
    return { data: next };
  }

  // Expired or failed: the API may mint a new intent so the guest can still pay.
  const next = mintIntent(
    link,
    intent.method,
    channelOf(intent),
    link.view.bill.totals.outstandingIdr,
  );
  link.intents.set(next.id, next);
  link.view = { ...link.view, activeIntent: next };
  return { data: next };
});

registerMock(requestPayAtCashier, () => ({
  data: { requestedAt: new Date(now()).toISOString() },
}));
