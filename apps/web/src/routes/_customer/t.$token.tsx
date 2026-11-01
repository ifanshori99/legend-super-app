import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { menuQuery } from "@/features/ws03-qr-order/queries";

const t = createTranslator();

// "/t/[token]" — table QR session (PRD §5: dynamic SSR, Cache-Control private,
// noindex via the customer area). The token is opaque; the API resolves it to
// a table, zone and the tenant (TEN-02): the page trusts nothing in it. The
// menu is fetched on the server so the first paint already lists the dishes.
// The shell (brand, table context, bottom nav) is TableCustomerFrame, which
// AreaFrame renders for every /t/$token/* page.
export const Route = createFileRoute("/_customer/t/$token")({
  headers: () => ({ "Cache-Control": "private, no-store" }),
  loader: async ({ context, params }) => {
    try {
      const menu = await context.queryClient.ensureQueryData(
        menuQuery(params.token),
      );
      return { outletName: menu.data.outlet.name };
    } catch {
      // Unknown QR or API down: the page shows the matching state client-side.
      return { outletName: null };
    }
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.outletName
          ? t("qrMenu.head.title", { outlet: loaderData.outletName })
          : t("qrMenu.head.notFoundTitle"),
      },
    ],
  }),
  component: Outlet,
});
