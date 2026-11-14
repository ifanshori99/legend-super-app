// "Anggaran AI bulanan": this month's spend against the tenant cap, and the
// cap itself. Rp 0 turns AI off. Reads and writes the governance settings of
// features/ws12-ai-admin (monthlyBudgetIdr); the warn and stop percents shown
// in the note are that same row.
import * as React from "react";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { idr } from "@starter/shared/core";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useBudget,
  useGovernance,
  useUpdateGovernance,
} from "@/features/ws12-ai-admin/hooks";
import { budgetPercent, meterWidth } from "@/features/ws12-ai-admin/logic";
import {
  AdminCard,
  isOfflineError,
  saveErrorText,
  serverFieldErrors,
} from "@/features/ws12-ai-admin/components/shared";

const WHOLE_NUMBER = /^\d{1,15}$/;
// "5.000.000": dots only as thousands separators.
const GROUPED_NUMBER = /^\d{1,3}(\.\d{3}){1,4}$/;

/** Whole rupiah, 0 or more; spaces and thousands dots are accepted. */
function parseBudget(text: string): number | null {
  const compact = text.replace(/\s/g, "");
  if (!WHOLE_NUMBER.test(compact) && !GROUPED_NUMBER.test(compact)) return null;
  const value = Number(compact.replaceAll(".", ""));
  return Number.isSafeInteger(value) ? value : null;
}

/** Grouped the Indonesian way once the text is a valid amount. */
function groupBudget(text: string): string {
  const value = parseBudget(text);
  return value === null ? text : formatNumber(value);
}

const monthName = (now: Date) =>
  new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" }).format(
    now,
  );

