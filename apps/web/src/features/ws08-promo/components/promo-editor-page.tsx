// Promo rule builder (/kelola/promo/baru and /kelola/promo/$promotionId; PRD
// v1.7 §3.21 "Promo Engine"). One form covers every rule type in the contract:
// six conditions (minimum spend, channel, member/tier, happy hour, item
// quantity, bundle) and five benefits (percent, nominal, buy X get Y, bundle
// price, facility access), plus validity, quota, budget, stacking and voucher
// code. The right column reads the rule back in plain language and warns about
// conflicts with the other active promotions and the stacking policy.
import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Save } from "lucide-react";
import { createPromotionInputSchema } from "@starter/shared/crm";
import type { Promotion } from "@starter/shared/crm";
import { defaultPromoStackingPolicy } from "@starter/shared/crm";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/feedback-state";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  useCreatePromotion,
  useMenuItems,
  usePromotions,
  useStackingPolicy,
  useTiers,
  useUpdatePromotion,
} from "../hooks";
import {
  BENEFIT_KINDS,
  PROMO_CHANNELS,
  PROMO_STATUSES,
  WEEKDAYS,
  dateInputValue,
  detectConflicts,
  emptyPromoForm,
  hasErrors,
  previewBody,
  promoBody,
  promoFormFrom,
  summarizePromotion,
  validatePromoForm,
  type PromoField,
  type PromoForm,
  type ValidationErrors,
} from "../lib";
import { usePromoT } from "../t";
import {
  CheckGroup,
  LoadingBlock,
  Notice,
  ReadError,
  useOnline,
} from "./promo-shell";

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="grid gap-1">
        <h3 className="type-title">{title}</h3>
        {hint && (
          <p className="text-sm leading-5 text-muted-foreground">{hint}</p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </Card>
  );
}

function ConditionBlock({
  id,
  label,
  checked,
  onChange,
  error,
  children,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-3 rounded-lg border-(length:--border-w) p-3 sm:col-span-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(next) => onChange(next === true)}
        />
        <Label htmlFor={id} className="font-semibold">
          {label}
        </Label>
      </div>
      {error && (
        <p role="alert" className="text-sm leading-5 text-danger">
          {error}
        </p>
      )}
      {checked && <div className="grid gap-4 sm:grid-cols-2">{children}</div>}
    </div>
  );
}

export function PromoEditorPage({ promotionId }: { promotionId: string }) {
  const t = usePromoT();
  const promotionsQuery = usePromotions();
  const isNew = promotionId === "baru";

  if (promotionsQuery.isPending) return <LoadingBlock rows={6} />;
  if (promotionsQuery.isError)
    return (
      <Card>
        <ReadError
          error={promotionsQuery.error}
          onRetry={() => void promotionsQuery.refetch()}
        />
      </Card>
    );
  const promotions = promotionsQuery.data.data;
  const existing = isNew
    ? undefined
    : promotions.find((promotion) => promotion.id === promotionId);
  if (!isNew && !existing)
    return (
      <Card>
        <EmptyState
          title={t("promo.editor.notFoundTitle")}
          description={t("promo.editor.notFoundHint")}
          action={
            <Button asChild variant="outline">
              <Link to="/kelola/promo">{t("promo.editor.back")}</Link>
            </Button>
          }
        />
      </Card>
    );
  return (
    <PromoEditorForm
      key={existing?.id ?? "baru"}
      existing={existing}
      promotions={promotions}
    />
  );
}

