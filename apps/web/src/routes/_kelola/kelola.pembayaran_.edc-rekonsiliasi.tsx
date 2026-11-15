import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  EdcReconciliationPage,
  QUEUE_STATUS_FILTERS,
} from "@/features/edc-reconciliation/components/queue-page";
import { edcReconciliationGuard } from "@/features/edc-reconciliation/guard";
import { edcReconciliationQueueQuery } from "@/features/edc-reconciliation/queries";
import { isMockScenarioRequest } from "@/features/ws05-payment-admin/lib";
import { API_MOCK } from "@/lib/api/mock-flag";

// /kelola/pembayaran/edc-rekonsiliasi — flagged EDC transactions that need a
// human decision (legend-khi8n). The trailing underscore in the file name keeps
// this page out of the payment back office layout. `tx` selects the open row;
// the filters live in the URL too. A malformed part falls back to "not set".
const shortSearch = (max: number) =>
  z.string().trim().min(1).max(max).optional().catch(undefined);

export const Route = createFileRoute(
  "/_kelola/kelola/pembayaran_/edc-rekonsiliasi",
)({
  validateSearch: z.object({
    tx: shortSearch(64),
    outletId: shortSearch(64),
    // Same three values as the page filter, so the loader prefetches what the
    // page asks for; anything else falls back to "not set".
    status: z.enum(QUEUE_STATUS_FILTERS).optional().catch(undefined),
    q: shortSearch(100),
  }),
  beforeLoad: edcReconciliationGuard,
  loaderDeps: ({ search }) => ({
    outletId: search.outletId,
    status: search.status,
    q: search.q,
  }),
  // Mock mode serves the clickable demo: let the browser fetch so ?mock=empty
  // and ?mock=error apply instead of hydrating the server's fixture render.
  // The list is prefetched, not ensured: a failure shows in the page's own
  // error state instead of replacing the whole screen.
  loader: ({ context, location, deps }) =>
    API_MOCK || isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.prefetchQuery(edcReconciliationQueueQuery(deps)),
  component: EdcReconciliationPage,
});
