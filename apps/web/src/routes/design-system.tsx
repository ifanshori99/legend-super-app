// Design System Platform showcase (WS-00). Renders every token, component,
// state, both color modes, all three densities, and the app shells.
// ?density=hangat|kontras|padat and ?tenant=base|cafe-legend are linkable.
import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import {
  DENSITIES,
  cafeLegendTheme,
  failingThemeExample,
  type Density,
} from "@starter/shared/theme";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Badge } from "@/components/ui/badge";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ComponentGallery } from "@/components/design-system/component-gallery";
import {
  DensitiesSection,
  ShellsSection,
} from "@/components/design-system/previews";
import {
  ColorsSection,
  ShapeSection,
  TypographySection,
} from "@/components/design-system/token-sections";
import { API_MOCK } from "@/lib/api/mock-flag";
import { TenantThemeStyle } from "@/lib/theme";

// Tenant Themes available to preview. Configs come from data, never from a
// branch on a tenant id (PRD R27 / D44).
const TENANT_THEMES = [cafeLegendTheme];
const BASE = "base";

const searchSchema = z.object({
  density: z.enum(DENSITIES).optional().catch(undefined),
  tenant: z.string().max(64).optional().catch(undefined),
});

export const Route = createFileRoute("/design-system")({
  validateSearch: searchSchema,
  // Developer showcase: it names the platform, so a production build serves it
  // on no tenant domain (TEN-08). The mock-mode build keeps it for e2e.
  beforeLoad: () => {
    if (import.meta.env.PROD && !API_MOCK) throw notFound();
  },
  head: () => ({
    meta: [{ title: "Design System" }, { name: "robots", content: "noindex" }],
  }),
  component: DesignSystemPage,
});

const SECTIONS = [
  ["warna", "colors"],
  ["tipografi", "typography"],
  ["bentuk", "shape"],
  ["komponen", "components"],
  ["kepadatan", "densities"],
  ["shell", "shells"],
] as const;

function DesignSystemPage() {
  const t = useT();
  const search = Route.useSearch();
  const density: Density = search.density ?? "hangat";
  const tenantConfig =
    TENANT_THEMES.find((theme) => theme.id === search.tenant) ?? null;
  const tenant = tenantConfig?.id ?? BASE;
  const navigate = Route.useNavigate();
  const set = (next: Partial<{ density: Density; tenant: string }>) =>
    navigate({
      search: (prev) => ({ ...prev, ...next }),
      replace: true,
      resetScroll: false,
    });

  return (
    <>
      {TENANT_THEMES.map((theme) => (
        <TenantThemeStyle key={theme.id} tenant={theme} />
      ))}
      <ThemeScope
        density={density}
        tenant={tenantConfig?.id}
        className="min-h-dvh"
      >
        <header className="z-40 border-b bg-background md:sticky md:top-0">
          <div
            role="group"
            aria-label={t("designSystem.controls")}
            className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-gutter py-3"
          >
            <ThemeSwitcher />
            <SegmentedControl<string>
              label={t("theme.tenant")}
              value={tenant}
              onValueChange={(value) => set({ tenant: value })}
              options={[
                { value: BASE, label: t("theme.base") },
                ...TENANT_THEMES.map((theme) => ({
                  value: theme.id,
                  label: theme.name,
                })),
              ]}
            />
            <SegmentedControl<Density>
              label={t("density.label")}
              value={density}
              onValueChange={(value) => set({ density: value })}
              options={DENSITIES.map((d) => ({
                value: d,
                label: t(`density.${d}`),
              }))}
            />
          </div>
          <nav
            aria-label={t("designSystem.title")}
            className="mx-auto max-w-7xl overflow-x-auto px-gutter"
          >
            <ul className="flex gap-1 pb-2">
              {SECTIONS.map(([id, key]) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="inline-flex min-h-10 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {t(`designSystem.sections.${key}`)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </header>

        <main id="main-content" className="mx-auto max-w-7xl px-gutter pb-16">
          <div className="max-w-3xl py-10">
            <h1 className="text-3xl leading-9 font-bold tracking-tight sm:text-4xl sm:leading-11">
              {t("designSystem.title")}
            </h1>
            <p className="mt-3 text-lg leading-7 text-muted-foreground">
              {t("designSystem.intro")}
            </p>
            {tenantConfig?.placeholder && (
              <p className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="warning">{t("theme.placeholder")}</Badge>
                {t("designSystem.tenantNote")}
              </p>
            )}
          </div>
          <ColorsSection
            tenant={tenantConfig}
            density={density}
            failingExample={failingThemeExample}
          />
          <TypographySection />
          <ShapeSection />
          <ComponentGallery />
          <DensitiesSection />
          <ShellsSection />
        </main>
      </ThemeScope>
    </>
  );
}
