// Label filters (Baru, Terlaris, Pedas, ...): a paper panel that opens under
// the header from the filter button. Selected labels live in the URL.
import { Check, X } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { qrTextLink } from "../glass/qr-primitives";
import { labelText } from "../item-card";

export function LabelFilterPanel({
  id,
  available,
  selected,
  onToggle,
  onClear,
  onClose,
}: {
  id: string;
  available: string[];
  selected: string[];
  onToggle: (label: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="qr-paper grid gap-3 rounded-qr-media p-4 shadow-raised"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="text-base font-bold">
          {t("qrGlass.menu.filter.title")}
        </h2>
        <div className="flex items-center gap-2">
          {selected.length > 0 && (
            <button type="button" onClick={onClear} className={qrTextLink}>
              {t("qrMenu.filter.clear")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="-m-2 inline-grid size-11 place-items-center rounded-full hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <X className="size-5" aria-hidden="true" />
            <span className="sr-only">{t("qrGlass.menu.filter.close")}</span>
          </button>
        </div>
      </div>
      <div
        role="group"
        aria-label={t("qrMenu.filter.label")}
        className="flex flex-wrap gap-2"
      >
        {available.map((label) => {
          const pressed = selected.includes(label);
          return (
            <button
              key={label}
              type="button"
              aria-pressed={pressed}
              onClick={() => onToggle(label)}
              className={cn(
                "inline-flex min-h-11 items-center gap-1.5 rounded-full border border-input px-4 text-base pressable focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                pressed
                  ? "bg-qr-selection font-semibold"
                  : "bg-card hover:bg-qr-selection",
              )}
            >
              {pressed && <Check className="size-4" aria-hidden="true" />}
              {labelText(t, label)}
            </button>
          );
        })}
      </div>
    </section>
  );
}
