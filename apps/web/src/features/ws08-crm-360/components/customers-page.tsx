// Customer 360 list (/kelola/pelanggan; PRD v1.7 §3.21 "Customer 360":
// profile, visit history, favorite items, spend, tier and points, according to
// the role's permissions). This screen is the searchable directory; the
// profile itself opens on its own URL.
//
// PRD §3.21 "sesuai izin role" + §2 privacy: the DTO carries no phone number or
// hash, so the remaining PII fields (birth day, referral code) are only shown
// on the detail screen and only to a role holding `crm.customer.view`. The list
// states that rule in one hint instead of pretending the data is complete.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Info, RotateCw } from "lucide-react";
import type { MembershipStatus } from "@starter/shared/crm";
import { formatNumber } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { Money, NumberDisplay } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCustomers, useTiers } from "../hooks";
import { formatDate } from "../lib";
import { useCrm360T } from "../t";
import {
  CursorPager,
  MembershipStatusPill,
  Notice,
  ReadProblem,
} from "./crm-shell";

const PAGE_SIZE = 20;
const ALL = "all";

const MEMBERSHIP_OPTIONS: readonly MembershipStatus[] = [
  "pending_verification",
  "active",
  "suspended",
  "closed",
];

export function CustomersPage() {
  const t = useCrm360T();
  const common = useT();

  const [search, setSearch] = React.useState("");
  const deferredSearch = React.useDeferredValue(search);
  const [tier, setTier] = React.useState<string>(ALL);
  const [status, setStatus] = React.useState<string>(ALL);
  // Cursor stack: index 0 is the first page; the last entry is the open page.
  const [cursors, setCursors] = React.useState<(string | undefined)[]>([
    undefined,
  ]);
  const cursor = cursors.at(-1);

  const needle = deferredSearch.trim();
  const customers = useCustomers({
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(needle === "" ? {} : { q: needle }),
    ...(tier === ALL ? {} : { tierId: tier }),
    ...(status === ALL ? {} : { membershipStatus: status as MembershipStatus }),
  });
  const tiers = useTiers();

  const tierNames = new Map(
    (tiers.data?.data ?? []).map((row) => [row.id, row.name]),
  );
  const rows = customers.data?.data ?? [];
  const nextCursor = customers.data?.meta.nextCursor ?? null;
  const filtered = search.trim() !== "" || tier !== ALL || status !== ALL;

  function resetPages() {
    setCursors([undefined]);
  }

  function clearFilters() {
    setSearch("");
    setTier(ALL);
    setStatus(ALL);
    resetPages();
  }

  const state = customers.isPending
    ? "loading"
    : rows.length === 0
      ? "empty"
      : "ready";

  const tierLabel = (tierId: string | null) =>
    tierId === null
      ? t("crm360.customers.noTier")
      : (tierNames.get(tierId) ?? t("crm360.customers.noTier"));

  const lastVisit = (value: string | null) =>
    value === null ? t("crm360.customers.neverVisited") : formatDate(value);

  const emptyState = filtered
    ? {
        title: t("crm360.customers.filteredTitle"),
        description: t("crm360.customers.filteredHint"),
        action: (
          <Button variant="outline" size="sm" onClick={clearFilters}>
            {t("crm360.customers.clearFilters")}
          </Button>
        ),
      }
    : {
        title: t("crm360.customers.emptyTitle"),
        description: t("crm360.customers.emptyHint"),
        action: (
          <Button
            variant="outline"
            size="sm"
            loading={customers.isFetching}
            onClick={() => void customers.refetch()}
          >
            <RotateCw aria-hidden="true" />
            {common("common.retry")}
          </Button>
        ),
      };

  return (
    <div className="grid min-w-0 gap-4">
      <Notice tone="info" icon={Info}>
        {t("crm360.pii.hint")}
      </Notice>

      {customers.isError && customers.data === undefined ? (
        <ReadProblem
          error={customers.error}
          title={t("crm360.customers.loadError")}
          hint={t("crm360.customers.loadHint")}
          offlineTitle={t("crm360.customers.offlineTitle")}
          offlineHint={t("crm360.customers.offlineHint")}
          onRetry={() => void customers.refetch()}
        />
      ) : (
        <DataTableShell
          title={t("crm360.customers.title")}
          description={t("crm360.customers.description")}
          state={state}
          search={{
            value: search,
            onChange: (value) => {
              setSearch(value);
              resetPages();
            },
            label: t("crm360.customers.searchLabel"),
          }}
          actions={
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                value={tier}
                onValueChange={(value) => {
                  setTier(value);
                  resetPages();
                }}
              >
                <SelectTrigger
                  aria-label={t("crm360.customers.filterTier")}
                  className="sm:w-44"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t("crm360.customers.allTiers")}
                  </SelectItem>
                  {(tiers.data?.data ?? []).map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={status}
                onValueChange={(value) => {
                  setStatus(value);
                  resetPages();
                }}
              >
                <SelectTrigger
                  aria-label={t("crm360.customers.filterStatus")}
                  className="sm:w-48"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t("crm360.customers.allStatuses")}
                  </SelectItem>
                  {MEMBERSHIP_OPTIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`crm360.membership.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
          onRetry={() => void customers.refetch()}
          empty={emptyState}
          loadingRows={6}
        >
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("crm360.customers.columns.name")}</TableHead>
                  <TableHead>{t("crm360.customers.columns.tier")}</TableHead>
                  <TableHead>
                    {t("crm360.customers.columns.lastVisit")}
                  </TableHead>
                  <TableHead numeric>
                    {t("crm360.customers.columns.spend")}
                  </TableHead>
                  <TableHead numeric>
                    {t("crm360.customers.columns.points")}
                  </TableHead>
                  <TableHead>{t("crm360.customers.columns.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((profile) => (
                  <TableRow key={profile.id}>
                    <TableCell>
                      <Link
                        to="/kelola/pelanggan/$customerProfileId"
                        params={{ customerProfileId: profile.id }}
                        aria-label={t("crm360.customers.openDetail", {
                          name: profile.name,
                        })}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {profile.name}
                      </Link>
                    </TableCell>
                    <TableCell>{tierLabel(profile.tierId)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular">
                      {lastVisit(profile.lastVisitAt)}
                    </TableCell>
                    <TableCell numeric>
                      <Money amount={profile.lifetimeSpendIdr} size="sm" />
                    </TableCell>
                    <TableCell numeric>
                      <NumberDisplay value={profile.pointsBalance} />
                    </TableCell>
                    <TableCell>
                      <MembershipStatusPill status={profile.membershipStatus} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="md:hidden">
            {rows.map((profile) => (
              <li
                key={profile.id}
                className="grid gap-2 border-b px-card py-3 last:border-b-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    to="/kelola/pelanggan/$customerProfileId"
                    params={{ customerProfileId: profile.id }}
                    aria-label={t("crm360.customers.openDetail", {
                      name: profile.name,
                    })}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {profile.name}
                  </Link>
                  <MembershipStatusPill status={profile.membershipStatus} />
                </div>
                <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                  <div className="flex min-w-0 gap-1">
                    <dt className="text-muted-foreground">
                      {t("crm360.customers.columns.tier")}:
                    </dt>
                    <dd className="min-w-0 break-words">
                      {tierLabel(profile.tierId)}
                    </dd>
                  </div>
                  <div className="flex min-w-0 gap-1">
                    <dt className="text-muted-foreground">
                      {t("crm360.customers.columns.lastVisit")}:
                    </dt>
                    <dd className="min-w-0 break-words tabular">
                      {lastVisit(profile.lastVisitAt)}
                    </dd>
                  </div>
                  <div className="flex min-w-0 gap-1">
                    <dt className="text-muted-foreground">
                      {t("crm360.customers.columns.spend")}:
                    </dt>
                    <dd className="min-w-0">
                      <Money amount={profile.lifetimeSpendIdr} size="sm" />
                    </dd>
                  </div>
                  <div className="flex min-w-0 gap-1">
                    <dt className="text-muted-foreground">
                      {t("crm360.customers.columns.points")}:
                    </dt>
                    <dd className="min-w-0">
                      <NumberDisplay value={profile.pointsBalance} />
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>

          <CursorPager
            countLabel={t("crm360.customers.rowCount", {
              count: formatNumber(rows.length),
            })}
            canPrevious={cursors.length > 1}
            canNext={nextCursor !== null}
            pending={customers.isFetching}
            onPrevious={() => setCursors((current) => current.slice(0, -1))}
            onNext={() => {
              if (nextCursor === null) return;
              setCursors((current) => [...current, nextCursor]);
            }}
          />
        </DataTableShell>
      )}
    </div>
  );
}
