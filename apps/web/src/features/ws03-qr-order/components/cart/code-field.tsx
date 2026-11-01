// Promo / voucher code entry. The client sends the code only; the server
// validates it and recomputes the total (ORD-03).
import { useState } from "react";
import { Tag, X } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";

export function CodeField({
  applied,
  invalid,
  checking,
  onApply,
  onRemove,
}: {
  applied: string | null;
  invalid: boolean;
  checking: boolean;
  onApply: (code: string) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  if (applied && !invalid)
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl bg-success-subtle p-3">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Tag className="size-5 text-success" aria-hidden="true" />
          {t("qrCart.checkout.code.applied", { code: applied })}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          <X aria-hidden="true" />
          {t("qrCart.checkout.code.remove")}
        </Button>
      </div>
    );
  if (!open && !invalid)
    return (
      <Button
        type="button"
        variant="link"
        className="w-fit"
        onClick={() => setOpen(true)}
      >
        <Tag aria-hidden="true" />
        {t("qrCart.checkout.code.toggle")}
      </Button>
    );
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const code = value.trim().toUpperCase();
        if (code) onApply(code);
      }}
    >
      <FormField
        label={t("qrCart.checkout.code.label")}
        hint={t("qrCart.checkout.code.hint")}
        error={invalid ? t("qrCart.checkout.code.invalid") : undefined}
      >
        <Input
          value={value}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("qrCart.checkout.code.placeholder")}
          onChange={(event) => setValue(event.target.value.toUpperCase())}
        />
      </FormField>
      <Button
        type="submit"
        variant="outline"
        loading={checking}
        className="w-full sm:w-fit"
      >
        {t("qrCart.checkout.code.apply")}
      </Button>
    </form>
  );
}
