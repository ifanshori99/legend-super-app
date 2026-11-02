// Brand home page (PRD v1.7 §3.24 "Beranda"): cafe profile, photos, opening
// hours, location with a map link, featured menu and promos, plus the two
// entries the PRD names — reservation and member. v3 (DESIGN.md §5): page
// tone, one `surface-2` band for the featured menu, photo-first cards.
import { Link } from "@tanstack/react-router";
import { Clock, MapPin, TicketPercent, UtensilsCrossed } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardShell,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import type { PublicSite } from "@starter/shared/website";
import { API_MOCK } from "@/lib/api/mock-flag.ts";
import {
  demoGalleryPhotos,
  demoHeroPhoto,
  demoMenuPhoto,
} from "../lib/demo-media.ts";
import { formatBusinessDate, formatHoursRange } from "../lib/hours.ts";
import {
  AddressBlock,
  MemberEntryCard,
  OpeningHoursList,
  PriceNote,
  SectionHeading,
  SiteSection,
  WhatsAppLink,
} from "./blocks.tsx";
import { SiteFrame } from "./site-frame.tsx";

export function HomePage({
  site,
  signedIn,
}: {
  site: PublicSite;
  signedIn: boolean;
}) {
  const t = useT();
  const hero = site.heroImages[0];
  const demoHero = demoHeroPhoto();
  const heroSrc = demoHero ?? hero?.url ?? null;
  const heroAlt = demoHero
    ? t("website.demo.heroAlt")
    : (hero?.alt ?? site.brand.name);
  const firstHours = site.outlet.openingHours[0];
  const featured = site.featuredMenuItems;
  const promos = site.promotions;
  const demoGallery = demoGalleryPhotos();
  const gallery =
    demoGallery.length > 0
      ? demoGallery.map((src, index) => ({
          key: src,
          src,
          alt:
            index === 0
              ? t("website.demo.galleryInteriorAlt")
              : t("website.demo.galleryCoffeeAlt"),
        }))
      : site.gallery.map((image) => ({
          key: image.url,
          src: image.url,
          alt: image.alt,
        }));

  return (
    <SiteFrame site={site} signedIn={signedIn}>
      <SiteSection innerClassName="grid items-center gap-8 py-10 sm:py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="type-display-2xl text-balance">{site.brand.name}</h1>
            {API_MOCK && <Badge>{t("common.sampleData")}</Badge>}
          </div>
          <p className="text-lg leading-7 text-foreground">
            {site.brand.tagline}
          </p>
          <p className="max-w-prose text-base leading-7 text-muted-foreground">
            {site.brand.description}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button asChild size="lg">
              <Link to="/menu">{t("website.common.viewMenu")}</Link>
            </Button>
            {site.acceptsReservations && (
              <Button asChild size="lg" variant="outline">
                <Link to="/reservation">{t("website.common.reserve")}</Link>
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1 text-sm text-muted-foreground">
            {firstHours && (
              <span className="inline-flex items-center gap-1.5">
                <Clock className="size-4" aria-hidden="true" />
                <span className="tabular">
                  {t("website.home.hoursToday", {
                    hours: formatHoursRange(firstHours),
                  })}
                </span>
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-4" aria-hidden="true" />
              {site.outlet.address.city}
            </span>
          </div>
        </div>
        <MediaPlate
          src={heroSrc}
          alt={heroAlt}
          ratio="hero"
          className="aspect-[5/4]"
        />
      </SiteSection>

      {site.highlights.length > 0 && (
        <SiteSection>
          <SectionHeading
            title={t("website.home.highlightsTitle", {
              brand: site.brand.name,
            })}
          />
          <ul className="grid gap-6 border-t-(length:--border-w) pt-6 sm:grid-cols-3">
            {site.highlights.map((highlight) => (
              <li key={highlight.title} className="grid content-start gap-1.5">
                <h3 className="type-heading">{highlight.title}</h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  {highlight.description}
                </p>
              </li>
            ))}
          </ul>
        </SiteSection>
      )}

      <SiteSection band>
        <SectionHeading
          title={t("website.home.featuredTitle")}
          hint={t("website.home.featuredHint")}
          action={
            featured.length > 0 ? (
              <Button asChild variant="outline" size="sm">
                <Link to="/menu">{t("website.common.viewMenu")}</Link>
              </Button>
            ) : undefined
          }
        />
        {featured.length > 0 ? (
          <>
            <ul className="grid grid-cols-2 gap-4 lg:grid-cols-3 lg:gap-5">
              {featured.map((item) => {
                const src = demoMenuPhoto(item.name) ?? item.imageUrl;
                return (
                  <li key={item.id} className="grid content-start gap-2">
                    <MediaPlate src={src} alt={item.name} ratio="card" />
                    <h3 className="line-clamp-2 font-semibold">{item.name}</h3>
                    {item.description && (
                      <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">
                        {item.description}
                      </p>
                    )}
                    <Money amount={item.priceIdr} className="font-semibold" />
                  </li>
                );
              })}
            </ul>
            <PriceNote className="mt-5" />
          </>
        ) : (
          <EmptyState
            icon={UtensilsCrossed}
            title={t("website.home.featuredEmptyTitle")}
            description={t("website.home.featuredEmptyHint")}
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/menu">{t("website.home.featuredEmptyAction")}</Link>
              </Button>
            }
          />
        )}
      </SiteSection>

      <SiteSection>
        <SectionHeading title={t("website.home.promosTitle")} />
        {promos.length > 0 ? (
          <ul className="grid gap-4 sm:grid-cols-2">
            {promos.map((promo) => (
              <li key={promo.title}>
                <Card className="h-full">
                  <CardContent className="grid content-start gap-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <CardTitle>{promo.title}</CardTitle>
                      {promo.validUntil && (
                        <Badge tone="info">
                          {t("website.home.promoValidUntil", {
                            date: formatBusinessDate(promo.validUntil),
                          })}
                        </Badge>
                      )}
                    </div>
                    <CardDescription>{promo.description}</CardDescription>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={TicketPercent}
            title={t("website.home.promosEmptyTitle")}
            description={t("website.home.promosEmptyHint")}
          />
        )}
      </SiteSection>

      {gallery.length > 0 && (
        <SiteSection>
          <SectionHeading title={t("website.home.galleryTitle")} />
          <ul className="grid gap-4 sm:grid-cols-2">
            {gallery.map((image) => (
              <li key={image.key}>
                <MediaPlate src={image.src} alt={image.alt} ratio="card" />
              </li>
            ))}
          </ul>
        </SiteSection>
      )}

      <SiteSection>
        <CardShell>
          <Card>
            <CardContent className="grid gap-6 lg:grid-cols-2">
              <div className="grid content-start gap-3">
                <h2 className="type-title">
                  {t("website.home.visitTitle", { brand: site.brand.name })}
                </h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  {t("website.home.visitHint")}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <WhatsAppLink
                    contact={site.contact}
                    brandName={site.brand.name}
                  />
                  <Button asChild variant="outline">
                    <a
                      href={site.outlet.mapUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("website.common.openMaps")}
                    </a>
                  </Button>
                </div>
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="grid content-start gap-2">
                  <p className="type-eyebrow text-muted-foreground">
                    {t("website.home.hoursTitle")}
                  </p>
                  <OpeningHoursList outlet={site.outlet} />
                </div>
                <div className="grid content-start gap-2">
                  <p className="type-eyebrow text-muted-foreground">
                    {t("website.home.addressTitle")}
                  </p>
                  <AddressBlock outlet={site.outlet} />
                </div>
              </div>
            </CardContent>
          </Card>
        </CardShell>
      </SiteSection>

      <SiteSection innerClassName="pt-0">
        <MemberEntryCard brandName={site.brand.name} signedIn={signedIn} />
      </SiteSection>
    </SiteFrame>
  );
}
