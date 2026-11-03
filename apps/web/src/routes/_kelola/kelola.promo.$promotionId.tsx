import { createFileRoute } from "@tanstack/react-router";
import { PromoEditorPage } from "@/features/ws08-promo/components/promo-editor-page";
import { PromoPage } from "@/features/ws08-promo/components/promo-shell";
import { promoGuard } from "@/features/ws08-promo/guard";
import { isMockScenarioRequest } from "@/features/ws08-promo/lib";
import {
  menuItemsQuery,
  promotionsQuery,
  stackingPolicyQuery,
  tiersQuery,
} from "@/features/ws08-promo/queries";

// /kelola/promo/$promotionId — the rule builder for one promotion. `baru`
// opens the create form (same convention as /kelola/menu/baru).
export const Route = createFileRoute("/_kelola/kelola/promo/$promotionId")({
  beforeLoad: promoGuard(["promo.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : Promise.all([
          context.queryClient.ensureQueryData(promotionsQuery()),
          context.queryClient.ensureQueryData(stackingPolicyQuery()),
          context.queryClient.ensureQueryData(menuItemsQuery()),
          context.queryClient.ensureQueryData(tiersQuery()),
        ]),
  component: PromoEditorScreen,
});

function PromoEditorScreen() {
  const { promotionId } = Route.useParams();
  return (
    <PromoPage active="promos">
      <PromoEditorPage promotionId={promotionId} />
    </PromoPage>
  );
}
