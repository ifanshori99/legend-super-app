import { useId, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowLeft } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/errors";
import { isContractPending, useCashierCodeLookup } from "../../hooks";
import { PosPageHeading, PosTwoPane } from "../shared";
import { CodeKeypad } from "./code-keypad";
import { CodeResultPanel, type CodeResultView } from "./code-result-panel";

const MAX_DIGITS = 6;

// Which of the two inline messages (if any) sits under the code field.
function lookupFailure(error: unknown): "invalid" | "pending" | "failed" {
  if (isContractPending(error)) return "pending";
  if (error instanceof ApiError && error.code === "NOT_FOUND") return "invalid";
  return "failed";
}

// /pos/kode — the cashier types the code a customer shows ("Bayar di kasir"),
// checks table and total, and continues to payment. A search never marks the
// order paid and never starts a payment.
export function CashierCodeScreen() {
  const t = useT();
  const inputId = useId();
  const messageId = `${inputId}-message`;
  const lookup = useCashierCodeLookup();
  const [digits, setDigits] = useState("");
  const [missing, setMissing] = useState(false);

  const failure = lookup.isError ? lookupFailure(lookup.error) : null;

  const view: CodeResultView = lookup.isPending
    ? { kind: "loading" }
    : lookup.isSuccess
      ? { kind: "found", order: lookup.data }
      : failure === "invalid"
        ? { kind: "invalid" }
        : failure
          ? { kind: "error", pending: failure === "pending" }
          : { kind: "idle" };

  const message = missing
    ? t("posKasirCode.input.required")
    : failure === "invalid"
      ? t("posKasirCode.input.notFound")
      : failure === "pending"
        ? t("posKasirCode.error.pendingInline")
        : failure === "failed"
          ? t("posKasirCode.error.inline")
          : null;

  const edit = (next: string) => {
    setDigits(next.replace(/\D/g, "").slice(0, MAX_DIGITS));
    setMissing(false);
    // A found order belongs to the code that found it: editing drops it.
    if (lookup.isSuccess) lookup.reset();
  };

  const search = (event?: FormEvent) => {
    event?.preventDefault();
    if (digits === "") {
      setMissing(true);
      return;
    }
    setMissing(false);
    lookup.mutate(digits);
  };

  return (
    <div data-slot="cashier-code-screen" className="grid gap-4">
      <PosPageHeading
        title={t("posKasirCode.title")}
        subtitle={t("posKasirCode.subtitle")}
        action={
          <Button asChild variant="outline">
            <Link to="/pos/meja">
              <ArrowLeft aria-hidden="true" />
              {t("posKasirCode.back")}
            </Link>
          </Button>
        }
      />
      <PosTwoPane
        side={
          <form
            onSubmit={search}
            noValidate
            className="flex h-full flex-col gap-3 rounded-container border-(length:--border-w) border-border bg-card p-card"
          >
            <label
              htmlFor={inputId}
              className="text-xl leading-7 font-semibold"
            >
              {t("posKasirCode.input.label")}
            </label>
            <div
              className={cn(
                "flex h-16 items-center rounded-control border-(length:--border-w) bg-background px-4 shadow-hairline focus-within:shadow-focus",
                message ? "border-danger" : "border-input",
              )}
            >
              <span
                aria-hidden="true"
                className="pr-1 text-3xl font-bold tabular"
              >
                {t("posKasirCode.input.prefix")}
              </span>
              <input
                id={inputId}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={digits}
                onChange={(event) => edit(event.target.value)}
                aria-label={t("posKasirCode.input.ariaLabel")}
                aria-invalid={message ? true : undefined}
                aria-describedby={messageId}
                className="h-full min-w-0 flex-1 bg-transparent text-3xl font-bold tracking-wide text-foreground tabular focus-visible:outline-none"
              />
            </div>
            <p
              id={messageId}
              className={cn(
                "text-base",
                message ? "text-danger" : "text-muted-foreground",
              )}
            >
              {message ?? t("posKasirCode.input.hint")}
            </p>
            <CodeKeypad
              onDigit={(digit) => edit(`${digits}${digit}`)}
              onBackspace={() => edit(digits.slice(0, -1))}
              onClear={() => edit("")}
            />
            <Button
              type="submit"
              size="lg"
              variant={view.kind === "found" ? "outline" : "default"}
              loading={lookup.isPending}
              className="w-full"
            >
              {failure
                ? t("posKasirCode.searchAgain")
                : t("posKasirCode.search")}
            </Button>
          </form>
        }
      >
        <CodeResultPanel view={view} />
      </PosTwoPane>
    </div>
  );
}
