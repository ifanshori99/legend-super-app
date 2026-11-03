// Mock handlers for the CRM back office (`VITE_API_MOCK=true`), so every
// screen works with no API (docs/frontend.md "Typed endpoints and mock mode").
// They serve the CRM contract fixtures (bead legend-i026) and keep edits in an
// in-memory store, so a saved segment or a handled review is visible right
// away and a reload starts from the fixtures again.
//
// Loaded in Node by contract tests, so every import here is a bare package
// import or a relative `.ts` path (no `@/` alias). `?mock=empty` reports no
// customers, segments, feedback or point rows; the single-profile Customer 360
// answers NOT_FOUND so the screen shows its not-found state.
import {
  cafeLegendCrmFixtures,
  createSegment,
  getCustomer360,
  listCustomerPoints,
  listCustomers,
  listFeedback,
  listSegments,
  matchesSegment,
  previewSegment,
  tierProgressBp,
  transitionFeedback,
  updateFeedback,
  type Customer360,
  type CustomerProfile,
  type CustomerProfileDto,
  type Feedback,
  type FeedbackStatus,
  type Segment,
  type SegmentMatchContext,
  type VoucherDto,
} from "@starter/shared/crm";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock, type MockContext } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

const DAY_MS = 86_400_000;
const TENANT_ID = cafeLegendCrmFixtures.program.tenantId;
const STAFF_USER_ID = cafeLegendCrmFixtures.staffUserId;
/**
 * Anchor for "days since last visit" in the preview. The sample dataset's
 * newest timestamp is 2026-11-01 (segments.refreshedAt); a fixed anchor keeps
 * the preview deterministic instead of following the device clock.
 */
const SAMPLE_NOW_MS = Date.parse("2026-11-01T00:00:00.000Z");

type CrmMockState = {
  profiles: CustomerProfileDto[];
  segments: Segment[];
  feedback: Feedback[];
};

const store = createMockStore<CrmMockState>(() => ({
  profiles: [...cafeLegendCrmFixtures.profileDtos],
  segments: [...cafeLegendCrmFixtures.segments],
  feedback: [...cafeLegendCrmFixtures.feedback],
}));

function newId(): string {
  return newIdempotencyKey();
}

function toVoucherDto(
  voucher: (typeof cafeLegendCrmFixtures.vouchers)[number],
): VoucherDto {
  const copy: Record<string, unknown> = { ...voucher };
  delete copy.codeHash;
  return copy as VoucherDto;
}

// ---- Customer 360 ---------------------------------------------------------

/**
 * The fixtures ship one complete Customer 360 (the primary sample member).
 * For the other sample profiles the view is derived from their profile row and
 * the shared CRM fixtures: the dataset has no visit or favorite rows for them,
 * so those sections are honestly empty; the rolling window falls back to the
 * profile's lifetime figures so the tier card has a value.
 */
function buildCustomer360(profile: CustomerProfileDto): Customer360 {
  const primary = cafeLegendCrmFixtures.customer360;
  if (profile.id === primary.profile.id) return structuredClone(primary);

  const tiers = [...cafeLegendCrmFixtures.tiers]
    .filter((tier) => tier.isActive)
    .sort((left, right) => left.rank - right.rank);
  const currentTier =
    profile.tierId === null
      ? null
      : (tiers.find((tier) => tier.id === profile.tierId) ?? null);
  const nextTier =
    currentTier === null
      ? (tiers[0] ?? null)
      : (tiers.find((tier) => tier.rank > currentTier.rank) ?? null);
  const stats = {
    rollingSpendIdr: profile.lifetimeSpendIdr,
    rollingVisits: profile.visitsCount,
  };

  return {
    profile,
    consents: cafeLegendCrmFixtures.consents.filter(
      (consent) => consent.customerProfileId === profile.id,
    ),
    currentTier,
    nextTier,
    tierProgressBp: tierProgressBp(stats, nextTier),
    rollingSpendIdr: stats.rollingSpendIdr,
    rollingVisits: stats.rollingVisits,
    recentVisits: [],
    favoriteItems: [],
    recentFeedback: store
      .get()
      .feedback.filter((entry) => entry.customerProfileId === profile.id),
    activeVouchers: cafeLegendCrmFixtures.vouchers
      .filter(
        (voucher) =>
          voucher.customerProfileId === profile.id &&
          voucher.status === "issued",
      )
      .map(toVoucherDto),
  };
}

registerMock(listCustomers, ({ query, scenario }) => {
  const needle = query.q?.trim().toLocaleLowerCase("id-ID") ?? "";
  const rows = store.get().profiles.filter((profile) => {
    if (
      needle !== "" &&
      !profile.name.toLocaleLowerCase("id-ID").includes(needle)
    )
      return false;
    if (query.tierId !== undefined && profile.tierId !== query.tierId)
      return false;
    if (
      query.membershipStatus !== undefined &&
      profile.membershipStatus !== query.membershipStatus
    )
      return false;
    return true;
  });
  return paginateFixture(rows, query, (profile) => profile.id, scenario);
});

