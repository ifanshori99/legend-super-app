// Mock handlers for the payment back office (VITE_API_MOCK=true): routing,
// EDC terminals and cashier defaults, refunds with approval, unallocated funds
// and settlement reconciliation. Fixtures come from
// @starter/shared/payment/admin, and the runtime validates every response with
// the same schema the API will use, so the screen works without a backend.
import {
  approveRefund,
  cafeLegendPaymentAdminFixtures as fixtures,
  createEdcTerminal,
  createRefund,
  edcCashierDefaultsViewSchema,
  getEdcCashierDefaults,
  getPaymentRouting,
  getReconciliationSummary,
  listEdcTerminals,
  listReconciliationCases,
  listRefundablePayments,
  listRefunds,
  listUnallocatedFunds,
  paymentRoutingViewSchema,
  rejectRefund,
  releaseQuarantinedRefund,
  reopenQuarantinedRefund,
  settleRefundManually,
  resolveReconciliationCase,
  resolveUnallocatedFund,
  retryRefundPayout,
  updateEdcCashierDefault,
  updateEdcTerminal,
  updatePaymentRoute,
  type EdcCashierDefault,
  type EdcTerminalView,
  type PaymentRoute,
  type ReconciliationCaseView,
  type CreateRefundInput,
  type ReconciliationSummary,
  type ResolveUnallocatedFundInput,
  type RefundView,
  type RefundablePayment,
  type UnallocatedFundView,
} from "@starter/shared/payment/admin";
import { idempotencyKeySchema, idr } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

/** The signed-in supervisor the mock records as the actor (mock mode only). */
const ACTOR = {
  id: "b1a2c3d4-0001-4a01-8b01-00000000a001",
  name: "Budi Supervisor",
};

type MockState = {
  routes: PaymentRoute[];
  outletRoutes: PaymentRoute[];
  terminals: EdcTerminalView[];
  cashiers: EdcCashierDefault[];
  refunds: RefundView[];
  refundable: RefundablePayment[];
  funds: UnallocatedFundView[];
  fundRefunds: Map<string, string>;
  cases: ReconciliationCaseView[];
  summary: ReconciliationSummary;
};

/**
 * Follow-up states the screens must show (kfkt/hn5q mockups): rejected, failed
 * for good, retryable, unknown result and quarantined. Built from the first
 * fixture so the contract schema still validates every row.
 */
function followUpRefunds(): RefundView[] {
  const base = fixtures.refunds[0];
  const requester = {
    requestedBy: "d4e5f6a7-0001-4d01-8e01-000000000001",
    requestedByName: "Rina Kasir",
  };
  const decided = {
    approvedBy: ACTOR.id,
    approvedByName: ACTOR.name,
    decidedAt: "2026-11-11T07:10:00.000Z",
    viewerCanApprove: false,
  };
  const row = (
    suffix: string,
    reference: string,
    patch: Partial<RefundView>,
  ): RefundView => ({
    ...base,
    ...requester,
    id: `e5f6a7b8-00f${suffix}-4e0${suffix}-8f0${suffix}-0000000000f${suffix}`,
    paymentIntentId: `8a32e00d-7e43-45b6-9d01-7a92e605c1f${suffix}`,
    paymentReference: reference,
    createdAt: "2026-11-11T07:00:00.000Z",
    ...patch,
  });
  return [
    row("1", "POS-0148", {
      status: "failed",
      failureReason: "rejected",
      reason: "Pesanan tidak sesuai",
      note: "Bukti transaksi belum sesuai dengan pesanan.",
      ...decided,
      approvedBy: null,
      approvedByName: null,
    }),
    row("2", "POS-0149", {
      status: "failed",
      failureReason: "provider_declined",
      payoutAttempts: 1,
      lastPayoutError: "PROVIDER_DECLINED",
      ...decided,
    }),
    row("3", "POS-0150", {
      status: "approved",
      payoutAttempts: 0,
      lastPayoutError: "PAYOUT_SEND_RIGHT_LOST",
      ...decided,
    }),
    row("4", "POS-0151", {
      status: "approved",
      payoutAttempts: 1,
      lastPayoutError: "ECONNRESET",
      ...decided,
    }),
    row("5", "POS-0152", {
      status: "approved",
      payoutAttempts: 0,
      lastPayoutError: "PAYOUT_QUARANTINED",
      amountIdr: idr(75_000),
      reason: "Item tidak tersedia",
      ...decided,
    }),
  ];
}

