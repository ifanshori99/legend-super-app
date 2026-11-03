// Mock handlers for the campaign screens (`VITE_API_MOCK=true`), so every
// screen works with no API (docs/frontend.md "Typed endpoints and mock mode").
// They serve the CRM contract fixtures (segments, campaigns, campaign sends
// and results; bead legend-zk25) and keep edits in an in-memory store, so a
// created campaign and a status transition are visible right away.
//
// Owned endpoints: listCampaigns, createCampaign, updateCampaign,
// getCampaignResults. Segments (listSegments / createSegment / previewSegment)
// are owned by the CRM segment mock (legend-i026) — this file never registers
// them, so the audience picker reads that single owner and a duplicate cannot
// shadow it.
//
// Consent-aware results (LOY-04): campaigns with no fixture results get a
// deterministic summary derived from the segment size and the contract's own
// `campaignSendDecision`, so a skipped recipient is a recipient without active
// marketing consent — never a hand-written number. `?mock=empty` returns an
// empty campaign list and zeroed results; `?mock=error` fails every call.
import {
  cafeLegendCrmFixtures,
  createCampaign,
  getCampaignResults,
  listCampaigns,
  transitionCampaign,
  updateCampaign,
  type Campaign,
  type CampaignResults,
  type CampaignStatus,
} from "@starter/shared/crm";
import { idr } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { countConsentSkips } from "./lib.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock, type MockContext } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";

const fixtures = cafeLegendCrmFixtures;
const tenantId = fixtures.campaigns[0]!.tenantId;

type CampaignMockState = { campaigns: Campaign[] };

const store = createMockStore<CampaignMockState>(() => ({
  campaigns: [...fixtures.campaigns],
}));

function newId(): string {
  return newIdempotencyKey();
}

function findCampaign(id: string): Campaign {
  const campaign = store
    .get()
    .campaigns.find((candidate) => candidate.id === id);
  if (!campaign)
    throw new ApiError(404, "NOT_FOUND", "Kampanye tidak ditemukan.");
  return campaign;
}

function zeroResults(campaignId: string): CampaignResults {
  return {
    campaignId,
    recipients: 0,
    sent: 0,
    delivered: 0,
    failed: 0,
    skippedNoConsent: 0,
    opened: 0,
    redeemed: 0,
    revenueIdr: idr(0),
    costIdr: idr(0),
  };
}

/**
 * Results snapshot for one campaign. A campaign that never ran has none; a
 * campaign created here (no fixture row) is summarised from its segment size
 * and the consent rule: skipped recipients are exactly the customers
 * `campaignSendDecision` refuses (LOY-04).
 */
function resultsFor(campaign: Campaign): CampaignResults {
  if (campaign.status !== "running" && campaign.status !== "completed")
    return zeroResults(campaign.id);
  if (fixtures.campaignResults.campaignId === campaign.id)
    return fixtures.campaignResults;
  const segment = fixtures.segments.find(
    (candidate) => candidate.id === campaign.segmentId,
  );
  const recipients = segment?.size ?? 0;
  const at =
    campaign.completedAt ?? campaign.startedAt ?? new Date().toISOString();
  const skipped = Math.min(
    recipients,
    countConsentSkips(fixtures.profiles, fixtures.consents, at),
  );
  const sent = Math.max(0, recipients - skipped);
  return {
    campaignId: campaign.id,
    recipients,
    sent,
    delivered: sent,
    failed: 0,
    skippedNoConsent: skipped,
    opened: 0,
    redeemed: 0,
    revenueIdr: idr(0),
    costIdr: idr(0),
  };
}

// ---- Campaigns ------------------------------------------------------------

registerMock(
  listCampaigns,
  ({ query, scenario }: MockContext<typeof listCampaigns>) => {
    const campaigns = store
      .get()
      .campaigns.filter(
        (campaign) =>
          query.status === undefined || campaign.status === query.status,
      );
    return paginateFixture(
      campaigns,
      query,
      (campaign) => campaign.id,
      scenario,
    );
  },
);

registerMock(createCampaign, ({ body }) => {
  const state = store.get();
  const campaign: Campaign = {
    id: newId(),
    tenantId,
    name: body.name,
    segmentId: body.segmentId,
    channel: body.channel,
    content: body.content,
    abTest: body.abTest,
    scheduledAt: body.scheduledAt,
    // A campaign with a send time is scheduled; without one it stays a draft
    // (the create form says so).
    status: body.scheduledAt === null ? "draft" : "scheduled",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
  };
  store.set({ ...state, campaigns: [campaign, ...state.campaigns] });
  return { data: campaign };
});

registerMock(updateCampaign, ({ params, body }) => {
  const state = store.get();
  const current = findCampaign(params.campaignId);
  let next: Campaign = {
    ...current,
    content: body.content ?? current.content,
    abTest: body.abTest === undefined ? current.abTest : body.abTest,
    scheduledAt:
      body.scheduledAt === undefined ? current.scheduledAt : body.scheduledAt,
  };

  if (body.action !== undefined) {
    let status: CampaignStatus;
    try {
      status = transitionCampaign(current.status, body.action);
    } catch {
      throw new ApiError(
        409,
        "INVALID_CAMPAIGN_TRANSITION",
        "Aksi ini tidak berlaku untuk status kampanye ini.",
      );
    }
    const now = new Date().toISOString();
    if (status === "scheduled" && next.scheduledAt === null)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Kampanye terjadwal membutuhkan waktu kirim.",
        [{ field: "scheduledAt", message: "Isi waktu kirim." }],
      );
    // The contract ties each timestamp to one status: only running/completed
    // carry startedAt, only completed carries completedAt, only cancelled
    // carries cancelledAt.
    next = {
      ...next,
      status,
      startedAt:
        status === "running" || status === "completed"
          ? (current.startedAt ?? now)
          : null,
      completedAt: status === "completed" ? now : null,
      cancelledAt: status === "cancelled" ? now : null,
    };
  }

  if (
    (next.status === "scheduled" || next.status === "running") &&
    next.scheduledAt === null
  )
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Kampanye terjadwal membutuhkan waktu kirim.",
      [{ field: "scheduledAt", message: "Isi waktu kirim." }],
    );

  store.set({
    ...state,
    campaigns: state.campaigns.map((candidate) =>
      candidate.id === next.id ? next : candidate,
    ),
  });
  return { data: next };
});

registerMock(
  getCampaignResults,
  ({ params, scenario }: MockContext<typeof getCampaignResults>) => {
    const campaign = findCampaign(params.campaignId);
    return {
      data:
        scenario === "empty" ? zeroResults(campaign.id) : resultsFor(campaign),
    };
  },
);