function PromoEditorForm({
  existing,
  promotions,
}: {
  existing: Promotion | undefined;
  promotions: readonly Promotion[];
}) {
  const t = usePromoT();
  const common = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const online = useOnline();
  const menuQuery = useMenuItems();
  const tiersQuery = useTiers();
  const policyQuery = useStackingPolicy();
  const createPromotion = useCreatePromotion();
  const updatePromotion = useUpdatePromotion();

  const [form, setForm] = React.useState<PromoForm>(() =>
    existing
      ? promoFormFrom(existing)
      : emptyPromoForm(dateInputValue(new Date().toISOString())),
  );
  const [errors, setErrors] = React.useState<ValidationErrors<PromoField>>({});
  const [saveFailed, setSaveFailed] = React.useState(false);

  const menuItems = React.useMemo(
    () => menuQuery.data?.data ?? [],
    [menuQuery.data],
  );
  const tiers = React.useMemo(
    () => tiersQuery.data?.data ?? [],
    [tiersQuery.data],
  );
  const [nowMs] = React.useState(() => Date.now());
  const policy = policyQuery.data?.data ?? defaultPromoStackingPolicy;
  const menuOptions = menuItems.map((item) => ({
    id: item.id,
    label: item.name,
  }));
  const menuState = menuQuery.isPending
    ? "loading"
    : menuQuery.isError
      ? "error"
      : "ready";
  const menuText =
    menuState === "loading"
      ? t("promo.editor.itemsLoading")
      : t("promo.editor.itemsError");

  function set<Field extends keyof PromoForm>(
    field: Field,
    value: PromoForm[Field],
  ) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaveFailed(false);
  }
  const err = (field: PromoField) => {
    const key = errors[field];
    return key ? t(key) : undefined;
  };

  const summary = React.useMemo(() => {
    const body = previewBody(form);
    if (!body) return null;
    const lines = summarizePromotion(body, {
      t,
      itemName: (id) => menuItems.find((item) => item.id === id)?.name,
      tierName: (id) => tiers.find((tier) => tier.id === id)?.name,
    });
    const conflicts = detectConflicts({
      body,
      selfId: existing?.id ?? null,
      spentIdr: existing?.spentIdr ?? 0,
      hasStoredCode: form.hasStoredCode,
      others: promotions,
      policy,
      now: nowMs,
    });
    return { lines, conflicts };
  }, [form, t, menuItems, tiers, existing, promotions, policy, nowMs]);

  const pending = createPromotion.isPending || updatePromotion.isPending;
  const errorCount = Object.values(errors).filter(Boolean).length;

  function save() {
    const next = validatePromoForm(form);
    setErrors(next);
    if (hasErrors(next)) return;
    const body = promoBody(form, existing?.codeHash ?? null);
    const parsed = body ? createPromotionInputSchema.safeParse(body) : null;
    if (!body || !parsed?.success) {
      setSaveFailed(true);
      return;
    }
    const onSuccess = (saved: Promotion) => {
      toast({
        title: existing
          ? t("promo.editor.updatedToast", { name: saved.name })
          : t("promo.editor.createdToast", { name: saved.name }),
        tone: "success",
      });
      void navigate({ to: "/kelola/promo" });
    };
    const onError = () => setSaveFailed(true);
    if (existing)
      updatePromotion.mutate(
        { promotionId: existing.id, body },
        { onSuccess, onError },
      );
    else createPromotion.mutate(body, { onSuccess, onError });
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="grid min-w-0 gap-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline" size="sm">
          <Link to="/kelola/promo">
            <ArrowLeft aria-hidden="true" />
            {t("promo.editor.back")}
          </Link>
        </Button>
        <h3 className="type-title">
          {existing ? t("promo.editor.titleEdit") : t("promo.editor.titleNew")}
        </h3>
      </div>

      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 gap-5">
          <Section title={t("promo.editor.sections.basic")}>
            <FormField
              label={t("promo.editor.name")}
              hint={t("promo.editor.nameHint")}
              error={err("name")}
              required
              className="sm:col-span-2"
            >
              <Input
                value={form.name}
                onChange={(event) => set("name", event.target.value)}
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={t("promo.editor.description")}
              className="sm:col-span-2"
            >
              <Textarea
                rows={2}
                value={form.description}
                onChange={(event) => set("description", event.target.value)}
              />
            </FormField>
            <FormField
              id="promo-status"
              label={t("promo.editor.status")}
              hint={t("promo.editor.statusHint")}
              className="sm:col-span-2"
            >
              <Select
                value={form.status}
                onValueChange={(value) =>
                  set("status", value as PromoForm["status"])
                }
              >
                <SelectTrigger id="promo-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROMO_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {t(`promo.status.${status}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </Section>

          <Section
            title={t("promo.editor.sections.conditions")}
            hint={t("promo.editor.conditionsHint")}
          >
            <ConditionBlock
              id="cond-min-spend"
              label={t("promo.conditionKind.min_spend")}
              checked={form.condMinSpend}
              onChange={(checked) => set("condMinSpend", checked)}
            >
              <FormField
                label={t("promo.editor.minSpend")}
                hint={t("promo.editor.minSpendHint")}
                error={err("minSpend")}
                required
                className="sm:col-span-2"
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={form.minSpend}
                  onChange={(event) => set("minSpend", event.target.value)}
                />
              </FormField>
            </ConditionBlock>

            <ConditionBlock
              id="cond-channel"
              label={t("promo.conditionKind.channel")}
              checked={form.condChannel}
              onChange={(checked) => set("condChannel", checked)}
            >
              <CheckGroup
                className="sm:col-span-2"
                idPrefix="promo-channel"
                legend={t("promo.editor.channels")}
                options={PROMO_CHANNELS.map((channel) => ({
                  id: channel,
                  label: t(`promo.channel.${channel}`),
                }))}
                value={form.channels}
                onChange={(next) =>
                  set("channels", next as PromoForm["channels"])
                }
                error={err("channels")}
              />
            </ConditionBlock>

            <ConditionBlock
              id="cond-member"
              label={t("promo.conditionKind.member")}
              checked={form.condMember}
              onChange={(checked) => set("condMember", checked)}
            >
              <CheckGroup
                className="sm:col-span-2"
                idPrefix="promo-tier"
                legend={t("promo.editor.memberTiers")}
                hint={t("promo.editor.memberTiersHint")}
                options={tiers.map((tier) => ({
                  id: tier.id,
                  label: tier.name,
                }))}
                value={form.tierIds}
                onChange={(next) => set("tierIds", next)}
                state={
                  tiersQuery.isPending
                    ? "loading"
                    : tiersQuery.isError
                      ? "error"
                      : "ready"
                }
                stateText={
                  tiersQuery.isPending
                    ? common("common.loading")
                    : t("promo.offline.readHint")
                }
                emptyText={t("promo.editor.noTiers")}
              />
            </ConditionBlock>

            <ConditionBlock
              id="cond-time"
              label={t("promo.conditionKind.time_window")}
              checked={form.condTime}
              onChange={(checked) => set("condTime", checked)}
            >
              <CheckGroup
                className="sm:col-span-2"
                idPrefix="promo-day"
                legend={t("promo.editor.days")}
                options={WEEKDAYS.map((day) => ({
                  id: String(day),
                  label: t(`promo.weekday.d${day}`),
                }))}
                value={form.days.map(String)}
                onChange={(next) =>
                  set(
                    "days",
                    next.map(Number).sort((a, b) => a - b),
                  )
                }
                error={err("days")}
                columns={false}
              />
              <FormField
                label={t("promo.editor.timeStart")}
                error={err("timeStart")}
                required
              >
                <Input
                  type="time"
                  value={form.timeStart}
                  onChange={(event) => set("timeStart", event.target.value)}
                />
              </FormField>
              <FormField
                label={t("promo.editor.timeEnd")}
                hint={t("promo.editor.timeHint")}
                error={err("timeEnd")}
                required
              >
                <Input
                  type="time"
                  value={form.timeEnd}
                  onChange={(event) => set("timeEnd", event.target.value)}
                />
              </FormField>
            </ConditionBlock>

            <ConditionBlock
              id="cond-item-qty"
              label={t("promo.conditionKind.item_quantity")}
              checked={form.condItemQty}
              onChange={(checked) => set("condItemQty", checked)}
              error={err("condItemQty")}
            >
              <CheckGroup
                className="sm:col-span-2"
                idPrefix="promo-qty-item"
                legend={t("promo.editor.items")}
                options={menuOptions}
                value={form.qtyItemIds}
                onChange={(next) => set("qtyItemIds", next)}
                error={err("qtyItemIds")}
                state={menuState}
                stateText={menuText}
                emptyText={t("promo.editor.itemsEmpty")}
              />
              <FormField
                label={t("promo.editor.minQuantity")}
                error={err("minQuantity")}
                required
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={form.minQuantity}
                  onChange={(event) => set("minQuantity", event.target.value)}
                />
              </FormField>
            </ConditionBlock>

            <ConditionBlock
              id="cond-bundle"
              label={t("promo.conditionKind.bundle")}
              checked={form.condBundle}
              onChange={(checked) => set("condBundle", checked)}
            >
              <CheckGroup
                className="sm:col-span-2"
                idPrefix="promo-bundle-item"
                legend={t("promo.editor.bundleItems")}
                options={menuOptions}
                value={form.bundleItemIds}
                onChange={(next) => set("bundleItemIds", next)}
                error={err("bundleItemIds")}
                state={menuState}
                stateText={menuText}
                emptyText={t("promo.editor.itemsEmpty")}
              />
            </ConditionBlock>
          </Section>

          <Section title={t("promo.editor.sections.benefit")}>
            <FormField
              id="promo-benefit-kind"
              label={t("promo.editor.benefitKind")}
              required
              className="sm:col-span-2"
            >
              <Select
                value={form.benefitKind}
                onValueChange={(value) =>
                  set("benefitKind", value as PromoForm["benefitKind"])
                }
              >
                <SelectTrigger id="promo-benefit-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BENEFIT_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`promo.benefitKind.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {form.benefitKind === "percent_off" && (
              <>
                <FormField
                  label={t("promo.editor.percent")}
                  hint={t("promo.editor.percentHint")}
                  error={err("percent")}
                  required
                >
                  <Input
                    inputMode="decimal"
                    value={form.percent}
                    onChange={(event) => set("percent", event.target.value)}
                  />
                </FormField>
                <FormField
                  label={t("promo.editor.maxDiscount")}
                  hint={t("promo.editor.maxDiscountHint")}
                  error={err("maxDiscount")}
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={form.maxDiscount}
                    onChange={(event) => set("maxDiscount", event.target.value)}
                  />
                </FormField>
              </>
            )}

            {form.benefitKind === "nominal_off" && (
              <FormField
                label={t("promo.editor.nominal")}
                error={err("nominal")}
                required
                className="sm:col-span-2"
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={form.nominal}
                  onChange={(event) => set("nominal", event.target.value)}
                />
              </FormField>
            )}

            {form.benefitKind === "free_items" && (
              <>
                {!form.condItemQty && (
                  <Notice
                    tone="warning"
                    className="sm:col-span-2"
                    role={errors.condItemQty ? "alert" : undefined}
                  >
                    {t("promo.editor.freeNeedsBuy")}
                  </Notice>
                )}
                <CheckGroup
                  className="sm:col-span-2"
                  idPrefix="promo-free-item"
                  legend={t("promo.editor.freeItems")}
                  options={menuOptions}
                  value={form.freeItemIds}
                  onChange={(next) => set("freeItemIds", next)}
                  error={err("freeItemIds")}
                  state={menuState}
                  stateText={menuText}
                  emptyText={t("promo.editor.itemsEmpty")}
                />
                <FormField
                  label={t("promo.editor.freeQty")}
                  error={err("freeQty")}
                  required
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={form.freeQty}
                    onChange={(event) => set("freeQty", event.target.value)}
                  />
                </FormField>
              </>
            )}

            {form.benefitKind === "bundle_price" && (
              <>
                <CheckGroup
                  className="sm:col-span-2"
                  idPrefix="promo-bundle-price-item"
                  legend={t("promo.editor.bundlePriceItems")}
                  options={menuOptions}
                  value={form.bundlePriceItemIds}
                  onChange={(next) => set("bundlePriceItemIds", next)}
                  error={err("bundlePriceItemIds")}
                  state={menuState}
                  stateText={menuText}
                  emptyText={t("promo.editor.itemsEmpty")}
                />
                <FormField
                  label={t("promo.editor.bundlePrice")}
                  error={err("bundlePrice")}
                  required
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={form.bundlePrice}
                    onChange={(event) => set("bundlePrice", event.target.value)}
                  />
                </FormField>
              </>
            )}

            {form.benefitKind === "facility_entitlement" && (
              <>
                <FormField
                  label={t("promo.editor.facilityProductId")}
                  hint={t("promo.editor.facilityProductHint")}
                  error={err("facilityProductId")}
                  required
                  className="sm:col-span-2"
                >
                  <Input
                    value={form.facilityProductId}
                    onChange={(event) =>
                      set("facilityProductId", event.target.value)
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                </FormField>
                <FormField
                  label={t("promo.editor.facilityQty")}
                  error={err("facilityQty")}
                  required
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={form.facilityQty}
                    onChange={(event) => set("facilityQty", event.target.value)}
                  />
                </FormField>
              </>
            )}
          </Section>

          <Section title={t("promo.editor.sections.validity")}>
            <FormField
              label={t("promo.editor.startsOn")}
              error={err("startsOn")}
              required
            >
              <Input
                type="date"
                value={form.startsOn}
                onChange={(event) => set("startsOn", event.target.value)}
              />
            </FormField>
            <FormField
              label={t("promo.editor.endsOn")}
              hint={t("promo.editor.endsOnHint")}
              error={err("endsOn")}
            >
              <Input
                type="date"
                value={form.endsOn}
                onChange={(event) => set("endsOn", event.target.value)}
              />
            </FormField>
          </Section>

          <Section title={t("promo.editor.sections.limits")}>
            <FormField
              label={t("promo.editor.quotaTotal")}
              hint={t("promo.editor.quotaHint")}
              error={err("quotaTotal")}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                value={form.quotaTotal}
                onChange={(event) => set("quotaTotal", event.target.value)}
              />
            </FormField>
            <FormField
              label={t("promo.editor.quotaPerCustomer")}
              hint={t("promo.editor.quotaHint")}
              error={err("quotaPerCustomer")}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                value={form.quotaPerCustomer}
                onChange={(event) =>
                  set("quotaPerCustomer", event.target.value)
                }
              />
            </FormField>
            <FormField
              label={t("promo.editor.budget")}
              hint={
                existing && existing.budgetIdr !== null
                  ? t("promo.editor.budgetSpent", {
                      spent: formatRupiah(existing.spentIdr),
                      budget: formatRupiah(existing.budgetIdr),
                    })
                  : t("promo.editor.budgetHint")
              }
              error={err("budget")}
              className="sm:col-span-2"
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={form.budget}
                onChange={(event) => set("budget", event.target.value)}
              />
            </FormField>
          </Section>

          <Section title={t("promo.editor.sections.stacking")}>
            <FormField
              label={t("promo.editor.stackGroup")}
              hint={t("promo.editor.stackGroupHint")}
              error={err("stackGroup")}
              required
            >
              <Input
                value={form.stackGroup}
                onChange={(event) => set("stackGroup", event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <FormField
              label={t("promo.editor.priority")}
              hint={t("promo.editor.priorityHint")}
              error={err("priority")}
              required
            >
              <Input
                type="number"
                inputMode="numeric"
                value={form.priority}
                onChange={(event) => set("priority", event.target.value)}
              />
            </FormField>
            <div className="flex items-center gap-3 sm:col-span-2">
              <Switch
                id="promo-stackable"
                checked={form.stackable}
                onCheckedChange={(checked) => set("stackable", checked)}
              />
              <Label htmlFor="promo-stackable">
                {t("promo.editor.stackable")}
              </Label>
            </div>
          </Section>

          <Section title={t("promo.editor.sections.voucher")}>
            <div className="flex items-center gap-3 sm:col-span-2">
              <Switch
                id="promo-voucher-required"
                checked={form.voucherRequired}
                onCheckedChange={(checked) => set("voucherRequired", checked)}
              />
              <Label htmlFor="promo-voucher-required">
                {t("promo.editor.voucherRequired")}
              </Label>
            </div>
            {form.voucherRequired && (
              <FormField
                label={t("promo.editor.code")}
                hint={
                  form.hasStoredCode
                    ? t("promo.editor.codeStored")
                    : t("promo.editor.codeHint")
                }
                error={err("code")}
                required={!form.hasStoredCode}
                className="sm:col-span-2"
              >
                <Input
                  value={form.code}
                  onChange={(event) =>
                    set("code", event.target.value.toUpperCase())
                  }
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </FormField>
            )}
          </Section>
        </div>

        <aside className="grid min-w-0 gap-5 lg:sticky lg:top-4">
          <Card aria-labelledby="promo-summary-title">
            <div className="grid gap-1">
              <h3 id="promo-summary-title" className="type-title">
                {t("promo.editor.sections.summary")}
              </h3>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("promo.editor.summaryHint")}
              </p>
            </div>
            {summary ? (
              <div
                className="grid gap-2 text-sm leading-6"
                data-testid="promo-summary"
              >
                {summary.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("promo.editor.summaryEmpty")}
              </p>
            )}
          </Card>

          <Card aria-labelledby="promo-conflicts-title">
            <h3 id="promo-conflicts-title" className="type-title">
              {t("promo.editor.sections.conflicts")}
            </h3>
            {policyQuery.isPending ? (
              <p className="text-sm text-muted-foreground" role="status">
                {t("promo.editor.conflictsLoading")}
              </p>
            ) : summary && summary.conflicts.length > 0 ? (
              <ul className="grid gap-2" data-testid="promo-conflicts">
                {summary.conflicts.map((conflict) => (
                  <li key={conflict.id}>
                    <Notice tone={conflict.level}>
                      {t(conflict.key, conflict.vars)}
                    </Notice>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("promo.editor.conflictsNone")}
              </p>
            )}
          </Card>

          {errorCount > 0 && (
            <Notice tone="danger" role="alert">
              {t("promo.editor.errorSummary", { count: errorCount })}
            </Notice>
          )}
          {saveFailed && (
            <Notice tone="danger" role="alert">
              {t("promo.editor.saveFailed")}
            </Notice>
          )}
          {!online && (
            <Notice tone="warning">{t("promo.offline.saveBlocked")}</Notice>
          )}
          <Button type="submit" loading={pending} disabled={!online || pending}>
            <Save aria-hidden="true" />
            {pending ? t("promo.editor.saving") : t("promo.editor.save")}
          </Button>
        </aside>
      </div>
    </form>
  );
}
