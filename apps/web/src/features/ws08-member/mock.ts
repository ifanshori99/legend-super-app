// Mock mode for the member PWA (VITE_API_MOCK=true): serves the CRM domain
// fixtures from @starter/shared/crm, with the same validation, pagination and
// LOY-03 atomicity the API guarantees. Mutations (redeem, consent) live in
// per-runtime stores, so a browser session sees its own changes and a reset
// (`window.__legendMock.reset()`) restores the fixture state.
import {
  cafeLegendCrmFixtures,
  crmErrorMessages,
  customerConsentSchema,
  getMemberOverview,
  issueMemberQrToken,
  liabilityIdrForPoints,
  listMemberFavorites,
  listMemberMissions,
  listMemberPoints,
  listMemberRewards,
  listMemberVisits,
  listMemberVouchers,
  pointLedgerEntrySchema,
  redeemReward,
  rewardRedemptionCheck,
  rewardRedemptionSchema,
  updateMemberConsent,
} from "@starter/shared/crm";
import type {
  CustomerConsent,
  RewardRedemption,
  VoucherDto,
} from "@starter/shared/crm";
import { createUlidFactory } from "@starter/shared/core";
import { ApiError } from "@/lib/api/errors";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import {
  mintRedeemMockToken,
  redeemedPointsTotal,
} from "../member-tukar-poin/mock";

const fixtures = cafeLegendCrmFixtures;
const memberId = fixtures.memberOverview.profile.id;
const tenantId = fixtures.memberOverview.profile.tenantId;
const nextUlid = createUlidFactory();
const nowIso = () => new Date().toISOString();

const overview = createMockStore(() =>
  structuredClone(fixtures.memberOverview),
);

const points = createMockStore(() =>
  fixtures.ledgerEntries
    .filter((entry) => entry.customerProfileId === memberId)
    .sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    ),
);

// Cloned: a redemption decrements stock, which must never reach the shared
// fixtures (a reset would not restore it).
const rewards = createMockStore(() =>
  structuredClone(fixtures.rewards)
    .filter((reward) => reward.isActive)
    .sort((left, right) => left.sortOrder - right.sortOrder),
);

const missions = createMockStore(() =>
  fixtures.missions
    .filter((mission) => mission.isActive)
    .map((mission) => ({
      mission,
      progress:
        fixtures.missionProgress.find(
          (progress) =>
            progress.missionId === mission.id &&
            progress.customerProfileId === memberId,
        ) ?? null,
      voucherCode: null,
    })),
);

type FixtureVoucher = (typeof fixtures.vouchers)[number];

function toVoucherDto(voucher: FixtureVoucher): VoucherDto {
  const copy: Record<string, unknown> = { ...voucher };
  delete copy.codeHash;
  return copy as VoucherDto;
}

const vouchers = createMockStore(() =>
  fixtures.vouchers
    .filter((voucher) => voucher.customerProfileId === memberId)
    .map(toVoucherDto)
    .sort(
      (left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt),
    ),
);

const visits = createMockStore(() =>
  [...fixtures.memberVisits].sort(
    (left, right) => Date.parse(right.visitedAt) - Date.parse(left.visitedAt),
  ),
);

const favorites = createMockStore(() => [...fixtures.memberFavorites]);

const consents = createMockStore(() =>
  structuredClone(fixtures.memberOverview.consents),
);

const redemptions = createMockStore((): RewardRedemption[] => []);
const redemptionsByKey = createMockStore(
  () => new Map<string, RewardRedemption>(),
);

// legend-0ne0z: points spent through the cashier QR (tukar-poin mock store) come
// off the balance here, so the overview matches the quote after a redemption.
registerMock(getMemberOverview, ({ scenario }) => {
  const current = overview.get();
  const spent = redeemedPointsTotal(scenario);
  if (spent === 0) return { data: current };
  return {
    data: {
      ...current,
      profile: {
        ...current.profile,
        pointsBalance: Math.max(0, current.profile.pointsBalance - spent),
      },
    },
  };
});

