import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEdcTerminals } from "../../hooks";
import type { EdcMode, EdcSlip } from "../../types";

export type TypedSlip = {
  amount: string;
  mode: EdcMode;
  terminalId: string;
  bankRef: string;
  approvalCode: string;
};

export const EMPTY_SLIP: TypedSlip = {
  amount: "",
  mode: "card",
  terminalId: "",
  bankRef: "",
  approvalCode: "",
};

/** null while a required field of the slip is missing. */
export function slipInput(typed: TypedSlip): EdcSlip | null {
  const amountIdr = Number(typed.amount);
  const bankRef = typed.bankRef.trim();
  const approvalCode = typed.approvalCode.trim();
  if (!amountIdr || !typed.terminalId || !bankRef) return null;
  return {
    amountIdr,
    edcMode: typed.mode,
    terminalId: typed.terminalId,
    bankRef,
    ...(approvalCode ? { approvalCode } : {}),
  };
}

// The paper EDC slip of a request that cannot be read. The amount is typed, not
// taken from the bill: a slip of another amount must not be recorded.
export function SlipFields({
  value,
  onChange,
  disabled,
}: {
  value: TypedSlip;
  onChange: (next: TypedSlip) => void;
  disabled: boolean;
}) {
  const t = useT();
  const terminals = useEdcTerminals();
  const set = (part: Partial<TypedSlip>) => onChange({ ...value, ...part });
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <FormField
        label={t("posKasirPayment.unresolved.slipAmount")}
        hint={
          value.amount
            ? formatRupiah(Number(value.amount))
            : t("posKasirPayment.unresolved.slipAmountHint")
        }
        required
      >
        <Input
          name="slipAmount"
          value={value.amount}
          onChange={(event) =>
            set({ amount: event.target.value.replace(/\D/g, "").slice(0, 12) })
          }
          inputMode="numeric"
          autoComplete="off"
          className="tabular"
          disabled={disabled}
        />
      </FormField>
      <FormField label={t("posKasirEdc.select.modeLegend")} required>
        <Select
          value={value.mode}
          onValueChange={(next) => next && set({ mode: next as EdcMode })}
          disabled={disabled}
        >
          <SelectTrigger className="h-control">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="card">
              {t("posKasirEdc.side.mode.card")}
            </SelectItem>
            <SelectItem value="qris">
              {t("posKasirEdc.side.mode.qris")}
            </SelectItem>
          </SelectContent>
        </Select>
      </FormField>
      <FormField label={t("posKasirEdc.select.terminalLegend")} required>
        <Select
          value={value.terminalId}
          onValueChange={(next) => next && set({ terminalId: next })}
          disabled={disabled}
        >
          <SelectTrigger className="h-control">
            <SelectValue
              placeholder={t("posKasirPayment.unresolved.slipTerminal")}
            />
          </SelectTrigger>
          <SelectContent>
            {(terminals.data ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField
        label={t("posKasirEdc.standalone.bankRef")}
        hint={t("posKasirEdc.standalone.bankRefHint")}
        required
      >
        <Input
          name="slipBankRef"
          value={value.bankRef}
          onChange={(event) => set({ bankRef: event.target.value })}
          autoComplete="off"
          spellCheck={false}
          className="tabular"
          disabled={disabled}
        />
      </FormField>
      <FormField label={t("posKasirEdc.standalone.approval")}>
        <Input
          name="slipApprovalCode"
          value={value.approvalCode}
          onChange={(event) => set({ approvalCode: event.target.value })}
          autoComplete="off"
          spellCheck={false}
          className="tabular"
          disabled={disabled}
        />
      </FormField>
    </div>
  );
}
