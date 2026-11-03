import { createFileRoute } from "@tanstack/react-router";
import { CrmPage } from "@/features/ws08-crm-360/components/crm-shell";
import { SegmentsPage } from "@/features/ws08-crm-360/components/segments-page";
import { crm360Guard } from "@/features/ws08-crm-360/guard";

// /kelola/pelanggan/segmen — dynamic segment builder (PRD v1.7 §3.21
// "Segmentasi", LOY-04). No loader: the saved list and the live preview are
// client queries, and `?mock=empty|error|offline` must reach the browser.
export const Route = createFileRoute("/_kelola/kelola/pelanggan/segmen")({
  beforeLoad: crm360Guard(["crm.customer.view"]),
  component: SegmentsScreen,
});

function SegmentsScreen() {
  return (
    <CrmPage active="segments">
      <SegmentsPage />
    </CrmPage>
  );
}
