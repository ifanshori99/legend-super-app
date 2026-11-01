import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { EmptyState } from "@/components/ui/feedback-state";
import { AREAS, type AreaKey } from "@/lib/areas/definitions";
import { reachableWorkAreas } from "@/lib/areas/guard";
import type { AreaAccess } from "@/lib/areas/access";
import { AREA_ICONS } from "@/components/layout/area-icons";

/**
 * Placeholder landing page of an area: an honest empty state, no sample data.
 * Feature beads replace it with the real screen (docs/frontend.md).
 */
export function AreaIndexPage({
  area,
  headingLevel = 1,
}: {
  area: AreaKey;
  /** 1 when the shell has no page title of its own, 2 when it does. */
  headingLevel?: 1 | 2;
}) {
  const t = useT();
  const definition = AREAS[area];
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section aria-labelledby={`${area}-index-title`}>
      <Heading className="sr-only" id={`${area}-index-title`}>
        {t(definition.nameKey)}
      </Heading>
      <EmptyState
        icon={AREA_ICONS[area]}
        title={t(definition.emptyTitleKey)}
        description={t(definition.emptyHintKey)}
      />
    </section>
  );
}

/** Links to the work areas this visitor can open (from their real access). */
export function ReachableAreas({ access }: { access: AreaAccess }) {
  const t = useT();
  const areas = reachableWorkAreas(access);
  if (areas.length === 0) return null;
  return (
    <nav aria-label={t("area.reachable")} className="mt-6 grid gap-3">
      <h2 className="text-lg leading-7 font-semibold">
        {t("area.reachable")}
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {areas.map((definition) => {
          const Icon = AREA_ICONS[definition.key];
          return (
            <li key={definition.key}>
              <Link
                to={definition.indexPath as "/"}
                className="flex min-h-control items-center gap-3 rounded-card border-(length:--border-w) bg-card px-4 py-3 font-medium transition-colors hover:bg-accent"
              >
                <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
                {t(definition.nameKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
