// Shared pieces of the public brand site: section rhythm, opening hours,
// address, contact links and the member entry card. Layout only — every colour
// is a design token (DESIGN.md v3) and every sentence comes from the text
// catalog.
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
  AtSign,
  Clock,
  ExternalLink,
  Info,
  Mail,
  MapPin,
  MessageCircle,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { PublicContact, PublicOutlet } from "@starter/shared/website";
import { openingHoursLines, type DayLabels } from "../lib/hours.ts";
import { buildWhatsAppUrl } from "../lib/reservation.ts";

/**
 * Page section. `band` puts the content on the `surface-2` canvas band
 * (v3 customer rhythm: page tone, one tinted band per screen); the gutter and
 * max width stay inside the band so the tint reads edge to edge.
 */
export function SiteSection({
  id,
  band = false,
  className,
  innerClassName,
  children,
}: {
  id?: string;
  band?: boolean;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn("w-full scroll-mt-20", band && "bg-surface-2", className)}
    >
      <div
        className={cn(
          "mx-auto w-full max-w-6xl px-gutter py-10 sm:py-14",
          innerClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

export function SectionHeading({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="grid gap-1">
        <h2 className="type-title">{title}</h2>
        {hint && (
          <p className="text-sm leading-6 text-muted-foreground">{hint}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/** Owner decision 1 Nov 2026: menu prices exclude tax and service charge. */
export function PriceNote({ className }: { className?: string }) {
  const t = useT();
  return (
    <p
      className={cn(
        "flex items-start gap-2 text-sm leading-5 text-muted-foreground",
        className,
      )}
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {t("website.common.priceNote")}
    </p>
  );
}

/** Day labels in `Date#getDay` order, read from the catalog. */
export function useDayLabels(): DayLabels {
  const t = useT();
  return [
    t("website.day.sun"),
    t("website.day.mon"),
    t("website.day.tue"),
    t("website.day.wed"),
    t("website.day.thu"),
    t("website.day.fri"),
    t("website.day.sat"),
  ];
}

export function OpeningHoursList({
  outlet,
  className,
}: {
  outlet: PublicOutlet;
  className?: string;
}) {
  const t = useT();
  const days = useDayLabels();
  const lines = openingHoursLines(outlet.openingHours, {
    days,
    everyDay: t("website.common.everyDay"),
  });
  return (
    <ul className={cn("grid gap-2", className)}>
      {lines.map((line) => (
        <li key={line} className="flex items-start gap-2 text-sm leading-5">
          <Clock
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="tabular">{line}</span>
        </li>
      ))}
    </ul>
  );
}

export function AddressBlock({
  outlet,
  className,
}: {
  outlet: PublicOutlet;
  className?: string;
}) {
  const t = useT();
  const { address } = outlet;
  const cityLine = [address.district, address.city]
    .filter((part): part is string => Boolean(part))
    .join(", ");
  return (
    <div className={cn("grid gap-2", className)}>
      <address className="flex items-start gap-2 text-sm leading-5 not-italic">
        <MapPin
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span>
          {address.streetLine}
          <br />
          {cityLine}
          <br />
          {address.province} {address.postalCode}
        </span>
      </address>
      <a
        href={outlet.mapUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex w-fit items-center gap-1 text-sm font-semibold text-primary underline-offset-4 hover:underline"
      >
        {t("website.common.openMaps")}
        <ExternalLink className="size-4" aria-hidden="true" />
        <span className="sr-only">({t("website.common.newTab")})</span>
      </a>
    </div>
  );
}

/** WhatsApp deep link; renders nothing when the contact number is unusable. */
export function WhatsAppLink({
  contact,
  brandName,
  message,
  label,
  variant = "default",
  size = "default",
  className,
}: {
  contact: PublicContact;
  brandName: string;
  message?: string;
  label?: string;
  variant?: "default" | "outline" | "secondary" | "ghost";
  size?: "default" | "sm" | "lg";
  className?: string;
}) {
  const t = useT();
  const url = buildWhatsAppUrl(
    contact.whatsapp,
    message ?? t("website.common.whatsAppGreeting", { brand: brandName }),
  );
  if (!url) return null;
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <a href={url} target="_blank" rel="noreferrer">
        <MessageCircle aria-hidden="true" />
        {label ?? t("website.common.chatWhatsApp")}
        <span className="sr-only">({t("website.common.newTab")})</span>
      </a>
    </Button>
  );
}

/** Footer contact rows: WhatsApp, email, Instagram and the Google profile. */
export function ContactList({
  contact,
  brandName,
}: {
  contact: PublicContact;
  brandName: string;
}) {
  const t = useT();
  const items: { key: string; href: string; label: string; icon: ReactNode }[] =
    [];
  const whatsapp = buildWhatsAppUrl(
    contact.whatsapp,
    t("website.common.whatsAppGreeting", { brand: brandName }),
  );
  if (whatsapp)
    items.push({
      key: "whatsapp",
      href: whatsapp,
      label: `+${contact.whatsapp}`,
      icon: <MessageCircle className="size-4" aria-hidden="true" />,
    });
  if (contact.email)
    items.push({
      key: "email",
      href: `mailto:${contact.email}`,
      label: contact.email,
      icon: <Mail className="size-4" aria-hidden="true" />,
    });
  if (contact.instagramUrl)
    items.push({
      key: "instagram",
      href: contact.instagramUrl,
      label: "Instagram",
      icon: <AtSign className="size-4" aria-hidden="true" />,
    });
  if (contact.googleBusinessProfileUrl)
    items.push({
      key: "gbp",
      href: contact.googleBusinessProfileUrl,
      label: "Google Business Profile",
      icon: <ExternalLink className="size-4" aria-hidden="true" />,
    });
  return (
    <ul className="grid gap-1">
      {items.map((item) => (
        <li key={item.key}>
          <a
            href={item.href}
            {...(item.key === "email"
              ? {}
              : { target: "_blank", rel: "noreferrer" })}
            className="inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {item.icon}
            <span className="break-all">{item.label}</span>
            {item.key !== "email" && (
              <span className="sr-only">({t("website.common.newTab")})</span>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Member entry (PRD §3.24 "Reservasi & Member"): a signed-in visitor goes to
 * their member page, everyone else gets the sign-in and sign-up doors.
 */
export function MemberEntryCard({
  brandName,
  signedIn,
  className,
}: {
  brandName: string;
  signedIn: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <Card className={className}>
      <CardContent className="grid gap-4">
        <div className="grid gap-1">
          <h2 className="type-title">
            {t("website.home.memberTitle", { brand: brandName })}
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            {t("website.home.memberBody")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {signedIn ? (
            <Button asChild>
              <Link to="/member">{t("website.nav.member")}</Link>
            </Button>
          ) : (
            <>
              <Button asChild>
                <Link to="/member/daftar">
                  {t("website.home.memberRegister")}
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/masuk">{t("website.home.memberSignIn")}</Link>
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
