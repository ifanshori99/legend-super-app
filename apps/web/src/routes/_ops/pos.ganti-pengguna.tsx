import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { SwitchUserScreen } from "@/features/ws01-device-pin/components/switch-user-screen";

// /pos/ganti-pengguna: switch the working staff member with a personal
// 6-digit PIN (bead legend-6ew; PRD v1.7 §3 F6 "PIN Perangkat"). The area
// layout already gates the shell; the API verifies the PIN.
export const Route = createFileRoute("/_ops/pos/ganti-pengguna")({
  head: () => {
    const t = createTranslator();
    return {
      meta: [
        {
          title: t("app.titleTemplate", {
            page: t("devicePin.pageTitle"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: () => <SwitchUserScreen shell="pos" />,
});
