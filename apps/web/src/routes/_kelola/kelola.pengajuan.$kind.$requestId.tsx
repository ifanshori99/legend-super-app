import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { requestQueueGuard } from "@/features/hris-requests/components/queue-guard";
import { QueueDetailPage } from "@/features/hris-requests/components/queue-detail-page";

const t = createTranslator();

// /kelola/pengajuan/$kind/$requestId — decision on one request (bead
// legend-ydf2). Reads in the browser, so there is no route loader.
export const Route = createFileRoute(
  "/_kelola/kelola/pengajuan/$kind/$requestId",
)({
  beforeLoad: requestQueueGuard(),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("hrisRequestsQueue.page.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: QueueDetailRoute,
});

function QueueDetailRoute() {
  const { kind, requestId } = Route.useParams();
  return <QueueDetailPage kind={kind} requestId={requestId} />;
}
