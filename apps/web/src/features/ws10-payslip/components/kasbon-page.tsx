// "Kasbon" — the employee's loans and the request form (PRD v1.7 §3 F31
// "Kasbon: pengajuan pinjaman dengan batas maksimal, approval, dan cicilan
// otomatis dipotong dari payroll"; §6 H employee_loans; HR-01 own rows only).
//
// The form checks the contract's demo loan policy for its limits, but the API
// stays authoritative: the mock runs the same request through
// `assertLoanWithinPolicy`, and `PAYROLL_LOAN_LIMIT_EXCEEDED` comes back as a
// field-level message. One open loan at a time (policy.singleOpenLoan).
import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import {
  ChevronLeft,
  Circle,
  CircleCheck,
  CircleDot,
  HandCoins,
  Info,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  SectionEmpty,
  SectionError,
} from "@/features/ws10-hris-employee/components/section-states";
import type { MessageKey } from "@starter/shared/i18n";
import type { EmployeeLoan } from "@starter/shared/hris/payroll";
import { ApiError } from "@/lib/api/errors";
import { useAttemptKey } from "@/features/ws05-payment-admin/use-attempt-key";
import { formatBusinessDate } from "../format.ts";
import { useCreateLoan, useMyLoans } from "../hooks.ts";
import { DEMO_LOAN_POLICY } from "../policy.ts";
import {
  isOpenLoan,
  loanStatusKey,
  loanStatusTone,
  loanTimeline,
  parseAmountInput,
} from "../state.ts";
import { PageHeader } from "./page-header.tsx";
import { StateBadge } from "./state-badge.tsx";
import { SuccessCard } from "./success-card.tsx";

/** The contract caps installmentCount at 36; the tenant policy may be lower. */
const TENOR_MAX = Math.min(36, DEMO_LOAN_POLICY.maxInstallments);
const TENOR_OPTIONS = Array.from({ length: TENOR_MAX }, (_, index) =>
  String(index + 1),
);

type FieldErrors = Partial<Record<"amount" | "tenor" | "reason", MessageKey>>;

