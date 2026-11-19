// Customer shell (Hangat & Visual): QR order, member, shower, WFC. Mobile
// first: header with outlet context, one scrolling column, bottom nav in
// thumb reach with safe-area padding. Wider screens keep the same column.
// The bar holds at most five slots (DESIGN.md v2 §5); a customer area with
// more destinations gets a "Lainnya" sheet as the last slot (bead legend-oibk).
// v3: page stays white (Legend); the active slot gets Metoric's active-nav
// treatment as an accent-tint pill behind the icon (one accent detail, Q21).
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "cn";
import { MoreHorizontal } from "lucide-react";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { splitBottomNav } from "@/lib/areas/nav";
import {
  PlainLink,
  type ShellLinkComponent,
  type ShellNavItem,
} from "@/components/shells/nav";

/** One 64px bar slot: icon over the label, active item in the accent. */
function slotClass(current: boolean | undefined) {
  return cn(
    "relative flex min-h-16 w-full flex-col items-center justify-center gap-0.5 text-xs leading-4 font-medium text-muted-foreground transition-colors duration-(--duration-fast) pressable hover:text-foreground",
    current && "font-semibold text-primary hover:text-primary",
  );
}

/** Icon in a pill that takes the accent tint when its slot is current. */
function SlotIcon({
  current,
  children,
}: {
  current: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "grid h-8 w-14 place-items-center rounded-full transition-colors duration-(--duration-fast)",
        current && "bg-primary-tint",
      )}
    >
      {children}
    </span>
  );
}

function CountBadge({ count }: { count?: number }) {
  if (count === undefined || count <= 0) return null;
  return (
    <span className="absolute top-2 left-1/2 ml-2 min-w-5 rounded-full bg-primary px-1.5 text-center text-xs leading-5 font-semibold text-primary-foreground tabular">
      {count}
    </span>
  );
}

/** Clearance for the bar: one 64px slot row (slotClass `min-h-16`), the bar's
 * 1px top border, and the device safe area it pads for. */
const BAR_INSET = "calc(4rem + 1px + env(safe-area-inset-bottom))";

// The Toaster renders its viewport at the app root (providers.tsx), outside
// this shell's subtree, so an inline variable on the shell root would never
// reach it. While a shell with a bottom bar is mounted the inset is written to
// <html> and removed on unmount; management and ops shells never set it, so
// they keep toast.tsx's 0px default. The counter keeps nested/preview shells
// (a shell inside a preview of another shell) from clearing it too early.
let barShells = 0;

function useBarToastInset(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    if (barShells++ === 0)
      root.style.setProperty("--toast-inset-bottom", BAR_INSET);
    return () => {
      if (--barShells === 0) root.style.removeProperty("--toast-inset-bottom");
    };
  }, [active]);
}

export function CustomerShell({
  brandName,
  pageTitle,
  logoUrl,
  context,
  actions,
  nav,
  LinkComponent = PlainLink,
  embedded = false,
  children,
}: {
  /** Tenant display name (whitelabel: never the platform name, D43). */
  brandName: string;
  pageTitle?: string;
  logoUrl?: string | null;
  /** Where the customer is, e.g. "Meja 12 · 3 tamu". */
  context?: ReactNode;
  actions?: ReactNode;
  nav: ShellNavItem[];
  LinkComponent?: ShellLinkComponent;
  /** Preview inside another page: fills its parent, no <main> landmark. */
  embedded?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const [moreOpen, setMoreOpen] = useState(false);
  const { primary, overflow } = splitBottomNav(nav);
  // On an overflow screen no bar link is current, so "Lainnya" carries the
  // active state (the member PWA reaches /member/fasilitas this way).
  const moreCurrent = overflow.some((item) => item.current);
  // A count on a sheet item must still be visible from the bar.
  const moreCount = overflow.reduce((sum, item) => sum + (item.count ?? 0), 0);
  const slots = primary.length + (overflow.length > 0 ? 1 : 0);
  const Main = embedded ? "div" : "main";
  useBarToastInset(nav.length > 1);
  return (
    <ThemeScope
      density="hangat"
      className={cn(
        "flex flex-col bg-background",
        embedded ? "h-full" : "h-dvh",
      )}
    >
      <header className="shrink-0 border-b bg-background">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center gap-3 px-gutter">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={brandName}
              width={128}
              height={32}
              className="h-8 w-auto"
            />
          ) : (
            <span className="truncate font-brand type-title">{brandName}</span>
          )}
          {context && (
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {context}
            </span>
          )}
          {actions && (
            <div className="ml-auto flex items-center gap-2">{actions}</div>
          )}
        </div>
      </header>

      <Main
        id={embedded ? undefined : "main-content"}
        role={embedded ? "region" : undefined}
        aria-label={
          pageTitle ?? nav.find((item) => item.current)?.label ?? brandName
        }
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto focus-visible:-outline-offset-2"
      >
        <div className="mx-auto w-full max-w-2xl px-gutter py-4">
          {children}
        </div>
      </Main>

      {nav.length > 1 && (
        <nav
          aria-label={t("shell.mainNav")}
          className="shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)]"
        >
          <ul
            className="mx-auto grid w-full max-w-2xl"
            style={{
              gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))`,
            }}
          >
            {primary.map(({ label, href, icon: Icon, current, count }) => (
              <li key={label}>
                <LinkComponent
                  href={href}
                  aria-current={current ? "page" : undefined}
                  className={slotClass(current)}
                >
                  <SlotIcon current={current}>
                    <Icon className="size-6" aria-hidden="true" />
                  </SlotIcon>
                  {label}
                  <CountBadge count={count} />
                </LinkComponent>
              </li>
            ))}
            {overflow.length > 0 && (
              <li>
                <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
                  <SheetTrigger asChild>
                    <button
                      type="button"
                      aria-current={moreCurrent ? "page" : undefined}
                      className={slotClass(moreCurrent)}
                    >
                      <SlotIcon current={moreCurrent}>
                        <MoreHorizontal className="size-6" aria-hidden="true" />
                      </SlotIcon>
                      {t("common.more")}
                      <CountBadge count={moreCount} />
                    </button>
                  </SheetTrigger>
                  <SheetContent side="bottom">
                    <SheetHeader>
                      <SheetTitle>{t("common.more")}</SheetTitle>
                      <SheetDescription className="sr-only">
                        {t("shell.mainNav")}
                      </SheetDescription>
                    </SheetHeader>
                    <ul className="grid gap-0.5">
                      {overflow.map(
                        ({ label, href, icon: Icon, current, count }) => (
                          <li key={label}>
                            <LinkComponent
                              href={href}
                              aria-current={current ? "page" : undefined}
                              onClick={() => setMoreOpen(false)}
                              className={cn(
                                "relative flex min-h-12 items-center gap-3 rounded-control px-3 text-sm font-medium text-foreground transition-colors duration-(--duration-fast) pressable hover:bg-surface-3",
                                current &&
                                  "bg-primary-tint font-semibold text-primary hover:bg-primary-tint",
                              )}
                            >
                              <Icon
                                className="size-5 shrink-0"
                                aria-hidden="true"
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {label}
                              </span>
                              {count !== undefined && count > 0 && (
                                <span className="min-w-5 rounded-full bg-primary px-1.5 text-center text-xs leading-5 font-semibold text-primary-foreground tabular">
                                  {count}
                                </span>
                              )}
                            </LinkComponent>
                          </li>
                        ),
                      )}
                    </ul>
                  </SheetContent>
                </Sheet>
              </li>
            )}
          </ul>
        </nav>
      )}
    </ThemeScope>
  );
}
