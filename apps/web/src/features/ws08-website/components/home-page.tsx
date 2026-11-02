// Brand home page (PRD v1.7 §3.24 "Beranda"): cafe profile, photos, opening
// hours, location with a map link, featured menu and promos, plus the two
// entries the PRD names — reservation and member.
import { Link } from "@tanstack/react-router";
import { Clock, MapPin } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import type { PublicSite } from "@starter/shared/website";
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
import { SiteImage } from "./site-image.tsx";

export function HomePage({
  site,
  signedIn,
}: {
  site: PublicSite;
  signedIn: boolean;
}) {
  const t = useT();
  const hero = site.heroImages[0];
  const firstHours = site.outlet.openingHours[0];
  const featured = site.featuredMenuItems;
  const promos = site.promotions;
  return (
    <SiteFrame site={site}>
      <SiteSection className="grid items-center gap-8 py-10 sm:py-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <h1 className="font-brand text-3xl leading-tight font-bold tracking-tight text-balance sm:text-4xl">
            {site.brand.name}
          </h1>
          <p className="text-lg leading-7 text-foreground">{site.brand.tagline}</p>
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
        {hero && (
          <SiteImage
            src={hero.url}
            alt={hero.alt}
            priority
            className="aspect-[4/3] lg:aspect-[5/4]"
          />
        )}
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
                <h3 className="text-base font-semibold">{highlight.title}</h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  {highlight.description}
                </p>
              </li>
            ))}
          </ul>
        </SiteSection>
      )}

      <SiteSection>
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
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {featured.map((item) => (
                <li key={item.id}>
                  <Card className="h-full">
                    {item.imageUrl && (
                      <SiteImage
                        src={item.imageUrl}
                        alt={item.name}
                        className="aspect-[16/10] rounded-lg"
                      />
                    )}
                    <CardContent className="grid content-start gap-1.5">
                      <CardTitle>{item.name}</CardTitle>
                      {item.description && (
                        <CardDescription>{item.description}</CardDescription>
                      )}
                      <Money
                        amount={item.priceIdr}
                        size="lg"
                        className="pt-1 text-base font-semibold"
                      />
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
            <PriceNote className="mt-4" />
          </>
        ) : (
          <EmptyState
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
            title={t("website.home.promosEmptyTitle")}
            description={t("website.home.promosEmptyHint")}
          />
        )}
      </SiteSection>

      {site.gallery.length > 0 && (
        <SiteSection>
          <SectionHeading title={t("website.home.galleryTitle")} />
          <ul className="grid gap-4 sm:grid-cols-2">
            {site.gallery.map((image) => (
              <li key={image.url}>
                <SiteImage
                  src={image.url}
                  alt={image.alt}
                  className="aspect-[4/3]"
                />
              </li>
            ))}
          </ul>
        </SiteSection>
      )}

      <SiteSection>
        <Card>
          <CardContent className="grid gap-6 lg:grid-cols-2">
            <div className="grid content-start gap-3">
              <h2 className="text-2xl font-semibold tracking-tight">
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
                  <a href={site.outlet.mapUrl} target="_blank" rel="noreferrer">
                    {t("website.common.openMaps")}
                  </a>
                </Button>
              </div>
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="grid content-start gap-2">
                <p className="text-sm font-semibold">
                  {t("website.home.hoursTitle")}
                </p>
                <OpeningHoursList outlet={site.outlet} />
              </div>
              <div className="grid content-start gap-2">
                <p className="text-sm font-semibold">
                  {t("website.home.addressTitle")}
                </p>
                <AddressBlock outlet={site.outlet} />
              </div>
            </div>
          </CardContent>
        </Card>
      </SiteSection>

      <SiteSection>
        <MemberEntryCard brandName={site.brand.name} signedIn={signedIn} />
      </SiteSection>
    </SiteFrame>
  );
}
