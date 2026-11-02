// The public brand website frame (PRD v1.7 §3.24): a wide, warm, photo-led
// page on the white page surface — the brand's face, not the app's shell. The
// area layout (_public.tsx) sets the Hangat density; this frame adds the site
// header, footer and the <main> landmark.
//
// Whitelabel (TEN-08): every name, link and image comes from the site payload.
// The platform name, logo and links never appear here.
import type { ReactNode } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import type { MessageKey } from "@starter/shared/i18n";
import type { PublicSite } from "@starter/shared/website";
import {
  AddressBlock,
  ContactList,
  OpeningHoursList,
  SiteSection,
} from "./blocks.tsx";

const HEADER_LINKS: { to: string; labelKey: MessageKey; desktopOnly?: boolean }[] =
  [
    { to: "/menu", labelKey: "website.nav.menu" },
    { to: "/reservation", labelKey: "website.nav.reservation" },
    { to: "/member", labelKey: "website.nav.member", desktopOnly: true },
  ];

function isCurrent(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

function HeaderLink({
  to,
  labelKey,
  desktopOnly,
  pathname,
}: {
  to: string;
  labelKey: MessageKey;
  desktopOnly?: boolean;
  pathname: string;
}) {
  const t = useT();
  const current = isCurrent(pathname, to);
  return (
    <Link
      to={to}
      aria-current={current ? "page" : undefined}
      className={cn(
        "inline-flex h-11 items-center rounded-control px-2 text-sm font-medium text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground",
        current && "font-semibold text-foreground",
        desktopOnly && "hidden sm:inline-flex",
      )}
    >
      {t(labelKey)}
    </Link>
  );
}

export function SiteFrame({
  site,
  children,
}: {
  site: PublicSite;
  children: ReactNode;
}) {
  const t = useT();
  const { pathname } = useLocation();
  const year = new Date(site.updatedAt).getUTCFullYear();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b-(length:--border-w) bg-background">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-gutter">
          <Link
            to="/"
            className="mr-auto min-w-0 truncate font-brand text-xl leading-7 font-bold tracking-tight text-foreground"
          >
            {site.brand.name}
          </Link>
          <nav aria-label={t("website.nav.mainNav")} className="flex items-center gap-1">
            {HEADER_LINKS.map((link) => (
              <HeaderLink key={link.to} {...link} pathname={pathname} />
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </header>

      <main id="main-content" className="flex-1">
        {children}
      </main>

      <footer className="border-t-(length:--border-w) bg-muted">
        <SiteSection className="py-10 sm:py-12">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <div className="grid content-start gap-2">
              <p className="font-brand text-lg font-bold tracking-tight">
                {site.brand.name}
              </p>
              <p className="text-sm leading-6 text-muted-foreground">
                {site.brand.tagline}
              </p>
            </div>
            <nav aria-label={t("website.nav.footerNav")} className="grid content-start gap-2">
              <p className="text-sm font-semibold">{t("website.nav.footerNav")}</p>
              <ul className="grid gap-1">
                {(
                  [
                    { to: "/", labelKey: "website.nav.home" },
                    { to: "/menu", labelKey: "website.nav.menu" },
                    { to: "/reservation", labelKey: "website.nav.reservation" },
                    { to: "/member", labelKey: "website.nav.member" },
                  ] as const
                ).map((link) => (
                  <li key={link.to}>
                    <Link
                      to={link.to}
                      className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {t(link.labelKey)}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="grid content-start gap-2">
              <p className="text-sm font-semibold">{t("website.home.contactTitle")}</p>
              <ContactList contact={site.contact} brandName={site.brand.name} />
            </div>
            <div className="grid content-start gap-4">
              <div className="grid gap-2">
                <p className="text-sm font-semibold">{t("website.home.hoursTitle")}</p>
                <OpeningHoursList outlet={site.outlet} />
              </div>
              <div className="grid gap-2">
                <p className="text-sm font-semibold">{t("website.home.addressTitle")}</p>
                <AddressBlock outlet={site.outlet} />
              </div>
            </div>
          </div>
        </SiteSection>
        <div className="border-t-(length:--border-w)">
          <div className="mx-auto w-full max-w-6xl px-gutter py-4">
            <p className="text-sm text-muted-foreground">
              {t("website.footer.rights", {
                year,
                brand: site.brand.name,
              })}
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
