import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { PosOfflineShell } from "@/features/ws04-pos-kasir/offline/shell-screen";

// "/pos-offline": the offline POS shell (bead legend-wasr7.7, re-review O3
// P1). Outside every area on purpose: the service worker fetches it without
// cookies, so the `_ops` guard would send it to sign-in. It loads no data and
// the anonymous render carries no session, so this browser may keep it
// (`no-cache`: revalidated when online); `private` keeps shared caches out
// in case a signed-in visit renders it with a session.
const t = createTranslator();

export const Route = createFileRoute("/pos-offline")({
  headers: () => ({ "Cache-Control": "private, no-cache" }),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("posOffline.shell.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PosOfflineShell,
});