const seed = (): MockState => ({
  routes: fixtures.routes.map((route) => ({ ...route })),
  outletRoutes: [{ ...fixtures.outletRoute }],
  terminals: fixtures.terminals.map((terminal) => ({
    ...terminal,
    supportedMethods: [...terminal.supportedMethods],
  })),
  cashiers: fixtures.cashiers.map((cashier) => ({ ...cashier })),
  refunds: [
    ...fixtures.refunds.map((refund) => ({ ...refund })),
    ...followUpRefunds(),
  ],
  refundable: fixtures.refundablePayments.map((payment) => ({ ...payment })),
  funds: fixtures.unallocatedFunds.map((fund) => ({ ...fund })),
  fundRefunds: new Map(),
  cases: fixtures.reconciliationCases.map((entry) => ({ ...entry })),
  summary: { ...fixtures.reconciliationSummary },
});

const store = createMockStore(seed);

/**
 * Money writes replay by idempotency key like the real API (contracts.md
 * "Idempotent mutations"): same key + same request returns the first result,
 * same key + a different request fails IDEMPOTENCY_KEY_REUSED.
 */
const replays = createMockStore(
  () => new Map<string, { fingerprint: string; data: unknown }>(),
);

function replay<T>(key: string, fingerprint: string, run: () => T): T {
  const seen = replays.get().get(key);
  if (seen) {
    if (seen.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai untuk permintaan lain.",
      );
    return seen.data as T;
  }
  const data = run();
  replays.get().set(key, { fingerprint, data });
  return data;
}

/** Configuration writes use the same validated header and replay semantics as the API. */
function replayHeader<T>(
  headers: { "Idempotency-Key"?: string } | undefined,
  endpoint: string,
  params: unknown,
  body: unknown,
  run: () => T,
): T {
  const key = idempotencyKeySchema.safeParse(headers?.["Idempotency-Key"]);
  if (!key.success)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Kunci idempotensi tidak valid.",
    );
  return replay(key.data, JSON.stringify({ endpoint, params, body }), run);
}

const outlets = fixtures.outlets.map((outlet) => ({
  id: outlet.id,
  name: outlet.name,
}));

const now = () => new Date().toISOString();

function findOutlet(outletId: string) {
  const outlet = outlets.find((entry) => entry.id === outletId);
  if (!outlet) throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  return outlet;
}

// ---- Routing -------------------------------------------------------------

registerMock(getPaymentRouting, ({ query, scenario }) => {
  const state = store.get();
  if (query.outletId === undefined) {
    return {
      data: paymentRoutingViewSchema.parse({
        scope: "tenant",
        outletId: null,
        outletName: null,
        outlets,
        providers: [...fixtures.providers],
        routes: scenario === "empty" ? [] : state.routes,
      }),
    };
  }
  const outlet = findOutlet(query.outletId);
  const routes = state.routes.map((route) => {
    const override = state.outletRoutes.find(
      (entry) => entry.outletId === outlet.id && entry.method === route.method,
    );
    return override ?? route;
  });
  return {
    data: paymentRoutingViewSchema.parse({
      scope: "outlet",
      outletId: outlet.id,
      outletName: outlet.name,
      outlets,
      providers: [...fixtures.providers],
      routes: scenario === "empty" ? [] : routes,
    }),
  };
});

