import { createFileRoute } from "@tanstack/react-router";
import { AreaIndexPage } from "@/components/layout/area-index-page";

export const Route = createFileRoute("/_kitchen/kds/")({
  component: () => <AreaIndexPage area="kitchen" headingLevel={1} />,
});
