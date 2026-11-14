// Shared frame for every accounting back-office screen: page title, the two-tier
// section navigation between accounting areas, and the content slot. Tabs are
// links, not Radix tabs, because each section has its own URL (docs/frontend.md
// "Add a page"). PRD v1.7 §3.19, §5 "/kelola/*".
//
// Tier 1 is the group (Buku Besar · Kas & Bank · Pajak · Utang & Aset · Laporan
// · Bagi Hasil, beads legend-53q/5fdy/m4zn/rx0h/ogx3); tier 2 the sections of
// the active group. Thirteen sections in one strip would scroll past the fold on
// a 390px phone and read as a menu with no hierarchy.
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { MessageKey } from "@starter/shared/i18n";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { tabsListClass, tabsTriggerClass } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";

export const ACCOUNTING_GROUPS = [
  "books",
  "cash",
  "tax",
  "assets",
  "reports",
  "share",
] as const;

export type AccountingGroup = (typeof ACCOUNTING_GROUPS)[number];

type Section = {
  readonly key: string;
  readonly group: AccountingGroup;
  readonly labelKey: MessageKey;
  readonly to: string;
};

const SECTIONS = [
  // Buku Besar (legend-mzg).
  {
    key: "coa",
    group: "books",
    labelKey: "accounting.tabs.coa",
    to: "/kelola/akuntansi",
  },
  {
    key: "mapping",
    group: "books",
    labelKey: "accounting.tabs.mapping",
    to: "/kelola/akuntansi/pemetaan",
  },
  {
    key: "journals",
    group: "books",
    labelKey: "accounting.tabs.journals",
    to: "/kelola/akuntansi/jurnal",
  },
  {
    key: "manual",
    group: "books",
    labelKey: "accounting.tabs.manual",
    to: "/kelola/akuntansi/jurnal-manual",
  },
  {
    key: "recurring",
    group: "books",
    labelKey: "accounting.tabs.recurring",
    to: "/kelola/akuntansi/jurnal-berulang",
  },
  // Pengecualian finance (legend-4oclu).
  {
    key: "exceptions",
    group: "books",
    labelKey: "financeExceptions.tab",
    to: "/kelola/akuntansi/pengecualian",
  },
  // Kas & Bank (legend-53q; ACC-04, ACC-05).
  {
    key: "cash",
    group: "cash",
    labelKey: "accounting.tabs.cash",
    to: "/kelola/akuntansi/kas-bank",
  },
  {
    key: "recon",
    group: "cash",
    labelKey: "accounting.tabs.recon",
    to: "/kelola/akuntansi/rekonsiliasi",
  },
  // Pajak (legend-5fdy).
  {
    key: "tax",
    group: "tax",
    labelKey: "accounting.tabs.tax",
    to: "/kelola/akuntansi/pajak",
  },
  // Utang, piutang, aset tetap, anggaran (legend-m4zn).
  {
    key: "aging",
    group: "assets",
    labelKey: "accounting.tabs.aging",
    to: "/kelola/akuntansi/piutang-utang",
  },
  {
    key: "assets",
    group: "assets",
    labelKey: "accounting.tabs.assets",
    to: "/kelola/akuntansi/aset-tetap",
  },
  {
    key: "budgets",
    group: "assets",
    labelKey: "accounting.tabs.budgets",
    to: "/kelola/akuntansi/anggaran",
  },
  // Laporan keuangan + tutup periode (legend-rx0h; ACC-02, ACC-03).
  {
    key: "statements",
    group: "reports",
    labelKey: "accounting.tabs.statements",
    to: "/kelola/akuntansi/laporan",
  },
  {
    key: "periods",
    group: "reports",
    labelKey: "accounting.tabs.periods",
    to: "/kelola/akuntansi/tutup-periode",
  },
  // Bagi hasil (legend-ogx3; SH-03, SH-04).
  {
    key: "shareholders",
    group: "share",
    labelKey: "accounting.tabs.shareholders",
    to: "/kelola/akuntansi/bagi-hasil",
  },
  {
    key: "distributions",
    group: "share",
    labelKey: "accounting.tabs.distributions",
    to: "/kelola/akuntansi/bagi-hasil/distribusi",
  },
] as const satisfies readonly Section[];