registerMock(updatePaymentRoute, ({ endpoint, headers, params, body }) =>
  replayHeader(headers, endpoint.id, params, body, () => {
    const state = store.get();
    const provider = fixtures.providers.find(
      (entry) => entry.code === body.provider,
    );
    if (!provider)
      throw new ApiError(400, "VALIDATION_ERROR", "Gateway tidak dikenal.");
    if (body.provider === body.fallbackProvider)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Gateway cadangan harus berbeda dari gateway utama.",
      );
    const fallback =
      body.fallbackProvider === null
        ? null
        : fixtures.providers.find(
            (entry) => entry.code === body.fallbackProvider,
          );
    if (body.fallbackProvider !== null && !fallback)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Gateway cadangan tidak dikenal.",
      );
    if (fallback && !fallback.enabled)
      throw new ApiError(
        409,
        "CONFLICT",
        "Gateway cadangan belum aktif. Aktifkan gateway kedua lebih dulu.",
      );

    const updatedAt = now();
    if (body.outletId === null) {
      const route = state.routes.find(
        (entry) => entry.method === params.method,
      );
      if (!route)
        throw new ApiError(404, "NOT_FOUND", "Routing metode tidak ditemukan.");
      const updated: PaymentRoute = {
        ...route,
        provider: body.provider,
        fallbackProvider: body.fallbackProvider,
        enabled: body.enabled,
        updatedAt,
      };
      store.set({
        ...state,
        routes: state.routes.map((entry) =>
          entry.id === updated.id ? updated : entry,
        ),
      });
      return { data: updated };
    }

    const outlet = findOutlet(body.outletId);
    const existing = state.outletRoutes.find(
      (entry) => entry.outletId === outlet.id && entry.method === params.method,
    );
    const updated: PaymentRoute = {
      id: existing?.id ?? newIdempotencyKey(),
      tenantId: fixtures.tenantId,
      outletId: outlet.id,
      method: params.method,
      provider: body.provider,
      fallbackProvider: body.fallbackProvider,
      enabled: body.enabled,
      updatedAt,
    };
    store.set({
      ...state,
      outletRoutes: existing
        ? state.outletRoutes.map((entry) =>
            entry.id === updated.id ? updated : entry,
          )
        : [...state.outletRoutes, updated],
    });
    return { data: updated };
  }),
);

// ---- EDC terminals -------------------------------------------------------

registerMock(listEdcTerminals, ({ query, scenario }) => {
  const { terminals } = store.get();
  const filtered = query.outletId
    ? terminals.filter((terminal) => terminal.outletId === query.outletId)
    : terminals;
  return paginateFixture(filtered, query, (terminal) => terminal.id, scenario);
});

registerMock(createEdcTerminal, ({ endpoint, headers, body }) =>
  replayHeader(headers, endpoint.id, undefined, body, () => {
    const state = store.get();
    const outlet = findOutlet(body.outletId);
    const duplicate = state.terminals.some(
      (terminal) =>
        terminal.outletId === outlet.id &&
        terminal.terminalId === body.terminalId,
    );
    if (duplicate)
      throw new ApiError(
        409,
        "CONFLICT",
        `Terminal ${body.terminalId} sudah terdaftar di outlet ini.`,
      );
    const created: EdcTerminalView = {
      id: newIdempotencyKey(),
      tenantId: fixtures.tenantId,
      outletId: outlet.id,
      outletName: outlet.name,
      bankCode: body.bankCode,
      terminalId: body.terminalId,
      merchantId: body.merchantId,
      model: body.model,
      connection: body.connection,
      ipAddress: body.ipAddress,
      supportedMethods: [...body.supportedMethods],
      assignedDeviceId: null,
      status: body.status,
    };
    store.set({ ...state, terminals: [...state.terminals, created] });
    return { data: created };
  }),
);

