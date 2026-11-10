// Service-charge rules (PRD §3.14 "Service Charge"): a percentage per zone or
// order type, versioned with effective dates like tax rules. The zone id comes
// from the floor contract; names resolve there, with a fail-safe label when
// the floor read is unavailable.
import * as React from "react";
import { CopyPlus, Pencil, Plus, Send } from "lucide-react";
import type { RuleVersionStatus, ServiceChargeRule } from "@starter/shared/tax";
import { useT } from "@/components/i18n";
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
import { taxMutationError } from "../errors";
import {
  useFloorZones,
  usePublishServiceChargeRule,
  useServiceChargeRules,
} from "../hooks";
import { useTenantContext } from "@/lib/tenant-context";
import { CHANNEL_KEYS, ITEM_CLASS_KEYS } from "../labels";
import {
  businessDateToday,
  filterRuleVersions,
  formatBasisPoints,
  formatBusinessDate,
  sortRuleVersions,
} from "../lib";
import { PublishDialog } from "./publish-dialog";
import { ServiceChargeDialog } from "./service-charge-dialog";
import { ChannelsSummary, ZoneSummary } from "./summaries";
import { EffectiveBadge, VersionStatusBadge } from "./version-badges";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

type StatusFilter = RuleVersionStatus | "all";

type Editor =
  | { mode: "create" }
  | { mode: "edit"; rule: ServiceChargeRule }
  | { mode: "new-version"; rule: ServiceChargeRule };

