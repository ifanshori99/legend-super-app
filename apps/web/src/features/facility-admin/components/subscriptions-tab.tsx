// "Langganan" tab: monthly (or yearly) session plans billed through the DOIT
// recurring-billing provider (PRD v1.7 §3 F25 "Langganan Bulanan"). Plans are
// configuration; subscriptions and invoices belong to the customer screens.
import * as React from "react";
import type {
  FacilityConfig,
  SubscriptionInterval,
  SubscriptionPlan,
} from "@starter/shared/facility";
import {
  createSubscriptionPlanSchema,
  updateSubscriptionPlanSchema,
} from "@starter/shared/facility";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PendingDialog,
  PendingDialogContent,
} from "@/components/ui/pending-dialog";
import { EmptyState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { useCreatePlan, useUpdatePlan } from "../hooks.ts";
import {
  parseCreateDraft,
  parseInteger,
  parseUpdateDraft,
  subscriptionIntervalLabel,
  zodFieldErrors,
} from "../lib.ts";
import { ConfigSection } from "./config-section";
import { FormError } from "./form-error";

const INTERVALS: readonly SubscriptionInterval[] = ["month", "year"];

type PlanDialogState =
  { mode: "create" } | { mode: "edit"; plan: SubscriptionPlan } | null;

export function SubscriptionsTab({
  facilityId,
  config,
}: {
  facilityId: string;
  config: FacilityConfig;
}) {
  const t = useT();
  const toast = useToast();
  const updatePlan = useUpdatePlan(facilityId);
  const [dialog, setDialog] = React.useState<PlanDialogState>(null);

  const plans = [...config.subscriptionPlans]
    .filter((plan) => plan.facilityId === facilityId)
    .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));

  function toggle(plan: SubscriptionPlan, isActive: boolean) {
    updatePlan.mutate(
      {
        planId: plan.id,
        body: { isActive },
        expectedUpdatedAt: plan.updatedAt,
      },
      {
        onSuccess: () =>
          toast({
            title: t("facilityAdmin.subscriptions.updated"),
            tone: "success",
          }),
        onError: (error) =>
          toast({
            title: t("facilityAdmin.subscriptions.updateFailed"),
            description: error instanceof ApiError ? error.message : undefined,
            tone: "danger",
          }),
      },
    );
  }

  return (
    <div className="grid gap-5">
      <ConfigSection
        slot="facility-subscriptions"
        title={t("facilityAdmin.subscriptions.title")}
        description={t("facilityAdmin.subscriptions.description")}
        action={
          <Button
            type="button"
            size="sm"
            onClick={() => setDialog({ mode: "create" })}
          >
            {t("facilityAdmin.subscriptions.add")}
          </Button>
        }
      >
        {plans.length === 0 ? (
          <EmptyState
            title={t("facilityAdmin.subscriptions.empty")}
            description={t("facilityAdmin.subscriptions.emptyHint")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("facilityAdmin.subscriptions.columnsName")}
                </TableHead>
                <TableHead numeric>
                  {t("facilityAdmin.subscriptions.columnsPrice")}
                </TableHead>
                <TableHead numeric>
                  {t("facilityAdmin.subscriptions.columnsQuota")}
                </TableHead>
                <TableHead>
                  {t("facilityAdmin.subscriptions.columnsInterval")}
                </TableHead>
                <TableHead numeric>
                  {t("facilityAdmin.subscriptions.columnsMaxPerDay")}
                </TableHead>
                <TableHead>{t("facilityAdmin.common.status")}</TableHead>
                <TableHead className="text-right">
                  {t("facilityAdmin.common.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.map((plan) => (
                <TableRow
                  key={plan.id}
                  data-slot="facility-plan"
                  data-plan-id={plan.id}
                >
                  <TableCell className="font-medium">{plan.name}</TableCell>
                  <TableCell numeric>
                    <Money amount={plan.priceIdr} />
                  </TableCell>
                  <TableCell numeric>
                    {t("facilityAdmin.subscriptions.quotaPerPeriod", {
                      count: plan.quotaPerPeriod,
                    })}
                  </TableCell>
                  <TableCell>
                    {t(subscriptionIntervalLabel[plan.interval])}
                  </TableCell>
                  <TableCell numeric>
                    {plan.maxPerDay === null
                      ? t("facilityAdmin.common.unlimited")
                      : plan.maxPerDay}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={plan.isActive}
                      disabled={updatePlan.isPending}
                      aria-label={t(
                        plan.isActive
                          ? "facilityAdmin.subscriptions.disable"
                          : "facilityAdmin.subscriptions.enable",
                        { name: plan.name },
                      )}
                      onCheckedChange={(checked) => toggle(plan, checked)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t("facilityAdmin.subscriptions.edit", {
                          name: plan.name,
                        })}
                        onClick={() => setDialog({ mode: "edit", plan })}
                      >
                        {t("facilityAdmin.common.edit")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ConfigSection>

      {dialog && (
        <PlanDialog
          key={dialog.mode === "edit" ? dialog.plan.id : "new-plan"}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          facilityId={facilityId}
          plan={dialog.mode === "edit" ? dialog.plan : null}
        />
      )}
    </div>
  );
}

function PlanDialog({
  open,
  onOpenChange,
  facilityId,
  plan,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facilityId: string;
  plan: SubscriptionPlan | null;
}) {
  const t = useT();
  const toast = useToast();
  const createPlan = useCreatePlan(facilityId);
  const updatePlan = useUpdatePlan(facilityId);
  const [name, setName] = React.useState(plan?.name ?? "");
  const [price, setPrice] = React.useState(plan ? String(plan.priceIdr) : "");
  const [quota, setQuota] = React.useState(
    plan ? String(plan.quotaPerPeriod) : "10",
  );
  const [interval, setInterval] = React.useState<SubscriptionInterval>(
    plan?.interval ?? "month",
  );
  const [maxPerDay, setMaxPerDay] = React.useState(
    plan?.maxPerDay === null || plan?.maxPerDay === undefined
      ? ""
      : String(plan.maxPerDay),
  );
  const [providerPlanId, setProviderPlanId] = React.useState(
    plan?.providerPlanId ?? "",
  );
  const [isActive, setIsActive] = React.useState(plan?.isActive ?? true);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string>();
  const pending = createPlan.isPending || updatePlan.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    const trimmed = name.trim();
    if (trimmed.length === 0)
      next.name = t("facilityAdmin.subscriptions.errorsNameRequired");
    else if (trimmed.length > 150)
      next.name = t("facilityAdmin.errors.tooLong", {
        field: t("facilityAdmin.subscriptions.fieldsName"),
        max: 150,
      });
    const priceIdr = parseInteger(price);
    if (priceIdr === null)
      next.priceIdr = t("facilityAdmin.subscriptions.errorsPriceInvalid");
    const quotaPerPeriod = parseInteger(quota);
    if (quotaPerPeriod === null || quotaPerPeriod < 1 || quotaPerPeriod > 100)
      next.quotaPerPeriod = t("facilityAdmin.subscriptions.errorsQuotaInvalid");
    const maxParsed = maxPerDay.trim() === "" ? null : parseInteger(maxPerDay);
    if (
      maxPerDay.trim() !== "" &&
      (maxParsed === null || maxParsed < 1 || maxParsed > 10)
    )
      next.maxPerDay = t("facilityAdmin.products.errorsMaxPerDayInvalid");
    const provider = providerPlanId.trim();
    if (provider.length > 100)
      next.providerPlanId = t("facilityAdmin.errors.tooLong", {
        field: t("facilityAdmin.subscriptions.fieldsProviderPlanId"),
        max: 100,
      });

    setErrors(next);
    if (Object.keys(next).length > 0) {
      setFormError(t("form.errorSummary", { count: Object.keys(next).length }));
      return;
    }
    setFormError(undefined);
    if (priceIdr === null || quotaPerPeriod === null) return;

    if (plan) {
      const parsed = parseUpdateDraft(updateSubscriptionPlanSchema, {
        name: trimmed,
        priceIdr,
        quotaPerPeriod,
        interval,
        maxPerDay: maxParsed,
        providerPlanId: provider === "" ? null : provider,
        isActive,
      });
      if (!parsed.success) {
        setErrors(zodFieldErrors(parsed.error));
        setFormError(
          t("form.errorSummary", { count: parsed.error.issues.length }),
        );
        return;
      }
      updatePlan.mutate(
        {
          planId: plan.id,
          body: parsed.data,
          expectedUpdatedAt: plan.updatedAt,
        },
        {
          onSuccess: () => {
            toast({
              title: t("facilityAdmin.subscriptions.updated"),
              tone: "success",
            });
            onOpenChange(false);
          },
          onError: (error) =>
            setFormError(
              error instanceof ApiError
                ? error.message
                : t("facilityAdmin.subscriptions.updateFailed"),
            ),
        },
      );
      return;
    }

    const parsed = parseCreateDraft(createSubscriptionPlanSchema, {
      facilityId,
      name: trimmed,
      priceIdr,
      quotaPerPeriod,
      interval,
      maxPerDay: maxParsed,
      providerPlanId: provider === "" ? null : provider,
      isActive,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setFormError(
        t("form.errorSummary", { count: parsed.error.issues.length }),
      );
      return;
    }
    createPlan.mutate(parsed.data, {
      onSuccess: () => {
        toast({
          title: t("facilityAdmin.subscriptions.created"),
          tone: "success",
        });
        onOpenChange(false);
      },
      onError: (error) =>
        setFormError(
          error instanceof ApiError
            ? error.message
            : t("facilityAdmin.subscriptions.createFailed"),
        ),
    });
  }

  return (
    <PendingDialog pending={pending} open={open} onOpenChange={onOpenChange}>
      <PendingDialogContent>
        <DialogHeader>
          <DialogTitle>
            {plan
              ? t("facilityAdmin.subscriptions.editTitle")
              : t("facilityAdmin.subscriptions.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("facilityAdmin.subscriptions.description")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-4">
          <FormField
            label={t("facilityAdmin.subscriptions.fieldsName")}
            error={errors.name}
            required
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("facilityAdmin.subscriptions.fieldsPrice")}
              hint={t("facilityAdmin.common.priceExclTaxHint")}
              error={errors.priceIdr}
              required
            >
              <Input
                inputMode="numeric"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </FormField>
            <FormField
              label={t("facilityAdmin.subscriptions.fieldsQuota")}
              error={errors.quotaPerPeriod}
              required
            >
              <Input
                inputMode="numeric"
                value={quota}
                onChange={(event) => setQuota(event.target.value)}
              />
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("facilityAdmin.subscriptions.fieldsInterval")}
              required
            >
              <Select
                value={interval}
                onValueChange={(value) =>
                  setInterval(value as SubscriptionInterval)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVALS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(subscriptionIntervalLabel[option])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label={t("facilityAdmin.subscriptions.fieldsMaxPerDay")}
              hint={t("facilityAdmin.subscriptions.fieldsMaxPerDayHint")}
              error={errors.maxPerDay}
            >
              <Input
                inputMode="numeric"
                value={maxPerDay}
                onChange={(event) => setMaxPerDay(event.target.value)}
              />
            </FormField>
          </div>
          <FormField
            label={t("facilityAdmin.subscriptions.fieldsProviderPlanId")}
            hint={t("facilityAdmin.subscriptions.fieldsProviderPlanHint")}
            error={errors.providerPlanId}
          >
            <Input
              value={providerPlanId}
              onChange={(event) => setProviderPlanId(event.target.value)}
              autoComplete="off"
            />
          </FormField>
          <div className="flex items-start justify-between gap-3">
            <Label htmlFor="facility-plan-active">
              {t("facilityAdmin.subscriptions.fieldsActive")}
            </Label>
            <Switch
              id="facility-plan-active"
              checked={isActive}
              onCheckedChange={setIsActive}
            />
          </div>
          <FormError message={formError} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" loading={pending}>
              {t("facilityAdmin.subscriptions.save")}
            </Button>
          </DialogFooter>
        </form>
      </PendingDialogContent>
    </PendingDialog>
  );
}