registerMock(updateEdcTerminal, ({ endpoint, headers, params, body }) =>
  replayHeader(headers, endpoint.id, params, body, () => {
    const state = store.get();
    const terminal = state.terminals.find(
      (entry) => entry.id === params.terminalId,
    );
    if (!terminal)
      throw new ApiError(404, "NOT_FOUND", "Terminal tidak ditemukan.");
    if (
      body.terminalId !== undefined &&
      state.terminals.some(
        (entry) =>
          entry.id !== terminal.id &&
          entry.outletId === terminal.outletId &&
          entry.terminalId === body.terminalId,
      )
    )
      throw new ApiError(
        409,
        "CONFLICT",
        `Terminal ${body.terminalId} sudah terdaftar di outlet ini.`,
      );
    const updated: EdcTerminalView = {
      ...terminal,
      ...(body.bankCode === undefined ? {} : { bankCode: body.bankCode }),
      ...(body.terminalId === undefined ? {} : { terminalId: body.terminalId }),
      ...(body.merchantId === undefined ? {} : { merchantId: body.merchantId }),
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(body.connection === undefined ? {} : { connection: body.connection }),
      ...(body.ipAddress === undefined ? {} : { ipAddress: body.ipAddress }),
      ...(body.supportedMethods === undefined
        ? {}
        : { supportedMethods: [...body.supportedMethods] }),
      ...(body.status === undefined ? {} : { status: body.status }),
    };
    store.set({
      ...state,
      terminals: state.terminals.map((entry) =>
        entry.id === updated.id ? updated : entry,
      ),
      // Match the API's deletion of defaults that this terminal no longer
      // supports. Reactivating it must not resurrect an obsolete default.
      cashiers: state.cashiers.filter(
        (cashier) =>
          cashier.terminalId !== updated.id ||
          cashierDefaultUsable(cashier, [updated]),
      ),
    });
    return { data: updated };
  }),
);

// ---- Cashier defaults ----------------------------------------------------

function cashierDefaultUsable(
  cashier: EdcCashierDefault,
  terminals: EdcTerminalView[],
) {
  if (cashier.defaultMethod === "qris_doit") return cashier.terminalId === null;
  const terminal = terminals.find(
    (entry) =>
      entry.id === cashier.terminalId && entry.outletId === cashier.outletId,
  );
  const method = cashier.defaultMethod === "edc_card" ? "card" : "qris";
  return (
    terminal?.status === "active" && terminal.supportedMethods.includes(method)
  );
}

registerMock(getEdcCashierDefaults, ({ query, scenario }) => {
  const outlet = findOutlet(query.outletId);
  const { terminals, cashiers } = store.get();
  return {
    data: edcCashierDefaultsViewSchema.parse({
      outletId: outlet.id,
      outletName: outlet.name,
      terminals:
        scenario === "empty"
          ? []
          : terminals.filter((terminal) => terminal.outletId === outlet.id),
      cashiers:
        scenario === "empty"
          ? []
          : cashiers.filter(
              (cashier) =>
                cashier.outletId === outlet.id &&
                cashierDefaultUsable(cashier, terminals),
            ),
    }),
  };
});

registerMock(updateEdcCashierDefault, ({ endpoint, headers, params, body }) =>
  replayHeader(headers, endpoint.id, params, body, () => {
    const state = store.get();
    // The staff roster survives a default being cleared, just as the real
    // API can insert a new default for an existing outlet cashier.
    const cashier = [...state.cashiers, ...fixtures.cashiers].find(
      (entry) =>
        entry.cashierId === params.cashierId &&
        entry.outletId === body.outletId,
    );
    if (!cashier)
      throw new ApiError(404, "NOT_FOUND", "Kasir tidak ditemukan.");

    if (body.defaultMethod === "qris_doit") {
      if (body.terminalId !== null)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "QRIS DOIT tidak memakai terminal EDC.",
        );
    } else {
      if (body.terminalId === null)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Pilih terminal EDC untuk metode ini.",
        );
      const terminal = state.terminals.find(
        (entry) =>
          entry.id === body.terminalId && entry.outletId === body.outletId,
      );
      if (!terminal)
        throw new ApiError(404, "NOT_FOUND", "Terminal EDC tidak ditemukan.");
      if (terminal.status !== "active")
        throw new ApiError(409, "CONFLICT", "Terminal EDC sedang nonaktif.");
      const need = body.defaultMethod === "edc_card" ? "card" : "qris";
      if (!terminal.supportedMethods.includes(need))
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Terminal ini tidak mendukung metode yang dipilih.",
        );
    }

    const updated: EdcCashierDefault = {
      ...cashier,
      terminalId: body.terminalId,
      defaultMethod: body.defaultMethod,
      updatedAt: now(),
    };
    store.set({
      ...state,
      cashiers: state.cashiers.some((entry) => entry.id === updated.id)
        ? state.cashiers.map((entry) =>
            entry.id === updated.id ? updated : entry,
          )
        : [...state.cashiers, updated],
    });
    return { data: updated };
  }),
);

