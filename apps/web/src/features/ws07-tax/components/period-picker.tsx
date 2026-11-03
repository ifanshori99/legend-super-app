// Business-month picker for the tax recap. Month arithmetic and validation are
// the contract's period helpers (previousPeriod / nextPeriod / periodKeySchema)
// via ../lib; the native month field keeps keyboard and screen-reader behaviour.
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isTaxPeriodKey, shiftTaxPeriod } from "../lib";

export function PeriodPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (period: string) => void;
}) {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor="tax-period">{t("accounting.tax.period.label")}</Label>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t("accounting.tax.period.previous")}
          onClick={() => onChange(shiftTaxPeriod(value, -1))}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Input
          id="tax-period"
          type="month"
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            if (isTaxPeriodKey(next)) onChange(next);
          }}
          className="h-control-sm w-44"
        />
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t("accounting.tax.period.next")}
          onClick={() => onChange(shiftTaxPeriod(value, 1))}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <p className="max-w-sm text-sm leading-5 text-muted-foreground">
        {t("accounting.tax.period.hint")}
      </p>
    </div>
  );
}
