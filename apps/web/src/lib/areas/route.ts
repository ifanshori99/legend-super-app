// Shared pieces of the area route files: the guard run in beforeLoad and the
// <head> every area sets. Presentation only; the API enforces access.
import { redirect } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import type { AreaAccess } from "./access.ts";
import { AREAS, type AreaGuard, type AreaKey } from "./definitions.ts";
import { evaluateGuard } from "./guard.ts";

/**
 * Signed-out visitors go to sign-in. Everything else (no permission, second
 * factor missing) is returned as `gate` so the layout can explain it instead
 * of redirecting to a page that may not exist yet.
 */
export function runGuard(guard: AreaGuard, access: AreaAccess) {
  const gate = evaluateGuard(guard, access);
  if (gate.status === "unauthenticated") throw redirect({ to: "/sign-in" });
  return { gate };
}

const t = createTranslator();

/** Title plus robots noindex for areas PRD §5 marks "Diindeks: Tidak". */
export function areaHead(area: AreaKey) {
  const definition = AREAS[area];
  return {
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t(definition.nameKey),
          brand: t("app.defaultBrand"),
        }),
      },
      ...(definition.noindex
        ? [{ name: "robots", content: "noindex" }]
        : []),
    ],
  };
}
