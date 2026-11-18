// Small pieces shared by the recon panel and forms: a callout and the block
// that names the flag under review.
import * as React from "react";
import {
  CircleCheck,
  Info,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import type { Translate } from "@starter/shared/i18n";
import type { PayoutReconFlagDto } from "@starter/shared/types";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import type { ReconFacts } from "./recon-facts";
import { itemOfFlag, shortId } from "./recon-model";

// Tinted fill, a 4 px accent on the left and an icon: the tone never rests on
// colour alone.
const CALLOUT_TONE = {
  info: { box: "bg-surface-2 border-l-border", icon: Info },
  warning: { box: "bg-warning-subtle border-l-warning", icon: TriangleAlert },
  success: { box: "bg-success-subtle border-l-success", icon: CircleCheck },
  danger: { box: "bg-danger-subtle border-l-danger", icon: TriangleAlert },
} as const;

/** A short notice with a bold title. `alert` is for refusals, `status` for results. */
export function ReconCallout({
  tone,
  title,
  icon,
  role,
  children,
  action,
  ...props
}: {
  tone: keyof typeof CALLOUT_TONE;
  title: string;
  /** Replaces the tone's icon, e.g. a reopened mark. */
  icon?: LucideIcon;
  role?: "alert" | "status";
  children?: React.ReactNode;
  action?: React.ReactNode;
} & Omit<React.ComponentProps<"div">, "title" | "role">) {
  const Icon = icon ?? CALLOUT_TONE[tone].icon;
  return (
    <div
      role={role}
      className={cn(
        "grid gap-1 rounded-container border-l-4 p-3 text-sm",
        CALLOUT_TONE[tone].box,
      )}
      {...props}
    >
      <p className="flex items-start gap-2 font-semibold">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {title}
      </p>
      {children && <p>{children}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Name of the employee, "Memuat…" while the batch loads, else "not available". */
export function reconName(
  name: string | null,
  facts: ReconFacts,
  t: Translate,
): string {
  if (name) return name;
  return t(
    facts.batchState === "loading"
      ? "payrollPayoutReview.recon.flag.loadingName"
      : "payrollPayoutReview.recon.flag.noName",
  );
}

/** The flag the panel is about: who, why, how much, which slip. */
export function ReconSelection({
  flag,
  facts,
}: {
  flag: PayoutReconFlagDto;
  facts: ReconFacts;
}) {
  const t = useT();
  const item = itemOfFlag(facts.items, flag);
  const name = item ? facts.employeeName(item) : null;
  return (
    <div className="grid gap-1 border-y border-border py-3">
      <p className="text-sm font-semibold break-words">
        {reconName(name, facts, t)} ·{" "}
        {t("payrollPayoutReview.recon.flag.id", { id: shortId(flag.id) })}
      </p>
      <p className="text-sm text-muted-foreground break-words">{flag.reason}</p>
      {item ? (
        <Money amount={item.amountIdr} size="lg" />
      ) : (
        <p className="text-sm text-muted-foreground">
          {facts.batchState === "loading"
            ? t("payrollPayout.common.loading")
            : t("payrollPayoutReview.recon.flag.noDetail")}
        </p>
      )}
      <p className="text-xs text-muted-foreground tabular">
        {t("payrollPayoutReview.recon.selection.slipValue", {
          slip: shortId(flag.payslipId),
        })}
      </p>
    </div>
  );
}

/** Text link button that spans a 44 px target. */
export function ReconTextButton({
  className,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex min-h-11 items-center px-1 text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2",
        className,
      )}
      {...props}
    />
  );
}
