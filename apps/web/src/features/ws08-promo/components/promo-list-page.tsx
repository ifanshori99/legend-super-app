// Promotion list (/kelola/promo; PRD v1.7 §3.21 "Promo Engine"): every rule
// with its benefit in words, validity window, quota, budget spent vs budget
// and status. Edit opens the rule builder; active/paused toggles in place.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Pause, Pencil, Play, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
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
import { useToast } from "@/components/ui/toast";
import type { Promotion, PromotionStatus } from "@starter/shared/crm";
import { formatRupiah } from "@starter/shared/i18n";
import { useMenuItems, usePromotions, useUpdatePromotion } from "../hooks";
import {
  PROMO_STATUSES,
  benefitSummary,
  budgetPercent,
  formatDateLabel,
  type SummaryContext,
} from "../lib";
import { usePromoT, type PromoT } from "../t";
import { PromoStatusPill, useOnline } from "./promo-shell";

type StatusFilter = "all" | PromotionStatus;

function BudgetCell({ promotion, t }: { promotion: Promotion; t: PromoT }) {
  if (promotion.budgetIdr === null)
    return (
      <span className="text-sm text-muted-foreground">
        {t("promo.list.budgetNone")}
      </span>
    );
  const percent = budgetPercent(promotion.spentIdr, promotion.budgetIdr) ?? 0;
  return (
    <div className="grid min-w-32 gap-1">
      <span className="tabular text-sm">
        {t("promo.list.budgetUsed", {
          spent: formatRupiah(promotion.spentIdr),
          budget: formatRupiah(promotion.budgetIdr),
        })}
      </span>
      <div
        role="progressbar"
        aria-label={t("promo.list.budgetBar", { percent })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className={percent >= 90 ? "h-full bg-warning" : "h-full bg-primary"}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function quotaLine(promotion: Promotion, t: PromoT): string {
  const parts: string[] = [];
  if (promotion.quotaTotal !== null)
    parts.push(t("promo.list.quotaTotal", { total: promotion.quotaTotal }));
  if (promotion.quotaPerCustomer !== null)
    parts.push(
      t("promo.list.quotaPerCustomer", { count: promotion.quotaPerCustomer }),
    );
  return parts.length === 0
    ? t("promo.list.quotaUnlimited")
    : parts.join(" · ");
}

function windowLine(promotion: Promotion, t: PromoT): string {
  return promotion.endsAt === null
    ? t("promo.list.windowOpen", { from: formatDateLabel(promotion.startsAt) })
    : t("promo.list.window", {
        from: formatDateLabel(promotion.startsAt),
        to: formatDateLabel(promotion.endsAt),
      });
}

export function PromoListPage() {
  const t = usePromoT();
  const toast = useToast();
  const online = useOnline();
  const [filter, setFilter] = React.useState<StatusFilter>("all");
  const [search, setSearch] = React.useState("");
  const promotionsQuery = usePromotions(filter === "all" ? undefined : filter);
  const menuItemsQuery = useMenuItems();
  const update = useUpdatePromotion();

  const promotions = promotionsQuery.data?.data ?? [];
  const menuItems = menuItemsQuery.data?.data ?? [];
  const filtered = promotions.filter((promotion) =>
    promotion.name
      .toLocaleLowerCase("id-ID")
      .includes(search.trim().toLocaleLowerCase("id-ID")),
  );

  const ctx: SummaryContext = {
    t,
    itemName: (id) => menuItems.find((item) => item.id === id)?.name,
    tierName: () => undefined,
  };
  const benefitLine = (promotion: Promotion) =>
    benefitSummary(promotion.benefit, ctx);

  function toggle(promotion: Promotion) {
    const next = promotion.status === "active" ? "paused" : "active";
    update.mutate(
      { promotionId: promotion.id, body: { status: next } },
      {
        onSuccess: () =>
          toast({
            title: t(
              next === "paused" ? "list.pausedToast" : "list.resumedToast",
              {
                name: promotion.name,
              },
            ),
            tone: "success",
          }),
        onError: () =>
          toast({ title: t("promo.list.actionFailed"), tone: "danger" }),
      },
    );
  }

  const state = promotionsQuery.isPending
    ? "loading"
    : promotionsQuery.isError
      ? "error"
      : promotions.length === 0
        ? "empty"
        : "ready";
  const filteredEmpty = filter !== "all" && promotions.length === 0;

  const addLink = (variant: "default" | "outline") => (
    <Button asChild variant={variant}>
      <Link to="/kelola/promo/$promotionId" params={{ promotionId: "baru" }}>
        <Plus aria-hidden="true" />
        {t("promo.list.add")}
      </Link>
    </Button>
  );

  const rowActions = (promotion: Promotion) => (
    <div className="flex justify-end gap-1">
      {(promotion.status === "active" || promotion.status === "paused") && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={!online || update.isPending}
          aria-label={t(
            promotion.status === "active"
              ? "list.pauseAction"
              : "list.resumeAction",
            { name: promotion.name },
          )}
          onClick={() => toggle(promotion)}
        >
          {promotion.status === "active" ? (
            <Pause aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
        </Button>
      )}
      <Button asChild variant="ghost" size="icon-sm">
        <Link
          to="/kelola/promo/$promotionId"
          params={{ promotionId: promotion.id }}
          aria-label={t("promo.list.edit", { name: promotion.name })}
        >
          <Pencil aria-hidden="true" />
        </Link>
      </Button>
    </div>
  );

  return (
    <DataTableShell
      title={t("promo.list.title")}
      description={t("promo.list.description")}
      state={state}
      search={{
        value: search,
        onChange: setSearch,
        label: t("promo.list.searchLabel"),
      }}
      actions={
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select
            value={filter}
            onValueChange={(value) => setFilter(value as StatusFilter)}
          >
            <SelectTrigger
              aria-label={t("promo.list.filterLabel")}
              className="sm:w-44"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("promo.list.filterAll")}</SelectItem>
              {PROMO_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {t(`promo.status.${status}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {addLink("default")}
        </div>
      }
      onRetry={() => void promotionsQuery.refetch()}
      empty={{
        title: filteredEmpty
          ? t("promo.list.emptyFilteredTitle")
          : t("promo.list.emptyTitle"),
        description: filteredEmpty
          ? t("promo.list.emptyFilteredHint")
          : t("promo.list.emptyHint"),
        action: filteredEmpty ? undefined : addLink("outline"),
      }}
      noResults={filtered.length === 0 && promotions.length > 0}
      rowCount={filtered.length}
    >
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("promo.list.columns.name")}</TableHead>
              <TableHead>{t("promo.list.columns.benefit")}</TableHead>
              <TableHead>{t("promo.list.columns.window")}</TableHead>
              <TableHead>{t("promo.list.columns.quota")}</TableHead>
              <TableHead>{t("promo.list.columns.budget")}</TableHead>
              <TableHead>{t("promo.list.columns.status")}</TableHead>
              <TableHead numeric>{t("promo.list.columns.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((promotion) => (
              <TableRow key={promotion.id}>
                <TableCell className="font-medium">
                  <div className="flex flex-wrap items-center gap-2">
                    {promotion.name}
                    {promotion.voucherRequired && (
                      <Badge tone="brand">{t("promo.list.voucherOnly")}</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  {benefitLine(promotion)}
                </TableCell>
                <TableCell className="tabular text-sm">
                  {windowLine(promotion, t)}
                </TableCell>
                <TableCell className="text-sm">
                  {quotaLine(promotion, t)}
                </TableCell>
                <TableCell>
                  <BudgetCell promotion={promotion} t={t} />
                </TableCell>
                <TableCell>
                  <PromoStatusPill status={promotion.status} />
                </TableCell>
                <TableCell numeric>{rowActions(promotion)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="md:hidden">
        {filtered.map((promotion) => (
          <li
            key={promotion.id}
            className="grid gap-2 border-b px-card py-3 last:border-b-0"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="grid min-w-0 gap-0.5">
                <span className="font-medium">{promotion.name}</span>
                <span className="text-sm text-muted-foreground">
                  {benefitLine(promotion)}
                </span>
              </div>
              <PromoStatusPill status={promotion.status} />
            </div>
            <div className="grid gap-1 text-sm text-muted-foreground">
              <span className="tabular">{windowLine(promotion, t)}</span>
              <span>{quotaLine(promotion, t)}</span>
              {promotion.voucherRequired && (
                <Badge tone="brand">{t("promo.list.voucherOnly")}</Badge>
              )}
            </div>
            <BudgetCell promotion={promotion} t={t} />
            {rowActions(promotion)}
          </li>
        ))}
      </ul>
    </DataTableShell>
  );
}
