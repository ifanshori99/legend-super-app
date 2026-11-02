// Online menu page (PRD v1.7 §3.24 "Menu Online"): the full menu with photos
// and prices, no ordering from outside the cafe in the first release. Prices
// come from the outlet price list and exclude tax and service charge (owner
// decision, 1 Nov 2026), so the disclosure sits above the list and every
// sold-out item says so instead of disappearing.
//
// v3 (DESIGN.md §4/§5): photo-first rows (MediaPlate list thumb), ink tab
// track for the sections, search on a `surface-2` toolbar band.
import { useMemo, useState } from "react";
import { Ban, BookOpen, Search } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import type {
  PublicMenuPage,
  PublicMenuItem,
  PublicMenuSection,
  PublicSite,
} from "@starter/shared/website";
import { API_MOCK } from "@/lib/api/mock-flag.ts";
import { demoMenuPhoto } from "../lib/demo-media.ts";
import { formatIsoDate } from "../lib/hours.ts";
import { PriceNote, SiteSection } from "./blocks.tsx";
import { SiteFrame } from "./site-frame.tsx";

function matchesQuery(item: PublicMenuItem, query: string): boolean {
  const haystack = `${item.name} ${item.description}`.toLowerCase();
  return haystack.includes(query);
}

function MenuItemRow({ item }: { item: PublicMenuItem }) {
  const t = useT();
  const src = demoMenuPhoto(item.name) ?? item.imageUrl;
  return (
    <li className="flex items-start gap-4 py-4">
      <MediaPlate
        src={src}
        alt={item.name}
        ratio="card"
        muted={!item.isAvailable}
        className="size-18 shrink-0"
      />
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
        className={cn(
          "shrink-0 text-base font-semibold",
          !item.isAvailable && "text-muted-foreground",
        )}
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
      <h2 id={`${id}-title`} className="type-title">
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
  signedIn,
}: {
  site: PublicSite;
  page: PublicMenuPage;
  signedIn: boolean;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const itemCount = useMemo(
    () =>
      page.sections.reduce((total, section) => total + section.items.length, 0),
    [page.sections],
  );
  const visibleCount = useMemo(
    () =>
      page.sections.reduce(
        (total, section) =>
          total +
          section.items.filter((item) => !query || matchesQuery(item, query))
            .length,
        0,
      ),
    [page.sections, query],
  );

  return (
    <SiteFrame site={site} signedIn={signedIn}>
      <SiteSection innerClassName="pb-4">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="type-display-xl">{t("website.menu.title")}</h1>
            {API_MOCK && <Badge>{t("common.sampleData")}</Badge>}
          </div>
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
        <SiteSection innerClassName="pt-0">
          <EmptyState
            icon={BookOpen}
            title={t("website.menu.emptyTitle")}
            description={t("website.menu.emptyHint")}
          />
        </SiteSection>
      ) : (
        <>
          <SiteSection band innerClassName="py-5">
            <div className="grid gap-3">
              <div className="grid max-w-md gap-1.5">
                <Label htmlFor="menu-search">
                  {t("website.menu.searchLabel")}
                </Label>
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
                    className="bg-card pl-9"
                    autoComplete="off"
                  />
                </div>
              </div>
              <nav aria-label={t("website.menu.sectionsNav")}>
                <ul className={tabsListClass}>
                  {page.sections.map((section, index) => (
                    <li key={section.id}>
                      <a
                        href={`#menu-section-${index}`}
                        className={tabsTriggerClass}
                      >
                        {section.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          </SiteSection>

          <SiteSection innerClassName="grid items-start gap-10 pt-8 lg:grid-cols-2 lg:gap-x-12 lg:gap-y-12">
            {visibleCount === 0 ? (
              <EmptyState
                icon={Search}
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
