// Open-bill policy of one outlet (bead legend-2zb5; PRD v1.7 §3 F43 "Kontrol
// Open Bill"): the unpaid-bill limit a supervisor may not cross when turning a
// table into an open bill, the idle reminder and the bill-request target. The
// form keeps its fields as text so a half-typed number never fights the
// input; every submit and blur parses them with the shared schema, the same
// one the API checks.
import * as React from "react";
import { CircleAlert } from "lucide-react";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import {
  OPEN_BILL_INACTIVITY_MINUTES_MAX,
  OPEN_BILL_INACTIVITY_MINUTES_MIN,
  OPEN_BILL_MAX_VALUE_CEILING_IDR,
  OPEN_BILL_MAX_VALUE_FLOOR_IDR,
  OPEN_BILL_SLO_SECONDS_MAX,
  OPEN_BILL_SLO_SECONDS_MIN,
  upsertOpenBillPolicyInputSchema,
  type OpenBillPolicy,
} from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardShell } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOpenBillPolicy, useUpdateOpenBillPolicy } from "../hooks";
import { OPEN_BILL_DEFAULTS } from "../lib";
import { OPEN_BILL_OUTLET_ID } from "../outlet";

type FieldName = keyof typeof OPEN_BILL_DEFAULTS;
type FormValues = Record<FieldName, string>;
type FieldErrors = Partial<Record<FieldName | "form", string>>;

const FIELDS: readonly FieldName[] = [
  "maxBillValueIdr",
  "inactivityMinutes",
  "billRequestSloSeconds",
];

/** Digits only, grouped for display: "3000000" → "3.000.000". */
function groupDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 12);
  return digits === "" ? "" : formatNumber(Number(digits));
}

function toValues(source: Record<FieldName, number>): FormValues {
  return {
    maxBillValueIdr: groupDigits(String(source.maxBillValueIdr)),
    inactivityMinutes: String(source.inactivityMinutes),
    billRequestSloSeconds: String(source.billRequestSloSeconds),
  };
}

/**
 * Empty or non-numeric text becomes NaN, which the schema rejects. The Rupiah
 * field is grouped on input, so it keeps only its digits; minutes and seconds
 * must already be plain digits, so "4x5" shows the message instead of 45.
 */
function toNumber(name: FieldName, value: string): number {
  const text =
    name === "maxBillValueIdr" ? value.replace(/\D/g, "") : value.trim();
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

function parseValues(values: FormValues) {
  return upsertOpenBillPolicyInputSchema.safeParse({
    maxBillValueIdr: toNumber("maxBillValueIdr", values.maxBillValueIdr),
    inactivityMinutes: toNumber("inactivityMinutes", values.inactivityMinutes),
    billRequestSloSeconds: toNumber(
      "billRequestSloSeconds",
      values.billRequestSloSeconds,
    ),
  });
}

/** Input with a fixed prefix or suffix (Rp, menit, detik) inside the field. */
function AffixInput({
  prefix,
  suffix,
  className,
  ...props
}: React.ComponentProps<typeof Input> & { prefix?: string; suffix?: string }) {
  return (
    <div className="relative">
      {prefix && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 start-3 grid place-items-center text-sm text-muted-foreground"
        >
          {prefix}
        </span>
      )}
      <Input
        {...props}
        className={[
          "h-11 tabular-nums sm:h-control",
          prefix ? "ps-10" : "",
          suffix ? "pe-16" : "",
          className ?? "",
        ].join(" ")}
      />
      {suffix && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 end-3 grid place-items-center text-sm text-muted-foreground"
        >
          {suffix}
        </span>
      )}
    </div>
  );
}

