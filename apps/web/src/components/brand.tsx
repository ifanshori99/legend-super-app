import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Layers2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { publicSiteQuery } from "@/features/ws08-website/queries";

// Tenant brand when the host is a recognized tenant, otherwise the catalog
// brand. The starter name never shows (legend-240kd). Not suspense: an
// unrecognized host makes the site call fail and must still render the page.
export function Brand() {
  const t = useT();
  const { data } = useQuery({ ...publicSiteQuery(), retry: false });
  const name = data?.brand.name ?? t("app.defaultBrand");
  return (
    <Link
      to="/"
      className="inline-flex items-center gap-2.5 rounded-sm font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      aria-label={name}
    >
      <span className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
        <Layers2 className="size-4" aria-hidden="true" />
      </span>
      <span>{name}</span>
    </Link>
  );
}
