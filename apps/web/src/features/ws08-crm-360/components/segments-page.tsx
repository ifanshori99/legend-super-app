// Segment builder (/kelola/pelanggan/segmen; PRD v1.7 §3.21 "Segmentasi":
// dynamic segments over RFM, tier, favorite menu, outlet and behaviour).
//
// The builder edits `segmentDefinitionSchema` rules and previews them with
// previewSegment before createSegment. LOY-04 note: only customers with an
// active marketing consent receive campaigns, so the previewed size is not the
// campaign audience.
import * as React from "react";
import { useRouteContext } from "@tanstack/react-router";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { formatNumber } from "@starter/shared/i18n";
import type { LoyaltyTier, Segment } from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberDisplay } from "@/components/ui/money";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { useOnline } from "@/lib/use-online";
import type { AreaAccess } from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import {
  useCreateSegment,
  useMenuCatalog,
  useOutletCatalog,
  useSegments,
  useSegmentPreview,
  useTiers,
} from "../hooks";
import {
  DEFAULT_SEGMENT_MATCH,
  SEGMENT_RULE_KINDS,
  changeRuleKind,
  createRuleDraft,
  definitionFromDrafts,
  formatDate,
  hasSegmentErrors,
  initialRuleDrafts,
  monthLabel,
  ruleSummary,
  validateSegmentBuilder,
  type RuleDraft,
  type SegmentBuilderErrors,
  type SegmentRuleKind,
} from "../lib";
import { useCrm360T } from "../t";
import { CursorPager, Notice, ReadProblem } from "./crm-shell";

const SEGMENT_PAGE_SIZE = 20;

type CatalogOption = { id: string; name: string };
type Catalog = {
  options: readonly CatalogOption[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
};

const NUMERIC_FIELD: Partial<
  Record<SegmentRuleKind, { label: string; hint?: string }>
> = {
  rfm_recency: { label: "crm360.segments.fields.maxDays" },
  rfm_frequency: { label: "crm360.segments.fields.minVisits" },
  rfm_monetary: { label: "crm360.segments.fields.minSpend" },
  inactive_days: { label: "crm360.segments.fields.inactiveDays" },
};

function tierOptions(
  tiers: readonly LoyaltyTier[] | undefined,
): CatalogOption[] {
  return (tiers ?? []).map((tier) => ({ id: tier.id, name: tier.name }));
}

function SelectionGroup({
  label,
  hint,
  options,
  selected,
  error,
  catalog,
  onToggle,
}: {
  label: string;
  hint?: string;
  options: readonly CatalogOption[];
  selected: readonly string[];
  error?: string;
  catalog: Catalog;
  onToggle: (id: string, checked: boolean) => void;
}) {
  const t = useCrm360T();
  const common = useT();
  const groupId = React.useId();
  return (
    <fieldset className="grid gap-1.5">
      <legend className="text-sm leading-5 font-medium">{label}</legend>
      {hint && (
        <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
      )}
      {catalog.loading ? (
        <div className="grid gap-1" aria-busy="true">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <span className="sr-only">{t("crm360.segments.pickerLoading")}</span>
        </div>
      ) : catalog.failed ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-danger">
          <span>{t("crm360.segments.pickerError")}</span>
          <Button variant="outline" size="sm" onClick={catalog.onRetry}>
            {common("common.retry")}
          </Button>
        </div>
      ) : options.length === 0 ? (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("crm360.segments.pickerEmpty")}
        </p>
      ) : (
        <div
          className="grid max-h-56 gap-2 overflow-y-auto rounded-container border-(length:--border-w) bg-surface-2 p-3 sm:grid-cols-2"
          id={groupId}
        >
          {options.map((option) => {
            const id = `${groupId}-${option.id}`;
            return (
              <div key={option.id} className="flex items-start gap-2">
                <Checkbox
                  id={id}
                  checked={selected.includes(option.id)}
                  onCheckedChange={(checked) =>
                    onToggle(option.id, checked === true)
                  }
                />
                <Label
                  htmlFor={id}
                  className="min-w-0 text-sm leading-5 font-normal"
                >
                  {option.name}
                </Label>
              </div>
            );
          })}
        </div>
      )}
      {selected.length === 0 && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("crm360.segments.selectHint")}
        </p>
      )}
      {error && (
        <p
          className="text-sm leading-5 font-medium text-danger"
          aria-live="polite"
        >
          {error}
        </p>
      )}
    </fieldset>
  );
}

