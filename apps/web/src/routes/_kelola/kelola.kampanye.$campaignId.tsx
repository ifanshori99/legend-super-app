import { createFileRoute } from "@tanstack/react-router";
import { CampaignDetailPage } from "@/features/ws08-crm-campaigns/components/campaign-detail-page";
import { CampaignsPage } from "@/features/ws08-crm-campaigns/components/campaign-shell";
import { campaignGuard } from "@/features/ws08-crm-campaigns/guard";
import { isMockScenarioRequest } from "@/features/ws08-crm-campaigns/lib";
import {
  campaignResultsQuery,
  campaignsQuery,
} from "@/features/ws08-crm-campaigns/queries";

// A campaign id is a UUID-in-uuid; anything else cannot have results, so the
// loader skips that call and the page renders its "not found" state instead of
// a validation error from the results endpoint.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /kelola/kampanye/$campaignId — one campaign: status, content, A/B split,
// audience, legal actions and results (PRD §3.21 "Kampanye"; LOY-04). The
// segment name is read in the browser after hydration: a slow or absent
// segment endpoint must not block the campaign itself.
export const Route = createFileRoute("/_kelola/kelola/kampanye/$campaignId")({
  beforeLoad: campaignGuard(["campaign.manage"]),
  loader: ({ context, location, params }) => {
    if (isMockScenarioRequest(location.searchStr)) return undefined;
    return Promise.all([
      context.queryClient.ensureQueryData(campaignsQuery()),
      ...(UUID.test(params.campaignId)
        ? [
            context.queryClient.ensureQueryData(
              campaignResultsQuery(params.campaignId),
            ),
          ]
        : []),
    ]);
  },
  component: CampaignDetailScreen,
});

function CampaignDetailScreen() {
  const { campaignId } = Route.useParams();
  return (
    <CampaignsPage active="campaigns">
      <CampaignDetailPage campaignId={campaignId} />
    </CampaignsPage>
  );
}
