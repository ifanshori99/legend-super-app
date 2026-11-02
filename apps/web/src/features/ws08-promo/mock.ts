// Mock handlers for the promo admin (`VITE_API_MOCK=true`), so every screen
// works with no API (docs/frontend.md "Typed endpoints and mock mode"). They
// serve the CRM contract fixtures (promotions, vouchers; bead legend-zk25) and
// keep edits in memory, so a save is visible on the list right away and a
// reload starts from the fixtures again. ROI rows are derived from each
// promotion's spent budget with a fixed factor, so the report is stable.
//
// Loaded in Node by tests, so every import is a bare package import or a
// relative `.ts` path (no `@/` alias). `?mock=empty` makes the lists empty.
import {
  cafeLegendCrmFixtures,
  createPromotion,
  defaultPromoStackingPolicy,
  getPromoStackingPolicy,
  getPromotionRoi,
  issueVoucher,
  listPromotions,
  listVouchers,
  updatePromoStackingPolicy,
  updatePromotion,
  validateVoucher,
  type PromoStackingPolicy,
  type Promotion,
  type PromotionRoi,
  type VoucherDto,
} from "@starter/shared/crm";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock, type MockContext } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

type PromoMockState = {
  promotions: Promotion[];
  vouchers: VoucherDto[];
  policy: PromoStackingPolicy;
  /** Plain code → voucher id, so "cek kode" can answer without hashes. */
  codes: Map<string, string>;
};

function toDto(
  voucher: (typeof cafeLegendCrmFixtures.vouchers)[number],
): VoucherDto {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { codeHash: _codeHash, ...dto } = voucher;
  return dto;
}

const DEMO_CODES: ReadonlyArray<readonly [string, number]> = [
  ["AKHIRPEKAN25", 0],
  ["ULTAHBUDI25", 1],
  ["MAAFRINA50", 2],
];

const store = createMockStore<PromoMockState>(() => {
  const vouchers = cafeLegendCrmFixtures.vouchers.map(toDto);
  return {
    promotions: [...cafeLegendCrmFixtures.promotions],
    vouchers,
    policy: { ...defaultPromoStackingPolicy },
    codes: new Map(
      DEMO_CODES.flatMap(([code, index]) =>
        vouchers[index] ? [[code, vouchers[index].id] as const] : [],
      ),
    ),
  };
});

const tenantId = cafeLegendCrmFixtures.promotions[0]!.tenantId;

function newId(): string {
  return newIdempotencyKey();
}

function findPromotion(id: string): Promotion {
  const promotion = store.get().promotions.find((p) => p.id === id);
  if (!promotion)
    throw new ApiError(404, "NOT_FOUND", "Promo tidak ditemukan.");
  return promotion;
}

/** Drop undefined keys so a PATCH only changes what the client sent. */
function definedOnly<T extends object>(body: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

// ---- Promotions -----------------------------------------------------------

registerMock(
  listPromotions,
  ({ query, scenario }: MockContext<typeof listPromotions>) => {
    const promotions = store
      .get()
      .promotions.filter(
        (promotion) =>
          query.status === undefined || promotion.status === query.status,
      );
    return paginateFixture(promotions, query, (p) => p.id, scenario);
  },
);

registerMock(createPromotion, ({ body }) => {
  const state = store.get();
  const now = new Date().toISOString();
  const promotion: Promotion = {
    ...body,
    id: newId(),
    tenantId,
    spentIdr: 0,
    createdAt: now,
    updatedAt: now,
  } as Promotion;
  store.set({ ...state, promotions: [promotion, ...state.promotions] });
  return { data: promotion };
});

registerMock(updatePromotion, ({ params, body }) => {
  const state = store.get();
  const current = findPromotion(params.promotionId);
  const promotion: Promotion = {
    ...current,
    ...definedOnly(body),
    updatedAt: new Date().toISOString(),
  } as Promotion;
  store.set({
    ...state,
    promotions: state.promotions.map((p) =>
      p.id === promotion.id ? promotion : p,
    ),
  });
  return { data: promotion };
});

// ---- Stacking policy ------------------------------------------------------

registerMock(getPromoStackingPolicy, () => ({ data: store.get().policy }));

registerMock(updatePromoStackingPolicy, ({ body }) => {
  const policy: PromoStackingPolicy = {
    mode: body.mode,
    maxStacked: body.mode === "exclusive" ? 1 : body.maxStacked,
    allowSameGroup: body.allowSameGroup,
  };
  store.set({ ...store.get(), policy });
  return { data: policy };
});

// ---- ROI ------------------------------------------------------------------

/** Revenue per rupiah of discount, fixed per promotion so the report is stable. */
const ROI_FACTORS = [8, 5, 6, 7, 4, 9, 3, 6, 5, 0.8, 0];

function roiFor(promotion: Promotion, index: number): PromotionRoi {
  const cost = promotion.spentIdr;
  const factor = ROI_FACTORS[index % ROI_FACTORS.length] ?? 4;
  const revenue = Math.round(cost * factor);
  const net = revenue - cost;
  return {
    promotionId: promotion.id,
    transactions: cost > 0 ? Math.max(1, Math.round(cost / 12_500)) : 0,
    discountCostIdr: cost,
    revenueIdr: revenue,
    netMarginIdr: net,
    roiBp: cost > 0 ? Math.round((net / cost) * 10_000) : null,
  } as PromotionRoi;
}

registerMock(getPromotionRoi, ({ params }) => {
  const promotions = store.get().promotions;
  const promotion = findPromotion(params.promotionId);
  return { data: roiFor(promotion, promotions.indexOf(promotion)) };
});

// ---- Vouchers -------------------------------------------------------------

registerMock(
  listVouchers,
  ({ query, scenario }: MockContext<typeof listVouchers>) => {
    const vouchers = store
      .get()
      .vouchers.filter(
        (voucher) =>
          (query.status === undefined || voucher.status === query.status) &&
          (query.customerProfileId === undefined ||
            voucher.customerProfileId === query.customerProfileId),
      );
    return paginateFixture(vouchers, query, (v) => v.id, scenario);
  },
);

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(length = 10): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(
    "",
  );
}

