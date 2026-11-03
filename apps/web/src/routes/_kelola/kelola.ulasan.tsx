import { createFileRoute } from "@tanstack/react-router";
import { CrmPage } from "@/features/ws08-crm-360/components/crm-shell";
import { FeedbackPage } from "@/features/ws08-crm-360/components/feedback-page";
import { crm360Guard } from "@/features/ws08-crm-360/guard";

// /kelola/ulasan — reviews & complaints queue (PRD v1.7 §3.21 "Ulasan &
// Keluhan", AI-11). The queue is actionable for review.respond; a reader with
// only crm.customer.view may still read it (the API decides per request).
// No loader: feedback comments are PII-bearing and must not enter the SSR
// document; `?mock=empty|error|offline` also has to reach the browser fetch.
export const Route = createFileRoute("/_kelola/kelola/ulasan")({
  beforeLoad: crm360Guard(["review.respond", "crm.customer.view"]),
  component: FeedbackScreen,
});

function FeedbackScreen() {
  return (
    <CrmPage active="feedback">
      <FeedbackPage />
    </CrmPage>
  );
}
