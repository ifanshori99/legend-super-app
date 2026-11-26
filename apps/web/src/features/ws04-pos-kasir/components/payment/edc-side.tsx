import type { ReactNode } from "react";
import { Lock, type LucideIcon } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import { isContractPending } from "../../hooks";
import type { PaymentBill } from "../../types";
import {
  PosPageHeading,
  PosPanel,
  PosTwoPane,
  StatusPill,
  type StatusPillTone,
} from "../shared";

export type EdcPill = {
  tone: StatusPillTone;
  label: string;
  icon?: LucideIcon;
};

/** The terminal chosen for this payment, shown under the amount on the left. */
export type EdcSideTerminal = { title: string; detail: string };

/** Maps a failed call to a sentence the cashier can act on. */
export function useEdcErrorText() {
  const t = useT();
  return (error: unknown): string => {
    if (isContractPending(error)) return t("posKasirEdc.contractPending");
    if (error instanceof Error && error.message) return error.message;
    return t("posKasirEdc.genericError");
  };
}

function SideLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-(length:--density-text)">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// Every EDC state shares this frame: page heading with a state pill, the bill on
// the left (the amount line changes with the state), the work panel on the right.
export function EdcLayout({
  title,
  bill,
  headPill,
  headAction,
  sideLabel,
  sideAmountIdr,
  sidePill,
  sideTerminal,
  sideNote,
  children,
}: {
  title: string;
  bill: PaymentBill;
  /** The state chip in the heading; omit it when `headAction` or the work panel carries it. */
  headPill?: EdcPill;
  /** Replaces the heading chip, e.g. the way back to the order. */
  headAction?: ReactNode;
  sideLabel: string;
  /** null: nothing to show yet (the slip amount is not typed). */
  sideAmountIdr: number | null;
  sidePill?: EdcPill;
  sideTerminal?: EdcSideTerminal;
  sideNote: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={title}
        subtitle={t("posKasirEdc.subtitle", {
          orderNo: bill.orderNo,
          table: bill.tableLabel,
        })}
        action={
          headAction ??
          (headPill && (
            <StatusPill tone={headPill.tone} icon={headPill.icon}>
              {headPill.label}
            </StatusPill>
          ))
        }
      />
      <PosTwoPane
        side={
          <PosPanel title={t("posKasirEdc.side.title")}>
            <div className="grid gap-4">
              <dl className="grid gap-2 border-b-(length:--border-w) border-border pb-4">
                <SideLine label={t("posKasirEdc.side.total")}>
                  <Money amount={bill.totalIdr} className="font-semibold" />
                </SideLine>
                {bill.deposit && (
                  <SideLine label={t("posKasirEdc.side.deposit")}>
                    <Money
                      amount={-bill.deposit.amountIdr}
                      className="font-semibold"
                    />
                  </SideLine>
                )}
              </dl>
              <div className="grid justify-items-start gap-2">
                <p className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                  {sideLabel}
                </p>
                {sideAmountIdr === null ? (
                  <p className="type-money-hero tabular">
                    <span aria-hidden="true">–</span>
                    <span className="sr-only">
                      {t("posKasirEdc.side.notFilled")}
                    </span>
                  </p>
                ) : (
                  <Money amount={sideAmountIdr} size="hero" />
                )}
                {sidePill && (
                  <StatusPill
                    tone={sidePill.tone}
                    icon={
                      sidePill.icon ??
                      (sidePill.tone === "neutral" ? Lock : undefined)
                    }
                  >
                    {sidePill.label}
                  </StatusPill>
                )}
                {bill.depositSurplusIdr > 0 && (
                  <p className="text-base">
                    {t("posKasirEdc.side.depositSurplus", {
                      amount: formatRupiah(bill.depositSurplusIdr),
                    })}
                  </p>
                )}
              </div>
              {sideTerminal && (
                <div className="grid gap-1 rounded-control bg-surface-2 p-4">
                  <p className="type-heading">{sideTerminal.title}</p>
                  <p className="text-base">{sideTerminal.detail}</p>
                </div>
              )}
              <p className="text-base leading-6 text-muted-foreground">
                {sideNote}
              </p>
            </div>
          </PosPanel>
        }
      >
        {children}
      </PosTwoPane>
    </div>
  );
}
