// Stacking policy (/kelola/promo/tumpang-tindih; PRD v1.7 §3.21 "aturan tumpang
// tindih"): exclusive (one best promotion) or stackable (up to maxStacked,
// optionally two from the same group). The worked example shows the owner's
// sequential rule (Q20): percentages apply to what is left, so 10% then 20% of
// Rp100.000 is Rp28.000, not Rp30.000.
import * as React from "react";
import { Layers, Save } from "lucide-react";
import type { PromoStackingPolicy } from "@starter/shared/crm";
import { formatRupiah } from "@starter/shared/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useSaveStackingPolicy, useStackingPolicy } from "../hooks";
import {
  formatPercentBp,
  parsePercentBp,
  parseWholeNumber,
  sequentialStack,
} from "../lib";
import { usePromoT } from "../t";
import { LoadingBlock, Notice, ReadError, useOnline } from "./promo-shell";

type Draft = {
  mode: PromoStackingPolicy["mode"];
  maxStacked: string;
  allowSameGroup: boolean;
};

export function StackingPage() {
  const t = usePromoT();
  const policyQuery = useStackingPolicy();

  if (policyQuery.isPending)
    return (
      <Card>
        <LoadingBlock rows={4} />
      </Card>
    );
  if (policyQuery.isError)
    return (
      <Card>
        <ReadError
          error={policyQuery.error}
          onRetry={() => void policyQuery.refetch()}
        />
      </Card>
    );
  return (
    <div className="grid min-w-0 items-start gap-5 lg:grid-cols-2">
      <PolicyForm policy={policyQuery.data.data} />
      <Card aria-labelledby="stack-example-title">
        <ExampleBody
          policy={policyQuery.data.data}
          titleId="stack-example-title"
        />
        <p className="text-sm leading-5 text-muted-foreground">
          <span className="font-semibold text-foreground">
            {t("promo.stacking.orderTitle")}.
          </span>{" "}
          {t("promo.stacking.orderBody")}
        </p>
      </Card>
    </div>
  );
}

