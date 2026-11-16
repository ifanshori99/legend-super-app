// DESIGN.md v2 direction board (bead legend-6be7, PRD D42): before/after
// for the customer, operations, and management surfaces, built from the
// v2 tokens on labeled sample data. Linkable state:
//   ?surface=customer|ops|management   one surface (default: all)
//   ?view=both|before|after            which stage(s) to show
//   ?tenant=base|cafe-legend           tenant theme for the AFTER stage
//   ?bare=1                            hide the control bar (screenshots)
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createTranslator } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { cafeLegendTheme } from "@starter/shared/theme";
import { ThemeScope } from "@/components/theme-scope";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Badge } from "@/components/ui/badge";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { CustomerCompare } from "@/components/design-system/v2/customer";
import { ManagementCompare } from "@/components/design-system/v2/management";
import { OpsCompare } from "@/components/design-system/v2/ops";
import type { CompareView } from "@/components/design-system/v2/frame";
import { TenantThemeStyle } from "@/lib/theme";

const t = createTranslator();

const TENANT_THEMES = [cafeLegendTheme];
const SURFACES = ["customer", "ops", "management"] as const;
type Surface = (typeof SURFACES)[number];

const searchSchema = z.object({
  surface: z.enum(SURFACES).optional().catch(undefined),
  view: z.enum(["both", "before", "after"]).optional().catch(undefined),
  tenant: z.string().max(64).optional().catch(undefined),
  bare: z.coerce.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_platform/platform/design-system/v2")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: t("designV2.route.pageTitle") },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DesignV2Page,
});

const SURFACE_META: Record<
  Surface,
  { id: string; title: `designV2.route.${Surface}` }
> = {
  customer: { id: "pelanggan", title: "designV2.route.customer" },
  ops: { id: "operasional", title: "designV2.route.ops" },
  management: { id: "manajemen", title: "designV2.route.management" },
};

function DesignV2Page() {
  const t = useT();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const view: CompareView = search.view ?? "both";
  // Default to the Cafe Legend placeholder: the accent ramp is derived from
  // the tenant primary, so the AFTER stage needs a tenant to show it.
  const tenantId =
    search.tenant === "base"
      ? undefined
      : (
          TENANT_THEMES.find((theme) => theme.id === search.tenant) ??
          cafeLegendTheme
        ).id;
  const surfaces = search.surface ? [search.surface] : SURFACES;
  const set = (next: Partial<z.infer<typeof searchSchema>>) =>
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
      <ThemeScope density="hangat" className="min-h-dvh bg-background">
        {!search.bare && (
          <header className="z-40 border-b bg-background md:sticky md:top-0">
            <div
              role="group"
              aria-label={t("designV2.route.controls")}
              className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-3 px-gutter py-3"
            >
              <ThemeSwitcher />
              <SegmentedControl<CompareView>
                label={t("designV2.route.view")}
                value={view}
                onValueChange={(value) => set({ view: value })}
                options={[
                  { value: "both", label: t("designV2.route.both") },
                  { value: "before", label: t("designV2.route.before") },
                  { value: "after", label: t("designV2.route.after") },
                ]}
              />
              <SegmentedControl<string>
                label={t("designV2.route.tenant")}
                value={tenantId ?? "base"}
                onValueChange={(value) => set({ tenant: value })}
                options={[
                  { value: "base", label: t("designV2.route.base") },
                  ...TENANT_THEMES.map((theme) => ({
                    value: theme.id,
                    label: theme.name,
                  })),
                ]}
              />
            </div>
          </header>
        )}
        <div className="mx-auto grid max-w-[1440px] gap-16 px-gutter pt-8 pb-16">
          <div className="grid max-w-3xl gap-3">
            <p className="type-eyebrow text-muted-foreground">
              {t("designV2.route.eyebrow")}
            </p>
            <h1 className="type-display-xl">{t("designV2.route.title")}</h1>
            <p className="text-lg text-muted-foreground">
              {t("designV2.route.intro")}
            </p>
            <Badge tone="warning">{t("designV2.route.sample")}</Badge>
          </div>
          {surfaces.map((surface) => (
            <section
              key={surface}
              id={SURFACE_META[surface].id}
              aria-labelledby={`${SURFACE_META[surface].id}-title`}
              className="grid gap-6"
            >
              <h2
                id={`${SURFACE_META[surface].id}-title`}
                className="type-display border-b pb-3"
              >
                {t(SURFACE_META[surface].title)}
              </h2>
              {surface === "customer" && (
                <CustomerCompare view={view} tenant={tenantId} />
              )}
              {surface === "ops" && (
                <OpsCompare view={view} tenant={tenantId} />
              )}
              {surface === "management" && (
                <ManagementCompare view={view} tenant={tenantId} />
              )}
            </section>
          ))}
        </div>
      </ThemeScope>
    </>
  );
}
