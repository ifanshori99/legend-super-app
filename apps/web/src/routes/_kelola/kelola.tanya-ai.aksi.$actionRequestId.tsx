import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { ActionDetailPage } from "@/features/ws12-ai-action/components/action-detail-page";
import { accessGuard } from "@/features/ws01-access/guard";

const t = createTranslator();

// /kelola/tanya-ai/aksi/<actionRequestId> — one AI action request: the draft,
// its status and the way into the approval inbox (bead legend-jk6s). Whoever
// may ask the AI or review approvals can open it; the API re-checks every read.
export const Route = createFileRoute(
  "/_kelola/kelola/tanya-ai/aksi/$actionRequestId",
)({
  beforeLoad: accessGuard([
    "ai.ask",
    "ai.action.propose",
    "approval.inbox.view",
  ]),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("aiAction.pageTitle"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ActionDetailScreen,
});

function ActionDetailScreen() {
  const { access } = Route.useRouteContext();
  const { actionRequestId } = Route.useParams();
  return <ActionDetailPage actionRequestId={actionRequestId} access={access} />;
}
