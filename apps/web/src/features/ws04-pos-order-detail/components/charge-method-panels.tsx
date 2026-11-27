// The method pieces of the charge screen (legend-t93l8). They only draw what
// the server's charge says; what may be collected is decided in
// ../charge-method-logic.ts. Same patterns as the cashier payment panels.
import { useId, type ReactNode } from "react";
import { cn } from "cn";
import {
  Banknote,
  Circle,
  CircleDot,
  CreditCard,
  QrCode as QrGlyph,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Money } from "@/components/ui/money";
import { QrCode } from "@/components/ui/qr-code";
import {
  CountdownPill,
  remainingMsOf,
  useNow,
} from "@/features/ws04-pos-kasir/components/payment/gateway-parts";
import {
  Notice,
  StatusPill,
  type StatusPillTone,
} from "@/features/ws04-pos-kasir/components/shared";
import type { ChargeTerminal } from "../charge-api";
import type { ChargeEdcSale, IssueChargeDetail } from "../charge-endpoints";
import { edcSaleMatches, type ChargeMethod } from "../charge-method-logic";

const METHODS: readonly { code: ChargeMethod; icon: LucideIcon }[] = [
  { code: "cash", icon: Banknote },
  { code: "qris", icon: QrGlyph },
  { code: "edc_card", icon: CreditCard },
];

// One option of a radio group. The native radio stays in the page (screen
// reader and arrow keys work); the choice shows with ink and a filled glyph.
function Choice({
  name,
  checked,
  disabled,
  onChange,
  children,
}: {
  name: string;
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
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <Glyph className="size-5 shrink-0" aria-hidden="true" />
      {children}
    </label>
  );
}

/**
 * The methods the cashier may use. `only`: an attempt without an answer holds
 * the picker to its own method from the start (legend-f1mmf (a)); the others
 * are not offered at all.
 */
export function MethodPicker({
  value,
  onChange,
  only = null,
}: {
  value: ChargeMethod;
  onChange: (method: ChargeMethod) => void;
  only?: ChargeMethod | null;
}) {
  const t = useT();
  const name = useId();
  return (
    <fieldset className="grid gap-2">
      <legend className="type-heading mb-2">
        {t("posIssueCharge.method.legend")}
      </legend>
      {METHODS.filter(({ code }) => only === null || code === only).map(
        ({ code, icon: Icon }) => (
          <Choice
            key={code}
            name={name}
            checked={value === code}
            onChange={() => onChange(code)}
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            {t(`posIssueCharge.method.${code}`)}
          </Choice>
        ),
      )}
    </fieldset>
  );
}

/**
 * The outlet's card terminals (payment options). A stored card start holds
 * the choice to its own terminal, so a retry replays the same sale.
 */
export function TerminalPicker({
  terminals,
  value,
  onChange,
  lockedId,
  loading,
  failed,
}: {
  terminals: readonly ChargeTerminal[];
  value: string | null;
  onChange: (id: string) => void;
  lockedId: string | null;
  loading: boolean;
  failed: boolean;
}) {
  const t = useT();
  const name = useId();
  if (loading)
    return (
      <p role="status" className="text-base text-muted-foreground">
        {t("posIssueCharge.edc.terminalsLoading")}
      </p>
    );
  if (failed)
    return (
      <Notice tone="danger" title={t("posIssueCharge.edc.terminalsErrorTitle")}>
        <p>{t("posIssueCharge.edc.terminalsError")}</p>
      </Notice>
    );
  const shown = lockedId
    ? terminals.filter((terminal) => terminal.id === lockedId)
    : terminals;
  if (shown.length === 0)
    return (
      <Notice
        tone="warning"
        title={t("posIssueCharge.edc.terminalsEmptyTitle")}
      >
        <p>{t("posIssueCharge.edc.terminalsEmpty")}</p>
      </Notice>
    );
  return (
    <fieldset className="grid gap-2">
      <legend className="type-heading mb-2">
        {t("posIssueCharge.edc.terminalLegend")}
      </legend>
      {lockedId && (
        <p className="text-base text-muted-foreground">
          {t("posIssueCharge.edc.terminalLockedHint")}
        </p>
      )}
      {shown.map((terminal) => (
        <Choice
          key={terminal.id}
          name={name}
          checked={value === terminal.id}
          onChange={() => onChange(terminal.id)}
        >
          <CreditCard className="size-5 shrink-0" aria-hidden="true" />
          <span className="grid min-w-0 gap-1">
            <span>{terminal.label}</span>
            <span className="text-base font-normal text-muted-foreground">
              {terminal.detail}
            </span>
          </span>
        </Choice>
      ))}
    </fieldset>
  );
}

