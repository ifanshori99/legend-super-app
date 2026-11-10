// Recipe editor (PRD v1.7 §3 F17 "Resep Bertingkat", §17, §6.E; owner decisions
// Q19/Q20): the BOM lines with unit conversion, waste as a yield loss, the live
// theoretical HPP, and "Simpan sebagai versi baru" (createRecipeVersion, so old
// versions stay readable). Users without recipe.manage see a read-only sheet.
import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import type {
  InventoryItem,
  Recipe,
  RecipeComponentType,
  RecipeDetail,
  StockBalance,
  Uom,
} from "@starter/shared/inventory";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useTenantContext } from "@/lib/tenant-context";
import { useOnline } from "@/lib/use-online";
import { useInventoryItems, useStockBalances, useUnits } from "../hooks";
import { formatQuantity, LIST_LIMIT, uomCode } from "../lib";
import {
  idrFromDecimal4,
  lineBaseQuantity,
  lineCostIdr,
  lineDraftsFromDetail,
  lineGrossQuantity,
  lineInputFromDraft,
  quantityInputValue,
  recipeTotals,
  wastePctFromInput,
  weightedUnitCosts,
  type LineCostContext,
  type RecipeLineDraft,
  type RecipeLineInput,
} from "../recipe-lib";
import {
  useComponentConversions,
  useCreateRecipeVersion,
  useRecipe,
  useRecipes,
  useAttemptKey,
} from "../recipe-hooks";
import { formatDateTime, shortId } from "../stock-lib";
import { RecipeActiveBadge } from "./recipe-status";

// ---- Small pieces ---------------------------------------------------------

/** Catalog keys per BOM component kind (read-only rows name the kind). */
const COMPONENT_TYPE_LABEL = {
  item: "inventoryRecipe.editor.lines.types.item",
  recipe: "inventoryRecipe.editor.lines.types.recipe",
} as const;

function lineIssues(
  line: RecipeLineDraft,
  currentRecipeId: string,
  t: ReturnType<typeof useT>,
): Record<string, string | undefined> {
  const issues: Record<string, string | undefined> = {};
  if (line.componentId === "")
    issues.component = t("inventoryRecipe.editor.lines.invalidComponent");
  if (line.componentType === "recipe" && line.componentId === currentRecipeId)
    issues.component = t("inventoryRecipe.editor.lines.selfRecipe");
  if (quantityInputValue(line.quantity) === null)
    issues.quantity = t("inventoryRecipe.editor.lines.invalidQuantity");
  if (wastePctFromInput(line.wastePct) === null)
    issues.waste = t("inventoryRecipe.editor.lines.invalidWaste");
  if (line.uomId === "")
    issues.unit = t("inventoryRecipe.editor.lines.invalidUnit");
  return issues;
}