// ---- Refunds -------------------------------------------------------------

registerMock(listRefunds, ({ query, scenario }) => {
  const { refunds } = store.get();
  const filtered = query.outletId
    ? refunds.filter((refund) => refund.outletId === query.outletId)
    : refunds;
  return paginateFixture(filtered, query, (refund) => refund.id, scenario);
});

registerMock(listRefundablePayments, ({ query, scenario }) => {
  if (scenario === "empty") return { data: { payments: [] } };
  const { refundable } = store.get();
  const payments = query.outletId
    ? refundable.filter((payment) => payment.outletId === query.outletId)
    : refundable;
  return { data: { payments } };
});

registerMock(createRefund, ({ body }) =>
  replay(body.idempotencyKey, `refund:${JSON.stringify(body)}`, () =>
    createRefundOnce(body),
  ),
);

function createRefundOnce(body: CreateRefundInput) {
  const state = store.get();
  const payment = state.refundable.find(
    (entry) => entry.paymentIntentId === body.paymentIntentId,
  );
  if (!payment)
    throw new ApiError(
      404,
      "NOT_FOUND",
      "Pembayaran lunas tidak ditemukan atau sudah direfund seluruhnya.",
    );
  if (body.amountIdr > payment.refundableAmountIdr)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `Nominal melebihi sisa yang dapat direfund (${payment.refundableAmountIdr}).`,
      [
        {
          field: "amountIdr",
          message: "Kurangi nominal refund.",
        },
      ],
    );
  const created: RefundView = {
    id: newIdempotencyKey(),
    tenantId: fixtures.tenantId,
    outletId: payment.outletId,
    outletName: payment.outletName,
    paymentIntentId: payment.paymentIntentId,
    paymentReference: payment.reference,
    method: payment.method,
    paidAmountIdr: payment.paidAmountIdr,
    amountIdr: body.amountIdr,
    reason: body.reason,
    providerRef: null,
    status: "pending",
    approvedBy: null,
    approvedByName: null,
    requestedBy: ACTOR.id,
    requestedByName: ACTOR.name,
    // Nobody approves their own refund (PRD §3 "Matriks Approval").
    viewerCanApprove: false,
    note: body.note ?? null,
    createdAt: now(),
    decidedAt: null,
  };
  store.set({
    ...state,
    refunds: [created, ...state.refunds],
    refundable: state.refundable.map((entry) =>
      entry.paymentIntentId === payment.paymentIntentId
        ? {
            ...entry,
            refundedAmountIdr: idr(entry.refundedAmountIdr + body.amountIdr),
            refundableAmountIdr: idr(
              entry.refundableAmountIdr - body.amountIdr,
            ),
          }
        : entry,
    ),
  });
  return { data: created };
}

registerMock(approveRefund, ({ params, body }) =>
  replay(
    body.idempotencyKey,
    `approve:${params.refundId}:${body.note ?? ""}`,
    () => approveRefundOnce(params.refundId, body.note),
  ),
);

