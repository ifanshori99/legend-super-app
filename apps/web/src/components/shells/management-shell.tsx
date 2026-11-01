// Management shell (Padat & Presisi): dashboards for management, owner,
// shareholder, finance. Sidebar + topbar from 64rem of shell width; below
// that the sidebar moves into a sheet behind a menu button. Breakpoints are
// container queries, so the shell adapts to its own width (also in previews).
import { useState, type ReactNode } from "react";
import { cn } from "cn";
import { Menu } from "lucide-react";
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

function NavList({
  items,
  LinkComponent,
  onNavigate,
}: {
  items: ShellNavItem[];
  LinkComponent: ShellLinkComponent;
  onNavigate?: () => void;
}) {
  return (
    <ul className="grid gap-0.5">
      {items.map(({ label, href, icon: Icon, current, count }) => (
        <li key={label}>
          <LinkComponent
            href={href}
            onClick={onNavigate}
            aria-current={current ? "page" : undefined}
            className={cn(
              "flex min-h-control items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              current && "bg-accent font-semibold text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {count !== undefined && count > 0 && (
              <span className="rounded-md bg-background px-1.5 text-xs leading-5 font-semibold text-foreground tabular">
                {count}
              </span>
            )}
          </LinkComponent>
        </li>
      ))}
    </ul>
  );
}

function Sidebar({
  brandName,
  nav,
  footerNav,
  LinkComponent,
  onNavigate,
}: {
  brandName: string;
  nav: ShellNavItem[];
  footerNav?: ShellNavItem[];
  LinkComponent: ShellLinkComponent;
  onNavigate?: () => void;
}) {
  const t = useT();
  return (
    <nav aria-label={t("shell.mainNav")} className="flex h-full flex-col gap-4">
      <p className="px-2.5 text-base leading-6 font-bold tracking-tight">
        {brandName}
      </p>
      <NavList
        items={nav}
        LinkComponent={LinkComponent}
        onNavigate={onNavigate}
      />
      {footerNav && (
        <div className="mt-auto border-t pt-3">
          <NavList
            items={footerNav}
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
      className={cn("@container flex", embedded ? "h-full" : "h-dvh")}
    >
      <aside className="hidden w-60 shrink-0 border-r bg-muted px-3 py-4 @5xl:block">
        <Sidebar
          brandName={brandName}
          nav={nav}
          footerNav={footerNav}
          LinkComponent={LinkComponent}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-gutter">
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2 @5xl:hidden"
            onClick={() => setOpen(true)}
            aria-expanded={open}
          >
            <Menu aria-hidden="true" />
            <span className="sr-only">{t("shell.openNav")}</span>
          </Button>
          <Title className="min-w-0 truncate text-lg leading-7 font-semibold">
            {pageTitle}
          </Title>
          <div className="ml-auto flex items-center gap-2">
            {actions}
            {user && (
              <div className="hidden text-right @2xl:block">
                <p className="text-sm leading-5 font-semibold">{user.name}</p>
                <p className="text-xs leading-4 text-muted-foreground">
                  {user.role}
                </p>
              </div>
            )}
          </div>
        </header>
        <Main
          id={embedded ? undefined : "main-content"}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="px-gutter py-6">{children}</div>
        </Main>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="bg-muted px-3">
          <SheetTitle className="sr-only">{t("shell.mainNav")}</SheetTitle>
          <SheetDescription className="sr-only">{brandName}</SheetDescription>
          <Sidebar
            brandName={brandName}
            nav={nav}
            footerNav={footerNav}
            LinkComponent={LinkComponent}
            onNavigate={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </ThemeScope>
  );
}
