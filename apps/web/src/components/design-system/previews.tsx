// /design-system: the three densities side by side and the three app shells
// rendered inside frames (shells adapt to their own width).
import {
  BadgeCheck,
  BookOpen,
  Boxes,
  ClipboardCheck,
  Contact,
  LayoutDashboard,
  Plus,
  ReceiptText,
  Settings,
  ShoppingCart,
  UserRound,
  Wallet,
} from "lucide-react";
import {
  DENSITIES,
  cafeLegendTheme,
  type ColorMode,
} from "@starter/shared/theme";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { CustomerShell } from "@/components/shells/customer-shell";
import { ManagementShell } from "@/components/shells/management-shell";
import { OperationsShell } from "@/components/shells/operations-shell";
import { OrdersTable } from "@/components/design-system/component-gallery";
import {
  sampleMenu,
  sampleOpenOrders,
  sampleOrders,
  sampleOutlet,
  sampleSalesToday,
  sampleStation,
  sampleTickets,
  sampleTimeZone,
} from "@/components/design-system/sample-data";
import { Section } from "@/components/design-system/token-sections";

export function DensitiesSection() {
  const t = useT();
  return (
    <Section id="kepadatan" title={t("designSystem.sections.densities")}>
      <div className="grid gap-6 xl:grid-cols-3">
        {DENSITIES.map((density) => (
          <ThemeScope
            key={density}
            density={density}
            className="flex min-w-0 flex-col gap-4 rounded-xl border-(length:--border-w) p-card"
          >
            <div>
              <p className="text-lg leading-7 font-semibold">
                {t(`density.${density}`)}
              </p>
              <p className="text-sm leading-5 text-muted-foreground">
                {t(`designSystem.densities.${density}`)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button>{t("designSystem.demo.sendOrder")}</Button>
              <Button variant="outline">{t("common.cancel")}</Button>
            </div>
            <FormField label={t("designSystem.demo.nameLabel")} required>
              <Input />
            </FormField>
            <OrdersTable orders={sampleOrders.slice(0, 2)} compact />
          </ThemeScope>
        ))}
      </div>
    </Section>
  );
}

function Frame({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="grid min-w-0 content-start gap-2">
      <figcaption className="text-sm font-semibold text-muted-foreground">
        {label}
      </figcaption>
      <div className={`overflow-hidden rounded-xl border-2 ${className}`}>
        {children}
      </div>
    </figure>
  );
}

function CustomerPreview() {
  const t = useT();
  return (
    <CustomerShell
      embedded
      brandName={cafeLegendTheme.name}
      context={t("designSystem.demo.customerContext", {
        table: "12",
        guests: 3,
      })}
      nav={[
        {
          label: t("nav.customer.menu"),
          href: "#shell",
          icon: BookOpen,
          current: true,
        },
        {
          label: t("nav.customer.orders"),
          href: "#shell",
          icon: ReceiptText,
          count: 2,
        },
        { label: t("nav.customer.member"), href: "#shell", icon: BadgeCheck },
        { label: t("nav.customer.account"), href: "#shell", icon: UserRound },
      ]}
    >
      <p className="mb-3 font-brand text-2xl leading-8 font-bold tracking-tight">
        {t("designSystem.demo.menuTitle")}
      </p>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
        {sampleMenu.slice(0, 4).map((menu) => (
          <li
            key={menu.id}
            className="flex items-center gap-3 rounded-2xl border bg-card p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{menu.name}</p>
              <p className="truncate text-sm text-muted-foreground">
                {menu.description}
              </p>
              <Money amount={menu.price} className="mt-1 block font-semibold" />
            </div>
            <Button
              size="icon-sm"
              aria-label={t("designSystem.demo.addItem", { item: menu.name })}
            >
              <Plus aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    </CustomerShell>
  );
}

function OperationsPreview({
  mode,
  title,
}: {
  mode: ColorMode;
  title: string;
}) {
  const t = useT();
  return (
    <OperationsShell
      embedded
      mode={mode}
      title={title}
      outlet={sampleOutlet}
      online={false}
      timeZone={sampleTimeZone}
    >
      <div className="grid h-full auto-rows-min gap-3 overflow-y-auto p-4 sm:grid-cols-3">
        {sampleTickets.map((ticket) => (
          <article
            key={ticket.table}
            className="flex flex-col gap-3 rounded-lg border-(length:--border-w) bg-card p-4"
            data-timer={ticket.timer}
          >
            <header className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-2xl leading-8 font-bold whitespace-nowrap">
                {t("designSystem.demo.ticket", { table: ticket.table })}
              </p>
              <StatusPill status={ticket.timer} className="text-sm">
                {t("timer.elapsed", { minutes: ticket.minutes })}
              </StatusPill>
            </header>
            <ul className="grid gap-1 text-(length:--density-text) font-medium">
              {ticket.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <Button className="mt-auto w-full">
              {t("designSystem.demo.bump")}
            </Button>
          </article>
        ))}
      </div>
    </OperationsShell>
  );
}

function ManagementPreview() {
  const t = useT();
  return (
    <ManagementShell
      embedded
      brandName={cafeLegendTheme.name}
      pageTitle={t("designSystem.demo.dashboard")}
      user={{
        name: t("designSystem.demo.account"),
        role: t("designSystem.demo.role"),
      }}
      nav={[
        {
          label: t("nav.management.dashboard"),
          href: "#shell",
          icon: LayoutDashboard,
          current: true,
        },
        {
          label: t("nav.management.approvals"),
          href: "#shell",
          icon: ClipboardCheck,
          count: 4,
        },
        {
          label: t("nav.management.inventory"),
          href: "#shell-inventory",
          icon: Boxes,
          group: t("nav.group.operations"),
        },
        {
          label: t("nav.management.purchasing"),
          href: "#shell-purchasing",
          icon: ShoppingCart,
          group: t("nav.group.operations"),
        },
        {
          label: t("nav.management.accounting"),
          href: "#shell-accounting",
          icon: Wallet,
          group: t("nav.group.finance"),
        },
        {
          label: t("nav.management.crm"),
          href: "#shell-crm",
          icon: Contact,
          group: t("nav.group.team"),
        },
      ]}
      footerNav={[
        { label: t("nav.management.settings"), href: "#shell", icon: Settings },
      ]}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <StatStrip label={t("designSystem.demo.dashboard")} columns={2}>
          <StatTile
            label={t("designSystem.demo.salesToday")}
            value={<Money amount={sampleSalesToday} size="stat" />}
            context={t("designSystem.demo.today", { outlet: sampleOutlet })}
            source={
              <a href="#shell">{t("designSystem.demo.viewTransactions")}</a>
            }
          />
          <StatTile
            label={t("designSystem.demo.openOrders")}
            value={sampleOpenOrders}
            context={t("designSystem.demo.today", { outlet: sampleOutlet })}
            source={<a href="#shell">{t("designSystem.demo.viewOrders")}</a>}
          />
        </StatStrip>
        <div className="overflow-hidden rounded-container border bg-card">
          <OrdersTable orders={sampleOrders} />
        </div>
      </div>
    </ManagementShell>
  );
}

export function ShellsSection() {
  const t = useT();
  return (
    <Section
      id="shell"
      title={t("designSystem.sections.shells")}
      aside={<Badge tone="warning">{t("common.sampleData")}</Badge>}
    >
      <div className="grid gap-8 xl:grid-cols-[390px_minmax(0,1fr)]">
        <Frame
          label={t("designSystem.shells.customer")}
          className="mx-auto h-[640px] w-full max-w-[390px]"
        >
          <CustomerPreview />
        </Frame>
        <div className="grid min-w-0 content-start gap-8">
          <Frame
            label={t("designSystem.shells.operations")}
            className="h-[400px]"
          >
            <OperationsPreview
              mode="dark"
              title={t("designSystem.demo.kdsTitle", {
                station: sampleStation,
              })}
            />
          </Frame>
          <Frame
            label={t("designSystem.shells.operationsLight")}
            className="h-[400px]"
          >
            <OperationsPreview
              mode="light"
              title={t("designSystem.demo.posTitle")}
            />
          </Frame>
        </div>
      </div>
      <Frame label={t("designSystem.shells.management")} className="h-[560px]">
        <ManagementPreview />
      </Frame>
    </Section>
  );
}