function approveRefundOnce(refundId: string, note: string | undefined) {
  const state = store.get();
  const refund = state.refunds.find((entry) => entry.id === refundId);
  if (!refund) throw new ApiError(404, "NOT_FOUND", "Refund tidak ditemukan.");
  if (refund.requestedBy === ACTOR.id)
    throw new ApiError(
      403,
      "APPROVER_IS_REQUESTER",
      "Penyetuju tidak boleh sama dengan pemohon.",
    );
  if (refund.status !== "pending")
    throw new ApiError(
      409,
      "CONFLICT",
      "Refund ini sudah diputuskan sebelumnya.",
    );
  // Fail closed like the API: the server-computed `viewerCanApprove` stands for
  // payment.reconcile + pos.refund.approve (or an open approval chain level) at
  // the outlet. Without it nothing is approved.
  if (!refund.viewerCanApprove)
    throw new ApiError(
      403,
      "PERMISSION_DENIED",
      "Akun Anda tidak dapat melakukan tindakan ini.",
    );
  // Approval never completes a refund: only the provider payout (or finance
  // for a manual refund) does, so it ends `approved` with no provider ref.
  const updated: RefundView = {
    ...refund,
    status: "approved",
    approvedBy: ACTOR.id,
    approvedByName: ACTOR.name,
    viewerCanApprove: false,
    providerRef: null,
    note: note ?? refund.note,
    decidedAt: now(),
  };
  store.set({
    ...state,
    refunds: state.refunds.map((entry) =>
      entry.id === updated.id ? updated : entry,
    ),
  });
  return { data: updated };
}

// Follow-up actions. The mock mirrors the API guards in refund-actions.ts, so a
// maybe-sent payout is only ever looked up here, never "sent again".

function refundOrThrow(refundId: string) {
  const state = store.get();
  const refund = state.refunds.find((entry) => entry.id === refundId);
  if (!refund) throw new ApiError(404, "NOT_FOUND", "Refund tidak ditemukan.");
  return { state, refund };
}

function saveRefund(state: MockState, updated: RefundView) {
  store.set({
    ...state,
    refunds: state.refunds.map((entry) =>
      entry.id === updated.id ? updated : entry,
    ),
  });
  return { data: updated };
}

registerMock(rejectRefund, ({ params, body }) =>
  replay(
    body.idempotencyKey,
    `reject:${params.refundId}:${body.reason}`,
    () => {
      const { state, refund } = refundOrThrow(params.refundId);
      if (refund.status !== "pending")
        throw new ApiError(
          409,
          "CONFLICT",
          "Refund ini sudah diputuskan sebelumnya.",
        );
      if (!refund.viewerCanApprove)
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "Akun Anda tidak dapat melakukan tindakan ini.",
        );
      return saveRefund(state, {
        ...refund,
        status: "failed",
        failureReason: "rejected",
        note: body.reason,
        viewerCanApprove: false,
        decidedAt: now(),
      });
    },
  ),
);

registerMock(retryRefundPayout, ({ params, body }) =>
  replay(body.idempotencyKey, `retry:${params.refundId}`, () => {
    const { state, refund } = refundOrThrow(params.refundId);
    if (refund.status !== "approved")
      throw new ApiError(
        409,
        "CONFLICT",
        "Hanya refund yang sudah disetujui yang dapat dicoba lagi.",
      );
    if (
      refund.lastPayoutError === "PAYOUT_QUARANTINED" &&
      (refund.payoutAttempts ?? 0) === 0 &&
      refund.providerRef === null
    )
      throw new ApiError(
        409,
        "PAYOUT_QUARANTINED",
        "Persetujuan refund gagal diperiksa ulang; refund tidak dapat dikirim.",
      );
    // The provider answers: paid. Either a first send or a lookup finds it.
    return saveRefund(state, {
      ...refund,
      status: "completed",
      providerRef: `RF-${refund.paymentReference}`,
      lastPayoutError: null,
      payoutAttempts: (refund.payoutAttempts ?? 0) + 1,
      completedAt: now(),
    });
  }),
);

