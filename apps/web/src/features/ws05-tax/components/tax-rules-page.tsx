// Tax rule versions (PRD §3.14 "Aturan Pajak Berversi"): every change is a new
// version with its own effective date; published versions are immutable (R21).
// The list is the version history per code, newest first, with drafts editable
// and published versions copied into a new draft.
import * as React from "react";
import { CopyPlus, Pencil, Plus, Send } from "lucide-react";
import type { RuleVersionStatus, TaxRule } from "@starter/shared/tax";
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
import { usePublishTaxRule, useTaxRules } from "../hooks";
import { TAX_TYPE_KEYS } from "../labels";
import {
  businessDateToday,
  filterRuleVersions,
  formatBasisPoints,
  formatBusinessDate,
  sortRuleVersions,
} from "../lib";
import { PublishDialog } from "./publish-dialog";
import { AppliesToSummary, ChannelsSummary } from "./summaries";
import { TaxRuleDialog } from "./tax-rule-dialog";
import { EffectiveBadge, VersionStatusBadge } from "./version-badges";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

type StatusFilter = RuleVersionStatus | "all";

type Editor =
  | { mode: "create" }
  | { mode: "edit"; rule: TaxRule }
  | { mode: "new-version"; rule: TaxRule };

function RuleActions({
  rule,
  showLabels,
  onEdit,
  onPublish,
  onNewVersion,
}: {
  rule: TaxRule;
  showLabels: boolean;
  onEdit: () => void;
  onPublish: () => void;
  onNewVersion: () => void;
}) {
  const t = useT();
  const editLabel = t("tax.rules.editDraft");
  const publishLabel = t("tax.rules.publish");
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
            {editLabel}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${editLabel} ${rule.code}`}
            onClick={onEdit}
          >
            <Pencil aria-hidden="true" />
          </Button>
        )}
        {showLabels ? (
          <Button type="button" variant="outline" size="sm" onClick={onPublish}>
            <Send aria-hidden="true" />
            {publishLabel}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${publishLabel} ${rule.code}`}
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

export function TaxRulesPage() {
  const t = useT();
  const toast = useToast();
  const rulesQuery = useTaxRules();
  const publishRule = usePublishTaxRule();

  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [publishing, setPublishing] = React.useState<TaxRule | null>(null);
  const [publishError, setPublishError] = React.useState<string>();

  const today = businessDateToday();
  const all = React.useMemo(
    () => sortRuleVersions(rulesQuery.data?.data ?? []),
    [rulesQuery.data],
  );
  const rows = filterRuleVersions(all, { search, status });

  function confirmPublish() {
    if (!publishing) return;
    publishRule.mutate(
      {
        params: { taxRuleId: publishing.id },
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: () => {
          toast({ title: t("tax.rules.publishedToast"), tone: "success" });
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
        title={t("tax.rules.title")}
        description={t("tax.rules.description")}
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
              {t("tax.rules.add")}
            </Button>
          </>
        }
        onRetry={() => void rulesQuery.refetch()}
        empty={{
          title: t("tax.rules.emptyTitle"),
          description: t("tax.rules.emptyHint"),
          action: (
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditor({ mode: "create" })}
            >
              {t("tax.rules.add")}
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
                <TableHead>{t("tax.rules.columns.appliesTo")}</TableHead>
                <TableHead>{t("tax.rules.columns.channels")}</TableHead>
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
                    <div className="grid justify-items-end gap-0.5">
                      <span className="font-semibold tabular">
                        {formatBasisPoints(rule.rateBp)}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {t(TAX_TYPE_KEYS[rule.taxType])}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-56 whitespace-normal">
                    <AppliesToSummary appliesTo={rule.appliesTo} />
                  </TableCell>
                  <TableCell className="max-w-48 whitespace-normal">
                    <ChannelsSummary channels={rule.channels} />
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
                    <RuleActions
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
                  {t(TAX_TYPE_KEYS[rule.taxType])}
                </span>
              </p>
              <p className="text-sm text-muted-foreground">
                <AppliesToSummary appliesTo={rule.appliesTo} />
              </p>
              <p className="text-sm text-muted-foreground">
                {t("tax.rules.effectiveFrom", {
                  date: formatBusinessDate(rule.effectiveFrom),
                })}
              </p>
              <EffectiveBadge version={rule} versions={all} today={today} />
              <RuleActions
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
        <TaxRuleDialog
          mode={editor.mode}
          rule={editor.mode === "create" ? undefined : editor.rule}
          versions={all}
          today={today}
          onClose={() => setEditor(null)}
        />
      )}

      {publishing && (
        <PublishDialog
          title={t("tax.publish.ruleTitle", {
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