export function OpenBillPolicyPage() {
  const t = useT();
  const policyQuery = useOpenBillPolicy(OPEN_BILL_OUTLET_ID);
  const policy = policyQuery.data;

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 className="type-title">{t("openBillPolicy.title")}</h2>
          <p className="max-w-2xl text-base leading-5 text-muted-foreground sm:text-sm">
            {t("openBillPolicy.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {policy?.isDefault && (
            <Badge tone="neutral">{t("openBillPolicy.defaultBadge")}</Badge>
          )}
          {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
        </div>
      </div>

      {policyQuery.isPending ? (
        <div aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          <PolicyFormSkeleton />
        </div>
      ) : policy ? (
        <PolicyForm
          // Remount on a saved or reloaded policy so the fields restart from it.
          key={`${policy.maxBillValueIdr}-${policy.inactivityMinutes}-${policy.billRequestSloSeconds}-${policy.isDefault}`}
          policy={policy}
        />
      ) : (
        <ErrorState
          description={t("openBillPolicy.loadError")}
          action={
            <Button
              variant="outline"
              size="sm"
              className="h-11 sm:h-control-sm"
              onClick={() => void policyQuery.refetch()}
            >
              {t("openBillPolicy.retry")}
            </Button>
          }
        />
      )}
    </div>
  );
}

/** Same shape as the form: explain line, three label + input rows, buttons. */
function PolicyFormSkeleton() {
  return (
    <CardShell>
      <Card>
        <div className="grid max-w-2xl gap-4">
          <Skeleton className="h-5 w-full max-w-xl" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="grid gap-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-11 w-full sm:h-control" />
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <Skeleton className="h-11 w-40 sm:h-control" />
            <Skeleton className="h-11 w-36 sm:h-control" />
          </div>
        </div>
      </Card>
    </CardShell>
  );
}

