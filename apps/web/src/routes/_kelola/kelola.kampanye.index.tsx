import { createFileRoute } from "@tanstack/react-router";
import { CampaignListPage } from "@/features/ws08-crm-campaigns/components/campaign-list-page";
import { campaignGuard } from "@/features/ws08-crm-campaigns/guard";
import { isMockScenarioRequest } from "@/features/ws08-crm-campaigns/lib";
import { campaignsQuery } from "@/features/ws08-crm-campaigns/queries";

// /kelola/kampanye — the campaign list: status filter, channel, schedule, A/B
// and the results summary (PRD §3.21 "Kampanye"; LOY-04).
export const Route = createFileRoute("/_kelola/kelola/kampanye/")({
  beforeLoad: campaignGuard(["campaign.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(campaignsQuery()),
  component: CampaignListScreen,
});

function CampaignListScreen() {
  // CampaignListPage renders the shared CampaignsPage frame itself; wrapping it
  // here again would repeat the title, subtitle and tabs (review finding).
  return <CampaignListPage />;
}