function actOnQuarantineOnce(
  refundId: string,
  action: "release" | "reopen",
  note: string,
) {
  const { state, refund } = refundOrThrow(refundId);
  if (
    refund.status !== "approved" ||
    refund.lastPayoutError !== "PAYOUT_QUARANTINED"
  )
    throw new ApiError(
      409,
      "REFUND_NOT_QUARANTINED",
      "Hanya refund yang ditahan karantina yang dapat dilepas atau dibuka ulang.",
    );
  if ((refund.payoutAttempts ?? 0) > 0 || refund.providerRef !== null)
    throw new ApiError(
      409,
      "REFUND_PAYOUT_MAYBE_SENT",
      "Pengiriman mungkin sudah sampai ke penyedia; periksa statusnya.",
    );
  if (action === "release")
    return saveRefund(state, {
      ...refund,
      status: "failed",
      failureReason: "approver_unauthorized",
      lastPayoutError: null,
      note,
      decidedAt: now(),
    });
  return saveRefund(state, {
    ...refund,
    status: "pending",
    approvedBy: null,
    approvedByName: null,
    lastPayoutError: null,
    viewerCanApprove: true,
    note,
    decidedAt: null,
  });
}

registerMock(releaseQuarantinedRefund, ({ params, body }) =>
  replay(body.idempotencyKey, `release:${params.refundId}:${body.note}`, () =>
    actOnQuarantineOnce(params.refundId, "release", body.note),
  ),
);

registerMock(reopenQuarantinedRefund, ({ params, body }) =>
  replay(body.idempotencyKey, `reopen:${params.refundId}:${body.note}`, () =>
    actOnQuarantineOnce(params.refundId, "reopen", body.note),
  ),
);

// Manual settlement (card 1259). Like the API: MFA first (the mock session has
// none on the first try, so the screen shows MFA_REQUIRED once), then state,
// provider hold and amount.
let manualMfaChallenged = false;
registerMock(settleRefundManually, ({ params, body }) => {
  if (!manualMfaChallenged) {
    manualMfaChallenged = true;
    throw new ApiError(
      403,
      "MFA_REQUIRED",
      "Verifikasi dua langkah diperlukan.",
    );
  }
  return replay(
    body.idempotencyKey,
    `settle:${params.refundId}:${body.externalReference}:${body.amountIdr}`,
    () => {
      const { state, refund } = refundOrThrow(params.refundId);
      if (refund.status !== "approved")
        throw new ApiError(
          409,
          "REFUND_NOT_SETTLEABLE",
          "Only an approved refund can be settled manually.",
        );
      if (refund.providerRef !== null)
        throw new ApiError(
          409,
          "REFUND_AT_PROVIDER",
          "The provider holds this refund.",
        );
      if (body.amountIdr !== refund.amountIdr)
        throw new ApiError(
          409,
          "SETTLEMENT_AMOUNT_MISMATCH",
          "The paid amount must equal the refund amount.",
        );
      return saveRefund(state, {
        ...refund,
        status: "completed",
        lastPayoutError: null,
        note: body.note,
        completedAt: now(),
      });
    },
  );
});

// ---- Unallocated funds ---------------------------------------------------

registerMock(listUnallocatedFunds, ({ query, scenario }) => {
  const { funds } = store.get();
  const rows =
    scenario === "resolved-evidence-mismatch"
      ? funds.map((fund) =>
          fund.status === "resolved"
            ? { ...fund, evidenceMismatch: true }
            : fund,
        )
      : funds;
  const filtered = rows.filter(
    (fund) =>
      (!query.outletId || fund.outletId === query.outletId) &&
      (!query.status || fund.status === query.status),
  );
  return paginateFixture(filtered, query, (fund) => fund.id, scenario);
});

registerMock(resolveUnallocatedFund, ({ params, body }) =>
  replay(
    body.idempotencyKey,
    `fund:${params.fundId}:${body.resolution}:${body.note}`,
    () => resolveFundOnce(params.fundId, body),
  ),
);