registerMock(getCustomer360, ({ params, scenario }) => {
  const profile =
    scenario === "empty"
      ? undefined
      : store
          .get()
          .profiles.find(
            (candidate) => candidate.id === params.customerProfileId,
          );
  if (!profile)
    throw new ApiError(404, "NOT_FOUND", "Pelanggan tidak ditemukan.");
  return { data: buildCustomer360(profile) };
});

registerMock(listCustomerPoints, ({ params, query, scenario }) => {
  // The ledger is append-only (LOY-01), so the fixtures are the truth.
  const rows = cafeLegendCrmFixtures.ledgerEntries
    .filter((entry) => entry.customerProfileId === params.customerProfileId)
    .sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
  return paginateFixture(rows, query, (entry) => entry.id, scenario);
});

// ---- Segments -------------------------------------------------------------

registerMock(listSegments, ({ query, scenario }) =>
  paginateFixture(
    store.get().segments,
    query,
    (segment) => segment.id,
    scenario,
  ),
);

registerMock(createSegment, ({ body }) => {
  const state = store.get();
  const segment: Segment = {
    id: newId(),
    tenantId: TENANT_ID,
    name: body.name,
    definition: body.definition,
    // The real service materializes the size asynchronously; a new segment has
    // not been counted yet, so the list says so instead of showing a guess.
    refreshedAt: null,
    size: 0,
  };
  store.set({ ...state, segments: [...state.segments, segment] });
  return { data: segment };
});

/** Facts the server derives per profile before matching a definition. */
function matchContext(profile: CustomerProfileDto): SegmentMatchContext {
  const primary = profile.id === cafeLegendCrmFixtures.customer360.profile.id;
  const visitedOutletIds = primary
    ? [
        ...new Set(
          cafeLegendCrmFixtures.memberVisits.map((visit) => visit.outletId),
        ),
      ]
    : [];
  const favoriteMenuItemIds = primary
    ? cafeLegendCrmFixtures.memberFavorites.map((item) => item.menuItemId)
    : [];
  const contextProfile: CustomerProfile = {
    ...profile,
    // The DTO drops the WhatsApp hash; the match context works on the stored
    // profile, and this mock has no hash to put back.
    whatsappHash: null,
  };
  return {
    profile: contextProfile,
    daysSinceLastVisit:
      profile.lastVisitAt === null
        ? null
        : Math.max(
            0,
            Math.floor(
              (SAMPLE_NOW_MS - Date.parse(profile.lastVisitAt)) / DAY_MS,
            ),
          ),
    favoriteMenuItemIds,
    visitedOutletIds,
    birthMonth:
      profile.birthMonthDay === null
        ? null
        : Number(profile.birthMonthDay.slice(0, 2)),
  };
}

registerMock(previewSegment, ({ body, scenario }) => {
  if (scenario === "empty") return { data: { size: 0, sample: [] } };
  const matched = store
    .get()
    .profiles.filter((profile) =>
      matchesSegment(matchContext(profile), body.definition),
    );
  return { data: { size: matched.length, sample: matched.slice(0, 20) } };
});

// ---- Feedback queue -------------------------------------------------------

export function feedbackMockHandler({
  query,
  scenario,
}: MockContext<typeof listFeedback>) {
  const rows = store
    .get()
    .feedback.filter((entry) => {
      if (query.status !== undefined && entry.status !== query.status)
        return false;
      if (query.kind !== undefined && entry.kind !== query.kind) return false;
      if (query.outletId !== undefined && entry.outletId !== query.outletId)
        return false;
      return true;
    })
    .sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
  return paginateFixture(rows, query, (entry) => entry.id, scenario);
}

// Single mock owner for GET /api/feedback. The owner dashboard's former
// fallback (ws11) was removed when this bead merged: this handler filters by
// status, kind and outlet, a superset of the dashboard's kind filter.
registerMock(listFeedback, feedbackMockHandler);

registerMock(updateFeedback, ({ params, body }) => {
  const state = store.get();
  const current = state.feedback.find(
    (entry) => entry.id === params.feedbackId,
  );
  if (!current) throw new ApiError(404, "NOT_FOUND", "Ulasan tidak ditemukan.");
  let status: FeedbackStatus;
  try {
    status = transitionFeedback(current.status, body.action);
  } catch {
    throw new ApiError(
      409,
      "CONFLICT",
      "Status ulasan tidak mendukung aksi ini.",
    );
  }
  const now = new Date().toISOString();
  const next: Feedback = {
    ...current,
    status,
    // feedbackSchema: a row is assigned once it leaves the queue, and
    // resolved/closed rows carry a resolution time.
    handledBy: status === "open" ? null : (current.handledBy ?? STAFF_USER_ID),
    resolvedAt:
      status === "resolved" || status === "closed"
        ? (current.resolvedAt ?? now)
        : null,
  };
  store.set({
    ...state,
    feedback: state.feedback.map((entry) =>
      entry.id === next.id ? next : entry,
    ),
  });
  return { data: next };
});
