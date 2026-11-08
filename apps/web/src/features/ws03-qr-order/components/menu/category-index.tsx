// Category navigation of the menu, driven by the `cat` URL param. Mobile: pill
// chips in the glass header (dark pill = active). Desktop: the left index list
// with an active dark pill and an arrow.
import { ArrowRight } from "lucide-react";
import type { QrMenu } from "@starter/shared/qr-order";
import { cn } from "cn";
import { useT } from "@/components/i18n";

type Props = {
  categories: QrMenu["categories"];
  active: string | undefined;
  onChange: (category: string | undefined) => void;
};

function entries(categories: QrMenu["categories"], all: string) {
  return [
    { id: undefined as string | undefined, name: all },
    ...[...categories].sort((a, b) => a.sortOrder - b.sortOrder),
  ];
}

const focus =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function CategoryChips({ categories, active, onChange }: Props) {
  const t = useT();
  return (
    <nav
      aria-label={t("qrMenu.category.navLabel")}
      className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 py-1"
    >
      {entries(categories, t("qrMenu.category.all")).map((entry) => {
        const pressed = entry.id === active;
        return (
          <button
            key={entry.id ?? "all"}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(entry.id)}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center rounded-full px-5 text-base pressable",
              focus,
              pressed
                ? "bg-qr-coffee font-bold text-qr-on-dark"
                : "font-semibold text-foreground hover:bg-qr-selection",
            )}
          >
            {entry.name}
          </button>
        );
      })}
    </nav>
  );
}

export function CategoryList({ categories, active, onChange }: Props) {
  const t = useT();
  return (
    <nav aria-label={t("qrMenu.category.navLabel")}>
      <ul className="grid gap-1">
        {entries(categories, t("qrMenu.category.all")).map((entry) => {
          const pressed = entry.id === active;
          return (
            <li key={entry.id ?? "all"}>
              <button
                type="button"
                aria-pressed={pressed}
                onClick={() => onChange(entry.id)}
                className={cn(
                  "flex min-h-12 w-full items-center justify-between gap-2 rounded-qr-cta px-3 text-left text-base pressable",
                  focus,
                  pressed
                    ? "bg-qr-coffee font-bold text-qr-on-dark"
                    : "font-medium hover:bg-qr-selection",
                )}
              >
                <span className="min-w-0 truncate">{entry.name}</span>
                {pressed && (
                  <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
