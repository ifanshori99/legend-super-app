// Loyalty program screen (/kelola/loyalty): the earn ratio, the point value,
// the expiry policy and the rolling tier window (PRD v1.7 §3.20 "Poin",
// "Kedaluwarsa Poin", "Tier"; §6.G loyalty_programs). Saves one PUT with the
// whole program; the example below the form is computed with the contract's
// pointsForSpend, so it never drifts from the engine.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { formatRupiah, formatNumber } from "@starter/shared/i18n";
import { idrSchema } from "@starter/shared/core";
import { pointsForSpend, type LoyaltyProgram } from "@starter/shared/crm";
import { useProgram, useUpdateProgram } from "../hooks";
import {
  formatMultiplier,
  hasErrors,
  parseWholeNumber,
  programBody,
  programFormFrom,
  validateProgramForm,
  type ProgramField,
  type ProgramForm,
  type ValidationErrors,
} from "../lib";

/** Default example spend; the admin can type another amount. */
const DEFAULT_PREVIEW_SPEND = "100000";

/** Live program used for the example; null while a field is unusable. */
function draftProgram(
  program: LoyaltyProgram,
  form: ProgramForm,
): LoyaltyProgram | null {
  const spendIdr = parseWholeNumber(form.earnSpend);
  const points = parseWholeNumber(form.earnPoints);
  const pointValueIdr = parseWholeNumber(form.pointValue);
  if (spendIdr === null || spendIdr < 1) return null;
  if (points === null || points < 1) return null;
  if (pointValueIdr === null || pointValueIdr < 1) return null;
  return {
    ...program,
    name: form.name,
    earnRate: { spendIdr: idrSchema.parse(spendIdr), points },
    expiryMonths: parseWholeNumber(form.expiry) ?? program.expiryMonths,
    rollingMonths: parseWholeNumber(form.rolling) ?? program.rollingMonths,
    pointValueIdr: idrSchema.parse(pointValueIdr),
  };
}

