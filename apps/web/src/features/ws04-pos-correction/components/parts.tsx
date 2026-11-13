import type { ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api/errors";
import type { MessageKey } from "@starter/shared/i18n";
import {
  PosPageHeading,
  PosPanel,
  PosTwoPane,
  StatusPill,
} from "../../ws04-pos-kasir/components/shared";

/** One label and amount of the side summary; `strong` for the closing line. */
export function SummaryLine({
  label,
  amountIdr,
  strong = false,
  children,
}: {
  label: string;
  /** Whole rupiah; omit to put `children` on the right instead. */
  amountIdr?: number;
  strong?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3 text-(length:--density-text)",
        strong && "font-bold",
      )}
    >
      <span>{label}</span>
      <span className="text-right font-semibold">
        {amountIdr !== undefined ? <Money amount={amountIdr} /> : children}
      </span>
    </div>
  );
}

/** The rule between the lines and the closing total. */
export function SummaryDivider() {
  return (
    <div
      role="presentation"
      className="border-t-(length:--border-w) border-border"
    />
  );
}

/** A reason list: one of the contract enum values, shown with its label. */
export function ReasonSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; labelKey: MessageKey }[];
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <FormField label={label} required>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as T)}
        disabled={disabled}
      >
        <SelectTrigger className="h-control">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}

/** "Kembali": one step back in the history, where the cashier came from. */
export function BackButton({ className }: { className?: string }) {
  const t = useT();
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="outline"
      className={className}
      onClick={() => router.history.back()}
    >
      {t("posCorrection.actions.back")}
    </Button>
  );
}

/**
 * The page of one correction mode: heading with an optional status pill, the
 * order summary on the side and the work panel with its action footer. Below
 * 768 px the two stack, so there is no horizontal scroll at 390 px. The footer
 * sits inline at the end of the form (not sticky) with the buttons side by
 * side, so it never covers the first field on a small screen.
 */
export function CorrectionLayout({
  title,
  subtitle,
  badge,
  switcher,
  sideTitle,
  side,
  panelTitle,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  badge?: ReactNode;
  /** The mode switch, under the heading. */
  switcher?: ReactNode;
  sideTitle: string;
  side: ReactNode;
  panelTitle: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-4">
      <PosPageHeading title={title} subtitle={subtitle} action={badge} />
      {switcher}
      <PosTwoPane
        side={
          <PosPanel title={sideTitle}>
            <div className="grid gap-3">{side}</div>
          </PosPanel>
        }
      >
        <PosPanel title={panelTitle}>
          <div className="grid gap-4">
            {children}
            {footer && (
              <div className="flex flex-row flex-wrap justify-end gap-3 border-t-(length:--border-w) border-border pt-4 max-md:[&>*]:flex-1">
                {footer}
              </div>
            )}
          </div>
        </PosPanel>
      </PosTwoPane>
    </div>
  );
}

/** Warning pill of the heading: needs a supervisor, or already in the kitchen. */
export function HeadingPill({ children }: { children: ReactNode }) {
  return <StatusPill tone="warning">{children}</StatusPill>;
}

/** Why a correction was refused, in words the cashier can act on. */
export function correctionErrorText(
  error: unknown,
  fallback: string,
  edgeBlocked?: string,
): string {
  if (
    edgeBlocked &&
    error instanceof ApiError &&
    error.code === "EDGE_ORDER_CORRECTION_BLOCKED"
  )
    return edgeBlocked;
  return error instanceof ApiError && error.message ? error.message : fallback;
}