registerMock(issueVoucher, ({ body }) => {
  const state = store.get();
  if (body.promotionId === null && body.valueIdr === null)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Pilih promo atau isi nilai voucher.",
      [{ field: "valueIdr", message: "Pilih promo atau isi nilai voucher." }],
    );
  if (body.promotionId !== null) findPromotion(body.promotionId);
  const now = new Date().toISOString();
  const voucher: VoucherDto = {
    id: newId(),
    tenantId,
    promotionId: body.promotionId,
    customerProfileId: body.customerProfileId,
    source: body.source,
    status: "issued",
    valueIdr: body.valueIdr,
    validFrom: body.validFrom,
    validUntil: body.validUntil,
    issuedAt: now,
    issuedBy: cafeLegendCrmFixtures.staffUserId,
    redeemedAt: null,
    redeemedOrderId: null,
    cancelledReason: null,
  } as VoucherDto;
  const code = randomCode();
  const codes = new Map(state.codes);
  codes.set(code, voucher.id);
  store.set({ ...state, vouchers: [voucher, ...state.vouchers], codes });
  return { data: { voucher, code } };
});

function previewDiscount(promotion: Promotion, subtotalIdr: number): number {
  const benefit = promotion.benefit;
  if (benefit.kind === "nominal_off")
    return Math.min(benefit.amountIdr, subtotalIdr);
  if (benefit.kind === "percent_off") {
    const raw = Math.round((subtotalIdr * benefit.percentBp) / 10_000);
    return benefit.maxDiscountIdr === null
      ? raw
      : Math.min(raw, benefit.maxDiscountIdr);
  }
  return 0;
}

registerMock(validateVoucher, ({ body }) => {
  const state = store.get();
  const reject = (reason: string) => ({
    data: { valid: false as const, reason: reason as never },
  });
  const voucherId = state.codes.get(body.code);
  const voucher = state.vouchers.find((v) => v.id === voucherId);
  if (!voucher) return reject("not_found");
  if (voucher.status === "redeemed") return reject("already_redeemed");
  if (voucher.status === "cancelled") return reject("cancelled");
  const now = Date.now();
  if (
    voucher.status === "expired" ||
    (voucher.validUntil && Date.parse(voucher.validUntil) < now)
  )
    return reject("expired");
  if (Date.parse(voucher.validFrom) > now) return reject("not_started");
  const promotion = voucher.promotionId
    ? state.promotions.find((p) => p.id === voucher.promotionId)
    : undefined;
  if (promotion) {
    for (const condition of promotion.conditions) {
      if (
        condition.kind === "min_spend" &&
        body.subtotalIdr < condition.amountIdr
      )
        return reject("min_spend_not_met");
      if (
        condition.kind === "channel" &&
        !condition.channels.includes(body.channel)
      )
        return reject("channel_not_allowed");
    }
  }
  const discountPreviewIdr = promotion
    ? previewDiscount(promotion, body.subtotalIdr)
    : Math.min(voucher.valueIdr ?? 0, body.subtotalIdr);
  return {
    data: {
      valid: true as const,
      voucherId: voucher.id,
      promotionId: voucher.promotionId,
      discountPreviewIdr,
    },
  };
});
