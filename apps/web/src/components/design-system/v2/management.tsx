import { useT } from "@/components/i18n";
// Management surface (Padat): kelola dashboard home + data table — v1 vs v2.
// BEFORE uses the shipped ManagementShell, StatTile, and Table. AFTER shows
// the v2 shell (grouped sidebar on surface-2, tint + rule selected row,
// breadcrumb topbar), "what needs attention" first, one stat strip instead
// of identical cards, a one-accent chart, and a table with a toolbar.
import {
  BadgeCheck,
  Boxes,
  CalendarDays,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  ClipboardCheck,
  Download,
  Info,
  LayoutDashboard,
  Menu,
  ReceiptText,
  Search,
  Settings,
  ShieldCheck,
  Store,
  TableProperties,
  TriangleAlert,
  UsersRound,
  UtensilsCrossed,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import { formatNumber } from "@starter/shared/i18n";
import { ManagementShell } from "@/components/shells/management-shell";
import { ThemeScope } from "@/components/theme-scope";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Compare, Screen, Stage, type CompareView } from "./frame";
import {
  v2Attention,
  v2HourLabels,
  v2Hourly,
  v2HourlyToday,
  v2Stats,
  v2Transactions,
} from "./sample";

export function ManagementCompare({
  view,
  tenant,
}: {
  view: CompareView;
  tenant?: string;
}) {
  const t = useT();
  return (
    <Compare
      view={view}
      before={
        <Stage
          tag="before"
          title={t("designV2.management.text001")}
          note={t("designV2.management.text002")}
        >
          <Screen label={t("designV2.management.text003")}>
            <BeforeDashboard />
          </Screen>
        </Stage>
      }
      after={
        <Stage
          tag="after"
          title={t("designV2.management.text001")}
          note={t("designV2.management.text004")}
        >
          <ThemeScope tenant={tenant} density="padat">
            <Screen label={t("designV2.management.text003")}>
              <AfterDashboard />
            </Screen>
          </ThemeScope>
        </Stage>
      }
    />
  );
}

/* ------------------------------------------------------------ BEFORE */

function BeforeDashboard() {
  const t = useT();
  return (
    <ManagementShell
      embedded
      brandName={t("designV2.management.text005")}
      pageTitle={t("designV2.management.text006")}
      user={{
        name: t("designV2.management.text007"),
        role: t("designV2.management.text008"),
      }}
      nav={[
        {
          label: t("designV2.management.text006"),
          href: "#manajemen",
          icon: LayoutDashboard,
          current: true,
        },
        {
          label: t("designV2.management.text009"),
          href: "#manajemen",
          icon: ClipboardCheck,
          count: 4,
        },
        {
          label: t("designV2.management.text010"),
          href: "#manajemen",
          icon: Boxes,
        },
        {
          label: t("designV2.management.text011"),
          href: "#manajemen",
          icon: UtensilsCrossed,
        },
        {
          label: t("designV2.management.text012"),
          href: "#manajemen",
          icon: Wallet,
        },
        {
          label: t("designV2.management.text013"),
          href: "#manajemen",
          icon: UsersRound,
        },
      ]}
      footerNav={[
        {
          label: t("designV2.management.text014"),
          href: "#manajemen",
          icon: Settings,
        },
      ]}
    >
      <div className="grid gap-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {v2Stats.map((stat) => (
            <StatTile
              key={stat.label}
              label={stat.label}
              value={
                typeof stat.value === "number" && stat.money ? (
                  <Money amount={stat.value} />
                ) : typeof stat.value === "number" ? (
                  formatNumber(stat.value)
                ) : (
                  stat.value
                )
              }
              context={stat.context}
              source={<a href="#manajemen">{stat.link}</a>}
            />
          ))}
        </div>
        <div className="grid gap-3">
          <p className="text-lg font-semibold">
            {t("designV2.management.text015")}
          </p>
          <TransactionsTable />
        </div>
      </div>
    </ManagementShell>
  );
}