registerMock(listMemberPoints, ({ query, scenario }) =>
  paginateFixture(points.get(), query, (entry) => entry.id, scenario),
);

registerMock(listMemberRewards, ({ query, scenario }) =>
  paginateFixture(rewards.get(), query, (reward) => reward.id, scenario),
);

registerMock(listMemberMissions, ({ scenario }) => {
  if (scenario === "empty") return { data: [] };
  return { data: missions.get() };
});

registerMock(listMemberVouchers, ({ query, scenario }) =>
  paginateFixture(vouchers.get(), query, (voucher) => voucher.id, scenario),
);

registerMock(listMemberVisits, ({ query, scenario }) =>
  paginateFixture(visits.get(), query, (visit) => visit.orderId, scenario),
);

registerMock(listMemberFavorites, ({ scenario }) => {
  if (scenario === "empty") return { data: [] };
  return { data: favorites.get() };
});

/** Uppercase, no confusable characters: the code is read aloud at the till. */
function redemptionCode(prefix: string): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `${prefix}${suffix}`;
}

const REJECTION_ERRORS = {
  insufficient_points: ["POINTS_INSUFFICIENT", 409],
  out_of_stock: ["REWARD_OUT_OF_STOCK", 409],
  not_started: ["REWARD_EXPIRED", 409],
  expired: ["REWARD_EXPIRED", 409],
  reward_inactive: ["REWARD_EXPIRED", 409],
  limit_reached: ["REDEMPTION_LIMIT_REACHED", 409],
} as const satisfies Record<
  string,
  readonly [keyof typeof crmErrorMessages, number]
>;

registerMock(redeemReward, ({ params, body }) => {
  const key = body.idempotencyKey;
  const previous = redemptionsByKey.get().get(key);
  if (previous) {
    if (previous.rewardId !== params.rewardId)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai untuk hadiah lain.",
      );
    return { data: previous };
  }

  const reward = rewards.get().find((item) => item.id === params.rewardId);
  if (!reward) throw new ApiError(404, "NOT_FOUND", "Hadiah tidak ditemukan.");
  const current = overview.get();
  const decision = rewardRedemptionCheck({
    isActive: reward.isActive,
    stock: reward.stock,
    validFrom: reward.validFrom,
    validUntil: reward.validUntil,
    pointsCost: reward.pointsCost,
    pointsBalance: current.profile.pointsBalance,
    existingRedemptions: redemptions
      .get()
      .filter(
        (redemption) =>
          redemption.rewardId === reward.id &&
          redemption.customerProfileId === memberId &&
          redemption.status !== "cancelled" &&
          redemption.status !== "expired",
      ).length,
    // PRD §3.20 names no per-customer limit; the reward contract carries it.
    perCustomerLimit: null,
    at: nowIso(),
  });
  if (!decision.ok) {
    const [code, status] = REJECTION_ERRORS[decision.reason];
    throw new ApiError(status, code, crmErrorMessages[code]);
  }

  const at = nowIso();
  const redemption = rewardRedemptionSchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    rewardId: reward.id,
    customerProfileId: memberId,
    orderId: null,
    pointsSpent: reward.pointsCost,
    status: "pending",
    redemptionCode: redemptionCode(reward.type === "voucher" ? "VCR" : "RWD"),
    rewardType: reward.type,
    expiresAt: new Date(
      Date.parse(at) + reward.redemptionValidDays * 86_400_000,
    ).toISOString(),
    voucherId: null,
    fulfilledOutletId: null,
    idempotencyKey: key,
    redeemedAt: at,
    fulfilledAt: null,
    cancelledAt: null,
    createdAt: at,
  });

  // LOY-03: stock, balance and ledger change together, once per key.
  if (reward.stock !== null) reward.stock -= 1;
  const balanceAfter = current.profile.pointsBalance - reward.pointsCost;
  const ledgerRow = pointLedgerEntrySchema.parse({
    id: nextUlid(),
    tenantId,
    customerProfileId: memberId,
    type: "redeem",
    points: -reward.pointsCost,
    sourceType: "reward_redemption",
    sourceId: redemption.id,
    expiresAt: null,
    liabilityIdr: liabilityIdrForPoints(current.program, -reward.pointsCost),
    reason: null,
    createdAt: at,
  });
  points.get().unshift(ledgerRow);
  redemptions.get().unshift(redemption);
  redemptionsByKey.get().set(key, redemption);
  overview.set({
    ...current,
    profile: { ...current.profile, pointsBalance: balanceAfter },
  });
  return { data: redemption };
});