function PolicyForm({ policy }: { policy: PromoStackingPolicy }) {
  const t = usePromoT();
  const toast = useToast();
  const online = useOnline();
  const save = useSaveStackingPolicy();
  const [draft, setDraft] = React.useState<Draft>({
    mode: policy.mode,
    maxStacked: String(policy.maxStacked),
    allowSameGroup: policy.allowSameGroup,
  });
  const [maxError, setMaxError] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  function submit() {
    const max = parseWholeNumber(draft.maxStacked);
    const invalid =
      draft.mode === "stackable" && (max === null || max < 1 || max > 10);
    setMaxError(invalid);
    if (invalid) return;
    save.mutate(
      {
        mode: draft.mode,
        maxStacked: draft.mode === "exclusive" ? 1 : (max ?? 1),
        allowSameGroup:
          draft.mode === "exclusive" ? false : draft.allowSameGroup,
      },
      {
        onSuccess: () => {
          setFailed(false);
          toast({ title: t("promo.stacking.savedToast"), tone: "success" });
        },
        onError: () => setFailed(true),
      },
    );
  }

  const stackable = draft.mode === "stackable";
  return (
    <Card aria-labelledby="stack-policy-title">
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-1">
          <h3 id="stack-policy-title" className="type-title">
            {t("promo.stacking.title")}
          </h3>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("promo.stacking.description")}
          </p>
        </div>

        <div className="grid gap-2">
          <p className="text-sm leading-5 font-semibold">
            {t("promo.stacking.mode")}
          </p>
          <SegmentedControl
            label={t("promo.stacking.mode")}
            value={draft.mode}
            onValueChange={(mode) => {
              setDraft((current) => ({ ...current, mode }));
              setFailed(false);
            }}
            options={[
              {
                value: "exclusive",
                label: t("promo.stacking.modeExclusive"),
                icon: Layers,
              },
              {
                value: "stackable",
                label: t("promo.stacking.modeStackable"),
                icon: Layers,
              },
            ]}
          />
          <p className="text-sm leading-5 text-muted-foreground">
            {stackable
              ? t("promo.stacking.modeStackableHint")
              : t("promo.stacking.modeExclusiveHint")}
          </p>
        </div>

        {stackable && (
          <>
            <FormField
              label={t("promo.stacking.maxStacked")}
              hint={t("promo.stacking.maxStackedHint")}
              error={maxError ? t("promo.stacking.errorMaxStacked") : undefined}
              required
            >
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={10}
                value={draft.maxStacked}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    maxStacked: event.target.value,
                  }));
                  setMaxError(false);
                }}
              />
            </FormField>
            <div className="grid gap-1">
              <div className="flex items-center gap-3">
                <Switch
                  id="stack-same-group"
                  checked={draft.allowSameGroup}
                  onCheckedChange={(checked) =>
                    setDraft((current) => ({
                      ...current,
                      allowSameGroup: checked,
                    }))
                  }
                />
                <Label htmlFor="stack-same-group">
                  {t("promo.stacking.allowSameGroup")}
                </Label>
              </div>
              <p className="text-sm leading-5 text-muted-foreground">
                {t("promo.stacking.allowSameGroupHint")}
              </p>
            </div>
          </>
        )}

        {failed && (
          <Notice tone="danger" role="alert">
            {t("promo.stacking.saveFailed")}
          </Notice>
        )}
        {!online && (
          <Notice tone="warning">{t("promo.offline.saveBlocked")}</Notice>
        )}
        <div>
          <Button type="submit" loading={save.isPending} disabled={!online}>
            <Save aria-hidden="true" />
            {t("promo.stacking.save")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ExampleBody({
  policy,
  titleId,
}: {
  policy: PromoStackingPolicy;
  titleId: string;
}) {
  const t = usePromoT();
  const [subtotal, setSubtotal] = React.useState("100000");
  const [first, setFirst] = React.useState("10");
  const [second, setSecond] = React.useState("20");

  const base = parseWholeNumber(subtotal);
  const bps = [parsePercentBp(first), parsePercentBp(second)];
  const valid = base !== null && base >= 0 && bps.every((bp) => bp !== null);
  const result = valid ? sequentialStack(base, bps as number[]) : null;
  const exclusive = valid
    ? Math.max(
        ...sequentialStack(base, [bps[0] as number]).steps.map(
          (s) => s.discountIdr,
        ),
        ...sequentialStack(base, [bps[1] as number]).steps.map(
          (s) => s.discountIdr,
        ),
      )
    : 0;

  return (
    <>
      <div className="grid gap-1">
        <h3 id={titleId} className="type-title">
          {t("promo.stacking.exampleTitle")}
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("promo.stacking.exampleHint")}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label={t("promo.stacking.exampleSubtotal")}>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            value={subtotal}
            onChange={(event) => setSubtotal(event.target.value)}
          />
        </FormField>
        <FormField label={t("promo.stacking.exampleFirst")}>
          <Input
            inputMode="decimal"
            value={first}
            onChange={(event) => setFirst(event.target.value)}
          />
        </FormField>
        <FormField label={t("promo.stacking.exampleSecond")}>
          <Input
            inputMode="decimal"
            value={second}
            onChange={(event) => setSecond(event.target.value)}
          />
        </FormField>
      </div>
      {result && (
        <dl className="grid gap-1.5 text-sm" data-testid="stack-example">
          {result.steps.map((step, index) => (
            <div
              key={index}
              className="flex items-baseline justify-between gap-3"
            >
              <dt className="min-w-0 text-muted-foreground">
                {t(index === 0 ? "stacking.stepFirst" : "stacking.stepSecond", {
                  percent: formatPercentBp(step.percentBp),
                  base: formatRupiah(step.baseIdr),
                })}
              </dt>
              <dd className="tabular whitespace-nowrap">
                {formatRupiah(step.discountIdr)}
              </dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-3 border-t pt-1.5 font-semibold">
            <dt>{t("promo.stacking.stepTotal")}</dt>
            <dd className="tabular whitespace-nowrap" data-testid="stack-total">
              {formatRupiah(result.totalIdr)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">
              {t("promo.stacking.stepPay")}
            </dt>
            <dd className="tabular whitespace-nowrap">
              {formatRupiah(result.payIdr)}
            </dd>
          </div>
        </dl>
      )}
      {valid && policy.mode === "exclusive" && (
        <Notice tone="info">
          {t("promo.stacking.exampleExclusive", {
            amount: formatRupiah(exclusive),
          })}
        </Notice>
      )}
      {valid && policy.mode === "stackable" && policy.maxStacked < 2 && (
        <Notice tone="info">
          {t("promo.stacking.exampleLimit", { max: policy.maxStacked })}
        </Notice>
      )}
    </>
  );
}
