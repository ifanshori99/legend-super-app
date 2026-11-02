// Online menu page (PRD v1.7 §3.24 "Menu Online"): the full menu with photos
// and prices, no ordering from outside the cafe in the first release. Prices
// come from the outlet price list and exclude tax and service charge (owner
// decision, 1 Nov 2026), so the disclosure sits above the list and every
// sold-out item says so instead of disappearing.
import { useMemo, useState } from "react";
import { Ban, Search } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import type {
  PublicMenuPage,
  PublicMenuItem,
  PublicMenuSection,
  PublicSite,
} from "@starter/shared/website";
import { formatIsoDate } from "../lib/hours.ts";
import { PriceNote, SectionHeading, SiteSection } from "./blocks.tsx";
import { SiteFrame } from "./site-frame.tsx";
import { SiteImage } from "./site-image.tsx";

function matchesQuery(item: PublicMenuItem, query: string): boolean {
  const haystack = `${item.name} ${item.description}`.toLowerCase();
  return haystack.includes(query);
}

function MenuItemRow({ item }: { item: PublicMenuItem }) {
  const t = useT();
  return (
    <li className="flex items-start gap-4 py-4">
      {item.imageUrl && (
        <SiteImage
          src={item.imageUrl}
          alt={item.name}
          className="size-20 shrink-0 rounded-lg"
        />
      )}
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base leading-6 font-semibold">{item.name}</h3>
          {item.labels.map((label) => (
            <Badge key={label} tone="brand">
              {label}
            </Badge>
          ))}
          {!item.isAvailable && (
            <Badge tone="warning">
              <Ban aria-hidden="true" />
              {t("website.common.soldOut")}
            </Badge>
          )}
        </div>
        {item.description && (
          <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">
            {item.description}
          </p>
        )}
        {item.allergens.length > 0 && (
          <p className="text-xs leading-4 text-muted-foreground">
            {t("website.menu.allergens", { list: item.allergens.join(", ") })}
          </p>
        )}
      </div>
      <Money
        amount={item.priceIdr}
        className={
          item.isAvailable
            ? "shrink-0 text-base font-semibold"
            : "shrink-0 text-base font-semibold text-muted-foreground"
        }
      />
    </li>
  );
}

function MenuSectionBlock({
  section,
  index,
  query,
}: {
  section: PublicMenuSection;
  index: number;
  query: string;
}) {
  const t = useT();
  const items = query
    ? section.items.filter((item) => matchesQuery(item, query))
    : section.items;
  if (query && items.length === 0) return null;
  const id = `menu-section-${index}`;
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="grid gap-1">
      <h2
        id={`${id}-title`}
        className="text-xl font-semibold tracking-tight"
      >
        {section.name}
      </h2>
      {section.description && (
        <p className="text-sm leading-6 text-muted-foreground">
          {section.description}
        </p>
      )}
      {items.length > 0 ? (
        <ul className="mt-1 divide-y divide-border border-t-(length:--border-w)">
          {items.map((item) => (
            <MenuItemRow key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <p className="py-4 text-sm text-muted-foreground">
          {t("website.menu.sectionEmpty")}
        </p>
      )}
    </section>
  );
}

export function MenuPage({
  site,
  page,
}: {
  site: PublicSite;
  page: PublicMenuPage;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const itemCount = useMemo(
    () =>
      page.sections.reduce(
        (total, section) => total + section.items.length,
        0,
      ),
    [page.sections],
  );
  const visibleCount = useMemo(
    () =>
      page.sections.reduce(
        (total, section) =>
          total +
          section.items.filter(
            (item) => !query || matchesQuery(item, query),
          ).length,
        0,
      ),
    [page.sections, query],
  );

  return (
    <SiteFrame site={site}>
      <SiteSection className="pb-6">
        <div className="grid gap-3">
          <h1 className="font-brand text-3xl leading-tight font-bold tracking-tight sm:text-4xl">
            {t("website.menu.title")}
          </h1>
          <p className="text-lg leading-7 text-muted-foreground">
            {t("website.menu.lead", { brand: site.brand.name })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("website.menu.updatedAt", {
              date: formatIsoDate(page.updatedAt),
            })}
          </p>
          <PriceNote />
        </div>
      </SiteSection>

      {itemCount === 0 ? (
        <SiteSection className="pt-0">
          <EmptyState
            title={t("website.menu.emptyTitle")}
            description={t("website.menu.emptyHint")}
          />
        </SiteSection>
      ) : (
        <>
          <SiteSection className="py-4">
            <div className="grid max-w-md gap-1.5">
              <Label htmlFor="menu-search">{t("website.menu.searchLabel")}</Label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="menu-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("website.menu.searchPlaceholder")}
                  className="pl-9"
                  autoComplete="off"
                />
              </div>
            </div>
            <nav aria-label={t("website.menu.sectionsNav")} className="mt-4">
              <ul className="flex flex-wrap gap-2">
                {page.sections.map((section, index) => (
                  <li key={section.id}>
                    <a
                      href={`#menu-section-${index}`}
                      className="inline-flex min-h-11 items-center rounded-full border-(length:--border-w) border-input px-3 text-sm font-medium text-foreground transition-colors duration-(--duration-fast) hover:bg-accent"
                    >
                      {section.name}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </SiteSection>

          <SiteSection className="grid gap-10 pt-2">
            {visibleCount === 0 ? (
              <EmptyState
                title={t("website.menu.noResultsTitle")}
                description={t("website.menu.noResultsHint")}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSearch("")}
                  >
                    {t("website.menu.noResultsAction")}
                  </Button>
                }
              />
            ) : (
              page.sections.map((section, index) => (
                <MenuSectionBlock
                  key={section.id}
                  section={section}
                  index={index}
                  query={query}
                />
              ))
            )}
          </SiteSection>
        </>
      )}
    </SiteFrame>
  );
}