const hasActiveConsent = (
  list: readonly CustomerConsent[],
  purpose: CustomerConsent["purpose"],
) => list.some((item) => item.purpose === purpose && item.withdrawnAt === null);

registerMock(updateMemberConsent, ({ body }) => {
  const at = nowIso();
  const list = consents.get();
  const active = list.find(
    (item) => item.purpose === body.purpose && item.withdrawnAt === null,
  );
  let saved: CustomerConsent;
  if (body.granted) {
    if (active) {
      saved = customerConsentSchema.parse({
        ...active,
        policyVersion: body.policyVersion,
      });
      list[list.indexOf(active)] = saved;
    } else {
      saved = customerConsentSchema.parse({
        id: newIdempotencyKey(),
        tenantId,
        customerProfileId: memberId,
        purpose: body.purpose,
        policyVersion: body.policyVersion,
        grantedAt: at,
        withdrawnAt: null,
        source: "member_pwa",
      });
      list.push(saved);
    }
  } else if (active) {
    saved = customerConsentSchema.parse({ ...active, withdrawnAt: at });
    list[list.indexOf(active)] = saved;
  } else {
    // Already withdrawn: keep the versioned history untouched.
    saved =
      list.findLast((item) => item.purpose === body.purpose) ??
      customerConsentSchema.parse({
        id: newIdempotencyKey(),
        tenantId,
        customerProfileId: memberId,
        purpose: body.purpose,
        policyVersion: body.policyVersion,
        grantedAt: at,
        withdrawnAt: at,
        source: "member_pwa",
      });
  }

  // PRD §3.20: membership is active only with a verified WhatsApp number and
  // an active loyalty consent. Suspended and closed memberships stay put.
  const current = overview.get();
  const verified = current.profile.whatsappVerifiedAt !== null;
  const loyalty = hasActiveConsent(list, "loyalty");
  const marketing = hasActiveConsent(list, "marketing");
  const membershipStatus =
    current.profile.membershipStatus === "suspended" ||
    current.profile.membershipStatus === "closed"
      ? current.profile.membershipStatus
      : verified && loyalty
        ? "active"
        : "pending_verification";
  overview.set({
    ...current,
    profile: {
      ...current.profile,
      marketingOptIn: marketing,
      membershipStatus,
    },
    consents: [...list],
  });
  return { data: saved };
});

// 1150: the real token is signed server-side; the mock only needs a unique
// string that expires after 120 s. Error, offline and slow scenarios are
// applied centrally (lib/mock/control.ts).
let qrTokenCounter = 0;
registerMock(issueMemberQrToken, ({ body, scenario }) => {
  // legend-0ne0z: a token bound to a bill and points is the points-redeem QR;
  // the tukar-poin mock tracks it so the status endpoint can answer for it.
  // The contract sends orderId and points together or neither.
  if (body.orderId !== undefined && body.points !== undefined)
    return mintRedeemMockToken(
      { orderId: body.orderId, points: body.points },
      scenario,
    );
  qrTokenCounter += 1;
  return {
    data: {
      token: `mock.${qrTokenCounter}.${Date.now().toString(36)}`,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    },
  };
});
