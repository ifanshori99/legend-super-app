// Back-office "Status edge" (legend-ph62j, mockup receipt-run-s7szu): the edge
// nodes of the tenant's outlets plus the repeated receipt-number rotation
// alert (legend-s7szu). The POS keeps its own screen at /operasional/koneksi.
import { useState } from "react";
import { HardDrive, Link2Off } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { isEdgeContractPending, useEdgeNodes } from "../hooks.ts";
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
      className="grid gap-4 border-t-(length:--border-w) pt-4 first:border-t-0 first:pt-0"
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
  const alert = data?.receiptRunAlert ?? null;
  // Confirms a manual refresh that found no receipt-run alert.
  const [refreshed, setRefreshed] = useState(false);
  // Spinner only for a manual refresh: a background fetch on mount would make
  // the client markup differ from the server HTML (hydration mismatch).
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshed(false);
    setRefreshing(true);
    void nodes
      .refetch()
      .then((result) => {
        if (result.isSuccess && result.data.receiptRunAlert === null)
          setRefreshed(true);
      })
      .finally(() => setRefreshing(false));
  };
  const pending = nodes.isError && isEdgeContractPending(nodes.error);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid min-w-0 gap-1">
          <h1 className="type-display">{t("edgeNodes.title")}</h1>
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

      {refreshed && !alert && !refreshing && (
        <p
          role="status"
          className="rounded-container border-(length:--border-w) border-success bg-success-subtle p-4 text-sm leading-5 font-semibold text-foreground"
        >
          {t("edgeNodes.refreshed")}
        </p>
      )}

      {alert && (
        <ReceiptRunAlert edgeNodeId={alert.nodeName} alertAt={alert.alertAt} />
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
              icon={pending ? Link2Off : undefined}
              title={t(
                pending ? "edgeNodes.pendingTitle" : "edgeNodes.errorTitle",
              )}
              description={t(
                pending ? "edgeNodes.pendingHint" : "edgeNodes.errorHint",
              )}
              onRetry={pending ? undefined : () => void nodes.refetch()}
            />
          )}

          {data && data.nodes.length === 0 && (
            <EmptyState
              icon={HardDrive}
              title={t("edgeNodes.emptyTitle")}
              description={t("edgeNodes.emptyHint")}
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
