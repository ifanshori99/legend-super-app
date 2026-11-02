// Customer shell (Hangat & Visual): QR order, member, shower, WFC. Mobile
// first: header with outlet context, one scrolling column, bottom nav in
// thumb reach with safe-area padding. Wider screens keep the same column.
// v3: page stays white (Legend); the active bottom-nav item gets Metoric's
// active-nav treatment as an accent-tint pill behind the icon (one accent
// detail, Q21). Max 5 items; more go behind "Lainnya" in the feature nav.
import type { ReactNode } from "react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import {
  PlainLink,
  type ShellLinkComponent,
  type ShellNavItem,
} from "@/components/shells/nav";

export function CustomerShell({
  brandName,
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
  const Main = embedded ? "div" : "main";
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
            <img src={logoUrl} alt={brandName} className="h-8 w-auto" />
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
        className="min-h-0 flex-1 overflow-y-auto"
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
              gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))`,
            }}
          >
            {nav.map(({ label, href, icon: Icon, current, count }) => (
              <li key={label}>
                <LinkComponent
                  href={href}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "group relative flex min-h-16 flex-col items-center justify-center gap-0.5 text-xs leading-4 font-medium text-muted-foreground transition-colors duration-(--duration-fast) pressable hover:text-foreground",
                    current && "font-semibold text-primary hover:text-primary",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-8 w-14 place-items-center rounded-full transition-colors duration-(--duration-fast)",
                      current && "bg-primary-tint",
                    )}
                  >
                    <Icon className="size-6" aria-hidden="true" />
                  </span>
                  {label}
                  {count !== undefined && count > 0 && (
                    <span className="absolute top-2 left-1/2 ml-2 min-w-5 rounded-full bg-primary px-1.5 text-center text-xs leading-5 font-semibold text-primary-foreground tabular">
                      {count}
                    </span>
                  )}
                </LinkComponent>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </ThemeScope>
  );
}
