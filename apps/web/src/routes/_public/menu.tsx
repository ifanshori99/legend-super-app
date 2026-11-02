import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { MenuPage } from "@/features/ws08-website/components/menu-page";
import {
  WebsiteError,
  WebsitePending,
} from "@/features/ws08-website/components/states";
import { usePublicMenuPage, usePublicSite } from "@/features/ws08-website/hooks";
import { menuHead } from "@/features/ws08-website/lib/seo";
import {
  publicMenuPageQuery,
  publicSiteQuery,
} from "@/features/ws08-website/queries";

const t = createTranslator();

// "/menu" — online menu (PRD v1.7 §3.24 "Menu Online"): the full menu with
// photos and prices, no ordering from outside the cafe in the first release.
// The head carries the Menu JSON-LD; the page carries the tax/service note.
export const Route = createFileRoute("/_public/menu")({
  loader: async ({ context }) => {
    const [site, page] = await Promise.all([
      context.queryClient.ensureQueryData(publicSiteQuery()),
      context.queryClient.ensureQueryData(publicMenuPageQuery()),
    ]);
    return { site, page };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { site, page } = loaderData;
    const brand = site.brand.name;
    return menuHead(site, page, {
      title: t("website.seo.menuTitle", { brand }),
      description: t("website.seo.menuDescription", { brand }),
      jsonLdName: t("website.menu.jsonLdName", { brand }),
    });
  },
  pendingComponent: WebsitePending,
  errorComponent: WebsiteError,
  component: Menu,
});

function Menu() {
  const site = usePublicSite();
  const page = usePublicMenuPage();
  return <MenuPage site={site} page={page} />;
}