function TransactionsTable({ v2 = false }: { v2?: boolean }) {
  const t = useT();
  return (
    <Table>
      <TableHeader className={cn(v2 && "bg-surface-2")}>
        <TableRow className={cn(v2 && "hover:bg-transparent")}>
          <TableHead>{t("designV2.management.text016")}</TableHead>
          <TableHead>{t("designV2.management.text017")}</TableHead>
          <TableHead>{t("designV2.management.text018")}</TableHead>
          <TableHead>{t("designV2.management.text019")}</TableHead>
          <TableHead>{t("designV2.management.text020")}</TableHead>
          <TableHead numeric>{t("designV2.management.text021")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {v2Transactions.map((tx) => (
          <TableRow
            key={tx.code}
            className={cn(
              v2 && "whitespace-nowrap last:border-b-0 hover:bg-surface-3",
            )}
          >
            <TableCell className="text-muted-foreground tabular">
              {tx.time}
            </TableCell>
            <TableCell className={cn(v2 && "font-mono text-sm")}>
              {tx.code}
            </TableCell>
            <TableCell className="tabular">{tx.table}</TableCell>
            <TableCell>{tx.channel}</TableCell>
            <TableCell>
              <StatusPill status={tx.status} />
            </TableCell>
            <TableCell numeric>
              <Money amount={tx.total} className={cn(v2 && "font-medium")} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------------- AFTER */

type NavItem = {
  label: string;
  icon: LucideIcon;
  count?: number;
  current?: boolean;
};
function SideNav() {
  const t = useT();
  const NAV_GROUPS: { title?: string; items: NavItem[] }[] = [
    {
      items: [
        {
          label: t("designV2.management.text006"),
          icon: LayoutDashboard,
          current: true,
        },
        {
          label: t("designV2.management.text022"),
          icon: ClipboardCheck,
          count: 4,
        },
      ],
    },
    {
      title: t("designV2.management.text023"),
      items: [
        { label: t("designV2.management.text024"), icon: ReceiptText },
        { label: t("designV2.management.text025"), icon: TableProperties },
        { label: t("designV2.management.text011"), icon: UtensilsCrossed },
        { label: t("designV2.management.text010"), icon: Boxes },
      ],
    },
    {
      title: t("designV2.management.text026"),
      items: [
        { label: t("designV2.management.text027"), icon: Wallet },
        { label: t("designV2.management.text028"), icon: BadgeCheck },
      ],
    },
    {
      title: t("designV2.management.text029"),
      items: [
        { label: t("designV2.management.text013"), icon: UsersRound },
        { label: t("designV2.management.text030"), icon: ShieldCheck },
      ],
    },
  ];

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-e bg-surface-2 lg:flex">
      <div className="flex h-14 items-center gap-2.5 border-b px-3">
        <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
          <Store className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-semibold">
            {t("designV2.management.text031")}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {t("designV2.management.text032")}
          </p>
        </div>
        <ChevronsUpDown
          className="size-4 text-muted-foreground"
          aria-hidden="true"
        />
      </div>
      <nav
        aria-label={t("designV2.management.text033")}
        className="grid gap-5 p-3"
      >
        {NAV_GROUPS.map((group, index) => (
          <div key={group.title ?? index} className="grid gap-0.5">
            {group.title && (
              <p className="px-3 pb-1 type-eyebrow text-muted-foreground">
                {group.title}
              </p>
            )}
            {group.items.map((item) => (
              <span
                key={item.label}
                aria-current={item.current ? "page" : undefined}
                className={cn(
                  "relative flex h-9 items-center gap-2.5 rounded-md px-3 text-sm",
                  item.current
                    ? "bg-primary-tint font-semibold text-primary before:absolute before:inset-y-2 before:start-0 before:w-0.5 before:rounded-full before:bg-primary"
                    : "text-foreground",
                )}
              >
                <item.icon
                  className={cn(
                    "size-4",
                    !item.current && "text-muted-foreground",
                  )}
                  aria-hidden="true"
                />
                {item.label}
                {item.count !== undefined && (
                  <span className="ms-auto rounded-full bg-surface-3 px-1.5 text-xs leading-5 font-semibold text-foreground tabular">
                    {item.count}
                  </span>
                )}
              </span>
            ))}
          </div>
        ))}
      </nav>
      <div className="mt-auto grid gap-0.5 border-t p-3">
        <span className="flex h-9 items-center gap-2.5 rounded-md px-3 text-sm">
          <Settings
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {t("designV2.management.text014")}
        </span>
        <div className="flex items-center gap-2.5 px-3 pt-2">
          <span className="grid size-8 place-items-center rounded-full bg-surface-3 text-xs font-semibold">
            {t("designV2.management.text034")}
          </span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-medium">
              {t("designV2.management.text007")}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {t("designV2.management.text008")}
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}

function TopBar() {
  const t = useT();
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 lg:px-6">
      <span className="grid size-9 place-items-center rounded-md lg:hidden">
        <Menu
          className="size-5"
          aria-label={t("designV2.management.text035")}
        />
      </span>
      <p className="flex items-center gap-1.5 text-sm">
        <span className="hidden text-muted-foreground sm:inline">
          {t("designV2.management.text036")}
        </span>
        <ChevronRight
          className="hidden size-3.5 text-muted-foreground sm:inline"
          aria-hidden="true"
        />
        <span className="font-semibold">
          {t("designV2.management.text006")}
        </span>
      </p>
      <div className="ms-auto hidden h-9 w-80 items-center gap-2 rounded-md bg-surface-2 px-3 text-sm whitespace-nowrap text-muted-foreground md:flex">
        <Search className="size-4" aria-hidden="true" />
        {t("designV2.management.text037")}
        <kbd className="ms-auto rounded border bg-background px-1.5 font-sans text-xs">
          {t("designV2.management.text038")}
        </kbd>
      </div>
      <span className="ms-auto grid size-9 place-items-center rounded-md md:hidden">
        <Search
          className="size-5"
          aria-label={t("designV2.management.text039")}
        />
      </span>
    </header>
  );
}

function AttentionList() {
  const t = useT();
  const icon = { danger: CircleAlert, warning: TriangleAlert, info: Info };
  const tone = {
    danger: "bg-danger-subtle text-danger",
    warning: "bg-warning-subtle text-warning",
    info: "bg-info-subtle text-info",
  };
  return (
    <section
      aria-labelledby="perlu-perhatian"
      className="rounded-container border bg-card"
    >
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 id="perlu-perhatian" className="type-heading">
          {t("designV2.management.text040")}
        </h2>
        <span className="rounded-full bg-surface-3 px-2 text-xs leading-5 font-semibold tabular">
          {v2Attention.length}
        </span>
      </header>
      <ul className="divide-y">
        {v2Attention.map((row) => {
          const Icon = icon[row.tone];
          return (
            <li key={row.text} className="flex items-center gap-3 px-4 py-3">
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full",
                  tone[row.tone],
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <p className="min-w-0 flex-1 text-sm leading-5">{row.text}</p>
              <Button variant="outline" size="sm" className="shrink-0">
                {row.action}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StatStrip() {
  const t = useT();
  return (
    <section
      aria-label={t("designV2.management.text041")}
      className="grid overflow-hidden rounded-container border bg-card sm:grid-cols-2"
    >
      {v2Stats.map((stat, index) => (
        <div
          key={stat.label}
          className={cn(
            "grid content-start gap-1 p-5",
            index > 0 && "border-t sm:border-t-0",
            index % 2 === 1 && "sm:border-s",
            index >= 2 && "sm:border-t",
          )}
        >
          <p className="text-sm font-medium text-muted-foreground">
            {stat.label}
          </p>
          {typeof stat.value === "number" && stat.money ? (
            <Money amount={stat.value} size="stat" />
          ) : (
            <p className="type-money-display">
              {typeof stat.value === "number"
                ? formatNumber(stat.value)
                : stat.value}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{stat.context}</p>
          <a
            href="#manajemen"
            className="mt-2 inline-flex w-fit items-center gap-0.5 text-sm font-semibold text-primary"
          >
            {stat.link}
            <ChevronRight className="size-4" aria-hidden="true" />
          </a>
        </div>
      ))}
    </section>
  );
}

const CHART_MAX = 2500;

function HourlyChart() {
  const t = useT();
  return (
    <section
      aria-labelledby="chart-title"
      className="grid gap-4 rounded-container border bg-card p-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="chart-title" className="type-heading">
            {t("designV2.management.text042")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("designV2.management.text043")}
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-chart-accent" />
            {t("designV2.management.text044")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded-full bg-chart-neutral" />{" "}
            {t("designV2.management.text045")}
          </span>
        </div>
      </header>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
        <div className="relative h-48 w-10 text-end text-xs text-muted-foreground tabular">
          {[2000, 1000, 0].map((tick) => (
            <span
              key={tick}
              className="absolute end-0 -translate-y-1/2"
              style={{ top: `${(1 - tick / CHART_MAX) * 100}%` }}
            >
              {formatNumber(tick)}
            </span>
          ))}
        </div>
        <div
          role="img"
          aria-label={t("designV2.management.text047")}
          className="relative h-48 border-b border-chart-neutral"
        >
          {[1000, 2000].map((tick) => (
            <span
              key={tick}
              aria-hidden="true"
              className="absolute inset-x-0 border-t border-chart-grid"
              style={{ top: `${(1 - tick / CHART_MAX) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 grid grid-cols-14 items-end gap-1.5 sm:gap-2.5">
            {v2Hourly.map((avg, index) => {
              const today = v2HourlyToday[index];
              return (
                <div key={v2HourLabels[index]} className="relative h-full">
                  {today !== undefined && (
                    <span
                      className="absolute inset-x-0 bottom-0 rounded-t-[3px] bg-chart-accent"
                      style={{ height: `${(today / CHART_MAX) * 100}%` }}
                    />
                  )}
                  <span
                    className="absolute -inset-x-0.5 h-0.5 rounded-full bg-chart-neutral"
                    style={{ bottom: `${(avg / CHART_MAX) * 100}%` }}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <span />
        <div className="mt-2 grid grid-cols-14 gap-1.5 text-center text-xs text-muted-foreground tabular sm:gap-2.5">
          {v2HourLabels.map((label, index) => (
            <span
              key={label}
              className={cn(index % 2 === 1 && "max-sm:invisible")}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function AfterDashboard() {
  const t = useT();
  return (
    <div className="flex min-h-full">
      <SideNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="min-h-0 flex-1 bg-background">
          <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 lg:px-8 lg:py-8">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="type-eyebrow text-muted-foreground">
                  {t("designV2.management.text048")}
                </p>
                <h1 className="mt-1 type-display">
                  {t("designV2.management.text006")}
                </h1>
              </div>
              <div className="flex gap-2">
                <Button variant="outline">
                  <CalendarDays aria-hidden="true" />
                  {t("designV2.management.text044")}
                </Button>
                <Button variant="outline">
                  <Download aria-hidden="true" />
                  {t("designV2.management.text049")}
                </Button>
              </div>
            </div>
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
              <div className="order-2 grid min-w-0 gap-6 xl:order-1">
                <StatStrip />
                <HourlyChart />
              </div>
              <div className="order-1 min-w-0 xl:order-2">
                <AttentionList />
              </div>
            </div>
            <section
              aria-labelledby="tx-title"
              className="overflow-hidden rounded-container border bg-card"
            >
              <header className="flex flex-wrap items-center gap-3 px-4 py-3">
                <h2 id="tx-title" className="type-heading">
                  {t("designV2.management.text015")}
                </h2>
                <div className="inline-flex rounded-md bg-surface-2 p-0.5 text-sm font-medium">
                  {[
                    t("designV2.management.text050"),
                    t("designV2.management.text051"),
                    t("designV2.management.text052"),
                  ].map((label, index) => (
                    <span
                      key={label}
                      className={cn(
                        "rounded-[5px] px-2.5 py-1",
                        index === 0
                          ? "bg-card shadow-raised"
                          : "text-muted-foreground",
                      )}
                    >
                      {label}
                    </span>
                  ))}
                </div>
                <div className="ms-auto flex h-9 w-full items-center gap-2 rounded-md border border-input px-3 text-sm text-muted-foreground sm:w-60">
                  <Search className="size-4" aria-hidden="true" />
                  {t("designV2.management.text053")}
                </div>
              </header>
              <TransactionsTable v2 />
              <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
                <span className="tabular">
                  {t("designV2.management.text054")}
                </span>
                <span className="inline-flex gap-2">
                  <Button variant="outline" size="sm" disabled>
                    {t("designV2.management.text055")}
                  </Button>
                  <Button variant="outline" size="sm">
                    {t("designV2.management.text056")}
                  </Button>
                </span>
              </footer>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
