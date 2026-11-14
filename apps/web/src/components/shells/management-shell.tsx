// Management shell (Padat & Presisi): dashboards for management, owner,
// shareholder, finance. DESIGN.md v2 §5 (owner Q28): a 256px grouped sidebar
// on the surface-2 band from 80rem of shell width, a 64px icon rail from
// 64rem, and below that the sidebar moves into a sheet behind a menu button.
// Breakpoints are container queries, so the shell adapts to its own width
// (also in previews). The current item takes the accent tint plus a 2px
// leading rule (Q29) — one of the screen's two accent details (Q21).
//
// v3 (Metoric layering): sidebar on the near-white shell tone, topbar on
// the page tone with a 26px bold title, and the work area on the canvas
// (surface-2) so double-shell cards read as layers. Metoric's 296px sidebar
// and grey active pill lose to Legend's 256px/64px rail and tint + rule.
import { useState, type ReactNode } from "react";
import { cn } from "cn";
import { Menu, Store } from "lucide-react";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  PlainLink,
  type ShellLinkComponent,
  type ShellNavItem,
} from "@/components/shells/nav";

type Layout = "full" | "rail";

/** Up to two initials for the account chip (no avatar photo yet). */
function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

/** Consecutive items with the same `group` form one section. */
function groupItems(items: ShellNavItem[]) {
  const groups: { title?: string; items: ShellNavItem[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.title === item.group) last.items.push(item);
    else groups.push({ title: item.group, items: [item] });
  }
  return groups;
}

function NavItemLink({
  item: { label, href, icon: Icon, current, count },
  layout,
  LinkComponent,
  onNavigate,
}: {
  item: ShellNavItem;
  layout: Layout;
  LinkComponent: ShellLinkComponent;
  onNavigate?: () => void;
}) {
  const rail = layout === "rail";
  return (
    <LinkComponent
      href={href}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      title={rail ? label : undefined}
      className={cn(
        "relative flex min-h-10 items-center gap-3 rounded-control text-sm font-medium transition-colors duration-(--duration-fast)",
        rail ? "mx-auto size-10 justify-center" : "px-3",
        current
          ? "bg-primary-tint font-semibold text-primary before:absolute before:inset-y-2 before:start-0 before:w-0.5 before:rounded-full before:bg-primary"
          : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
      )}
    >
      <Icon
        className={cn("size-5 shrink-0", !current && "text-muted-foreground")}
        aria-hidden="true"
      />
      <span className={cn("min-w-0 flex-1 truncate", rail && "sr-only")}>
        {label}
      </span>
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            "rounded-full bg-surface-3 px-1.5 text-xs leading-5 font-semibold text-foreground tabular",
            rail && "absolute -top-1 -end-1 border-2 border-shell",
          )}
        >
          {count}
        </span>
      )}
    </LinkComponent>
  );
}

