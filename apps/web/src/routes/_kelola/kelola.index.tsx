import { createFileRoute } from "@tanstack/react-router";
import { AreaIndexPage } from "@/components/layout/area-index-page";

export const Route = createFileRoute("/_kelola/kelola/")({
  component: () => <AreaIndexPage area="kelola" headingLevel={2} />,
});
