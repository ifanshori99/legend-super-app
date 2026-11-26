// O5 (1): the way out of an unclear order's hold. The cashier says this cart
// is another customer's and writes why (4 to 200 letters). Nothing is sent
// here: the reason travels with the offline sale, which then reaches Finance
// flagged "perlu dicek" (Keputusan CTO 27 Nov, docs/qa/1272-o4-review.md).
import { useId, useState } from "react";
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
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import {
  OFFLINE_OTHER_CUSTOMER_REASON_MAX,
  OFFLINE_OTHER_CUSTOMER_REASON_MIN,
} from "@starter/shared/pos";
import { otherCustomerReasonOf } from "./sale-guard";

export function OtherCustomerDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && (
          <Body
            onCancel={() => onOpenChange(false)}
            onConfirm={(reason) => {
              onConfirm(reason);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const reason = otherCustomerReasonOf(value);
  const short = touched && reason === null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("posKasirOffline.otherCustomer.title")}</DialogTitle>
        <DialogDescription>
          {t("posKasirOffline.otherCustomer.body")}
        </DialogDescription>
      </DialogHeader>
      <FormField
        id={`${id}-reason`}
        label={t("posKasirOffline.otherCustomer.reason")}
        hint={t("posKasirOffline.otherCustomer.reasonHint", {
          min: OFFLINE_OTHER_CUSTOMER_REASON_MIN,
        })}
        error={short ? t("posKasirOffline.otherCustomer.short") : undefined}
        required
      >
        <Textarea
          rows={3}
          maxLength={OFFLINE_OTHER_CUSTOMER_REASON_MAX}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => setTouched(true)}
        />
      </FormField>
      <DialogFooter className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" size="lg" onClick={onCancel}>
          {t("posKasirOffline.otherCustomer.cancel")}
        </Button>
        <Button
          type="button"
          size="lg"
          aria-disabled={reason === null ? true : undefined}
          onClick={() => {
            setTouched(true);
            if (reason !== null) onConfirm(reason);
          }}
          className="font-bold"
        >
          {t("posKasirOffline.otherCustomer.confirm")}
        </Button>
      </DialogFooter>
    </>
  );
}