function resolveFundOnce(fundId: string, body: ResolveUnallocatedFundInput) {
  const state = store.get();
  const fund = state.funds.find((entry) => entry.id === fundId);
  if (!fund) throw new ApiError(404, "NOT_FOUND", "Dana tidak ditemukan.");
  if (fund.status === "resolved")
    throw new ApiError(409, "CONFLICT", "Dana ini sudah diselesaikan.");
  // Credit has no approved ledger adapter; never represent it as completed.
  if (body.resolution === "credit")
    throw new ApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "Persetujuan kredit belum tersedia.",
    );
  const existingRefundId = state.fundRefunds.get(fund.id);
  const existingRefund = state.refunds.find(
    (entry) => entry.id === existingRefundId,
  );
  if (existingRefund && existingRefund.status !== "failed")
    throw new ApiError(
      409,
      "CONFLICT",
      "Pengembalian dana ini sudah menunggu persetujuan.",
    );
  // Reserve this fund's excess exactly once. It is separate from a refund of
  // the bill, so its paid/refundable balances must not be consumed here.
  const refund: RefundView = {
    id: newIdempotencyKey(),
    tenantId: fund.tenantId,
    outletId: fund.outletId,
    outletName: fund.outletName,
    paymentIntentId: fund.paymentIntentId,
    paymentReference: fund.paymentReference,
    method: fund.method,
    paidAmountIdr: fund.paidAmountIdr,
    amountIdr: fund.amountIdr,
    reason: "Unallocated funds",
    providerRef: null,
    status: "pending",
    approvedBy: null,
    approvedByName: null,
    requestedBy: ACTOR.id,
    requestedByName: ACTOR.name,
    viewerCanApprove: false,
    note: body.note,
    createdAt: now(),
    decidedAt: null,
  };
  // A refund only opens an approval chain; like the API, the fund stays open
  // (no resolution, no approval ref) until that chain completes.
  const updated: UnallocatedFundView = {
    ...fund,
    resolution: null,
    approvalRef: null,
    resolvedBy: null,
    resolvedByName: null,
    resolvedAt: null,
    status: "open",
  };
  store.set({
    ...state,
    refunds: [refund, ...state.refunds],
    fundRefunds: new Map(state.fundRefunds).set(fund.id, refund.id),
    funds: state.funds.map((entry) =>
      entry.id === updated.id ? updated : entry,
    ),
  });
  return { data: updated };
}

// ---- Reconciliation ------------------------------------------------------

registerMock(listReconciliationCases, ({ query, scenario }) => {
  const { cases } = store.get();
  const filtered = cases.filter(
    (entry) =>
      (!query.outletId || entry.outletId === query.outletId) &&
      (!query.status || entry.status === query.status) &&
      (!query.source || entry.source === query.source),
  );
  return paginateFixture(filtered, query, (entry) => entry.id, scenario);
});

registerMock(getReconciliationSummary, ({ scenario }) => {
  if (scenario === "empty") {
    return {
      data: {
        matchedLines: 0,
        unmatchedLines: 0,
        mismatchLines: 0,
        openCases: 0,
        resolvedThisMonth: 0,
        varianceIdr: 0,
      },
    };
  }
  const { cases } = store.get();
  return {
    data: {
      ...store.get().summary,
      openCases: cases.filter(
        (entry) =>
          entry.status === "open" || entry.status === "pending_approval",
      ).length,
      resolvedThisMonth: cases.filter((entry) => entry.status === "resolved")
        .length,
    },
  };
});

registerMock(resolveReconciliationCase, ({ endpoint, headers, params, body }) =>
  replayHeader(headers, endpoint.id, params, body, () => {
    const state = store.get();
    const entry = state.cases.find((row) => row.id === params.caseId);
    if (!entry)
      throw new ApiError(
        404,
        "NOT_FOUND",
        "Kasus rekonsiliasi tidak ditemukan.",
      );
    if (entry.status !== "open")
      throw new ApiError(
        409,
        "CONFLICT",
        "Kasus ini sudah diajukan atau ditutup.",
      );
    // Closing is only requested: another person must approve it before the
    // case resolves (contract: reconciliation_case approval).
    const updated: ReconciliationCaseView = {
      ...entry,
      status: "pending_approval",
      requestedBy: ACTOR.id,
      requestedByName: ACTOR.name,
      approvalRequestId: newIdempotencyKey(),
      note: body.note,
    };
    store.set({
      ...state,
      cases: state.cases.map((row) => (row.id === updated.id ? updated : row)),
    });
    return { data: updated };
  }),
);
