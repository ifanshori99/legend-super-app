// Admin MCP & AI (WS-12, bead legend-hi82): service controls with the master
// and kill switches, MCP clients (approve, revoke all tokens), and the quota
// and cap card. Sections follow the permission the account holds: governance
// cards need ai.governance.manage, the clients card needs mcp.client.manage.
// The API checks every request; this only hides what the account cannot use.
import { Link } from "@tanstack/react-router";
import { ChartColumn, ScrollText } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback-state";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { API_MOCK } from "@/lib/api/mock-flag";
import { ClientsCard } from "./clients-card";
import { QuotaCard } from "./quota-card";
import { ServiceControls } from "./service-controls";

export function AiAdminPage({ access }: { access: AreaAccess }) {
  const t = useT();
  const canGovern = holdsAny(access, ["ai.governance.manage"]);
  const canClients = holdsAny(access, ["mcp.client.manage"]);
  const canAudit = holdsAny(access, ["audit.log.view"]);

  if (!canGovern && !canClients)
    return (
      <EmptyState
        title={t("aiAdmin.noAccessTitle")}
        description={t("aiAdmin.noAccessHint")}
      />
    );

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 className="type-title">{t("aiAdmin.heading")}</h2>
          <p className="max-w-2xl text-sm leading-5 text-muted-foreground">
            {t("aiAdmin.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
          {canGovern && (
            <Button variant="outline" asChild>
              <Link to="/kelola/pengaturan/mcp-ai/pemakaian">
                <ChartColumn aria-hidden="true" />
                {t("aiAdmin.usageLink")}
              </Link>
            </Button>
          )}
          {canAudit && (
            <Button variant="outline" asChild>
              <Link to="/audit">
                <ScrollText aria-hidden="true" />
                {t("aiAdmin.auditLink")}
              </Link>
            </Button>
          )}
        </div>
      </div>

      {canGovern && <ServiceControls />}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        {canClients && <ClientsCard />}
        {canGovern && <QuotaCard />}
      </div>
    </div>
  );
}