function RuleRow({
  draft,
  index,
  canRemove,
  error,
  tiers,
  menus,
  outlets,
  onChange,
  onRemove,
}: {
  draft: RuleDraft;
  index: number;
  canRemove: boolean;
  error?: string;
  tiers: Catalog;
  menus: Catalog;
  outlets: Catalog;
  onChange: (next: RuleDraft) => void;
  onRemove: () => void;
}) {
  const t = useCrm360T();
  const optInFieldId = React.useId();
  const monthFieldId = React.useId();
  const numeric = NUMERIC_FIELD[draft.kind];
  const selectionCatalog =
    draft.kind === "tier"
      ? tiers
      : draft.kind === "favorite_item"
        ? menus
        : draft.kind === "outlet"
          ? outlets
          : null;
  const selectionLabel =
    draft.kind === "tier"
      ? t("crm360.segments.fields.tiers")
      : draft.kind === "favorite_item"
        ? t("crm360.segments.fields.menuItems")
        : draft.kind === "outlet"
          ? t("crm360.segments.fields.outlets")
          : "";
  const selectionHint =
    draft.kind === "favorite_item"
      ? t("crm360.segments.selectHint")
      : undefined;
  return (
    <div className="grid gap-3 rounded-container border-(length:--border-w) bg-surface-2 p-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-sm font-semibold">
          {t("crm360.segments.ruleTitle", { index: index + 1 })}
        </p>
        <div className="flex items-center gap-2">
          <div className="w-52">
            <Select
              value={draft.kind}
              onValueChange={(value) =>
                onChange(changeRuleKind(draft, value as SegmentRuleKind))
              }
            >
              <SelectTrigger aria-label={t("crm360.segments.ruleKind")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEGMENT_RULE_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`crm360.segments.ruleKinds.${kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("crm360.segments.removeRule", { index: index + 1 })}
            disabled={!canRemove}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </div>

      {numeric && (
        <FormField
          label={t(numeric.label)}
          required
          hint={numeric.hint}
          error={error}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={draft.amount}
            onChange={(event) =>
              onChange({ ...draft, amount: event.target.value })
            }
          />
        </FormField>
      )}

      {selectionCatalog && (
        <SelectionGroup
          label={selectionLabel}
          hint={selectionHint}
          options={selectionCatalog.options}
          selected={draft.selectedIds}
          error={error}
          catalog={selectionCatalog}
          onToggle={(id, checked) =>
            onChange({
              ...draft,
              selectedIds: checked
                ? [...draft.selectedIds, id]
                : draft.selectedIds.filter((selected) => selected !== id),
            })
          }
        />
      )}

      {draft.kind === "marketing_opt_in" && (
        <FormField
          id={optInFieldId}
          label={t("crm360.segments.fields.optIn")}
          required
          error={error}
        >
          <Select
            value={draft.optIn}
            onValueChange={(value) =>
              onChange({ ...draft, optIn: value as RuleDraft["optIn"] })
            }
          >
            <SelectTrigger id={optInFieldId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">
                {t("crm360.segments.fields.optInYes")}
              </SelectItem>
              <SelectItem value="false">
                {t("crm360.segments.fields.optInNo")}
              </SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      )}

      {draft.kind === "birthday_month" && (
        <FormField
          id={monthFieldId}
          label={t("crm360.segments.fields.month")}
          required
          error={error}
        >
          <Select
            value={draft.month}
            onValueChange={(value) => onChange({ ...draft, month: value })}
          >
            <SelectTrigger id={monthFieldId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 12 }, (_, month) => {
                const value = String(month + 1);
                return (
                  <SelectItem key={value} value={value}>
                    {monthLabel(month + 1)}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </FormField>
      )}
    </div>
  );
}

function segmentSummary(
  segment: Segment,
  lookups: Parameters<typeof ruleSummary>[1],
  t: ReturnType<typeof useCrm360T>,
): string {
  return segment.definition.rules
    .map((rule) => {
      const summary = ruleSummary(rule, lookups);
      return t(summary.key, summary.vars);
    })
    .join(" · ");
}

export function SegmentsPage() {
  const t = useCrm360T();
  const toast = useToast();
  const online = useOnline();
  const { access } = useRouteContext({ strict: false }) as {
    access: AreaAccess;
  };
  // The page opens with crm.customer.view; saving needs crm.segment.manage
  // (the API re-checks). Preview stays available to every viewer.
  const canManage = holdsAny(access, ["crm.segment.manage"]);

  const [name, setName] = React.useState("");
  const [match, setMatch] = React.useState(DEFAULT_SEGMENT_MATCH);
  const [drafts, setDrafts] = React.useState<RuleDraft[]>(() =>
    initialRuleDrafts(),
  );
  const [errors, setErrors] = React.useState<SegmentBuilderErrors>({
    ruleErrors: {},
  });
  const nameInput = React.useRef<HTMLInputElement>(null);

  const tiers = useTiers();
  const menus = useMenuCatalog();
  const outlets = useOutletCatalog();
  const createSegment = useCreateSegment();

  const definition = React.useMemo(
    () => definitionFromDrafts(match, drafts),
    [match, drafts],
  );
  // Count after typing settles (300 ms), not on every keystroke.
  const [settledDefinition, setSettledDefinition] = React.useState(definition);
  React.useEffect(() => {
    const timer = setTimeout(() => setSettledDefinition(definition), 300);
    return () => clearTimeout(timer);
  }, [definition]);
  const preview = useSegmentPreview(settledDefinition);

  const [cursors, setCursors] = React.useState<(string | undefined)[]>([
    undefined,
  ]);
  const cursor = cursors.at(-1);
  const segments = useSegments({
    limit: SEGMENT_PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
  });

  // The picker hands back catalog ids as plain strings; the lookup maps are
  // keyed by string so the rule builder can resolve a name without re-branding.
  const tierLookup = new Map<string, string>(
    (tiers.data?.data ?? []).map((tier) => [tier.id, tier.name]),
  );
  const menuLookup = new Map<string, string>(
    (menus.data ?? []).map((item) => [item.id, item.name]),
  );
  const outletLookup = new Map<string, string>(
    (outlets.data ?? []).map((outlet) => [outlet.id, outlet.name]),
  );
  const lookups = {
    tierName: (id: string) => tierLookup.get(id),
    menuItemName: (id: string) => menuLookup.get(id),
    outletName: (id: string) => outletLookup.get(id),
  };

  const catalogs: { tiers: Catalog; menus: Catalog; outlets: Catalog } = {
    tiers: {
      options: tierOptions(tiers.data?.data),
      loading: tiers.isPending,
      failed: tiers.isError,
      onRetry: () => void tiers.refetch(),
    },
    menus: {
      options: (menus.data ?? []).map((item) => ({
        id: item.id,
        name: item.name,
      })),
      loading: menus.isPending,
      failed: menus.isError,
      onRetry: () => void menus.refetch(),
    },
    outlets: {
      options: (outlets.data ?? []).map((outlet) => ({
        id: outlet.id,
        name: outlet.name,
      })),
      loading: outlets.isPending,
      failed: outlets.isError,
      onRetry: () => void outlets.refetch(),
    },
  };

  const rows = segments.data?.data ?? [];
  const nextCursor = segments.data?.meta.nextCursor ?? null;

  function updateDraft(next: RuleDraft) {
    setDrafts((current) =>
      current.map((draft) => (draft.key === next.key ? next : draft)),
    );
    setErrors((current) => {
      const ruleErrors = { ...current.ruleErrors };
      delete ruleErrors[next.key];
      return { ...current, ruleErrors };
    });
  }

  function removeDraft(key: string) {
    setDrafts((current) => current.filter((draft) => draft.key !== key));
    setErrors((current) => {
      const ruleErrors = { ...current.ruleErrors };
      delete ruleErrors[key];
      return { ...current, ruleErrors };
    });
  }

  function save() {
    const next = validateSegmentBuilder(name, drafts);
    setErrors(next);
    if (hasSegmentErrors(next)) return;
    const body = definitionFromDrafts(match, drafts);
    if (body === null) return;
    createSegment.mutate(
      { name: name.trim(), definition: body },
      {
        onSuccess: (saved) => {
          toast({
            title: t("crm360.segments.createdToast", { name: saved.name }),
            tone: "success",
          });
          setName("");
          setMatch(DEFAULT_SEGMENT_MATCH);
          setDrafts(initialRuleDrafts());
          setErrors({ ruleErrors: {} });
        },
        onError: () =>
          toast({ title: t("crm360.segments.saveFailed"), tone: "danger" }),
      },
    );
  }

  const listState = segments.isPending
    ? "loading"
    : rows.length === 0
      ? "empty"
      : "ready";

  return (
    <div className="grid gap-5 xl:grid-cols-2 xl:items-start">
      <div className="grid min-w-0 gap-5">
        <CardShell>
          <CardShellBody>
            <div className="grid gap-4 p-card">
              <header className="grid gap-1">
                <h3 className="type-title">
                  {t("crm360.segments.builderTitle")}
                </h3>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("crm360.segments.builderDescription")}
                </p>
              </header>

              <FormField
                label={t("crm360.segments.name")}
                required
                error={errors.name ? t(errors.name) : undefined}
              >
                <Input
                  ref={nameInput}
                  value={name}
                  placeholder={t("crm360.segments.namePlaceholder")}
                  onChange={(event) => {
                    setName(event.target.value);
                    setErrors((current) => ({
                      ...current,
                      name: undefined,
                    }));
                  }}
                />
              </FormField>

              <div className="grid gap-1.5">
                <p className="text-sm leading-5 font-medium">
                  {t("crm360.segments.matchLabel")}
                </p>
                <SegmentedControl
                  label={t("crm360.segments.matchLabel")}
                  value={match}
                  onValueChange={(value) => setMatch(value as typeof match)}
                  options={[
                    {
                      value: "all",
                      label: t("crm360.segments.matchAll"),
                    },
                    {
                      value: "any",
                      label: t("crm360.segments.matchAny"),
                    },
                  ]}
                />
              </div>

              <div className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {t("crm360.segments.rulesTitle")}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setDrafts((current) => [
                        ...current,
                        createRuleDraft("rfm_recency"),
                      ])
                    }
                  >
                    <Plus aria-hidden="true" />
                    {t("crm360.segments.addRule")}
                  </Button>
                </div>
                {errors.rules && (
                  <p
                    className="text-sm leading-5 font-medium text-danger"
                    aria-live="polite"
                  >
                    {t(errors.rules)}
                  </p>
                )}
                {drafts.map((draft, index) => (
                  <RuleRow
                    key={draft.key}
                    draft={draft}
                    index={index}
                    canRemove={drafts.length > 1}
                    error={
                      errors.ruleErrors[draft.key]
                        ? t(errors.ruleErrors[draft.key])
                        : undefined
                    }
                    tiers={catalogs.tiers}
                    menus={catalogs.menus}
                    outlets={catalogs.outlets}
                    onChange={updateDraft}
                    onRemove={() => removeDraft(draft.key)}
                  />
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={save}
                  loading={createSegment.isPending}
                  disabled={!online || !canManage}
                >
                  {createSegment.isPending
                    ? t("crm360.segments.saving")
                    : t("crm360.segments.save")}
                </Button>
                {!canManage && (
                  <span className="text-sm leading-5 text-muted-foreground">
                    {t("crm360.segments.saveLocked")}
                  </span>
                )}
                {!online && (
                  <span className="text-sm leading-5 text-warning">
                    {t("crm360.offline.saveBlocked")}
                  </span>
                )}
              </div>
            </div>
          </CardShellBody>
        </CardShell>

        <Notice
          tone="info"
          icon={ShieldCheck}
          title={t("crm360.segments.consent.title")}
        >
          {t("crm360.segments.consent.body")}
        </Notice>

        <section
          className="grid gap-3"
          aria-label={t("crm360.segments.preview.title")}
        >
          <header className="grid gap-1">
            <h3 className="type-title">{t("crm360.segments.preview.title")}</h3>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("crm360.segments.preview.description")}
            </p>
          </header>

          <div
            className="grid gap-3"
            aria-live="polite"
            aria-busy={definition !== null && preview.isFetching}
          >
            {definition === null ? (
              <CardShell>
                <CardShellBody>
                  <EmptyState
                    title={t("crm360.segments.preview.incompleteTitle")}
                    description={t("crm360.segments.preview.incompleteHint")}
                  />
                </CardShellBody>
              </CardShell>
            ) : preview.isError ? (
              <CardShell>
                <CardShellBody>
                  <ReadProblem
                    error={preview.error}
                    title={t("crm360.segments.preview.errorTitle")}
                    hint={t("crm360.segments.preview.errorHint")}
                    offlineTitle={t("crm360.segments.preview.errorTitle")}
                    offlineHint={t("crm360.segments.preview.errorHint")}
                    onRetry={() => void preview.refetch()}
                  />
                </CardShellBody>
              </CardShell>
            ) : preview.data === undefined ? (
              <div className="grid gap-2" aria-busy="true">
                <span className="sr-only">
                  {t("crm360.segments.preview.computing")}
                </span>
                <Skeleton className="h-24" />
                <Skeleton className="h-16" />
              </div>
            ) : preview.data.size === 0 ? (
              <CardShell>
                <CardShellBody>
                  <EmptyState
                    title={t("crm360.segments.preview.emptyTitle")}
                    description={t("crm360.segments.preview.emptyHint")}
                  />
                </CardShellBody>
              </CardShell>
            ) : (
              <>
                <StatStrip
                  label={t("crm360.segments.preview.title")}
                  columns={2}
                >
                  <StatTile
                    label={t("crm360.segments.preview.size")}
                    value={
                      <NumberDisplay value={preview.data.size} size="stat" />
                    }
                    context={t("crm360.segments.preview.sizeContext")}
                  />
                  <StatTile
                    label={t("crm360.segments.preview.sampleCount")}
                    value={
                      <NumberDisplay
                        value={preview.data.sample.length}
                        size="stat"
                      />
                    }
                    context={t("crm360.segments.preview.sampleNote", {
                      count: formatNumber(preview.data.sample.length),
                    })}
                  />
                </StatStrip>
                <div className="grid gap-2">
                  <h4 className="type-title">
                    {t("crm360.segments.preview.sampleTitle")}
                  </h4>
                  <ul className="divide-y divide-border overflow-hidden rounded-container border-(length:--border-w) bg-card shadow-hairline">
                    {preview.data.sample.map((profile) => {
                      const tierName =
                        profile.tierId === null
                          ? undefined
                          : tierLookup.get(profile.tierId);
                      return (
                        <li
                          key={profile.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                        >
                          <span className="min-w-0 truncate font-medium">
                            {profile.name}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {tierName === undefined
                              ? t("crm360.customers.noTier")
                              : t("crm360.segments.preview.sampleTier", {
                                  tier: tierName,
                                })}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </>
            )}
          </div>
        </section>
      </div>

      <div className="grid min-w-0 gap-5">
        {segments.isError && segments.data === undefined ? (
          <CardShell>
            <CardShellBody>
              <ReadProblem
                error={segments.error}
                title={t("crm360.segments.listLoadError")}
                hint={t("crm360.segments.listLoadHint")}
                offlineTitle={t("crm360.segments.listLoadError")}
                offlineHint={t("crm360.segments.listLoadHint")}
                onRetry={() => void segments.refetch()}
              />
            </CardShellBody>
          </CardShell>
        ) : (
          <DataTableShell
            title={t("crm360.segments.listTitle")}
            description={t("crm360.segments.listDescription")}
            state={listState}
            onRetry={() => void segments.refetch()}
            empty={{
              title: t("crm360.segments.listEmptyTitle"),
              description: t("crm360.segments.listEmptyHint"),
              action: (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => nameInput.current?.focus()}
                >
                  {t("crm360.segments.listEmptyAction")}
                </Button>
              ),
            }}
            loadingRows={4}
          >
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("crm360.segments.columns.name")}</TableHead>
                    <TableHead numeric>
                      {t("crm360.segments.columns.size")}
                    </TableHead>
                    <TableHead>
                      {t("crm360.segments.columns.refreshed")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((segment) => (
                    <TableRow key={segment.id}>
                      <TableCell>
                        <span className="block font-medium">
                          {segment.name}
                        </span>
                        <span className="block text-xs leading-5 text-muted-foreground">
                          {t(
                            segment.definition.match === "all"
                              ? "crm360.segments.listMatchAll"
                              : "crm360.segments.listMatchAny",
                          )}
                          {" · "}
                          {t("crm360.segments.listRules", {
                            count: segment.definition.rules.length,
                          })}
                          {": "}
                          {segmentSummary(segment, lookups, t)}
                        </span>
                      </TableCell>
                      <TableCell numeric>
                        {segment.refreshedAt === null
                          ? t("crm360.segments.listSizeUnrefreshed")
                          : t("crm360.segments.listSize", {
                              count: formatNumber(segment.size),
                            })}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular">
                        {segment.refreshedAt === null
                          ? t("crm360.segments.listSizeUnrefreshed")
                          : formatDate(segment.refreshedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <ul className="md:hidden">
              {rows.map((segment) => (
                <li
                  key={segment.id}
                  className="grid gap-1.5 border-b px-card py-3 last:border-b-0"
                >
                  <span className="font-medium">{segment.name}</span>
                  <span className="text-xs leading-5 text-muted-foreground">
                    {t(
                      segment.definition.match === "all"
                        ? "crm360.segments.listMatchAll"
                        : "crm360.segments.listMatchAny",
                    )}
                    {" · "}
                    {t("crm360.segments.listRules", {
                      count: segment.definition.rules.length,
                    })}
                    {": "}
                    {segmentSummary(segment, lookups, t)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {segment.refreshedAt === null
                      ? t("crm360.segments.listSizeUnrefreshed")
                      : `${t("crm360.segments.listSize", {
                          count: formatNumber(segment.size),
                        })} · ${formatDate(segment.refreshedAt)}`}
                  </span>
                </li>
              ))}
            </ul>

            <CursorPager
              countLabel={t("crm360.segments.listRowCount", {
                count: formatNumber(rows.length),
              })}
              canPrevious={cursors.length > 1}
              canNext={nextCursor !== null}
              pending={segments.isFetching}
              onPrevious={() => setCursors((current) => current.slice(0, -1))}
              onNext={() => {
                if (nextCursor === null) return;
                setCursors((current) => [...current, nextCursor]);
              }}
            />
          </DataTableShell>
        )}
      </div>
    </div>
  );
}