/** A code is out. Past its deadline the code is hidden, the lock stays. */
export function GatewayWaiting({
  payment,
}: {
  payment: NonNullable<IssueChargeDetail["payment"]>;
}) {
  const t = useT();
  const now = useNow(true);
  const remainingMs = remainingMsOf(payment.expiresAt, now);
  const payload = payment.method === "qris" ? payment.qrisPayload : null;
  const timeUp = remainingMs === 0;
  let title = t("posIssueCharge.qris.waitingTitle");
  if (payload === null) title = t("posIssueCharge.qris.otherTitle");
  if (timeUp) title = t("posIssueCharge.qris.timeUpTitle");
  return (
    <>
      {payload !== null && remainingMs !== null && !timeUp && (
        <div className="grid justify-items-center gap-3">
          <QrCode
            value={payload}
            label={t("posIssueCharge.qris.codeLabel")}
            size={220}
            className="rounded-container border-(length:--border-w) border-border p-3"
          />
          <CountdownPill remainingMs={remainingMs} />
        </div>
      )}
      <Notice tone={timeUp ? "warning" : "info"} role="status" title={title}>
        <p>
          {timeUp && `${t("posIssueCharge.qris.timeUp")} `}
          {t("posIssueCharge.waiting.locked")}
        </p>
      </Notice>
    </>
  );
}

const SALE_TONE: Record<ChargeEdcSale["status"], StatusPillTone> = {
  approved: "success",
  pending: "warning",
  unknown: "warning",
  declined: "danger",
  cancelled: "neutral",
  failed: "danger",
};

function SaleFacts({ sale }: { sale: ChargeEdcSale }) {
  const t = useT();
  return (
    <>
      <span className="grid min-w-0 flex-1 justify-items-start gap-1">
        <span>{sale.terminalLabel ?? t("posIssueCharge.edc.terminal")}</span>
        <StatusPill tone={SALE_TONE[sale.status]}>
          {t(`posIssueCharge.edc.status.${sale.status}`)}
        </StatusPill>
        {sale.declineReason && (
          <span className="text-base font-normal text-muted-foreground">
            {sale.declineReason}
          </span>
        )}
      </span>
      <Money amount={sale.amountIdr} className="font-semibold" />
    </>
  );
}

/** Why a listed sale cannot pay this charge. */
function notUsableKey(sale: ChargeEdcSale, amountIdr: number) {
  if (sale.needsReconciliation) return "review" as const;
  if (sale.status === "approved" && sale.amountIdr !== amountIdr)
    return "amount" as const;
  return "status" as const;
}

/**
 * The server's EDC sales of the charge. Read-only facts (a list, never a dead
 * control), except while an approved sale waits to be recorded: then the
 * sales that pay the charge exactly are choices and the others say why not.
 */
export function EdcSales({
  charge,
  selectedId = null,
  onSelect,
}: {
  charge: IssueChargeDetail;
  selectedId?: string | null;
  /** Given only when a sale is to be picked for recording. */
  onSelect?: (id: string) => void;
}) {
  const t = useT();
  const name = useId();
  const legendId = useId();
  if (charge.edcSales.length === 0) return null;
  const usable = charge.edcSales.filter((sale) =>
    edcSaleMatches(sale, charge.amountIdr),
  );
  const facts = onSelect
    ? charge.edcSales.filter((sale) => !usable.includes(sale))
    : charge.edcSales;
  const row =
    "flex min-h-control items-center gap-3 rounded-control border-(length:--border-w) border-border bg-card px-4 py-3 text-(length:--density-text)";
  return (
    <div className="grid gap-2">
      <p id={legendId} className="type-heading mb-2">
        {t("posIssueCharge.edc.legend")}
      </p>
      {onSelect && usable.length > 0 && (
        <fieldset aria-labelledby={legendId} className="grid gap-2">
          {usable.map((sale) => (
            <Choice
              key={sale.id}
              name={name}
              checked={selectedId === sale.id}
              onChange={() => onSelect(sale.id)}
            >
              <SaleFacts sale={sale} />
            </Choice>
          ))}
        </fieldset>
      )}
      {facts.length > 0 && (
        <ul aria-labelledby={legendId} className="grid gap-2">
          {facts.map((sale) => (
            <li key={sale.id} className={row}>
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="flex min-w-0 items-center gap-3">
                  <SaleFacts sale={sale} />
                </span>
                {onSelect && (
                  <span className="text-base text-muted-foreground">
                    {t(
                      `posIssueCharge.edc.notUsable.${notUsableKey(sale, charge.amountIdr)}`,
                    )}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Why the last code is gone, before the cashier makes another. */
export function EndedCodeNotice({
  payment,
}: {
  payment: IssueChargeDetail["payment"];
}) {
  const t = useT();
  if (payment?.method !== "qris") return null;
  if (payment.status !== "expired" && payment.status !== "failed") return null;
  const key = payment.status;
  return (
    <Notice
      tone={key === "failed" ? "danger" : "warning"}
      title={t(`posIssueCharge.qris.${key}Title`)}
    >
      <p>{t(`posIssueCharge.qris.${key}`)}</p>
    </Notice>
  );
}
