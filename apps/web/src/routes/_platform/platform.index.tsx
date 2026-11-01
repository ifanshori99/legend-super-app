import { createFileRoute } from "@tanstack/react-router";
import { AreaIndexPage } from "@/components/layout/area-index-page";

export const Route = createFileRoute("/_platform/platform/")({
  component: () => <AreaIndexPage area="platform" headingLevel={2} />,
});