function PolicyForm({ policy }: { policy: OpenBillPolicy }) {
  const t = useT();
  const toast = useToast();
  const updatePolicy = useUpdateOpenBillPolicy(OPEN_BILL_OUTLET_ID);

  const [values, setValues] = React.useState<FormValues>(() =>
    toValues(policy),
  );
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const formRef = React.useRef<HTMLFormElement>(null);

  const fieldMessage: Record<FieldName, string> = {
    maxBillValueIdr: t("openBillPolicy.max.error", {
      min: formatRupiah(OPEN_BILL_MAX_VALUE_FLOOR_IDR),
      max: formatRupiah(OPEN_BILL_MAX_VALUE_CEILING_IDR),
    }),
    inactivityMinutes: t("openBillPolicy.idle.error", {
      min: formatNumber(OPEN_BILL_INACTIVITY_MINUTES_MIN),
      max: formatNumber(OPEN_BILL_INACTIVITY_MINUTES_MAX),
    }),
    billRequestSloSeconds: t("openBillPolicy.slo.error", {
      min: formatNumber(OPEN_BILL_SLO_SECONDS_MIN),
      max: formatNumber(OPEN_BILL_SLO_SECONDS_MAX),
    }),
  };

  /** Field names the schema rejects for the current values. */
  function invalidFields(next: FormValues): Set<FieldName> {
    const result = parseValues(next);
    const bad = new Set<FieldName>();
    if (!result.success)
      for (const issue of result.error.issues) {
        const name = issue.path[0];
        if (FIELDS.includes(name as FieldName)) bad.add(name as FieldName);
      }
    return bad;
  }

  function change(name: FieldName, raw: string) {
    setValues((current) => ({
      ...current,
      [name]: name === "maxBillValueIdr" ? groupDigits(raw) : raw,
    }));
    // Clear a message as soon as the person edits that field; blur or submit
    // check it again.
    setErrors((current) => ({
      ...current,
      [name]: undefined,
      form: undefined,
    }));
  }

  function blur(name: FieldName) {
    const bad = invalidFields(values);
    setErrors((current) => ({
      ...current,
      [name]: bad.has(name) ? fieldMessage[name] : undefined,
    }));
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = parseValues(values);
    if (!result.success) {
      const bad = invalidFields(values);
      const next: FieldErrors = {};
      for (const name of bad) next[name] = fieldMessage[name];
      setErrors(next);
      // Send focus to the first wrong field, in on-screen order.
      const first = FIELDS.find((name) => bad.has(name));
      const control = first && formRef.current?.elements.namedItem(first);
      if (control instanceof HTMLElement) control.focus();
      return;
    }
    setErrors({});
    updatePolicy.mutate(result.data, {
      onSuccess: () =>
        toast({ title: t("openBillPolicy.saved"), tone: "success" }),
      onError: () => setErrors({ form: t("openBillPolicy.saveError") }),
    });
  }

  function resetToDefault() {
    setValues(toValues(OPEN_BILL_DEFAULTS));
    setErrors({});
  }

  return (
    <CardShell>
      <Card>
        <form
          ref={formRef}
          onSubmit={submit}
          noValidate
          className="grid max-w-2xl gap-4"
          aria-busy={updatePolicy.isPending || undefined}
        >
          <p className="text-base leading-5 text-muted-foreground sm:text-sm">
            {t("openBillPolicy.explain")}
          </p>

          <FormField
            label={t("openBillPolicy.max.label")}
            id="open-bill-max"
            hint={
              <span className="text-base sm:text-sm">
                {t("openBillPolicy.max.hint", {
                  min: formatRupiah(OPEN_BILL_MAX_VALUE_FLOOR_IDR),
                  max: formatRupiah(OPEN_BILL_MAX_VALUE_CEILING_IDR),
                })}
              </span>
            }
            error={errors.maxBillValueIdr}
            required
          >
            <AffixInput
              id="open-bill-max"
              name="maxBillValueIdr"
              prefix="Rp"
              inputMode="numeric"
              autoComplete="off"
              value={values.maxBillValueIdr}
              onChange={(event) =>
                change("maxBillValueIdr", event.target.value)
              }
              onBlur={() => blur("maxBillValueIdr")}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("openBillPolicy.idle.label")}
              id="open-bill-idle"
              hint={
                <span className="text-base sm:text-sm">
                  {t("openBillPolicy.idle.hint", {
                    min: formatNumber(OPEN_BILL_INACTIVITY_MINUTES_MIN),
                    max: formatNumber(OPEN_BILL_INACTIVITY_MINUTES_MAX),
                  })}
                </span>
              }
              error={errors.inactivityMinutes}
              required
            >
              <AffixInput
                id="open-bill-idle"
                name="inactivityMinutes"
                suffix={t("openBillPolicy.idle.unit")}
                inputMode="numeric"
                autoComplete="off"
                value={values.inactivityMinutes}
                onChange={(event) =>
                  change("inactivityMinutes", event.target.value)
                }
                onBlur={() => blur("inactivityMinutes")}
              />
            </FormField>
            <FormField
              label={t("openBillPolicy.slo.label")}
              id="open-bill-slo"
              hint={
                <span className="text-base sm:text-sm">
                  {t("openBillPolicy.slo.hint", {
                    min: formatNumber(OPEN_BILL_SLO_SECONDS_MIN),
                    max: formatNumber(OPEN_BILL_SLO_SECONDS_MAX),
                  })}
                </span>
              }
              error={errors.billRequestSloSeconds}
              required
            >
              <AffixInput
                id="open-bill-slo"
                name="billRequestSloSeconds"
                suffix={t("openBillPolicy.slo.unit")}
                inputMode="numeric"
                autoComplete="off"
                value={values.billRequestSloSeconds}
                onChange={(event) =>
                  change("billRequestSloSeconds", event.target.value)
                }
                onBlur={() => blur("billRequestSloSeconds")}
              />
            </FormField>
          </div>

          <p className="text-base leading-5 text-muted-foreground sm:text-sm">
            {t("openBillPolicy.who")}
          </p>

          {errors.form && (
            <p
              role="alert"
              className="flex items-start gap-1.5 rounded-control border-(length:--border-w) border-danger bg-danger-subtle px-3 py-2 text-sm font-medium text-danger"
            >
              <CircleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <span>{errors.form}</span>
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:h-control"
              onClick={resetToDefault}
              disabled={updatePolicy.isPending}
            >
              {t("openBillPolicy.reset")}
            </Button>
            <Button
              type="submit"
              className="h-11 sm:h-control"
              loading={updatePolicy.isPending}
            >
              {t("openBillPolicy.save")}
            </Button>
          </div>
        </form>
      </Card>
    </CardShell>
  );
}