function LoanTimeline({ loan }: { loan: EmployeeLoan }) {
  const t = useT();
  return (
    <div className="grid gap-2 border-t pt-3">
      <p className="type-eyebrow text-muted-foreground">
        {t("payslip.kasbon.timelineTitle")}
      </p>
      <ol className="grid gap-2">
        {loanTimeline(loan.status).map((step) => (
          <li
            key={step.key}
            className="flex items-center gap-2 text-sm leading-5"
          >
            {step.state === "done" ? (
              <CircleCheck
                className="size-4 shrink-0 text-success"
                aria-hidden="true"
              />
            ) : step.state === "current" ? (
              <CircleDot
                className="size-4 shrink-0 text-foreground"
                aria-hidden="true"
              />
            ) : (
              <Circle
                className="size-4 shrink-0 text-muted-foreground/60"
                aria-hidden="true"
              />
            )}
            <span
              className={
                step.state === "current"
                  ? "font-semibold"
                  : step.state === "pending"
                    ? "text-muted-foreground"
                    : ""
              }
            >
              {t(step.key)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function LoanCard({ loan }: { loan: EmployeeLoan }) {
  const t = useT();
  return (
    <Card className="gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="type-eyebrow text-muted-foreground">
            {t("payslip.kasbon.amount")}
          </p>
          <Money
            amount={loan.principalIdr}
            size="stat"
            className="font-brand"
          />
        </div>
        <StateBadge tone={loanStatusTone(loan.status)}>
          {t(loanStatusKey(loan.status))}
        </StateBadge>
      </div>

      <dl className="grid grid-cols-2 gap-3 border-t pt-3 text-sm leading-5">
        <div className="grid min-w-0 gap-0.5">
          <dt className="text-muted-foreground">
            {t("payslip.kasbon.installment")}
          </dt>
          <dd className="font-medium">
            <Money amount={loan.installmentIdr} />
          </dd>
        </div>
        <div className="grid min-w-0 gap-0.5">
          <dt className="text-muted-foreground">{t("payslip.kasbon.tenor")}</dt>
          <dd className="font-medium tabular">
            {t("payslip.kasbon.tenorValue", { count: loan.installmentCount })}
          </dd>
        </div>
        <div className="grid min-w-0 gap-0.5">
          <dt className="text-muted-foreground">
            {t("payslip.kasbon.remaining")}
          </dt>
          <dd className="font-medium">
            <Money amount={loan.outstandingIdr} />
          </dd>
        </div>
        <div className="grid min-w-0 gap-0.5">
          <dt className="text-muted-foreground">
            {t("payslip.kasbon.firstDeduction")}
          </dt>
          <dd className="font-medium tabular">
            {formatBusinessDate(loan.firstDeductionPeriod)}
          </dd>
        </div>
      </dl>

      <div className="grid gap-0.5">
        <p className="text-sm leading-5 font-medium">
          {t("payslip.kasbon.reason")}
        </p>
        <p className="text-sm leading-5 text-muted-foreground">{loan.reason}</p>
      </div>

      <LoanTimeline loan={loan} />
    </Card>
  );
}

export function KasbonPage() {
  const t = useT();
  const query = useMyLoans();
  const create = useCreateLoan();
  const attempt = useAttemptKey();
  const [amount, setAmount] = useState("");
  const [tenor, setTenor] = useState(String(Math.min(3, TENOR_MAX)));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitFailure, setSubmitFailure] = useState<MessageKey | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // policy.singleOpenLoan: a running loan blocks a second request. Until the
  // list has loaded the form stays hidden, so it is never offered by mistake.
  const openLoan = DEMO_LOAN_POLICY.singleOpenLoan
    ? query.loans.find((loan) => isOpenLoan(loan.status))
    : undefined;

  function validate(): { amountIdr: number; installmentCount: number } | null {
    const next: FieldErrors = {};
    const amountIdr = parseAmountInput(amount);
    if (amount.trim() === "") {
      next.amount = "payslip.kasbon.errors.amountRequired";
    } else if (amountIdr === null) {
      next.amount = "payslip.kasbon.errors.amountInvalid";
    } else if (
      DEMO_LOAN_POLICY.maxPrincipalIdr !== null &&
      amountIdr > DEMO_LOAN_POLICY.maxPrincipalIdr
    ) {
      next.amount = "payslip.kasbon.errors.amountLimit";
    }

    const installmentCount = Number(tenor);
    if (
      !Number.isInteger(installmentCount) ||
      installmentCount < 1 ||
      installmentCount > TENOR_MAX
    ) {
      next.tenor = "payslip.kasbon.errors.tenorInvalid";
    }

    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      next.reason = "payslip.kasbon.errors.reasonRequired";
    } else if (trimmedReason.length > 500) {
      next.reason = "payslip.kasbon.errors.reasonTooLong";
    }

    setErrors(next);
    if (Object.values(next).some(Boolean) || amountIdr === null) return null;
    return { amountIdr, installmentCount };
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitFailure(null);
    const valid = validate();
    if (!valid) return;
    // Same request after a lost response reuses its key (replay, no second
    // loan request); a changed request is a new attempt.
    const body = {
      principalIdr: valid.amountIdr,
      installmentCount: valid.installmentCount,
      reason: reason.trim(),
    };
    create.mutate(
      { ...body, idempotencyKey: attempt.keyFor(body) },
      {
        onSuccess: () => {
          attempt.settle();
          setSubmitted(true);
          setAmount("");
          setReason("");
          setErrors({});
        },
        onError: (error) =>
          setSubmitFailure(
            error instanceof ApiError &&
              error.code === "PAYROLL_LOAN_LIMIT_EXCEEDED"
              ? "payslip.kasbon.errors.submitLimit"
              : "payslip.kasbon.errors.submit",
          ),
      },
    );
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to="/karyawan">
            <ChevronLeft aria-hidden="true" />
            {t("payslip.backHome")}
          </Link>
        </Button>
        <PageHeader
          title={t("payslip.kasbon.title")}
          subtitle={t("payslip.kasbon.subtitle")}
        />
      </div>

      <section className="grid gap-2">
        <h2 className="type-eyebrow text-muted-foreground">
          {t("payslip.kasbon.historyTitle")}
        </h2>
        {query.isPending ? (
          <div aria-busy="true" className="grid gap-3">
            <span className="sr-only" role="status">
              {t("common.loading")}
            </span>
            <Skeleton className="h-48 w-full rounded-container" />
          </div>
        ) : query.isError ? (
          <Card>
            <SectionError
              title={t("payslip.kasbon.listErrorTitle")}
              description={t("payslip.kasbon.listErrorHint")}
              onRetry={() => void query.refetch()}
            />
          </Card>
        ) : query.loans.length === 0 ? (
          <Card>
            <SectionEmpty
              icon={HandCoins}
              title={t("payslip.kasbon.emptyTitle")}
              description={t("payslip.kasbon.emptyDescription")}
            />
          </Card>
        ) : (
          <ul className="grid gap-3">
            {query.loans.map((loan) => (
              <li key={loan.id}>
                <LoanCard loan={loan} />
              </li>
            ))}
          </ul>
        )}

        {query.hasNextPage && (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage
              ? t("payslip.state.loadingMore")
              : t("payslip.state.loadMore")}
          </Button>
        )}
      </section>

      {query.isPending ? null : submitted ? (
        <SuccessCard
          title={t("payslip.kasbon.successTitle")}
          description={t("payslip.kasbon.successBody")}
          actionLabel={t("payslip.kasbon.successAction")}
          onAction={() => setSubmitted(false)}
        />
      ) : openLoan ? (
        <Card className="gap-2 border-warning-subtle bg-warning-subtle">
          <p className="flex items-start gap-2 text-sm leading-5 font-semibold">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t("payslip.kasbon.blockedTitle")}
          </p>
          <p className="text-sm leading-5">{t("payslip.kasbon.blockedBody")}</p>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="font-brand type-title">
              {t("payslip.kasbon.requestTitle")}
            </CardTitle>
            <CardDescription>
              {t("payslip.kasbon.requestSubtitle")}
            </CardDescription>
          </CardHeader>
          <form className="grid gap-3" noValidate onSubmit={handleSubmit}>
            <FormField
              label={t("payslip.kasbon.amountLabel")}
              hint={t("payslip.kasbon.limitHint")}
              error={errors.amount ? t(errors.amount) : undefined}
              required
            >
              <Input
                inputMode="numeric"
                autoComplete="off"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder={t("payslip.kasbon.amountPlaceholder")}
              />
            </FormField>

            <FormField
              label={t("payslip.kasbon.tenorLabel")}
              hint={t("payslip.kasbon.tenorHint", { count: TENOR_MAX })}
              error={
                errors.tenor ? t(errors.tenor, { count: TENOR_MAX }) : undefined
              }
              required
            >
              <Select value={tenor} onValueChange={setTenor}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TENOR_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t("payslip.kasbon.tenorValue", {
                        count: Number(option),
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label={t("payslip.kasbon.reasonLabel")}
              error={errors.reason ? t(errors.reason) : undefined}
              required
            >
              <Textarea
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t("payslip.kasbon.reasonPlaceholder")}
              />
            </FormField>

            {submitFailure && (
              <div role="alert" className="grid gap-0.5">
                <p className="text-sm leading-5 font-semibold text-danger">
                  {t(submitFailure)}
                </p>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("payslip.kasbon.errors.submitHint")}
                </p>
              </div>
            )}

            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={create.isPending}
            >
              {create.isPending
                ? t("payslip.kasbon.submitting")
                : t("payslip.kasbon.submit")}
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}
