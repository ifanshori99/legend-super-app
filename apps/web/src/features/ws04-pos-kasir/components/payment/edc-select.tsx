import { useId, useState, type ReactNode } from "react";
import { cn } from "cn";
import { Circle, CircleDot } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useStartPayment } from "../../hooks";
import type { EdcMode, EdcTerminal, PaymentBill } from "../../types";
import { Notice, PosPanel, StatusPill, type StatusPillTone } from "../shared";
import { EdcLayout, useEdcErrorText } from "./edc-side";

const MODES: readonly EdcMode[] = ["card", "qris"];

const STATUS_PILL: Record<
  EdcTerminal["status"],
  { tone: StatusPillTone; key: "ready" | "busy" | "offline" }
> = {
  ready: { tone: "success", key: "ready" },
  busy: { tone: "warning", key: "busy" },
  offline: { tone: "danger", key: "offline" },
};

// One option of a radio group. The native radio stays in the page (screen
// reader and arrow keys work) and the card shows the choice with ink and a
// filled glyph, not with the accent color.
function Choice({
  name,
  value,
  checked,
  disabled,
  onChange,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  const Glyph = checked ? CircleDot : Circle;
  return (
    <label
      className={cn(
        "flex min-h-control items-center gap-3 rounded-control border-(length:--border-w) border-border bg-card px-4 py-3 text-(length:--density-text) has-checked:border-2 has-checked:border-foreground has-checked:bg-surface-2 has-checked:font-semibold has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring has-disabled:opacity-60",
        !disabled && "cursor-pointer",
      )}
    >
      <input
        type="radio"
        className="sr-only"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <Glyph className="size-5 shrink-0" aria-hidden="true" />
      {children}
    </label>
  );
}

export function EdcSelect({
  orderId,
  bill,
  amountIdr,
  terminals,
  terminalsLoading,
  terminal,
  mode,
  onTerminalChange,
  onModeChange,
  previousFailed,
  onBack,
  onStandalone,
}: {
  orderId: string;
  bill: PaymentBill;
  /** What this payment sends to the machine (whole rupiah). */
  amountIdr: number;
  terminals: readonly EdcTerminal[];
  terminalsLoading: boolean;
  /** The terminal in effect: the cashier's pick or the first ready one. */
  terminal: EdcTerminal | undefined;
  mode: EdcMode;
  onTerminalChange: (terminalId: string) => void;
  onModeChange: (mode: EdcMode) => void;
  /** An earlier EDC request failed or was cancelled. */
  previousFailed: boolean;
  onBack: () => void;
  onStandalone: () => void;
}) {
  const t = useT();
  const errorText = useEdcErrorText();
  const group = useId();
  const start = useStartPayment();
  // The terminal in effect may be the automatic first-ready one: the side card
  // names a terminal only after the cashier chose one.
  const [picked, setPicked] = useState(false);
  // A machine that is not connected takes no amount from here: the cashier
  // keys it on the machine and records the slip (standalone).
  const manual = terminal !== undefined && !terminal.integrated;
  const takesMode = terminal?.modes?.includes(mode) ?? true;
  const canSend =
    terminal !== undefined && terminal.status === "ready" && !manual;
  const amountText = formatRupiah(amountIdr);

  return (
    <EdcLayout
      title={t("posKasirEdc.heading.select")}
      bill={bill}
      headPill={{ tone: "neutral", label: t("posKasirEdc.pill.select") }}
      sideLabel={t("posKasirEdc.side.remaining")}
      sideAmountIdr={amountIdr}
      sidePill={{ tone: "neutral", label: t("posKasirEdc.side.fromBill") }}
      sideTerminal={
        picked && terminal
          ? {
              title: terminal.label,
              detail: t(`posKasirEdc.side.mode.${mode}`),
            }
          : {
              title: t("posKasirEdc.side.pickTerminal"),
              detail: t("posKasirEdc.side.pickTerminalDetail"),
            }
      }
      sideNote={t("posKasirEdc.side.selectNote")}
    >
      <PosPanel
        title={t("posKasirEdc.select.title")}
        footer={
          <>
            <Button type="button" variant="outline" onClick={onBack}>
              {t("posKasirEdc.select.back")}
            </Button>
            {manual ? (
              <Button
                type="button"
                disabled={!takesMode}
                onClick={onStandalone}
              >
                {t("posKasirEdc.select.standalone")}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={!canSend}
                loading={start.isPending}
                onClick={() =>
                  terminal &&
                  start.mutate({
                    orderId,
                    method: "edc",
                    amountIdr,
                    terminalId: terminal.id,
                    edcMode: mode,
                  })
                }
              >
                {t("posKasirEdc.select.send", { amount: amountText })}
              </Button>
            )}
          </>
        }
      >
        <div className="grid gap-4">
          <p className="text-(length:--density-text) text-muted-foreground">
            {t("posKasirEdc.select.hint")}
          </p>
          {previousFailed && (
            <Notice tone="warning" title={t("posKasirEdc.select.failedTitle")}>
              {t("posKasirEdc.select.failedBody")}
            </Notice>
          )}
          <fieldset className="grid gap-2">
            <legend className="type-heading mb-2">
              {t("posKasirEdc.select.modeLegend")}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {MODES.map((item) => (
                <Choice
                  key={item}
                  name={`${group}-mode`}
                  value={item}
                  checked={mode === item}
                  disabled={terminal?.modes?.includes(item) === false}
                  onChange={() => onModeChange(item)}
                >
                  {t(`posKasirEdc.side.mode.${item}`)}
                </Choice>
              ))}
            </div>
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="type-heading mb-2">
              {t("posKasirEdc.select.terminalLegend")}
            </legend>
            {terminalsLoading ? (
              <div className="grid gap-3" aria-busy="true">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : terminals.length === 0 ? (
              <Notice tone="warning" title={t("posKasirEdc.select.noTerminal")}>
                {t("posKasirEdc.select.noTerminalHint")}
              </Notice>
            ) : (
              <div className="grid gap-3">
                {terminals.map((item) => {
                  const pill = STATUS_PILL[item.status];
                  return (
                    <Choice
                      key={item.id}
                      name={`${group}-terminal`}
                      value={item.id}
                      checked={terminal?.id === item.id}
                      disabled={item.status !== "ready"}
                      onChange={() => {
                        setPicked(true);
                        onTerminalChange(item.id);
                      }}
                    >
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span>{item.label}</span>
                        <span className="text-base font-normal text-muted-foreground">
                          {t(
                            item.integrated
                              ? "posKasirEdc.select.integrated"
                              : "posKasirEdc.select.manual",
                          )}{" "}
                          · {item.assignedTo}
                        </span>
                      </span>
                      <StatusPill tone={pill.tone}>
                        {t(`posKasirEdc.select.${pill.key}`)}
                      </StatusPill>
                    </Choice>
                  );
                })}
              </div>
            )}
          </fieldset>
          <Notice
            tone="info"
            title={t(
              manual
                ? "posKasirEdc.select.manualTitle"
                : "posKasirEdc.select.autoTitle",
            )}
          >
            {t(
              manual
                ? "posKasirEdc.select.manualBody"
                : "posKasirEdc.select.autoBody",
            )}
          </Notice>
          {!manual && (
            <Button
              type="button"
              variant="link"
              className="justify-self-start"
              onClick={onStandalone}
              disabled={start.isPending}
            >
              {t("posKasirEdc.select.standalone")}
            </Button>
          )}
          {start.error && (
            <Notice tone="danger" title={t("posKasirEdc.select.sendError")}>
              {errorText(start.error)}
            </Notice>
          )}
        </div>
      </PosPanel>
    </EdcLayout>
  );
}
