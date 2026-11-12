import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { requestQueueGuard } from "@/features/hris-requests/components/queue-guard";
import { QueuePage } from "@/features/hris-requests/components/queue-page";

const t = createTranslator();

// /kelola/pengajuan — supervisor queue of shift, leave and overtime requests
// (bead legend-ydf2). Reads in the browser (outlet from the shell), so there is
// no route loader.
export const Route = createFileRoute("/_kelola/kelola/pengajuan/")({
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
  component: QueuePage,
});