function RowActions({
  rule,
  showLabels,
  onEdit,
  onPublish,
  onNewVersion,
}: {
  rule: ServiceChargeRule;
  showLabels: boolean;
  onEdit: () => void;
  onPublish: () => void;
  onNewVersion: () => void;
}) {
  const t = useT();
  const editLabel = `${t("tax.serviceCharge.editDraft")} ${rule.code}`;
  const publishLabel = `${t("tax.rules.publish")} ${rule.code}`;
  const versionLabel = t("tax.rules.newVersion");
  if (rule.status === "draft") {
    return (
      <div
        className={
          showLabels
            ? "flex flex-wrap items-center gap-1"
            : "flex items-center justify-end gap-1"
        }
      >
        {showLabels ? (
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            <Pencil aria-hidden="true" />
            {t("tax.serviceCharge.editDraft")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={editLabel}
            onClick={onEdit}
          >
            <Pencil aria-hidden="true" />
          </Button>
        )}
        {showLabels ? (
          <Button type="button" variant="outline" size="sm" onClick={onPublish}>
            <Send aria-hidden="true" />
            {t("tax.rules.publish")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={publishLabel}
            onClick={onPublish}
          >
            <Send aria-hidden="true" />
          </Button>
        )}
      </div>
    );
  }
  if (rule.status === "published") {
    return (
      <div
        className={
          showLabels
            ? "flex flex-wrap items-center gap-1"
            : "flex items-center justify-end gap-1"
        }
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onNewVersion}
        >
          <CopyPlus aria-hidden="true" />
          {versionLabel}
        </Button>
      </div>
    );
  }
  return null;
}

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh screen, so a
 * filter or open editor of the previous outlet cannot carry over.
 */
export function ServiceChargePage() {
  const { outlet } = useTenantContext();
  return <ServiceChargeContent key={outlet?.id ?? "none"} />;
}

function ServiceChargeContent() {
  const t = useT();
  const toast = useToast();
  // The outlet the shell selected; the zone picker reads its floor.
  const { outlet } = useTenantContext();
  const rulesQuery = useServiceChargeRules();
  const zonesQuery = useFloorZones(outlet?.id);
  const publishRule = usePublishServiceChargeRule();

  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [publishing, setPublishing] = React.useState<ServiceChargeRule | null>(
    null,
  );
  const [publishError, setPublishError] = React.useState<string>();

  const today = businessDateToday();
  const all = React.useMemo(
    () => sortRuleVersions(rulesQuery.data?.data ?? []),
    [rulesQuery.data],
  );
  const rows = filterRuleVersions(all, { search, status });
  const zones = React.useMemo(
    () =>
      (zonesQuery.data?.data.zones ?? []).map(({ id, name }) => ({ id, name })),
    [zonesQuery.data],
  );
  const zoneNames = React.useMemo(
    () => new Map<string, string>(zones.map((zone) => [zone.id, zone.name])),
    [zones],
  );

  function confirmPublish() {
    if (!publishing) return;
    publishRule.mutate(
      {
        params: { serviceChargeRuleId: publishing.id },
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: () => {
          toast({
            title: t("tax.serviceCharge.publishedToast"),
            tone: "success",
          });
          setPublishing(null);
          setPublishError(undefined);
        },
        onError: (error) => setPublishError(taxMutationError(error, t)),
      },
    );
  }

  return (
    <>
      <DataTableShell
        title={t("tax.serviceCharge.title")}
        description={t("tax.serviceCharge.listDescription")}
        state={
          rulesQuery.isPending
            ? "loading"
            : rulesQuery.isError
              ? "error"
              : all.length === 0
                ? "empty"
                : "ready"
        }
        search={{
          value: search,
          onChange: setSearch,
          label: t("tax.rules.searchLabel"),
        }}
        actions={
          <>
            <Select
              value={status}
              onValueChange={(value) => setStatus(value as StatusFilter)}
            >
              <SelectTrigger
                aria-label={t("tax.rules.filterStatus")}
                className="h-control-sm sm:w-40"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("tax.rules.filterAll")}</SelectItem>
                <SelectItem value="draft">
                  {t("tax.versionStatus.draft")}
                </SelectItem>
                <SelectItem value="published">
                  {t("tax.versionStatus.published")}
                </SelectItem>
                <SelectItem value="archived">
                  {t("tax.versionStatus.archived")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button type="button" onClick={() => setEditor({ mode: "create" })}>
              <Plus aria-hidden="true" />
              {t("tax.serviceCharge.add")}
            </Button>
          </>
        }
        onRetry={() => void rulesQuery.refetch()}
        empty={{
          title: t("tax.serviceCharge.emptyTitle"),
          description: t("tax.serviceCharge.emptyHint"),
          action: (
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditor({ mode: "create" })}
            >
              {t("tax.serviceCharge.add")}
            </Button>
          ),
        }}
        noResults={all.length > 0 && rows.length === 0}
        rowCount={rows.length}
      >
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("tax.rules.columns.rule")}</TableHead>
                <TableHead numeric>{t("tax.rules.columns.rate")}</TableHead>
                <TableHead>{t("tax.serviceCharge.columns.scope")}</TableHead>
                <TableHead>{t("tax.rules.columns.effective")}</TableHead>
                <TableHead>{t("tax.rules.columns.status")}</TableHead>
                <TableHead numeric>{t("tax.rules.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-semibold">{rule.code}</span>
                      <span className="text-sm text-muted-foreground">
                        {rule.name}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell numeric>
                    <span className="font-semibold tabular">
                      {formatBasisPoints(rule.rateBp)}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal">
                    <div className="grid gap-0.5 text-sm">
                      <span className="font-medium text-foreground">
                        <ZoneSummary
                          zoneId={rule.zoneId}
                          zoneName={
                            rule.zoneId === null
                              ? undefined
                              : zoneNames.get(rule.zoneId)
                          }
                        />
                      </span>
                      <span className="text-muted-foreground">
                        {rule.orderTypes.length === 0 ? (
                          t("tax.serviceCharge.allOrderTypes")
                        ) : (
                          <ChannelsSummary channels={rule.orderTypes} />
                        )}
                      </span>
                      <span className="text-muted-foreground">
                        {rule.itemClasses
                          .map((itemClass) => t(ITEM_CLASS_KEYS[itemClass]))
                          .join(" · ")}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="grid justify-items-start gap-1">
                      <span className="tabular">
                        {formatBusinessDate(rule.effectiveFrom)}
                      </span>
                      <EffectiveBadge
                        version={rule}
                        versions={all}
                        today={today}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <VersionStatusBadge version={rule} />
                  </TableCell>
                  <TableCell numeric>
                    <RowActions
                      rule={rule}
                      showLabels={false}
                      onEdit={() => setEditor({ mode: "edit", rule })}
                      onPublish={() => {
                        setPublishError(undefined);
                        setPublishing(rule);
                      }}
                      onNewVersion={() =>
                        setEditor({ mode: "new-version", rule })
                      }
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className="md:hidden">
          {rows.map((rule) => (
            <li
              key={rule.id}
              className="grid gap-2 border-b px-card py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-semibold">{rule.code}</span>
                  <span className="text-sm text-muted-foreground">
                    {rule.name}
                  </span>
                </div>
                <VersionStatusBadge version={rule} />
              </div>
              <p className="text-sm">
                <span className="font-semibold tabular">
                  {formatBasisPoints(rule.rateBp)}
                </span>
                <span className="text-muted-foreground">
                  {" · "}
                  <ZoneSummary
                    zoneId={rule.zoneId}
                    zoneName={
                      rule.zoneId === null
                        ? undefined
                        : zoneNames.get(rule.zoneId)
                    }
                  />
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                {rule.orderTypes.length === 0
                  ? t("tax.serviceCharge.allOrderTypes")
                  : rule.orderTypes
                      .map((channel) => t(CHANNEL_KEYS[channel]))
                      .join(", ")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("tax.rules.effectiveFrom", {
                  date: formatBusinessDate(rule.effectiveFrom),
                })}
              </p>
              <EffectiveBadge version={rule} versions={all} today={today} />
              <RowActions
                rule={rule}
                showLabels
                onEdit={() => setEditor({ mode: "edit", rule })}
                onPublish={() => {
                  setPublishError(undefined);
                  setPublishing(rule);
                }}
                onNewVersion={() => setEditor({ mode: "new-version", rule })}
              />
            </li>
          ))}
        </ul>
      </DataTableShell>

      {editor && (
        <ServiceChargeDialog
          mode={editor.mode}
          rule={editor.mode === "create" ? undefined : editor.rule}
          versions={all}
          today={today}
          zones={zones}
          zonesUnavailable={zonesQuery.isError}
          onClose={() => setEditor(null)}
        />
      )}

      {publishing && (
        <PublishDialog
          title={t("tax.publish.serviceChargeTitle", {
            code: publishing.code,
            version: publishing.version,
          })}
          description={t("tax.publish.body")}
          error={publishError}
          pending={publishRule.isPending}
          onCancel={() => {
            setPublishing(null);
            setPublishError(undefined);
          }}
          onConfirm={confirmPublish}
        />
      )}
    </>
  );
}