export function ProgramPage() {
  const t = useT();
  const toast = useToast();
  const programQuery = useProgram();
  const updateProgram = useUpdateProgram();

  // The form starts from the saved program and keeps the admin's edits in
  // `draft`; saving clears it so the refreshed row shows through again.
  const [draft, setDraft] = React.useState<ProgramForm | null>(null);
  const [errors, setErrors] = React.useState<ValidationErrors<ProgramField>>(
    {},
  );
  const [saveFailed, setSaveFailed] = React.useState(false);
  const [previewSpend, setPreviewSpend] = React.useState(DEFAULT_PREVIEW_SPEND);

  const program = programQuery.data?.data.program;
  const form = draft ?? (program ? programFormFrom(program) : null);
  const topTier = React.useMemo(
    () =>
      (programQuery.data?.data.tiers ?? [])
        .filter((tier) => tier.isActive)
        .sort((a, b) => b.rank - a.rank)
        .at(0),
    [programQuery.data],
  );

  const set = <Field extends keyof ProgramForm>(
    field: Field,
    value: ProgramForm[Field],
  ) => {
    if (!form) return;
    setDraft((current) => ({ ...(current ?? form), [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaveFailed(false);
  };

  function save() {
    if (!form) return;
    const next = validateProgramForm(form);
    setErrors(next);
    if (hasErrors(next)) return;
    updateProgram.mutate(programBody(form), {
      onSuccess: () => {
        toast({ title: t("loyalty.program.savedToast"), tone: "success" });
        setDraft(null);
        setSaveFailed(false);
      },
      onError: () => setSaveFailed(true),
    });
  }

  if (programQuery.isPending || (programQuery.isSuccess && form === null))
    return (
      <Card aria-busy="true">
        <span className="sr-only">{t("common.loading")}</span>
        <Skeleton className="h-6 w-48" />
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-control" />
          ))}
        </div>
      </Card>
    );

  if (programQuery.isError || program === undefined)
    return (
      <Card>
        <ErrorState onRetry={() => void programQuery.refetch()} />
      </Card>
    );

  const liveProgram = form ? draftProgram(program, form) : null;
  const spend = parseWholeNumber(previewSpend);
  const basePoints =
    liveProgram && spend !== null && spend >= 0
      ? pointsForSpend(liveProgram, spend)
      : null;
  const topTierPoints =
    liveProgram && spend !== null && spend >= 0 && topTier
      ? pointsForSpend(liveProgram, spend, topTier.benefits.pointsMultiplierBp)
      : null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("loyalty.program.title")}</CardTitle>
          <CardDescription>{t("loyalty.program.description")}</CardDescription>
        </CardHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label={t("loyalty.program.name")}
            hint={t("loyalty.program.nameHint")}
            error={errors.name && t(errors.name)}
            required
            className="sm:col-span-2"
          >
            <Input
              value={form?.name ?? ""}
              onChange={(event) => set("name", event.target.value)}
              autoComplete="off"
            />
          </FormField>

          <FormField
            label={t("loyalty.program.earnSpend")}
            hint={t("loyalty.program.earnHint")}
            error={errors.earnSpend && t(errors.earnSpend)}
            required
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={form?.earnSpend ?? ""}
              onChange={(event) => set("earnSpend", event.target.value)}
            />
          </FormField>

          <FormField
            label={t("loyalty.program.earnPoints")}
            required
            error={errors.earnPoints && t(errors.earnPoints)}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={form?.earnPoints ?? ""}
              onChange={(event) => set("earnPoints", event.target.value)}
            />
          </FormField>

          <FormField
            label={t("loyalty.program.expiry")}
            hint={t("loyalty.program.expiryHint")}
            error={errors.expiry && t(errors.expiry)}
            required
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={60}
              value={form?.expiry ?? ""}
              onChange={(event) => set("expiry", event.target.value)}
            />
          </FormField>

          <FormField
            label={t("loyalty.program.rolling")}
            hint={t("loyalty.program.rollingHint")}
            error={errors.rolling && t(errors.rolling)}
            required
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={60}
              value={form?.rolling ?? ""}
              onChange={(event) => set("rolling", event.target.value)}
            />
          </FormField>

          <FormField
            label={t("loyalty.program.pointValue")}
            hint={t("loyalty.program.pointValueHint")}
            error={errors.pointValue && t(errors.pointValue)}
            required
            className="sm:col-span-2"
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={form?.pointValue ?? ""}
              onChange={(event) => set("pointValue", event.target.value)}
            />
          </FormField>
        </div>

        <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="tabular text-sm leading-5 text-muted-foreground">
            {liveProgram
              ? `${t("loyalty.program.rateLine", {
                  spend: formatRupiah(liveProgram.earnRate.spendIdr),
                  points: formatNumber(liveProgram.earnRate.points),
                })} · ${t("loyalty.program.pointValueLine", {
                  value: formatRupiah(liveProgram.pointValueIdr),
                })}`
              : ""}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {saveFailed && (
              <p role="alert" className="text-sm leading-5 text-danger">
                {t("loyalty.program.saveFailed")}
              </p>
            )}
            <Button
              type="button"
              loading={updateProgram.isPending}
              onClick={save}
            >
              {t("loyalty.program.save")}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("loyalty.program.preview.title")}</CardTitle>
          <CardDescription>
            {t("loyalty.program.preview.description")}
          </CardDescription>
        </CardHeader>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <FormField label={t("loyalty.program.preview.spend")} required>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              value={previewSpend}
              onChange={(event) => setPreviewSpend(event.target.value)}
            />
          </FormField>
          <dl className="grid content-start gap-3 sm:grid-cols-2">
            <div className="grid gap-0.5 rounded-lg bg-muted p-3">
              <dt className="text-sm leading-5 text-muted-foreground">
                {t("loyalty.program.preview.base")}
              </dt>
              <dd className="text-xl font-semibold tabular">
                {basePoints === null
                  ? "—"
                  : t("loyalty.program.preview.pointsValue", {
                      count: basePoints,
                    })}
              </dd>
              <dd className="text-xs leading-4 text-muted-foreground">
                {t("loyalty.program.preview.baseHint")}
              </dd>
            </div>
            {topTier && (
              <div className="grid gap-0.5 rounded-lg bg-muted p-3">
                <dt className="text-sm leading-5 text-muted-foreground">
                  {t("loyalty.program.preview.topTier", {
                    tier: topTier.name,
                    multiplier: formatMultiplier(
                      topTier.benefits.pointsMultiplierBp,
                    ),
                  })}
                </dt>
                <dd className="text-xl font-semibold tabular">
                  {topTierPoints === null
                    ? "—"
                    : t("loyalty.program.preview.pointsValue", {
                        count: topTierPoints,
                      })}
                </dd>
                <dd className="text-xs leading-4 text-muted-foreground">
                  {t("loyalty.program.preview.topTierHint")}
                </dd>
              </div>
            )}
          </dl>
        </div>
        {!topTier && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("loyalty.program.preview.noTiers")}
          </p>
        )}
      </Card>
    </>
  );
}
