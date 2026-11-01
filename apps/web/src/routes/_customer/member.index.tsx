import { createFileRoute } from "@tanstack/react-router";
import { AreaIndexPage } from "@/components/layout/area-index-page";

export const Route = createFileRoute("/_customer/member/")({
  component: () => <AreaIndexPage area="customer" />,
});
