// Back-office "Status edge" (legend-ph62j, mockup receipt-run-s7szu): the edge
// nodes of the tenant's outlets plus the repeated receipt-number rotation
// alert (legend-s7szu). The POS keeps its own screen at /operasional/koneksi.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CircleCheck, HardDrive } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useEdgeNodes } from "../hooks.ts";
import { formatAlertTime } from "../logic.ts";
import type { EdgeNodeRow } from "../types.ts";
import { ReceiptRunAlert } from "./receipt-run-alert.tsx";

function NodeFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="type-eyebrow text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-semibold break-words tabular">{value}</dd>
    </div>
  );
}

function NodeSection({ node }: { node: EdgeNodeRow }) {
  const t = useT();
  const connected = node.link === "connected";
  return (
    <section
      aria-label={node.name}
      className="grid gap-4 border-t-(length:--border-w) pt-4 first-of-type:border-t-0 first-of-type:pt-0"
    >
      <div>
        <StatusPill status={connected ? "success" : "danger"}>
          {t(
            connected
              ? "edgeNodes.linkConnected"
              : "edgeNodes.linkDisconnected",
          )}
        </StatusPill>
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        <NodeFact label={t("edgeNodes.nodeLabel")} value={node.name} />
        <NodeFact label={t("edgeNodes.outletLabel")} value={node.outletName} />
        <NodeFact
          label={t("edgeNodes.updatedLabel")}
          value={
            formatAlertTime(node.lastUpdatedAt) ?? t("edgeNodes.updatedUnknown")
          }
        />
      </dl>
    </section>
  );
}

export function EdgeNodesPage() {
  const t = useT();
  const nodes = useEdgeNodes();
  const data = nodes.data;
  const alerts = data?.receiptRunAlerts ?? [];
  // Confirms a manual refresh that found no receipt-run alert. It remembers the
  // fetch it confirmed and goes away after 5 s or when the next fetch lands.
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const refreshed = refreshedAt !== null && refreshedAt === nodes.dataUpdatedAt;
  useEffect(() => {
    if (refreshedAt === null) return;
    const timer = setTimeout(() => setRefreshedAt(null), 5_000);
    return () => clearTimeout(timer);
  }, [refreshedAt]);
  // Spinner only for a manual refresh: a background fetch on mount would make
  // the client markup differ from the server HTML (hydration mismatch).
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshedAt(null);
    setRefreshing(true);
    void nodes
      .refetch()
      .then((result) => {
        if (result.isSuccess && result.data.receiptRunAlerts.length === 0)
          setRefreshedAt(result.dataUpdatedAt);
      })
      .finally(() => setRefreshing(false));
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="type-display">{t("edgeNodes.title")}</h1>
            {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("edgeNodes.hint")}
          </p>
        </div>
        <Button
          variant="outline"
          className="w-full shrink-0 sm:w-auto"
          loading={refreshing}
          onClick={refresh}
        >
          {t("edgeNodes.refresh")}
        </Button>
      </header>

      {refreshed && alerts.length === 0 && !refreshing && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-container border-(length:--border-w) border-success bg-success-subtle p-4 text-sm leading-5 font-semibold text-foreground"
        >
          <CircleCheck
            className="mt-0.5 size-5 shrink-0 text-success"
            aria-hidden="true"
          />
          {t("edgeNodes.refreshed")}
        </p>
      )}

      {alerts.map((alert) => (
        <ReceiptRunAlert
          key={alert.nodeName}
          edgeNodeId={alert.nodeName}
          alertAt={alert.alertAt}
          guideOpen
        />
      ))}

      {nodes.isPending && (
        <Skeleton className="h-72 rounded-container" aria-hidden="true" />
      )}

      <CardShell>
        <Card
          role="region"
          aria-label={t("edgeNodes.listTitle")}
          aria-busy={nodes.isPending || undefined}
        >
          {nodes.isPending && (
            <>
              <span role="status" className="sr-only">
                {t("edgeNodes.loading")}
              </span>
              <Skeleton className="h-6 w-2/5" />
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-16" />
            </>
          )}

          {nodes.isError && (
            <ErrorState
              error={nodes.error}
              title={t("edgeNodes.errorTitle")}
              description={t("edgeNodes.errorHint")}
              onRetry={() => void nodes.refetch()}
            />
          )}

          {data && data.nodes.length === 0 && (
            <EmptyState
              icon={HardDrive}
              title={t("edgeNodes.emptyTitle")}
              description={t("edgeNodes.emptyHint")}
              action={
                <Button asChild variant="outline" size="sm">
                  <Link to="/operasional/koneksi">
                    {t("edgeNodes.connectivityLink")}
                  </Link>
                </Button>
              }
            />
          )}

          {data && data.nodes.length > 0 && (
            <>
              <div className="grid gap-1 border-b-(length:--border-w) pb-4">
                <h2 className="type-title">{t("edgeNodes.listTitle")}</h2>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("edgeNodes.listHint")}
                </p>
              </div>
              {data.nodes.map((node) => (
                <NodeSection key={node.id} node={node} />
              ))}
            </>
          )}
        </Card>
      </CardShell>
    </div>
  );
}
