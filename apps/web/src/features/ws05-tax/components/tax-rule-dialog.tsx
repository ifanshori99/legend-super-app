// Create a tax rule draft, edit a draft, or start the next version of a
// published code (PRD §3.14 "Aturan Pajak Berversi", R21). Published versions
// are immutable, so changing a rate always means a new version with its own
// effective date — the dialog pre-fills that date after the latest version.
import * as React from "react";
import { TriangleAlert } from "lucide-react";
import type {
  ItemTaxClass,
  TaxChannel,
  TaxRule,
  TaxType,
} from "@starter/shared/tax";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { taxMutationError } from "../errors";
import {
  useAllPublishedTaxRules,
  useCreateTaxRule,
  useTaxMenuCategories,
  useTaxMenuItems,
  useTaxOutlets,
  useUpdateTaxRule,
} from "../hooks";
import {
  CHANNEL_KEYS,
  ITEM_CLASSES,
  ITEM_CLASS_KEYS,
  TAX_CHANNELS,
  TAX_TYPE_KEYS,
} from "../labels";
import {
  foodBeverageCoverLoss,
  parseRatePercent,
  suggestEffectiveFrom,
  type FoodBeverageRuleVersion,
} from "../lib";
import { TargetPicker } from "./target-picker";

export type TaxRuleEditorMode = "create" | "edit" | "new-version";

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const REGION_PATTERN = /^ID-[A-Z]{2}(-\d{4})?$/;

type Errors = {
  code?: string;
  name?: string;
  rate?: string;
  region?: string;
  effectiveFrom?: string;
  itemClasses?: string;
  form?: string;
};

/** Select value for a tenant-wide rule (a Select item cannot be empty). */
const ALL_OUTLETS = "all";

function toggleValue<T>(values: readonly T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value];
  return values.filter((item) => item !== value);
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** The later of two ISO business dates. */
function laterDate(a: string, b: string): string {
  return b > a ? b : a;
}

/** Rate in the input: basis points → percent text with an id-ID comma. */
function rateInput(rule: TaxRule | undefined): string {
  if (!rule) return "";
  return String(rule.rateBp / 100).replace(".", ",");
}

