// Create a service-charge pool (PRD v1.7 §3 D.30 "Distribusi Service Charge"):
// the period, the collected amount, and the rule (method, minimum attendance,
// eligible employment types). The pool starts as a draft; calculating and
// approving are separate actions on the page.
import * as React from "react";
import { HandCoins } from "lucide-react";
import {
  businessDateOf,
  businessDateSchema,
  DEFAULT_BUSINESS_DAY_CUTOFF,
  idr,
  type Idr,
} from "@starter/shared/core";
import type { EmploymentType } from "@starter/shared/hris";
import {
  serviceChargeMethodSchema,
  type ServiceChargeMethod,
} from "@starter/shared/hris/payroll";
import type { MessageKey } from "@starter/shared/i18n";
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
import { useToast } from "@/components/ui/toast";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";
import { payrollErrorMessage } from "../errors";
import { useCreatePool } from "../hooks";
import { POOL_METHOD_LABEL } from "../lib";
import { PAYROLL_OUTLET_ID, PAYROLL_TIME_ZONE } from "../outlet";

const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  "pkwtt",
  "pkwt",
  "daily",
  "intern",
];

const EMPLOYMENT_LABEL: Record<EmploymentType, MessageKey> = {
  pkwtt: "payrollRun.pool.employment.pkwtt",
  pkwt: "payrollRun.pool.employment.pkwt",
  daily: "payrollRun.pool.employment.daily",
  intern: "payrollRun.pool.employment.intern",
};

/** Digits only; the API stores whole rupiah. */
function rupiahFromInput(value: string): Idr | null {
  const digits = value.replace(/[^\d]/g, "");
  if (digits === "") return null;
  const amount = Number(digits);
  return Number.isSafeInteger(amount) ? idr(amount) : null;
}

export function CreatePoolDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const createPool = useCreatePool();
  const [start, setStart] = React.useState(() => {
    const today = businessDateOf(new Date(), {
      timeZone: PAYROLL_TIME_ZONE,
      cutoff: DEFAULT_BUSINESS_DAY_CUTOFF,
    });
    return `${today.slice(0, 7)}-01`;
  });
  const [end, setEnd] = React.useState(() =>
    businessDateOf(new Date(), {
      timeZone: PAYROLL_TIME_ZONE,
      cutoff: DEFAULT_BUSINESS_DAY_CUTOFF,
    }),
  );
  const [amount, setAmount] = React.useState("");
  const [method, setMethod] = React.useState<ServiceChargeMethod>(
    "points_x_attendance",
  );
  const [minDays, setMinDays] = React.useState("10");
  const [types, setTypes] = React.useState<EmploymentType[]>([
    "pkwtt",
    "pkwt",
    "daily",
  ]);
  // One key per attempt: a double submit or a retry after a lost response
  // replays the same write. A new key is minted once the attempt ends (success
  // or close), so the next run/pool is never refused as a reused key.
  const [idempotencyKey, setIdempotencyKey] = React.useState(() =>
    newIdempotencyKey(),
  );
  function setOpen(next: boolean) {
    if (!next) setIdempotencyKey(newIdempotencyKey());
    onOpenChange(next);
  }
  const [error, setError] = React.useState<string | null>(null);

  function toggleType(type: EmploymentType, checked: boolean) {
    setTypes((current) =>
      checked
        ? current.includes(type)
          ? current
          : [...current, type]
        : current.filter((item) => item !== type),
    );
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const amountIdr = rupiahFromInput(amount);
    const days = Number(minDays);
    if (amountIdr === null) {
      setError(t("payrollRun.pool.amountInvalid"));
      return;
    }
    if (!Number.isInteger(days) || days < 0 || days > 31) {
      setError(t("payrollRun.pool.minDaysInvalid"));
      return;
    }
    if (types.length === 0) {
      setError(t("payrollRun.pool.typesRequired"));
      return;
    }
    if (end < start) {
      setError(t("payrollRun.pool.periodInvalid"));
      return;
    }
    const periodStart = businessDateSchema.safeParse(start);
    const periodEnd = businessDateSchema.safeParse(end);
    if (!periodStart.success || !periodEnd.success) {
      setError(t("payrollRun.pool.periodInvalid"));
      return;
    }
    createPool.mutate(
      {
        outletId: PAYROLL_OUTLET_ID,
        periodStart: periodStart.data,
        periodEnd: periodEnd.data,
        amountIdr,
        rule: {
          method,
          minAttendanceDays: days,
          eligibleEmploymentTypes: types,
        },
        idempotencyKey,
      },
      {
        onSuccess: () => {
          setIdempotencyKey(newIdempotencyKey());
          toast({ title: t("payrollRun.pool.created"), tone: "success" });
          setOpen(false);
        },
        onError: (cause) => setError(payrollErrorMessage(cause, t)),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("payrollRun.pool.createTitle")}</DialogTitle>
          <DialogDescription>
            {t("payrollRun.pool.createBody")}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t("payrollRun.pool.periodStart")} required>
              <Input
                type="date"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </FormField>
            <FormField label={t("payrollRun.pool.periodEnd")} required>
              <Input
                type="date"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
              />
            </FormField>
          </div>
          <FormField
            label={t("payrollRun.pool.amount")}
            hint={t("payrollRun.pool.amountHint")}
            required
          >
            <Input
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0"
              className="tabular"
            />
          </FormField>
          <FormField label={t("payrollRun.pool.method")} required>
            <Select
              value={method}
              onValueChange={(value) => {
                const parsed = serviceChargeMethodSchema.safeParse(value);
                if (parsed.success) setMethod(parsed.data);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["points", "points_x_attendance", "equal"] as const).map(
                  (value) => (
                    <SelectItem key={value} value={value}>
                      {t(POOL_METHOD_LABEL[value])}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            label={t("payrollRun.pool.minDays")}
            hint={t("payrollRun.pool.minDaysHint")}
            required
          >
            <Input
              type="number"
              min={0}
              max={31}
              value={minDays}
              onChange={(event) => setMinDays(event.target.value)}
              className="tabular"
            />
          </FormField>
          <fieldset className="grid gap-2">
            <legend className="text-sm leading-5 font-semibold">
              {t("payrollRun.pool.employmentTypes")}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {EMPLOYMENT_TYPES.map((type) => (
                <div key={type} className="flex items-center gap-2">
                  <Checkbox
                    id={`pool-type-${type}`}
                    checked={types.includes(type)}
                    onCheckedChange={(checked) =>
                      toggleType(type, checked === true)
                    }
                  />
                  <Label htmlFor={`pool-type-${type}`}>
                    {t(EMPLOYMENT_LABEL[type])}
                  </Label>
                </div>
              ))}
            </div>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={createPool.isPending}>
              <HandCoins aria-hidden="true" />
              {t("payrollRun.pool.createSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
