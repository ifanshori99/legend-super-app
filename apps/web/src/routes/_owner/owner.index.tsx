import { createFileRoute } from "@tanstack/react-router";
import { AreaIndexPage } from "@/components/layout/area-index-page";

export const Route = createFileRoute("/_owner/owner/")({
  component: () => <AreaIndexPage area="owner" headingLevel={2} />,
});