export type AccountingSection = (typeof SECTIONS)[number]["key"];

const GROUP_KEYS: Record<AccountingGroup, MessageKey> = {
  books: "accounting.tabs.groups.books",
  cash: "accounting.tabs.groups.cash",
  tax: "accounting.tabs.groups.tax",
  assets: "accounting.tabs.groups.assets",
  reports: "accounting.tabs.groups.reports",
  share: "accounting.tabs.groups.share",
};

/** The group a section belongs to; unknown keys fall back to the first group. */
export function groupOfSection(active: AccountingSection): AccountingGroup {
  return SECTIONS.find((section) => section.key === active)?.group ?? "books";
}

/** Sections of one group, in display order. */
export function sectionsOfGroup(
  group: AccountingGroup,
): readonly { key: string; labelKey: MessageKey; to: string }[] {
  return SECTIONS.filter((section) => section.group === group);
}

function keepInView(node: HTMLAnchorElement | null) {
  node?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function SectionLink({
  to,
  label,
  current,
  scrollIntoView,
}: {
  to: string;
  label: string;
  current: boolean;
  scrollIntoView: boolean;
}) {
  return (
    <Link
      to={to}
      // Exact match only: a parent link must not keep its own aria-current on
      // a child section (two current tabs, legend-jda7).
      activeOptions={{ exact: true }}
      // On 390px the strip scrolls; keep the current tab in view.
      ref={scrollIntoView ? keepInView : undefined}
      aria-current={current ? "page" : undefined}
      className={cn(tabsTriggerClass, "max-md:min-h-11")}
    >
      {label}
    </Link>
  );
}

export function AccountingTabs({ active }: { active: AccountingSection }) {
  const t = useT();
  const group = groupOfSection(active);
  const sections = sectionsOfGroup(group);
  return (
    <div className="grid w-full min-w-0 gap-2 sm:w-auto">
      {/* Tier 1: area groups. A group link opens its first section. */}
      <nav
        aria-label={t("accounting.title")}
        className={cn(tabsListClass, "[scrollbar-width:none]")}
      >
        {ACCOUNTING_GROUPS.map((key) => {
          const first = sectionsOfGroup(key)[0];
          if (!first) return null;
          return (
            <SectionLink
              key={key}
              to={first.to}
              label={t(GROUP_KEYS[key])}
              current={key === group}
              scrollIntoView={key === group}
            />
          );
        })}
      </nav>
      {/* Tier 2: sections of the active group, only when there is a choice. */}
      {sections.length > 1 && (
        <nav
          aria-label={t(GROUP_KEYS[group])}
          className={cn(tabsListClass, "[scrollbar-width:none]")}
        >
          {sections.map((section) => (
            <SectionLink
              key={section.key}
              to={section.to}
              label={t(section.labelKey)}
              current={section.key === active}
              scrollIntoView={section.key === active}
            />
          ))}
        </nav>
      )}
    </div>
  );
}

export function AccountingPage({
  active,
  children,
}: {
  active: AccountingSection;
  children: ReactNode;
}) {
  const t = useT();
  return (
    // The management topbar owns the page title (DESIGN.md v3 §5): no second
    // h1 and no extra gutter here. Detail screens render their own h2, and the
    // section screens own their intro, so the area shows only the navigation.
    <div className="grid min-w-0 gap-5">
      {/* 390px: the sample-data badge sits above the strips so both tiers keep the full width. */}
      <div className="flex min-w-0 flex-col-reverse items-start gap-2 sm:flex-row sm:justify-between sm:gap-3">
        <AccountingTabs active={active} />
        {API_MOCK && (
          <Badge tone="neutral" className="shrink-0 sm:mt-1">
            {t("common.sampleData")}
          </Badge>
        )}
      </div>
      <div className="grid min-w-0 gap-5">{children}</div>
    </div>
  );
}
