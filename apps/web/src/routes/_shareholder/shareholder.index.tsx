import { createFileRoute } from "@tanstack/react-router";
import { AreaIndexPage } from "@/components/layout/area-index-page";

export const Route = createFileRoute("/_shareholder/shareholder/")({
  component: () => <AreaIndexPage area="shareholder" headingLevel={2} />,
});