export function TaxRuleDialog({
  mode,
  rule,
  versions,
  today,
  presetInactive,
  onSaved,
  onClose,
}: {
  mode: TaxRuleEditorMode;
  /** Source version for edit / new-version; absent when creating. */
  rule?: TaxRule;
  versions: readonly FoodBeverageRuleVersion[];
  /** Outlet business date (server value), for defaults and hints. */
  today: string;
  /**
   * Open with "Aturan aktif" off: the fix for an overlap is an inactive version.
   * Names the other rule and the date the overlap starts.
   */
  presetInactive?: { otherCode: string; effectiveDate: string };
  /** Called with the saved draft after the dialog's own toast. */
  onSaved?: (rule: TaxRule) => void;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const createRule = useCreateTaxRule();
  const updateRule = useUpdateTaxRule();
  const outletsQuery = useTaxOutlets();
  const categoriesQuery = useTaxMenuCategories();
  const itemsQuery = useTaxMenuItems();
  const allPublishedQuery = useAllPublishedTaxRules();

  const chain = React.useMemo(
    () =>
      rule
        ? versions.filter(
            (row) => row.code === rule.code && row.outletId === rule.outletId,
          )
        : [],
    [rule, versions],
  );

  const [code, setCode] = React.useState(rule?.code ?? "");
  const [name, setName] = React.useState(rule?.name ?? "");
  const [taxType, setTaxType] = React.useState<TaxType>(
    rule?.taxType ?? "pbjt",
  );
  const [rate, setRate] = React.useState(rateInput(rule));
  const [region, setRegion] = React.useState(rule?.regionCode ?? "");
  const [itemClasses, setItemClasses] = React.useState<ItemTaxClass[]>(
    rule ? [...rule.appliesTo.itemClasses] : ["food_beverage"],
  );
  const [channels, setChannels] = React.useState<TaxChannel[]>(
    rule ? [...rule.channels] : [],
  );
  const [priceIncludesTax, setPriceIncludesTax] = React.useState(
    rule?.priceIncludesTax ?? false,
  );
  const [includeServiceInBase, setIncludeServiceInBase] = React.useState(
    rule?.includeServiceInBase ?? true,
  );
  const [isActive, setIsActive] = React.useState(
    presetInactive ? false : (rule?.isActive ?? true),
  );
  const [effectiveFrom, setEffectiveFrom] = React.useState(
    rule === undefined
      ? today
      : mode === "edit"
        ? rule.effectiveFrom
        : presetInactive
          ? // A higher version starting the same day wins, so today is valid.
            laterDate(today, presetInactive.effectiveDate)
          : suggestEffectiveFrom(chain, today),
  );
  const [outletId, setOutletId] = React.useState<string>(
    rule?.outletId ?? ALL_OUTLETS,
  );
  const [categoryIds, setCategoryIds] = React.useState<string[]>(
    rule ? [...rule.appliesTo.categoryIds] : [],
  );
  const [itemIds, setItemIds] = React.useState<string[]>(
    rule ? [...rule.appliesTo.itemIds] : [],
  );
  const [errors, setErrors] = React.useState<Errors>({});
  // d5pz: confirm before switching off the only food_beverage rule.
  const [confirmingOff, setConfirmingOff] = React.useState(false);
  const [zeroNote, setZeroNote] = React.useState(false);

  const scopeOutletId = outletId === ALL_OUTLETS ? null : outletId;
  const outlets = outletsQuery.data?.data ?? [];
  const outletName = (id: string) =>
    outlets.find((outlet) => outlet.id === id)?.name ??
    t("tax.conflicts.outletUnknown");
  const categoryOptions = (categoriesQuery.data?.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
  }));
  const itemOptions = (itemsQuery.data?.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
  }));

  const pending = createRule.isPending || updateRule.isPending;

  function errorMessage(error: unknown): string {
    const message = taxMutationError(error, t);
    // The confirm step has its own wording for a failed write.
    return confirmingOff && message === t("tax.errors.saveFailed")
      ? t(
          lastRuleChange === "inactive"
            ? "tax.deactivate.error"
            : "tax.deactivate.removeError",
        )
      : message;
  }

  // d5pz: the change takes effect on the later of today and the draft's date.
  // Judged against every published rule (all pages), not the loaded list; if
  // that read is not available, warn whenever an existing rule is changed.
  const changeDate = laterDate(
    today,
    /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) ? effectiveFrom : today,
  );
  const lastRuleChange = foodBeverageCoverLoss({
    publishedRules: allPublishedQuery.data?.data,
    loadedRules: versions,
    chain: { code: (rule?.code ?? code).trim(), outletId: scopeOutletId },
    date: changeDate,
    mustExist: mode !== "create",
    next: {
      isActive,
      appliesTo: { itemClasses, categoryIds, itemIds },
      channels,
      regionCode: region === "" ? null : region,
    },
  });
  const losesLastFoodBeverageRule = lastRuleChange !== null;

  function validate(rateBp: number | null): Errors {
    const next: Errors = {};
    if (mode === "create" && !CODE_PATTERN.test(code.trim()))
      next.code = t("tax.errors.code");
    if (name.trim() === "") next.name = t("tax.errors.required");
    if (rateBp === null) next.rate = t("tax.errors.rate");
    if (region !== "" && !REGION_PATTERN.test(region))
      next.region = t("tax.errors.region");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom))
      next.effectiveFrom = t("tax.errors.required");
    if (itemClasses.length === 0)
      next.itemClasses = t("tax.errors.itemClasses");
    return next;
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rateBp = parseRatePercent(rate);
    const found = validate(rateBp);
    setErrors(found);
    if (Object.keys(found).length > 0 || rateBp === null) return;
    if (losesLastFoodBeverageRule) {
      setConfirmingOff(true);
      return;
    }
    save(rateBp);
  }

  function setRateToZero() {
    setConfirmingOff(false);
    setIsActive(true);
    setRate("0");
    setErrors({});
    setZeroNote(true);
  }

  /** Undo the part of the edit that would drop or limit food and beverage. */
  function keepFoodBeverage() {
    setConfirmingOff(false);
    if (lastRuleChange === "narrowed") {
      setChannels([]);
      setRegion("");
      setCategoryIds([]);
      setItemIds([]);
    } else {
      setItemClasses((current) =>
        toggleValue<ItemTaxClass>(current, "food_beverage", true),
      );
    }
    setErrors({});
  }

  function save(rateBp: number) {
    const fields = {
      name: name.trim(),
      taxType,
      rateBp,
      regionCode: region === "" ? null : region,
      channels,
      appliesTo: {
        itemClasses,
        categoryIds,
        itemIds,
      },
      priceIncludesTax,
      includeServiceInBase,
      isActive,
      effectiveFrom,
    };

    const onSuccess = (saved: { data: TaxRule }) => {
      toast({
        title: t(
          confirmingOff && lastRuleChange === "inactive"
            ? "tax.deactivate.saved"
            : presetInactive
              ? "tax.conflicts.draftCreated"
              : mode === "edit"
                ? "tax.rules.updatedToast"
                : "tax.rules.createdToast",
        ),
        tone: "success",
      });
      onClose();
      onSaved?.(saved.data);
    };
    const onError = (error: unknown) =>
      setErrors({ form: errorMessage(error) });

    if (mode === "edit" && rule) {
      updateRule.mutate(
        { params: { taxRuleId: rule.id }, body: fields },
        { onSuccess, onError },
      );
      return;
    }
    createRule.mutate(
      {
        // A new version continues its chain, so it keeps the outlet scope.
        outletId:
          mode === "new-version" && rule ? rule.outletId : scopeOutletId,
        code: code.trim(),
        ...fields,
      },
      { onSuccess, onError },
    );
  }

  const title =
    mode === "edit"
      ? t("tax.rules.editTitle")
      : mode === "new-version"
        ? t("tax.rules.newVersionTitle", { code: rule?.code ?? "" })
        : t("tax.rules.createTitle");
  const description =
    mode === "create"
      ? t("tax.rules.createDescription")
      : t("tax.rules.editDescription", {
          code: rule?.code ?? "",
          version:
            mode === "edit" ? (rule?.version ?? 1) : (rule?.version ?? 0) + 1,
        });

  return (
    <>
      <Dialog open={!confirmingOff} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <form className="grid gap-4" onSubmit={submit} noValidate>
            {presetInactive && (
              <p
                role="note"
                className="rounded-container border-(length:--border-w) bg-warning-subtle p-card text-sm leading-5"
              >
                {t("tax.conflicts.presetNote", {
                  code: presetInactive.otherCode,
                })}
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t("tax.form.code")}
                required
                error={errors.code}
                hint={mode === "create" ? t("tax.form.codeHint") : undefined}
              >
                <Input
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.toUpperCase())
                  }
                  disabled={mode !== "create" || pending}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
              <FormField label={t("tax.form.taxType")} required>
                <Select
                  value={taxType}
                  onValueChange={(value) => setTaxType(value as TaxType)}
                  disabled={pending}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(TAX_TYPE_KEYS) as TaxType[]).map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(TAX_TYPE_KEYS[type])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                label={t("tax.form.name")}
                required
                className="sm:col-span-2"
                error={errors.name}
              >
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={pending}
                  maxLength={150}
                />
              </FormField>
              <FormField
                label={t("tax.form.rate")}
                required
                error={errors.rate}
                hint={t("tax.form.rateHint")}
              >
                <Input
                  inputMode="decimal"
                  value={rate}
                  onChange={(event) => setRate(event.target.value)}
                  disabled={pending}
                  placeholder="10"
                  autoComplete="off"
                />
              </FormField>
              <FormField
                label={t("tax.form.region")}
                error={errors.region}
                hint={t("tax.form.regionHint")}
              >
                <Input
                  value={region}
                  onChange={(event) =>
                    setRegion(
                      event.target.value.toUpperCase().replace(/\s/g, ""),
                    )
                  }
                  disabled={pending}
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
              <FormField
                label={t("tax.form.effectiveFrom")}
                required
                error={errors.effectiveFrom}
              >
                <Input
                  type="date"
                  value={effectiveFrom}
                  onChange={(event) => setEffectiveFrom(event.target.value)}
                  disabled={pending}
                />
              </FormField>
              <FormField
                label={t("tax.form.outlet")}
                required
                hint={
                  mode === "create"
                    ? t("tax.form.outletHint")
                    : t("tax.form.outletLocked")
                }
              >
                <Select
                  value={outletId}
                  onValueChange={setOutletId}
                  disabled={pending || mode !== "create"}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_OUTLETS}>
                      {t("tax.form.allOutlets")}
                    </SelectItem>
                    {outlets.map((outlet) => (
                      <SelectItem key={outlet.id} value={outlet.id}>
                        {outlet.name}
                      </SelectItem>
                    ))}
                    {/* The rule's own outlet, when the outlet list is missing it. */}
                    {outletId !== ALL_OUTLETS &&
                      !outlets.some((outlet) => outlet.id === outletId) && (
                        <SelectItem value={outletId}>
                          {outletName(outletId)}
                        </SelectItem>
                      )}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-semibold">
                {t("tax.form.appliesTo")}
              </legend>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("tax.form.appliesToHint")}
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                {ITEM_CLASSES.map((itemClass) => (
                  <label
                    key={itemClass}
                    className="flex min-h-control-sm items-center gap-2"
                  >
                    <Checkbox
                      checked={itemClasses.includes(itemClass)}
                      onCheckedChange={(checked) =>
                        setItemClasses((current) =>
                          toggleValue(current, itemClass, checked === true),
                        )
                      }
                      disabled={pending}
                    />
                    <span>{t(ITEM_CLASS_KEYS[itemClass])}</span>
                  </label>
                ))}
              </div>
              {errors.itemClasses && (
                <p
                  className="text-sm leading-5 font-medium text-danger"
                  role="alert"
                >
                  {errors.itemClasses}
                </p>
              )}
            </fieldset>

            <TargetPicker
              label={t("tax.form.categories")}
              hint={t("tax.form.categoriesHint")}
              options={categoryOptions}
              value={categoryIds}
              onChange={setCategoryIds}
              loading={categoriesQuery.isPending}
              unavailable={categoriesQuery.isError}
              disabled={pending}
            />
            <TargetPicker
              label={t("tax.form.items")}
              hint={t("tax.form.itemsHint")}
              options={itemOptions}
              value={itemIds}
              onChange={setItemIds}
              loading={itemsQuery.isPending}
              unavailable={itemsQuery.isError}
              disabled={pending}
            />

            <fieldset className="grid gap-2">
              <legend className="text-sm font-semibold">
                {t("tax.form.channels")}
              </legend>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("tax.form.channelsHint")}
              </p>
              <div className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
                {TAX_CHANNELS.map((channel) => (
                  <label
                    key={channel}
                    className="flex min-h-control-sm items-center gap-2"
                  >
                    <Checkbox
                      checked={channels.includes(channel)}
                      onCheckedChange={(checked) =>
                        setChannels((current) =>
                          toggleValue(current, channel, checked === true),
                        )
                      }
                      disabled={pending}
                    />
                    <span>{t(CHANNEL_KEYS[channel])}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-1 divide-y divide-border">
              <SwitchRow
                id="tax-price-includes"
                label={t("tax.form.priceIncludesTax")}
                hint={t("tax.form.priceIncludesTaxHint")}
                checked={priceIncludesTax}
                onCheckedChange={setPriceIncludesTax}
              />
              <SwitchRow
                id="tax-service-in-base"
                label={t("tax.form.includeServiceInBase")}
                hint={t("tax.form.includeServiceInBaseHint")}
                checked={includeServiceInBase}
                onCheckedChange={setIncludeServiceInBase}
              />
              <SwitchRow
                id="tax-rule-active"
                label={t("tax.form.isActive")}
                hint={t("tax.form.isActiveHint")}
                checked={isActive}
                onCheckedChange={setIsActive}
              />
            </div>

            {zeroNote && (
              <p
                role="note"
                className="rounded-container border-(length:--border-w) bg-info-subtle p-card text-sm leading-5"
              >
                {t("tax.deactivate.zeroNote")}
              </p>
            )}

            {errors.form && !confirmingOff && (
              <p
                className="text-sm leading-5 font-medium text-danger"
                role="alert"
              >
                {errors.form}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={pending}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={pending}>
                {mode === "edit" ? t("common.save") : t("tax.form.saveDraft")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmingOff}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirmingOff(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                lastRuleChange === "inactive"
                  ? "tax.deactivate.title"
                  : lastRuleChange === "narrowed"
                    ? "tax.deactivate.narrowTitle"
                    : "tax.deactivate.removeTitle",
              )}
            </DialogTitle>
            <DialogDescription>
              {t("tax.deactivate.body", {
                name: name.trim() || (rule?.name ?? ""),
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="rounded-container border-(length:--border-w) bg-warning-subtle p-card">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                {t("tax.deactivate.impactTitle")}
              </p>
              <p className="text-sm leading-5">
                {t(
                  lastRuleChange === "narrowed"
                    ? "tax.deactivate.narrowImpactBody"
                    : "tax.deactivate.impactBody",
                )}
              </p>
            </div>
            {lastRuleChange === "inactive" && (
              <div className="rounded-container border-(length:--border-w) p-card">
                <p className="text-sm font-semibold">
                  {t("tax.deactivate.recommendTitle")}
                </p>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("tax.deactivate.recommendBody")}
                </p>
              </div>
            )}
            {errors.form && (
              <p
                className="text-sm leading-5 font-medium text-danger"
                role="alert"
              >
                {errors.form}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setErrors({});
                setConfirmingOff(false);
              }}
              disabled={pending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={
                lastRuleChange === "inactive" ? setRateToZero : keepFoodBeverage
              }
              disabled={pending}
            >
              {t(
                lastRuleChange === "inactive"
                  ? "tax.deactivate.setZero"
                  : lastRuleChange === "narrowed"
                    ? "tax.deactivate.narrowKeep"
                    : "tax.deactivate.removeKeep",
              )}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={pending}
              onClick={() => {
                const rateBp = parseRatePercent(rate);
                if (rateBp !== null) save(rateBp);
              }}
            >
              {pending
                ? t(
                    lastRuleChange === "inactive"
                      ? "tax.deactivate.pending"
                      : "tax.deactivate.removePending",
                  )
                : t(
                    lastRuleChange === "inactive"
                      ? "tax.deactivate.confirm"
                      : "tax.deactivate.removeConfirm",
                  )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