function NavGroups({
  items,
  layout,
  LinkComponent,
  onNavigate,
}: {
  items: ShellNavItem[];
  layout: Layout;
  LinkComponent: ShellLinkComponent;
  onNavigate?: () => void;
}) {
  const rail = layout === "rail";
  return (
    <div className={cn("grid", rail ? "gap-2" : "gap-5")}>
      {groupItems(items).map((group, index) => (
        <div
          key={group.title ?? `group-${index}`}
          className={cn("grid gap-0.5", rail && index > 0 && "border-t pt-2")}
        >
          {group.title && (
            <p
              className={cn(
                "px-3 pb-1 type-eyebrow text-muted-foreground",
                rail && "sr-only",
              )}
            >
              {group.title}
            </p>
          )}
          <ul className="grid gap-0.5">
            {group.items.map((item) => (
              <li key={item.label}>
                <NavItemLink
                  item={item}
                  layout={layout}
                  LinkComponent={LinkComponent}
                  onNavigate={onNavigate}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Sidebar({
  brandName,
  nav,
  footerNav,
  layout,
  LinkComponent,
  onNavigate,
}: {
  brandName: string;
  nav: ShellNavItem[];
  footerNav?: ShellNavItem[];
  layout: Layout;
  LinkComponent: ShellLinkComponent;
  onNavigate?: () => void;
}) {
  const t = useT();
  const rail = layout === "rail";
  return (
    <nav aria-label={t("shell.mainNav")} className="flex h-full flex-col">
      <div
        className={cn(
          "flex h-16 shrink-0 items-center gap-2.5",
          rail ? "justify-center" : "px-4",
        )}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-control bg-foreground text-background">
          <Store className="size-5" aria-hidden="true" />
        </span>
        <p
          className={cn(
            "min-w-0 truncate text-base leading-6 font-bold tracking-tight",
            rail && "sr-only",
          )}
        >
          {brandName}
        </p>
      </div>
      <div
        className={cn("min-h-0 flex-1 overflow-y-auto", rail ? "py-3" : "p-3")}
      >
        <NavGroups
          items={nav}
          layout={layout}
          LinkComponent={LinkComponent}
          onNavigate={onNavigate}
        />
      </div>
      {footerNav && footerNav.length > 0 && (
        <div className={cn("border-t", rail ? "py-3" : "p-3")}>
          <NavGroups
            items={footerNav}
            layout={layout}
            LinkComponent={LinkComponent}
            onNavigate={onNavigate}
          />
        </div>
      )}
    </nav>
  );
}

export function ManagementShell({
  brandName,
  nav,
  footerNav,
  pageTitle,
  actions,
  user,
  LinkComponent = PlainLink,
  embedded = false,
  children,
}: {
  brandName: string;
  nav: ShellNavItem[];
  footerNav?: ShellNavItem[];
  pageTitle: string;
  actions?: ReactNode;
  user?: { name: string; role: string };
  LinkComponent?: ShellLinkComponent;
  embedded?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const Main = embedded ? "div" : "main";
  const Title = embedded ? "p" : "h1";
  return (
    <ThemeScope
      density="padat"
      className={cn(
        "@container flex bg-background",
        embedded ? "h-full" : "h-dvh",
      )}
    >
      <aside className="hidden w-16 shrink-0 border-e bg-shell @5xl:block @7xl:hidden">
        <Sidebar
          brandName={brandName}
          nav={nav}
          footerNav={footerNav}
          layout="rail"
          LinkComponent={LinkComponent}
        />
      </aside>
      <aside className="hidden w-64 shrink-0 border-e bg-shell @7xl:block">
        <Sidebar
          brandName={brandName}
          nav={nav}
          footerNav={footerNav}
          layout="full"
          LinkComponent={LinkComponent}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b bg-background px-gutter">
          <Button
            variant="ghost"
            size="icon"
            className="-ms-2 @5xl:hidden"
            onClick={() => setOpen(true)}
            aria-expanded={open}
          >
            <Menu aria-hidden="true" />
            <span className="sr-only">{t("shell.openNav")}</span>
          </Button>
          <Title className="min-w-0 truncate type-title @3xl:type-display">
            {pageTitle}
          </Title>
          <div className="ms-auto flex items-center gap-2">
            {actions}
            {user && (
              <div className="hidden items-center gap-2.5 border-s ps-3 @2xl:flex">
                <span
                  aria-hidden="true"
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-3 text-sm font-bold"
                >
                  {initials(user.name)}
                </span>
                <div className="leading-tight">
                  <p className="text-sm font-semibold">{user.name}</p>
                  <p className="text-xs text-muted-foreground">{user.role}</p>
                </div>
              </div>
            )}
          </div>
        </header>
        <Main
          id={embedded ? undefined : "main-content"}
          role={embedded ? "region" : undefined}
          aria-label={pageTitle}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto bg-surface-2 focus-visible:-outline-offset-2"
        >
          <div className="mx-auto w-full max-w-[90rem] px-gutter py-6">
            {children}
          </div>
        </Main>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-64 gap-0 bg-shell p-0">
          <SheetTitle className="sr-only">{t("shell.mainNav")}</SheetTitle>
          <SheetDescription className="sr-only">{brandName}</SheetDescription>
          <Sidebar
            brandName={brandName}
            nav={nav}
            footerNav={footerNav}
            layout="full"
            LinkComponent={LinkComponent}
            onNavigate={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </ThemeScope>
  );
}
