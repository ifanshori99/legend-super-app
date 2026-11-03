import { createFileRoute, notFound } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { FoodSafetyTemperatureScreen } from "@/features/operations-food-safety/components/suhu-screen";
import { evaluateGuard } from "@/lib/areas/guard";

// /operasional/suhu — food-safety temperature log (bead legend-d983; PRD v1.7
// §3 F41 "Log Keamanan Pangan", OPS-02). Presentation-only guard; the API
// re-checks the permission and the corrective-action rule.
export const Route = createFileRoute("/_ops/operasional/suhu")({
  beforeLoad: ({ context }) => {
    const gate = evaluateGuard(
      {
        kind: "permission",
        surface: "pos",
        anyOf: ["ops.food_safety.log"],
      },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  },
  head: () => {
    const t = createTranslator();
    return {
      meta: [
        {
          title: t("app.titleTemplate", {
            page: t("opsFoodSafety.temperature.title"),
            brand: t("app.defaultBrand"),
          }),
        },
        { name: "robots", content: "noindex" },
      ],
    };
  },
  component: TemperaturePage,
});

function TemperaturePage() {
  return <FoodSafetyTemperatureScreen />;
}
