// /platform/kesehatan — platform health tiles (PRD v1.7 §3 F4 Super Admin).
// The platform contract has no infrastructure health feed, so only what the
// existing endpoints really provide is shown: tenant statuses and, from each
// tenant's usage view, quotas and cost caps near or at their limit. Nothing is
// estimated; the missing infrastructure metrics are said so plainly.
import { Link } from "@tanstack/react-router";
import { Server } from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/feedback-state";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFleetUsage, useTenants } from "../hooks";
import { attentionItems, tenantCounts, type AttentionItem } from "../logic";
import { OpsPage, Section, SectionError, SectionLoading } from "./ops-shell";

export function HealthPage() {
  const t = useT();
  const tenants = useTenants();
  const rows = tenants.data?.data ?? [];
  const watched = rows.filter((row) => row.status !== "archived");
  const usages = useFleetUsage(watched.map((row) => row.id));

  const loading = tenants.isPending || usages.some((query) => query.isPending);
  const failed = tenants.isError || usages.some((query) => query.isError);

  const items: AttentionItem[] = watched.flatMap((row, index) => {
    const view = usages[index]?.data?.data;
    return view ? attentionItems(row.id, view) : [];
  });
  const nameOf = (id: string) =>
    rows.find((row) => row.id === id)?.name ?? id.slice(0, 8);
  const counts = tenantCounts(rows);

  return (
    <OpsPage>
      {loading ? (
        <Section title={t("platformOps.health.tenantsTitle")}>
          <SectionLoading rows={3} />
        </Section>
      ) : failed ? (
        <Section title={t("platformOps.health.tenantsTitle")}>
          <SectionError
            onRetry={() => {
              void tenants.refetch();
              usages.forEach((query) => void query.refetch());
            }}
          />
        </Section>
      ) : rows.length === 0 ? (
        <Section title={t("platformOps.health.tenantsTitle")}>
          <EmptyState
            title={t("platformOps.noTenantsTitle")}
            description={t("platformOps.noTenantsHint")}
          />
        </Section>
      ) : (
        <>
          <StatStrip label={t("platformOps.health.tenantsTitle")} columns={4}>
            <StatTile
              label={t("platformOps.health.tileActive")}
              value={formatNumber(counts.active)}
              context={t("platformOps.health.ofTotal", { total: counts.total })}
            />
            <StatTile
              label={t("platformOps.health.tileSuspended")}
              value={formatNumber(counts.suspended)}
              context={t("platformOps.health.ofTotal", { total: counts.total })}
            />
            <StatTile
              label={t("platformOps.health.tileArchived")}
              value={formatNumber(counts.archived)}
              context={t("platformOps.health.ofTotal", { total: counts.total })}
            />
            <StatTile
              label={t("platformOps.health.tileAttention")}
              value={formatNumber(items.length)}
              context={t("platformOps.health.attentionContext")}
              source={
                <Link to="/platform/kuota">
                  {t("platformOps.health.openQuota")}
                </Link>
              }
            />
          </StatStrip>

          <Section
            title={t("platformOps.health.attentionTitle")}
            description={t("platformOps.health.attentionDescription")}
            bodyClassName="p-0"
          >
            {items.length === 0 ? (
              <EmptyState
                title={t("platformOps.health.attentionEmptyTitle")}
                description={t("platformOps.health.attentionEmptyHint")}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {t("platformOps.health.columnTenant")}
                    </TableHead>
                    <TableHead>{t("platformOps.health.columnItem")}</TableHead>
                    <TableHead numeric>
                      {t("platformOps.health.columnUsed")}
                    </TableHead>
                    <TableHead>{t("platformOps.health.columnState")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={`${item.tenantId}:${item.kind}:${item.key}`}>
                      <TableCell className="font-semibold">
                        {nameOf(item.tenantId)}
                      </TableCell>
                      <TableCell>
                        {item.kind === "quota"
                          ? t(`platformOps.quotaNames.${item.key as "outlets"}`)
                          : t(`platformOps.capNames.${item.key as "ai"}`)}
                      </TableCell>
                      <TableCell numeric>{item.percent}%</TableCell>
                      <TableCell>
                        <StatusPill
                          status={
                            item.state === "stopped" ? "danger" : "warning"
                          }
                          className="text-xs"
                        >
                          {t(`platformOps.state.${item.state}`)}
                        </StatusPill>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        </>
      )}

      <Section title={t("platformOps.health.infraTitle")}>
        <EmptyState
          icon={Server}
          title={t("platformOps.health.infraEmptyTitle")}
          description={t("platformOps.health.infraEmptyHint")}
        />
      </Section>
    </OpsPage>
  );
}