export function BudgetCard({ locked = false }: { locked?: boolean }) {
  const t = useT();
  const governance = useGovernance(true);
  const budget = useBudget(true);

  if (governance.isPending) return <BudgetSkeleton />;
  if (!governance.data) {
    const offline = isOfflineError(governance.error);
    return (
      <AdminCard aria-labelledby="ai-budget-title">
        <h2 id="ai-budget-title" className="type-title">
          {t("aiSettingsCustom.budget.title")}
        </h2>
        <ErrorState
          error={governance.error}
          title={t(
            offline
              ? "aiAdmin.error.offlineTitle"
              : "aiSettingsCustom.budget.errorTitle",
          )}
          description={t(
            offline
              ? "aiAdmin.error.offlineHint"
              : "aiSettingsCustom.budget.errorHint",
          )}
          onRetry={() => void governance.refetch()}
        />
      </AdminCard>
    );
  }

  const settings = governance.data.data;
  const cap = settings.monthlyBudgetIdr;
  const usedIdr = budget.data?.data.budget.usedIdr ?? null;
  const percent = usedIdr === null ? null : budgetPercent(usedIdr, cap);
  const level =
    percent === null
      ? "ok"
      : percent >= settings.budgetStopPct
        ? "stop"
        : percent >= settings.budgetWarnPct
          ? "warn"
          : "ok";

  return (
    <AdminCard aria-labelledby="ai-budget-title">
      <div className="grid gap-1">
        <h2 id="ai-budget-title" className="type-title">
          {t("aiSettingsCustom.budget.title")}
        </h2>
        <p className="text-base leading-6 text-muted-foreground">
          {t("aiSettingsCustom.budget.description")}
        </p>
        {governance.isError && (
          <p
            role="status"
            className="text-sm leading-5 font-medium text-warning"
          >
            {t("aiSettingsCustom.budget.refreshError")}
          </p>
        )}
      </div>

      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <p className="text-sm leading-5 text-muted-foreground">
            {t("aiSettingsCustom.budget.usageLabel")}
          </p>
          {usedIdr === null ? (
            budget.isPending ? (
              <Skeleton className="h-9 w-36" />
            ) : (
              <p className="text-sm leading-5 text-muted-foreground">
                {t("aiSettingsCustom.budget.usageUnknown")}
              </p>
            )
          ) : (
            <Money amount={usedIdr} size="xl" />
          )}
          <p className="text-xs leading-4 text-muted-foreground sm:text-sm sm:leading-5">
            {monthName(new Date())}
          </p>
          {cap > 0 ? (
            <>
              <div
                role="meter"
                aria-label={t("aiSettingsCustom.budget.meterLabel")}
                aria-valuemin={0}
                aria-valuemax={cap}
                aria-valuenow={Math.min(usedIdr ?? 0, cap)}
                className="h-2.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={cn(
                    "h-full",
                    level === "stop"
                      ? "bg-danger"
                      : level === "warn"
                        ? "bg-warning"
                        : "bg-primary",
                  )}
                  style={{ width: `${meterWidth(percent)}%` }}
                />
              </div>
              {percent !== null && (
                <p className="text-sm leading-5 text-muted-foreground tabular">
                  {t("aiSettingsCustom.budget.percentOf", {
                    percent,
                    cap: formatRupiah(cap),
                  })}
                </p>
              )}
              {level !== "ok" && (
                <p
                  className={cn(
                    "flex items-start gap-1.5 text-sm leading-5 font-medium",
                    level === "stop" ? "text-danger" : "text-warning",
                  )}
                >
                  {level === "stop" ? (
                    <CircleAlert
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <TriangleAlert
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  {t(
                    level === "stop"
                      ? "aiSettingsCustom.budget.meterStop"
                      : "aiSettingsCustom.budget.meterWarn",
                  )}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm leading-5 font-bold text-warning sm:text-base sm:leading-6">
              {t("aiSettingsCustom.budget.off")}
            </p>
          )}
        </div>

        <BudgetForm cap={cap} locked={locked} />

        <p className="border-t border-border pt-4 text-sm leading-5 text-muted-foreground">
          {t("aiSettingsCustom.budget.note", {
            warn: settings.budgetWarnPct,
            stop: settings.budgetStopPct,
          })}
        </p>
      </div>
    </AdminCard>
  );
}

/** Starts from the stored cap; follows the server value while the field is untouched. */
function BudgetForm({ cap, locked }: { cap: number; locked: boolean }) {
  const t = useT();
  const update = useUpdateGovernance();
  const [text, setText] = React.useState(formatNumber(cap));
  const [dirty, setDirty] = React.useState(false);
  const [syncedCap, setSyncedCap] = React.useState(cap);
  const [invalid, setInvalid] = React.useState(false);
  const [confirmOff, setConfirmOff] = React.useState(false);
  const [saved, setSaved] = React.useState<"on" | "off" | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  if (syncedCap !== cap) {
    setSyncedCap(cap);
    if (!dirty) setText(formatNumber(cap));
  }

  const serverMessage = serverFieldErrors(update.error).monthlyBudgetIdr;
  const error = invalid
    ? t("aiSettingsCustom.budget.limitError")
    : update.isError
      ? serverMessage
      : undefined;

  const save = (value: number) => {
    if (locked) return;
    update.mutate(
      { monthlyBudgetIdr: idr(value) },
      {
        onSuccess: () => {
          setDirty(false);
          setText(formatNumber(value));
          setSaved(value === 0 ? "off" : "on");
        },
      },
    );
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (locked) return;
    setSaved(null);
    const value = parseBudget(text);
    if (value === null) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    setInvalid(false);
    // Rp 0 turns AI off for every tenant user: ask first.
    if (value === 0 && cap !== 0) {
      setConfirmOff(true);
      return;
    }
    save(value);
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <FormField
        label={t("aiSettingsCustom.budget.limitLabel")}
        hint={t("aiSettingsCustom.budget.limitHint")}
        error={error}
        required
      >
        <MoneyInput
          ref={inputRef}
          name="monthlyBudgetIdr"
          inputMode="numeric"
          autoComplete="off"
          disabled={locked}
          value={text}
          onChange={(event) => {
            setSaved(null);
            setDirty(true);
            setText(event.target.value);
          }}
          onBlur={(event) => {
            if (event.relatedTarget instanceof HTMLButtonElement) return;
            const next = parseBudget(event.target.value);
            setInvalid(next === null);
            setText(groupBudget(event.target.value));
          }}
        />
      </FormField>
      <Button
        type="submit"
        variant="outline"
        loading={update.isPending}
        disabled={locked}
        className="w-full sm:w-auto sm:justify-self-start"
      >
        {t("aiSettingsCustom.budget.save")}
      </Button>
      <div role="status" aria-live="polite">
        {saved !== null && (
          <p className="flex items-start gap-1.5 text-sm leading-5 font-medium text-success">
            <CircleCheck
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {t(
              saved === "off"
                ? "aiSettingsCustom.budget.savedOff"
                : "aiSettingsCustom.budget.saved",
            )}
          </p>
        )}
      </div>
      {update.isError && serverMessage === undefined && (
        <p role="alert" className="text-sm leading-5 font-medium text-danger">
          {saveErrorText(t, update.error)}
        </p>
      )}
      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent className="sm:max-w-[30rem]">
          <DialogHeader>
            <DialogTitle>
              {t("aiSettingsCustom.budget.confirmOffTitle")}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="grid max-w-[27rem] gap-2 text-pretty">
                <p>{t("aiSettingsCustom.budget.confirmOffBody")}</p>
                <p>{t("aiSettingsCustom.budget.confirmOffHint")}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOff(false)}
            >
              {t("aiSettingsCustom.budget.confirmOffCancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmOff(false);
                save(0);
              }}
            >
              {t("aiSettingsCustom.budget.confirmOffConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}

/** The input with the currency prefix inside its edge (mockup "money-input"). */
function MoneyInput({ ref, ...props }: React.ComponentProps<typeof Input>) {
  const t = useT();
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-base text-muted-foreground"
      >
        {t("aiSettingsCustom.budget.currency")}
      </span>
      <Input ref={ref} className="pl-10 tabular" {...props} />
    </div>
  );
}

function BudgetSkeleton() {
  const t = useT();
  return (
    <AdminCard
      aria-busy="true"
      aria-label={t("aiSettingsCustom.budget.loading")}
    >
      <Skeleton className="h-6 w-44" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-9 w-36" />
      <Skeleton className="h-2.5 w-full" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
    </AdminCard>
  );
}
