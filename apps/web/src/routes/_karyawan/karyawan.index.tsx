import { createFileRoute } from "@tanstack/react-router";
import { AreaIndexPage } from "@/components/layout/area-index-page";

export const Route = createFileRoute("/_karyawan/karyawan/")({
  component: () => <AreaIndexPage area="karyawan" headingLevel={1} />,
});