function ComponentSelect({
  componentType,
  componentId,
  items,
  recipes,
  currentRecipeId,
  onSelect,
}: {
  componentType: RecipeComponentType;
  componentId: string;
  items: readonly InventoryItem[];
  recipes: readonly Recipe[];
  currentRecipeId: string;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const options = React.useMemo(() => {
    if (componentType === "item")
      return [...items]
        .filter((item) => item.isActive)
        .sort((a, b) => a.name.localeCompare(b.name, "id-ID"))
        .map((item) => ({ id: item.id, name: item.name }));
    return [...recipes]
      .filter((recipe) => recipe.id !== currentRecipeId)
      .sort((a, b) => a.name.localeCompare(b.name, "id-ID"))
      .map((recipe) => ({ id: recipe.id, name: recipe.name }));
  }, [componentType, items, recipes, currentRecipeId]);
  return (
    <Select value={componentId} onValueChange={onSelect}>
      <SelectTrigger
        aria-label={t("inventoryRecipe.editor.lines.componentLabel")}
      >
        <SelectValue
          placeholder={t(
            componentType === "item"
              ? "inventoryRecipe.editor.lines.itemPlaceholder"
              : "inventoryRecipe.editor.lines.recipePlaceholder",
          )}
        />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function UnitSelect({
  value,
  units,
  onSelect,
}: {
  value: string;
  units: readonly Uom[];
  onSelect: (id: string) => void;
}) {
  const t = useT();
  return (
    <Select value={value} onValueChange={onSelect}>
      <SelectTrigger aria-label={t("inventoryRecipe.editor.lines.unit")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {units.map((unit) => (
          <SelectItem key={unit.id} value={unit.id}>
            {unit.code} — {unit.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function LineFacts({
  line,
  gross,
  base,
  costIdr,
  units,
  canViewCost,
}: {
  line: RecipeLineDraft;
  gross: string | null;
  base: { quantity: string; uomId: string } | null;
  costIdr: number | null;
  units: readonly Uom[];
  canViewCost: boolean;
}) {
  const t = useT();
  return (
    <div className="grid gap-1 text-sm">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-muted-foreground">
          {t("inventoryRecipe.editor.lines.gross")}:
        </span>
        <span className="tabular">
          {gross === null
            ? "—"
            : `${formatQuantity(gross)} ${uomCode(units, line.uomId)}`}
        </span>
      </p>
      {base !== null && base.uomId !== line.uomId && (
        <p className="text-muted-foreground">
          {t("inventoryRecipe.editor.lines.conversionHint", {
            quantity: formatQuantity(base.quantity),
            unit: uomCode(units, base.uomId),
          })}
        </p>
      )}
      {base === null && line.uomId !== "" && (
        <p className="text-muted-foreground">
          {t("inventoryRecipe.editor.lines.conversionMissing")}
        </p>
      )}
      {canViewCost && (
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-muted-foreground">
            {t("inventoryRecipe.editor.lines.cost")}:
          </span>
          {costIdr === null ? (
            <span className="text-muted-foreground">
              {t("inventoryRecipe.editor.lines.costUnavailable")}
            </span>
          ) : (
            <Money amount={costIdr} />
          )}
        </p>
      )}
    </div>
  );
}

// ---- Editor form ----------------------------------------------------------

function RecipeEditorForm({
  detail,
  recipes,
  items,
  units,
  balances,
  canManage,
  canViewCost,
  offline,
}: {
  detail: RecipeDetail;
  recipes: readonly Recipe[];
  items: readonly InventoryItem[];
  units: readonly Uom[];
  balances: readonly StockBalance[];
  canManage: boolean;
  canViewCost: boolean;
  offline: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const saveVersion = useCreateRecipeVersion();
  const attempt = useAttemptKey();

  const [drafts, setDrafts] = React.useState<RecipeLineDraft[]>(() =>
    lineDraftsFromDetail(detail.lines),
  );
  const nextKey = React.useRef(drafts.length);
  const [newLine, setNewLine] = React.useState<RecipeLineDraft>(() => ({
    key: -1,
    componentType: "item",
    componentId: "",
    quantity: "",
    uomId: "",
    wastePct: "0",
  }));
  const [newLineErrors, setNewLineErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [invalidKeys, setInvalidKeys] = React.useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [changeNote, setChangeNote] = React.useState("");
  const [formError, setFormError] = React.useState<string>();

  const itemsById = React.useMemo(
    () => new Map<string, InventoryItem>(items.map((item) => [item.id, item])),
    [items],
  );
  const recipesById = React.useMemo(
    () => new Map<string, Recipe>(recipes.map((recipe) => [recipe.id, recipe])),
    [recipes],
  );

  // Conversions for every component on screen (items and nested recipe outputs),
  // so a line can show its base quantity and cost without a request per render.
  const conversionItemIds = React.useMemo(() => {
    const ids: string[] = [];
    const push = (type: RecipeComponentType, id: string) => {
      if (id === "") return;
      if (type === "item") ids.push(id);
      else {
        const output = recipesById.get(id)?.outputItemId;
        if (output) ids.push(output);
      }
    };
    for (const line of drafts) push(line.componentType, line.componentId);
    push(newLine.componentType, newLine.componentId);
    return ids;
  }, [drafts, newLine.componentType, newLine.componentId, recipesById]);
  const conversions = useComponentConversions(conversionItemIds);
  const unitCosts = React.useMemo(
    () => weightedUnitCosts(balances),
    [balances],
  );
  const costContext: LineCostContext = {
    items,
    recipes,
    conversionsByItem: conversions.byItem,
    unitCosts,
  };

  const totals = recipeTotals(
    drafts,
    detail.recipe.yieldQuantity,
    detail.recipe.yieldUomId,
    costContext,
  );

  function updateLine(key: number, patch: Partial<RecipeLineDraft>) {
    setDrafts((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function selectLineComponent(key: number, id: string) {
    const line = drafts.find((row) => row.key === key);
    if (!line) return;
    const baseUomId =
      line.componentType === "item"
        ? (itemsById.get(id)?.baseUomId ?? "")
        : (recipesById.get(id)?.yieldUomId ?? "");
    updateLine(key, { componentId: id, uomId: baseUomId });
  }

  function removeLine(key: number) {
    setDrafts((current) => current.filter((line) => line.key !== key));
    setInvalidKeys((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function selectNewComponent(id: string) {
    const baseUomId =
      newLine.componentType === "item"
        ? (itemsById.get(id)?.baseUomId ?? "")
        : (recipesById.get(id)?.yieldUomId ?? "");
    setNewLine((current) => ({
      ...current,
      componentId: id,
      uomId: baseUomId,
    }));
  }

  function addLine() {
    const issues = lineIssues(newLine, detail.recipe.id, t);
    setNewLineErrors(issues);
    if (Object.values(issues).some(Boolean)) return;
    const draft: RecipeLineDraft = { ...newLine, key: nextKey.current };
    nextKey.current += 1;
    setDrafts((current) => [...current, draft]);
    setNewLine((current) => ({
      ...current,
      key: -1,
      componentId: "",
      quantity: "",
      wastePct: "0",
    }));
    setNewLineErrors({});
    toast({ title: t("inventoryRecipe.editor.add.success"), tone: "success" });
  }

  function save() {
    if (drafts.length === 0) {
      setFormError(t("inventoryRecipe.editor.addLineFirst"));
      return;
    }
    const invalid = new Set<number>();
    const inputs = drafts.map((line) => {
      const input = lineInputFromDraft(line);
      if (input === null) invalid.add(line.key);
      return input;
    });
    if (invalid.size > 0) {
      setInvalidKeys(invalid);
      setFormError(t("inventoryRecipe.errors.saveFailed"));
      return;
    }
    setInvalidKeys(new Set());
    setFormError(undefined);
    const payload = {
      lines: inputs,
      ...(changeNote.trim() === "" ? {} : { changeNote: changeNote.trim() }),
    };
    const validInputs = inputs.filter(
      (input): input is RecipeLineInput => input !== null,
    );
    saveVersion.mutate(
      {
        recipeId: detail.recipe.id,
        body: {
          lines: validInputs,
          ...(changeNote.trim() === ""
            ? {}
            : { changeNote: changeNote.trim() }),
          idempotencyKey: attempt.keyFor(payload),
        },
        idempotencyKey: attempt.keyFor(payload),
      },
      {
        onSuccess: (result) => {
          attempt.settle();
          setChangeNote("");
          toast({
            title: t("inventoryRecipe.editor.saved"),
            description: t("inventoryRecipe.editor.savedBody", {
              version: result.recipe.version,
            }),
            tone: "success",
          });
          void navigate({
            to: "/kelola/inventori/resep/$recipeId",
            params: { recipeId: result.recipe.id },
          });
        },
        onError: (error) =>
          setFormError(
            error instanceof ApiError && error.code === "RECIPE_CYCLE"
              ? t("inventoryRecipe.errors.cycle")
              : error instanceof ApiError
                ? error.message
                : t("inventoryRecipe.errors.saveFailed"),
          ),
      },
    );
  }

  return (
    <div className="grid min-w-0 gap-5">
      {offline && (
        <p
          role="status"
          className="rounded-container border-(length:--border-w) bg-warning-subtle px-3 py-2 text-sm font-medium text-warning"
        >
          {t("inventoryRecipe.errors.offline")}
        </p>
      )}
      <section className="grid gap-4 rounded-container border bg-card p-card shadow-hairline">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <h2 className="type-title">{detail.recipe.name}</h2>
            <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
              {t("inventoryRecipe.editor.subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">
              {t("inventoryRecipe.list.versionValue", {
                version: detail.recipe.version,
              })}
            </Badge>
            <RecipeActiveBadge isActive={detail.recipe.isActive} />
          </div>
        </div>

        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="grid gap-0.5">
            <dt className="text-sm text-muted-foreground">
              {t("inventoryRecipe.editor.header.output")}
            </dt>
            <dd className="font-semibold">
              {detail.recipe.outputItemId
                ? (itemsById.get(detail.recipe.outputItemId)?.name ??
                  t("inventoryRecipe.unknownItem"))
                : t("inventoryRecipe.menuOutput")}
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-sm text-muted-foreground">
              {t("inventoryRecipe.editor.header.yield")}
            </dt>
            <dd className="tabular font-semibold">
              {formatQuantity(detail.recipe.yieldQuantity)}{" "}
              {uomCode(units, detail.recipe.yieldUomId)}
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-sm text-muted-foreground">
              {t("inventoryRecipe.editor.header.costPerUnit", {
                unit: uomCode(units, detail.recipe.yieldUomId),
              })}
            </dt>
            <dd>
              {canViewCost ? (
                <Money
                  amount={idrFromDecimal4(detail.recipe.theoreticalCostIdr)}
                  size="lg"
                />
              ) : (
                <span className="text-muted-foreground">
                  {t("inventoryRecipe.list.costUnavailable")}
                </span>
              )}
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-sm text-muted-foreground">
              {t("inventoryRecipe.list.columns.updated")}
            </dt>
            <dd className="grid gap-0.5 text-sm">
              <time dateTime={detail.recipe.updatedAt}>
                {formatDateTime(detail.recipe.updatedAt)}
              </time>
              <span className="text-muted-foreground">
                {t("inventoryRecipe.list.updatedBy", {
                  user: shortId(detail.recipe.updatedBy),
                })}
              </span>
            </dd>
          </div>
        </dl>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("inventoryRecipe.editor.header.grossNote")}
        </p>
        {!canManage && (
          <p
            role="status"
            className="rounded-container border bg-surface-2 px-3 py-2 text-sm"
          >
            {t("inventoryRecipe.editor.readOnly")}
          </p>
        )}
      </section>

      <section className="grid gap-3 rounded-container border bg-card p-card shadow-hairline">
        <div className="grid gap-1">
          <h2 className="text-base leading-6 font-semibold">
            {t("inventoryRecipe.editor.lines.title")}
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("inventoryRecipe.editor.lines.description")}
          </p>
        </div>

        {drafts.length === 0 ? (
          <EmptyState
            title={t("inventoryRecipe.editor.lines.empty")}
            description={t("inventoryRecipe.editor.lines.emptyHint")}
            className="rounded-lg border"
          />
        ) : (
          <ul className="grid gap-3">
            {drafts.map((line) => {
              const componentName =
                line.componentType === "item"
                  ? (itemsById.get(line.componentId)?.name ?? "—")
                  : (recipesById.get(line.componentId)?.name ?? "—");
              const wasteBp = wastePctFromInput(line.wastePct);
              const gross =
                wasteBp === null
                  ? null
                  : lineGrossQuantity(line.quantity, wasteBp);
              const base = lineBaseQuantity(
                line,
                items,
                recipes,
                conversions.byItem,
              );
              const costIdr = canViewCost
                ? lineCostIdr(line, costContext)
                : null;
              const issues: ReturnType<typeof lineIssues> = invalidKeys.has(
                line.key,
              )
                ? lineIssues(line, detail.recipe.id, t)
                : {};
              return (
                <li
                  key={line.key}
                  className="grid gap-3 rounded-container border p-3"
                >
                  {canManage ? (
                    <>
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end">
                        <SegmentedControl
                          value={line.componentType}
                          onValueChange={(value) =>
                            updateLine(line.key, {
                              componentType: value as RecipeComponentType,
                              componentId: "",
                              uomId: "",
                            })
                          }
                          label={t("inventoryRecipe.editor.lines.typeLabel", {
                            name: componentName,
                          })}
                          options={[
                            {
                              value: "item",
                              label: t(
                                "inventoryRecipe.editor.lines.types.item",
                              ),
                            },
                            {
                              value: "recipe",
                              label: t(
                                "inventoryRecipe.editor.lines.types.recipe",
                              ),
                            },
                          ]}
                        />
                        <div className="grid gap-1">
                          <span className="text-sm font-semibold">
                            {t("inventoryRecipe.editor.lines.componentLabel")}
                          </span>
                          <ComponentSelect
                            componentType={line.componentType}
                            componentId={line.componentId}
                            items={items}
                            recipes={recipes}
                            currentRecipeId={detail.recipe.id}
                            onSelect={(id) => selectLineComponent(line.key, id)}
                          />
                          {issues.component && (
                            <p role="alert" className="text-sm text-danger">
                              {issues.component}
                            </p>
                          )}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("inventoryRecipe.editor.lines.remove", {
                            name: componentName,
                          })}
                          onClick={() => removeLine(line.key)}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="grid gap-1">
                          <span className="text-sm font-semibold">
                            {t("inventoryRecipe.editor.lines.netQuantity")}
                          </span>
                          <Input
                            value={line.quantity}
                            onChange={(event) =>
                              updateLine(line.key, {
                                quantity: event.target.value,
                              })
                            }
                            inputMode="decimal"
                            aria-label={t(
                              "inventoryRecipe.editor.lines.netQuantity",
                            )}
                            aria-invalid={issues.quantity ? true : undefined}
                          />
                          {issues.quantity && (
                            <p role="alert" className="text-sm text-danger">
                              {issues.quantity}
                            </p>
                          )}
                        </div>
                        <div className="grid gap-1">
                          <span className="text-sm font-semibold">
                            {t("inventoryRecipe.editor.lines.unit")}
                          </span>
                          <UnitSelect
                            value={line.uomId}
                            units={units}
                            onSelect={(id) =>
                              updateLine(line.key, { uomId: id })
                            }
                          />
                          {issues.unit && (
                            <p role="alert" className="text-sm text-danger">
                              {issues.unit}
                            </p>
                          )}
                        </div>
                        <div className="grid gap-1">
                          <span className="text-sm font-semibold">
                            {t("inventoryRecipe.editor.lines.waste")}
                          </span>
                          <Input
                            value={line.wastePct}
                            onChange={(event) =>
                              updateLine(line.key, {
                                wastePct: event.target.value,
                              })
                            }
                            inputMode="decimal"
                            aria-label={t("inventoryRecipe.editor.lines.waste")}
                            aria-invalid={issues.waste ? true : undefined}
                          />
                          {issues.waste && (
                            <p role="alert" className="text-sm text-danger">
                              {issues.waste}
                            </p>
                          )}
                        </div>
                      </div>
                      <LineFacts
                        line={line}
                        gross={gross}
                        base={base}
                        costIdr={costIdr}
                        units={units}
                        canViewCost={canViewCost}
                      />
                    </>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                      <div className="grid gap-0.5">
                        <p className="font-semibold">{componentName}</p>
                        <p className="text-sm text-muted-foreground">
                          {t(COMPONENT_TYPE_LABEL[line.componentType])}
                        </p>
                      </div>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                        <div>
                          <dt className="text-muted-foreground">
                            {t("inventoryRecipe.editor.lines.netQuantity")}
                          </dt>
                          <dd className="tabular">
                            {formatQuantity(line.quantity)}{" "}
                            {uomCode(units, line.uomId)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            {t("inventoryRecipe.editor.lines.waste")}
                          </dt>
                          <dd className="tabular">{line.wastePct}%</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            {t("inventoryRecipe.editor.lines.gross")}
                          </dt>
                          <dd className="tabular">
                            {gross === null
                              ? "—"
                              : `${formatQuantity(gross)} ${uomCode(
                                  units,
                                  line.uomId,
                                )}`}
                          </dd>
                        </div>
                        {canViewCost && (
                          <div>
                            <dt className="text-muted-foreground">
                              {t("inventoryRecipe.editor.lines.cost")}
                            </dt>
                            <dd>
                              {costIdr === null ? (
                                "—"
                              ) : (
                                <Money amount={costIdr} />
                              )}
                            </dd>
                          </div>
                        )}
                      </dl>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canManage && (
          <fieldset className="grid gap-3 rounded-container border border-dashed p-3">
            <legend className="px-1 text-sm leading-5 font-semibold">
              {t("inventoryRecipe.editor.add.title")}
            </legend>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryRecipe.editor.add.description")}
            </p>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
              <SegmentedControl
                value={newLine.componentType}
                onValueChange={(value) =>
                  setNewLine((current) => ({
                    ...current,
                    componentType: value as RecipeComponentType,
                    componentId: "",
                    uomId: "",
                  }))
                }
                label={t("inventoryRecipe.editor.lines.typeLabel", {
                  name: t("inventoryRecipe.editor.add.title"),
                })}
                options={[
                  {
                    value: "item",
                    label: t("inventoryRecipe.editor.lines.types.item"),
                  },
                  {
                    value: "recipe",
                    label: t("inventoryRecipe.editor.lines.types.recipe"),
                  },
                ]}
              />
              <div className="grid gap-1">
                <span className="text-sm font-semibold">
                  {t("inventoryRecipe.editor.lines.componentLabel")}
                </span>
                <ComponentSelect
                  componentType={newLine.componentType}
                  componentId={newLine.componentId}
                  items={items}
                  recipes={recipes}
                  currentRecipeId={detail.recipe.id}
                  onSelect={selectNewComponent}
                />
                {newLineErrors.component && (
                  <p role="alert" className="text-sm text-danger">
                    {newLineErrors.component}
                  </p>
                )}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1">
                <span className="text-sm font-semibold">
                  {t("inventoryRecipe.editor.lines.netQuantity")}
                </span>
                <Input
                  value={newLine.quantity}
                  onChange={(event) =>
                    setNewLine((current) => ({
                      ...current,
                      quantity: event.target.value,
                    }))
                  }
                  inputMode="decimal"
                  aria-label={t("inventoryRecipe.editor.lines.netQuantity")}
                  aria-invalid={newLineErrors.quantity ? true : undefined}
                />
                {newLineErrors.quantity && (
                  <p role="alert" className="text-sm text-danger">
                    {newLineErrors.quantity}
                  </p>
                )}
              </div>
              <div className="grid gap-1">
                <span className="text-sm font-semibold">
                  {t("inventoryRecipe.editor.lines.unit")}
                </span>
                <UnitSelect
                  value={newLine.uomId}
                  units={units}
                  onSelect={(id) =>
                    setNewLine((current) => ({ ...current, uomId: id }))
                  }
                />
                {newLineErrors.unit && (
                  <p role="alert" className="text-sm text-danger">
                    {newLineErrors.unit}
                  </p>
                )}
              </div>
              <div className="grid gap-1">
                <span className="text-sm font-semibold">
                  {t("inventoryRecipe.editor.lines.waste")}
                </span>
                <Input
                  value={newLine.wastePct}
                  onChange={(event) =>
                    setNewLine((current) => ({
                      ...current,
                      wastePct: event.target.value,
                    }))
                  }
                  inputMode="decimal"
                  aria-label={t("inventoryRecipe.editor.lines.waste")}
                  aria-invalid={newLineErrors.waste ? true : undefined}
                />
                {newLineErrors.waste && (
                  <p role="alert" className="text-sm text-danger">
                    {newLineErrors.waste}
                  </p>
                )}
              </div>
            </div>
            <LineFacts
              line={newLine}
              gross={
                wastePctFromInput(newLine.wastePct) === null
                  ? null
                  : lineGrossQuantity(
                      newLine.quantity,
                      wastePctFromInput(newLine.wastePct) ?? 0,
                    )
              }
              base={lineBaseQuantity(
                newLine,
                items,
                recipes,
                conversions.byItem,
              )}
              costIdr={canViewCost ? lineCostIdr(newLine, costContext) : null}
              units={units}
              canViewCost={canViewCost}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={addLine}
            >
              <Plus aria-hidden="true" />
              {t("inventoryRecipe.editor.add.submit")}
            </Button>
          </fieldset>
        )}
      </section>

      {canViewCost && (
        <section className="grid gap-3 rounded-container border bg-card p-card shadow-hairline">
          <h2 className="text-base leading-6 font-semibold">
            {t("inventoryRecipe.editor.total.title")}
          </h2>
          {totals.totalIdr === null || totals.perUnitIdr === null ? (
            <p className="text-sm leading-5 text-muted-foreground">
              {t("inventoryRecipe.editor.total.incomplete")}
            </p>
          ) : (
            <dl className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-0.5">
                <dt className="text-sm text-muted-foreground">
                  {t("inventoryRecipe.editor.total.batch")}
                </dt>
                <dd>
                  <Money amount={totals.totalIdr} size="lg" />
                </dd>
              </div>
              <div className="grid gap-0.5">
                <dt className="text-sm text-muted-foreground">
                  {t("inventoryRecipe.editor.total.perUnit", {
                    unit: uomCode(units, detail.recipe.yieldUomId),
                  })}
                </dt>
                <dd>
                  <Money
                    amount={idrFromDecimal4(totals.perUnitIdr)}
                    size="lg"
                  />
                </dd>
              </div>
            </dl>
          )}
          <p className="text-sm leading-5 text-muted-foreground">
            {t("inventoryRecipe.editor.total.draftHint")}
          </p>
        </section>
      )}

      {canManage && (
        <section className="grid gap-4 rounded-container border bg-card p-card shadow-hairline">
          <FormField
            label={t("inventoryRecipe.editor.changeNote")}
            hint={t("inventoryRecipe.editor.changeNoteHint")}
          >
            <Textarea
              value={changeNote}
              onChange={(event) => setChangeNote(event.target.value)}
              maxLength={300}
              rows={2}
            />
          </FormField>
          {formError && (
            <p
              role="alert"
              className="rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
            >
              {formError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              loading={saveVersion.isPending}
              onClick={save}
            >
              {t("inventoryRecipe.editor.save")}
            </Button>
            <Button asChild variant="outline">
              <Link to="/kelola/inventori/resep">
                <ArrowLeft aria-hidden="true" />
                {t("inventoryRecipe.editor.back")}
              </Link>
            </Button>
          </div>
        </section>
      )}

      {!canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <Link to="/kelola/inventori/resep">
              <ArrowLeft aria-hidden="true" />
              {t("inventoryRecipe.editor.back")}
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

// ---- Page -----------------------------------------------------------------

type RecipeEditorPageProps = {
  recipeId: string;
  canManage: boolean;
  canViewCost: boolean;
};

/**
 * Keyed by outlet: switching outlet in the shell reloads the stock balances
 * and drops the unsaved form of the previous outlet.
 */
export function RecipeEditorPage(props: RecipeEditorPageProps) {
  const { outlet } = useTenantContext();
  return <RecipeEditorContent key={outlet?.id ?? "none"} {...props} />;
}

function RecipeEditorContent({
  recipeId,
  canManage,
  canViewCost,
}: RecipeEditorPageProps) {
  const t = useT();
  const online = useOnline();
  const { outlet } = useTenantContext();
  const detailQuery = useRecipe(recipeId);
  const recipesQuery = useRecipes();
  const itemsQuery = useInventoryItems({ limit: LIST_LIMIT });
  const unitsQuery = useUnits({ limit: LIST_LIMIT });
  const balancesQuery = useStockBalances(outlet?.id);

  const pending =
    detailQuery.isPending ||
    recipesQuery.isPending ||
    itemsQuery.isPending ||
    unitsQuery.isPending ||
    balancesQuery.isPending;
  const failed =
    detailQuery.isError ||
    recipesQuery.isError ||
    itemsQuery.isError ||
    unitsQuery.isError ||
    balancesQuery.isError;
  const error =
    detailQuery.error ??
    recipesQuery.error ??
    itemsQuery.error ??
    unitsQuery.error ??
    balancesQuery.error;
  const notFound =
    detailQuery.error instanceof ApiError && detailQuery.error.status === 404;
  const offline =
    !online || (error instanceof ApiError && error.code === "NETWORK_ERROR");

  const retry = () => {
    void detailQuery.refetch();
    void recipesQuery.refetch();
    void itemsQuery.refetch();
    void unitsQuery.refetch();
    void balancesQuery.refetch();
  };

  if (pending)
    return (
      <div
        aria-busy="true"
        className="grid gap-3 rounded-container border bg-card p-card shadow-hairline"
      >
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-row" />
        <Skeleton className="h-row" />
        <Skeleton className="h-row" />
      </div>
    );

  if (notFound)
    return (
      <div className="rounded-container border bg-card">
        <EmptyState
          title={t("inventoryRecipe.editor.notFound")}
          description={t("inventoryRecipe.editor.notFoundHint")}
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/kelola/inventori/resep">
                {t("inventoryRecipe.editor.back")}
              </Link>
            </Button>
          }
        />
      </div>
    );

  if (failed || detailQuery.data === undefined)
    return (
      <div className="rounded-container border bg-card">
        <ErrorState
          title={t("inventoryRecipe.errors.load")}
          description={
            offline
              ? t("inventoryRecipe.errors.offline")
              : t("inventoryRecipe.errors.loadHint")
          }
          onRetry={retry}
        />
      </div>
    );

  return (
    <RecipeEditorForm
      key={`${detailQuery.data.recipe.id}:${detailQuery.data.recipe.version}`}
      detail={detailQuery.data}
      recipes={recipesQuery.data?.data ?? []}
      items={itemsQuery.data?.data ?? []}
      units={unitsQuery.data?.data ?? []}
      balances={balancesQuery.data?.data ?? []}
      canManage={canManage}
      canViewCost={canViewCost}
      offline={offline}
    />
  );
}
