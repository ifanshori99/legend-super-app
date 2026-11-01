import { createFileRoute } from "@tanstack/react-router";
import { AreaIndexPage } from "@/components/layout/area-index-page";

export const Route = createFileRoute("/_ops/pos/")({
  component: () => <AreaIndexPage area="ops" headingLevel={1} />,
});
